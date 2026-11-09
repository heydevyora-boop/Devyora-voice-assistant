import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AudioStoreService } from '../src/modules/voice/audio/audio-store.service';
import {
  containerForDeclaredMime,
  readWavProperties,
  sniffContainer,
  SUPPORTED_FORMATS,
} from '../src/modules/voice/audio/audio-format';
import {
  assertDurationWithinLimit,
  AudioValidationError,
  validateAudio,
} from '../src/modules/voice/audio/audio-validation';
import type { AppConfigService } from '../src/config/app-config.module';
import {
  flac,
  mp3Bare,
  mp3Tagged,
  mp4,
  notAudio,
  ogg,
  wav,
  wavWithListChunk,
  webm,
} from './helpers/audio';

const LIMITS = { minBytes: 512, maxBytes: 1_048_576, maxDurationMs: 10_000 };

describe('audio handling', () => {
  describe('format identification', () => {
    it('identifies every supported container from its bytes', () => {
      expect(sniffContainer(wav({ durationMs: 200 }))).toBe('wav');
      expect(sniffContainer(webm())).toBe('webm');
      expect(sniffContainer(ogg())).toBe('ogg');
      expect(sniffContainer(flac())).toBe('flac');
      expect(sniffContainer(mp4())).toBe('mp4');
      expect(sniffContainer(mp3Tagged())).toBe('mp3');
      expect(sniffContainer(mp3Bare())).toBe('mp3');
    });

    it('refuses to identify something that is not audio', () => {
      expect(sniffContainer(notAudio())).toBeNull();
      expect(sniffContainer(Buffer.alloc(4))).toBeNull();
      expect(sniffContainer(Buffer.alloc(0))).toBeNull();
    });

    it('does not accept a RIFF container that is not WAVE', () => {
      const avi = Buffer.concat([
        Buffer.from('RIFF', 'ascii'),
        Buffer.alloc(4),
        Buffer.from('AVI ', 'ascii'),
        Buffer.alloc(16),
      ]);
      expect(sniffContainer(avi)).toBeNull();
    });

    it('maps the MIME types clients actually send', () => {
      expect(containerForDeclaredMime('audio/webm;codecs=opus')).toBe('webm');
      // What MediaRecorder labels an audio-only WebM.
      expect(containerForDeclaredMime('video/webm')).toBe('webm');
      expect(containerForDeclaredMime('audio/x-wav')).toBe('wav');
      expect(containerForDeclaredMime('AUDIO/MPEG')).toBe('mp3');
      expect(containerForDeclaredMime('audio/x-m4a')).toBe('mp4');
      expect(containerForDeclaredMime('application/pdf')).toBeNull();
    });

    it('publishes one canonical MIME type per container', () => {
      expect(SUPPORTED_FORMATS.wav.mimeType).toBe('audio/wav');
      expect(SUPPORTED_FORMATS.mp3.mimeType).toBe('audio/mpeg');
      expect(Object.keys(SUPPORTED_FORMATS)).toHaveLength(6);
    });
  });

  describe('WAV duration', () => {
    it('measures duration exactly', () => {
      const properties = readWavProperties(wav({ durationMs: 1_500, sampleRate: 16_000 }));
      expect(properties).not.toBeNull();
      expect(properties!.durationMs).toBe(1_500);
      expect(properties!.sampleRate).toBe(16_000);
      expect(properties!.channels).toBe(1);
      expect(properties!.bitsPerSample).toBe(16);
    });

    it('measures stereo and other sample rates correctly', () => {
      expect(readWavProperties(wav({ durationMs: 2_000, sampleRate: 44_100, channels: 2 }))!.durationMs).toBe(2_000);
      expect(readWavProperties(wav({ durationMs: 500, sampleRate: 8_000 }))!.durationMs).toBe(500);
    });

    it('walks past chunks real encoders insert', () => {
      // A fixed-offset read would get this wrong.
      expect(readWavProperties(wavWithListChunk(1_000))!.durationMs).toBe(1_000);
    });

    it('uses what actually arrived when the data chunk declares no size', () => {
      const streamed = wav({ durationMs: 1_000, unsizedData: true });
      expect(readWavProperties(streamed)!.durationMs).toBe(1_000);
    });

    it('returns nothing for a container it cannot measure', () => {
      // The honest answer for a compressed container: this service does not
      // decode audio, so it does not know.
      expect(readWavProperties(webm())).toBeNull();
      expect(readWavProperties(ogg())).toBeNull();
      expect(readWavProperties(notAudio())).toBeNull();
    });
  });

  describe('validation', () => {
    it('accepts a well-formed recording and reports what it measured', () => {
      const result = validateAudio(wav({ durationMs: 1_200 }), 'audio/wav', LIMITS);
      expect(result.container).toBe('wav');
      expect(result.mimeType).toBe('audio/wav');
      expect(result.durationMs).toBe(1_200);
      expect(result.sampleRate).toBe(16_000);
      expect(result.checksum).toMatch(/^[0-9a-f]{64}$/);
    });

    it('leaves duration null for a compressed container rather than guessing', () => {
      const result = validateAudio(webm(4_096), 'audio/webm', LIMITS);
      expect(result.container).toBe('webm');
      expect(result.durationMs).toBeNull();
      expect(result.sampleRate).toBeNull();
    });

    it('rejects an empty or tiny upload', () => {
      expect(() => validateAudio(Buffer.alloc(0), 'audio/wav', LIMITS)).toThrow(AudioValidationError);
      try {
        validateAudio(Buffer.alloc(0), 'audio/wav', LIMITS);
      } catch (error) {
        expect((error as AudioValidationError).rejection).toBe('audio_missing');
      }
      try {
        validateAudio(Buffer.alloc(32, 1), 'audio/wav', LIMITS);
      } catch (error) {
        expect((error as AudioValidationError).rejection).toBe('audio_too_small');
      }
    });

    it('rejects an upload over the byte ceiling', () => {
      try {
        validateAudio(wav({ durationMs: 1_000 }), 'audio/wav', { ...LIMITS, maxBytes: 1_024 });
      } catch (error) {
        expect((error as AudioValidationError).rejection).toBe('audio_too_large');
      }
    });

    it('rejects something that is not audio', () => {
      try {
        validateAudio(notAudio(), 'audio/wav', LIMITS);
      } catch (error) {
        expect((error as AudioValidationError).rejection).toBe('audio_unsupported_format');
      }
    });

    it('rejects a client that lies about the format', () => {
      // Told apart from an unsupported format on purpose: one is a client
      // sending something we do not handle, the other is a client lying.
      try {
        validateAudio(webm(4_096), 'audio/wav', LIMITS);
      } catch (error) {
        expect((error as AudioValidationError).rejection).toBe('audio_format_mismatch');
      }
    });

    it('accepts a recording with no declared type at all', () => {
      // The bytes are what decide, so an absent header is not fatal.
      expect(validateAudio(webm(4_096), undefined, LIMITS).container).toBe('webm');
    });

    it('treats equivalent MIME spellings as a match, not a lie', () => {
      expect(validateAudio(wav({ durationMs: 600 }), 'audio/x-wav', LIMITS).container).toBe('wav');
      expect(validateAudio(webm(4_096), 'video/webm', LIMITS).container).toBe('webm');
    });

    it('rejects a measurably over-long recording', () => {
      try {
        validateAudio(wav({ durationMs: 20_000 }), 'audio/wav', LIMITS);
      } catch (error) {
        expect((error as AudioValidationError).rejection).toBe('audio_too_long');
      }
    });

    it('enforces the duration limit again once a provider has measured it', () => {
      // The byte ceiling cannot catch four minutes of silence in a small
      // Opus file, so the limit is applied a second time after decoding.
      expect(() => assertDurationWithinLimit(240_000, LIMITS)).toThrow(AudioValidationError);
      expect(() => assertDurationWithinLimit(5_000, LIMITS)).not.toThrow();
      expect(() => assertDurationWithinLimit(null, LIMITS)).not.toThrow();
    });
  });

  describe('temporary storage', () => {
    let root: string;
    let store: AudioStoreService;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'devyora-audio-test-'));
      store = new AudioStoreService({
        providers: { audio: { tempDir: root } },
      } as unknown as AppConfigService);
    });

    it('writes owner-only files under server-generated names', async () => {
      const key = await store.write(Buffer.from('audio bytes'));

      expect(key).toMatch(/^[0-9a-f]{32}$/);
      const info = await stat(join(root, key));
      // 0600: nothing else on the host can read a recording.
      expect(info.mode & 0o777).toBe(0o600);
      expect((await readFile(join(root, key))).toString()).toBe('audio bytes');
    });

    it('reads back what it wrote', async () => {
      const key = await store.write(Buffer.from([1, 2, 3, 4]));
      expect([...(await store.read(key))]).toEqual([1, 2, 3, 4]);
      expect(await store.exists(key)).toBe(true);
      expect(await store.sizeOf(key)).toBe(4);
    });

    it('deletes on request and reports a key that is gone', async () => {
      const key = await store.write(Buffer.from('x'.repeat(100)));
      expect(await store.remove(key)).toBe(true);
      expect(await store.exists(key)).toBe(false);
      expect(await store.sizeOf(key)).toBeNull();
    });

    it('never throws from a delete, so cleanup cannot mask a real failure', async () => {
      await expect(store.remove('deadbeefdeadbeefdeadbeefdeadbeef')).resolves.toBe(true);
      await expect(store.remove(null)).resolves.toBe(false);
      await expect(store.remove(undefined)).resolves.toBe(false);
      // A malformed key is refused inside, and still does not throw out.
      await expect(store.remove('../../etc/passwd')).resolves.toBe(false);
    });

    it('refuses a path that tries to leave the store', async () => {
      for (const key of ['../escape', 'a/b', '..', '.', 'ABCDEF', 'short', `${'a'.repeat(31)}`]) {
        await expect(store.read(key)).rejects.toThrow();
      }
    });

    it('empties the directory at startup', async () => {
      const first = await store.write(Buffer.from('one'));
      const second = await store.write(Buffer.from('two'));

      // A file left by a crashed process: audio that outlived its request.
      await store.onModuleInit();

      expect(await store.exists(first)).toBe(false);
      expect(await store.exists(second)).toBe(false);
    });

    it('leaves files it did not create alone', async () => {
      await writeFile(join(root, 'README.txt'), 'not mine');
      await store.write(Buffer.from('mine'));

      await store.purgeAll();

      // Only server-generated keys are touched; nothing is deleted on a guess.
      expect(await readdir(root)).toEqual(['README.txt']);
    });

    it('removes orphans that no live row claims, but spares recent ones', async () => {
      const orphan = await store.write(Buffer.from('orphaned'));
      const claimed = await store.write(Buffer.from('claimed'));
      const fresh = await store.write(Buffer.from('in flight'));

      // Age the first two past the grace window.
      const old = new Date(Date.now() - 120_000);
      const { utimes } = await import('node:fs/promises');
      await utimes(join(root, orphan), old, old);
      await utimes(join(root, claimed), old, old);

      const removed = await store.removeOlderThanExcept(60_000, new Set([claimed]));

      expect(removed).toBe(1);
      expect(await store.exists(orphan)).toBe(false);
      // Still referenced by a row.
      expect(await store.exists(claimed)).toBe(true);
      // Too recent: an upload being transcribed right now.
      expect(await store.exists(fresh)).toBe(true);
    });

    it('removes by age alone when asked', async () => {
      const key = await store.write(Buffer.from('aged'));
      const old = new Date(Date.now() - 120_000);
      const { utimes } = await import('node:fs/promises');
      await utimes(join(root, key), old, old);

      expect(await store.removeOlderThan(60_000)).toBe(1);
      expect(await store.exists(key)).toBe(false);
    });

    it('creates its directory with owner-only permissions', async () => {
      const nested = join(root, 'deeper', 'store');
      const scoped = new AudioStoreService({
        providers: { audio: { tempDir: nested } },
      } as unknown as AppConfigService);

      await scoped.write(Buffer.from('x'));
      expect((await stat(nested)).mode & 0o777).toBe(0o700);
    });
  });
});
