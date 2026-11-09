import { SttError } from '../src/providers/stt/errors';
import { MockSttProvider } from '../src/providers/stt/mock.provider';
import { SttRegistry } from '../src/providers/stt/stt.module';
import { WhisperSttProvider, extensionFor, normaliseLanguage } from '../src/providers/stt/whisper.provider';
import { GoogleSttProvider } from '../src/providers/stt/google.provider';
import { TtsError } from '../src/providers/tts/errors';
import { MockTtsProvider, silentWav } from '../src/providers/tts/mock.provider';
import { TtsRegistry } from '../src/providers/tts/tts.module';
import { OpenAiTtsProvider, clampRate } from '../src/providers/tts/openai.provider';
import { GoogleTtsProvider } from '../src/providers/tts/google.provider';
import { ProviderError, codeForStatus } from '../src/providers/shared/errors';
import { SttService } from '../src/modules/voice/stt.service';
import { TtsService } from '../src/modules/voice/tts.service';
import { validateAudio } from '../src/modules/voice/audio/audio-validation';
import { readWavProperties, sniffContainer } from '../src/modules/voice/audio/audio-format';
import {
  DEFAULT_VOICE_PREFERENCES,
  parseVoicePreferences,
} from '../src/modules/voice/voice-preferences';
import type { AppConfigService } from '../src/config/app-config.module';
import { wav, webm } from './helpers/audio';

const LIMITS = { minBytes: 512, maxBytes: 1_048_576, maxDurationMs: 10_000 };

function sttConfig(overrides: Record<string, unknown> = {}) {
  return {
    providers: {
      stt: { timeoutMs: 400, maxAttempts: 2, ...overrides },
      audio: { minBytes: 512, maxBytes: 1_048_576, maxDurationMs: 10_000 },
    },
  } as unknown as AppConfigService;
}

const ttsConfig = {
  providers: { tts: { timeoutMs: 400 } },
} as unknown as AppConfigService;

describe('speech providers', () => {
  // ──────────────────────────────────────────────────────── recognition

  describe('the recogniser contract', () => {
    it('declares what it can do rather than leaving callers to assume', () => {
      for (const provider of [
        new WhisperSttProvider('k', 'whisper-1', 1_000, 'https://api.openai.com/v1'),
        new GoogleSttProvider('k', 'latest_short', 1_000),
        new MockSttProvider(),
      ]) {
        expect(typeof provider.transcribe).toBe('function');
        expect(typeof provider.health).toBe('function');
        expect(provider.capabilities.mimeTypes.length).toBeGreaterThan(0);
        expect(['none', 'detected-as-one', 'alternatives']).toContain(
          provider.capabilities.codeSwitching,
        );
      }
    });

    it('does not claim streaming on a request/response endpoint', () => {
      // Both real adapters use a non-streaming method, so neither advertises it.
      expect(new WhisperSttProvider('k', 'm', 1_000, 'https://api.openai.com/v1').capabilities.streaming).toBe(false);
      expect(new GoogleSttProvider('k', 'm', 1_000).capabilities.streaming).toBe(false);
    });

    it('does not claim a confidence score it cannot produce', () => {
      // Whisper returns segment log-probabilities, not an utterance
      // confidence, so none is reported rather than one being derived.
      expect(new WhisperSttProvider('k', 'm', 1_000, 'https://api.openai.com/v1').capabilities.confidence).toBe(false);
      expect(new GoogleSttProvider('k', 'm', 1_000).capabilities.confidence).toBe(true);
    });

    it('treats a self-hosted endpoint as usable without a key', () => {
      // Pointing at a Whisper server you run yourself needs no credential,
      // and that is the arrangement worth supporting for voice.
      expect(new WhisperSttProvider(undefined, 'm', 1_000, 'http://whisper.internal:9000/v1').configured).toBe(true);
      // A hosted endpoint does need one.
      expect(new WhisperSttProvider(undefined, 'm', 1_000, 'https://api.openai.com/v1').configured).toBe(false);
      expect(new WhisperSttProvider('sk-x', 'm', 1_000, 'https://api.openai.com/v1').configured).toBe(true);
    });

    it('normalises a language hint to what the provider accepts', () => {
      expect(normaliseLanguage('hi-IN')).toBe('hi');
      expect(normaliseLanguage('en_US')).toBe('en');
      expect(normaliseLanguage('hi')).toBe('hi');
      // Unusable hints are dropped, because auto-detection beats a rejected
      // request.
      expect(normaliseLanguage('')).toBeNull();
      expect(normaliseLanguage(null)).toBeNull();
      expect(normaliseLanguage('!!')).toBeNull();
    });

    it('derives a decoder hint from the MIME type, never from client input', () => {
      expect(extensionFor('audio/webm')).toBe('.webm');
      expect(extensionFor('audio/mpeg')).toBe('.mp3');
      expect(extensionFor('audio/m4a')).toBe('.m4a');
      expect(extensionFor('application/x-evil')).toBe('.bin');
    });

    it('does not probe a provider during a health check', async () => {
      // A readiness probe must not spend transcription quota.
      const health = await new WhisperSttProvider('k', 'm', 1_000, 'https://api.openai.com/v1').health();
      expect(health.configured).toBe(true);
      expect(health.reachable).toBeNull();
      // And it never echoes a path or query that could have held a key.
      expect(health.detail).not.toContain('/v1');
    });
  });

  describe('transcription', () => {
    function service(mock: MockSttProvider, config = sttConfig()) {
      return new SttService(new SttRegistry([mock], 'mock'), config);
    }

    it('returns a transcript and reports the stand-in as a stand-in', async () => {
      const mock = new MockSttProvider().alwaysReturn('remind me to buy milk', {
        detectedLanguage: 'en-IN',
        confidence: 0.91,
        durationMs: 1_400,
      });

      const result = await service(mock).transcribe(
        validateAudio(wav({ durationMs: 1_400 }), 'audio/wav', LIMITS),
        null,
      );

      expect(result.text).toBe('remind me to buy milk');
      expect(result.detectedLanguage).toBe('en-IN');
      expect(result.confidence).toBeCloseTo(0.91, 5);
      expect(result.providerId).toBe('mock');
      // Carried everywhere it goes: nothing may present this as heard.
      expect(result.isMock).toBe(true);
    });

    it('hands the provider the canonical MIME type and the hint', async () => {
      const mock = new MockSttProvider().alwaysReturn('ok');
      await service(mock).transcribe(validateAudio(webm(4_096), 'video/webm', LIMITS), 'hi-IN');

      expect(mock.calls[0].mimeType).toBe('audio/webm');
      expect(mock.calls[0].languageHint).toBe('hi-IN');
      expect(mock.calls[0].bytes).toBe(4_096);
    });

    it('returns empty text when nothing was said, rather than failing', async () => {
      // A real outcome: the recogniser worked and heard nothing.
      const mock = new MockSttProvider();
      const result = await service(mock).transcribe(
        validateAudio(wav({ durationMs: 800 }), 'audio/wav', LIMITS),
        null,
      );
      expect(result.text).toBe('');
    });

    it('does not echo the hint back as a detected language', async () => {
      // An echoed guess is not a detection, and something downstream would
      // believe it.
      const blind = new MockSttProvider();
      Object.defineProperty(blind, 'capabilities', {
        value: { ...blind.capabilities, languageDetection: false, confidence: false },
      });
      blind.alwaysReturn('kuch bhi', { detectedLanguage: 'hi-IN', confidence: 0.8 });

      const result = await service(blind).transcribe(
        validateAudio(wav({ durationMs: 500 }), 'audio/wav', LIMITS),
        'hi-IN',
      );

      expect(result.detectedLanguage).toBeNull();
      expect(result.confidence).toBeNull();
    });

    it('refuses audio the active recogniser does not accept', async () => {
      const narrow = new MockSttProvider().alwaysReturn('x');
      Object.defineProperty(narrow, 'capabilities', {
        value: { ...narrow.capabilities, mimeTypes: ['audio/wav'] },
      });

      await expect(
        service(narrow).transcribe(validateAudio(webm(4_096), 'audio/webm', LIMITS), null),
      ).rejects.toMatchObject({ code: 'invalid_audio' });
    });

    it('rejects a recording whose real length only the provider could measure', async () => {
      // The byte ceiling cannot catch four minutes of silence in a small
      // Opus file; the duration check after decoding can.
      const mock = new MockSttProvider().alwaysReturn('long story', { durationMs: 240_000 });

      await expect(
        service(mock).transcribe(validateAudio(webm(4_096), 'audio/webm', LIMITS), null),
      ).rejects.toMatchObject({ rejection: 'audio_too_long' });
    });

    it('retries a transient failure and gives up on a permanent one', async () => {
      const flaky = new MockSttProvider().alwaysReturn('eventually');
      let attempts = 0;
      const original = flaky.transcribe.bind(flaky);
      flaky.transcribe = (request) => {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new SttError('unavailable', 'mock', 'blip'));
        return original(request);
      };

      const result = await service(flaky).transcribe(
        validateAudio(wav({ durationMs: 500 }), 'audio/wav', LIMITS),
        null,
      );
      expect(result.text).toBe('eventually');
      expect(attempts).toBe(2);

      const broken = new MockSttProvider().failWith(new SttError('auth', 'mock', 'no key'));
      let authAttempts = 0;
      const originalBroken = broken.transcribe.bind(broken);
      broken.transcribe = (request) => {
        authAttempts += 1;
        return originalBroken(request);
      };
      await expect(
        service(broken).transcribe(validateAudio(wav({ durationMs: 500 }), 'audio/wav', LIMITS), null),
      ).rejects.toMatchObject({ code: 'auth' });
      // A bad credential fails identically however often it is sent.
      expect(authAttempts).toBe(1);
    });

    it('gives up on a recogniser that stalls past its deadline', async () => {
      const mock = new MockSttProvider().stallFor(30_000).alwaysReturn('too late');

      await expect(
        service(mock).transcribe(validateAudio(wav({ durationMs: 500 }), 'audio/wav', LIMITS), null),
      ).rejects.toBeInstanceOf(SttError);
    }, 20_000);

    it('describes the active recogniser for a client to adapt to', () => {
      const described = service(new MockSttProvider()).describeProvider();
      expect(described.providerId).toBe('mock');
      expect(described.isMock).toBe(true);
      expect(described.capabilities.mimeTypes).toContain('audio/webm');
    });
  });

  describe('recogniser selection', () => {
    it('never selects a provider with no credential', () => {
      const registry = new SttRegistry(
        [new MockSttProvider(), new GoogleSttProvider(undefined, 'latest_short', 1_000)],
        'google',
      );
      // Audio is the user's own voice: sending it somewhere nobody chose
      // would be a disclosure, not a fallback.
      expect(registry.active().id).toBe('mock');
      expect(registry.active().kind).toBe('mock');
    });

    it('selects a configured provider when asked for it', () => {
      const registry = new SttRegistry(
        [new MockSttProvider(), new GoogleSttProvider('key', 'latest_short', 1_000)],
        'google',
      );
      expect(registry.active().id).toBe('google');
    });

    it('falls back to the stand-in for an unknown id', () => {
      expect(new SttRegistry([new MockSttProvider()], 'nonesuch').active().id).toBe('mock');
    });

    it('reports every provider in health, configured or not', async () => {
      const registry = new SttRegistry(
        [new MockSttProvider(), new GoogleSttProvider(undefined, 'm', 1_000)],
        'mock',
      );
      const health = await registry.healthAll();
      expect(health.map((h) => h.id).sort()).toEqual(['google', 'mock']);
      expect(health.find((h) => h.id === 'google')!.configured).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────── synthesis

  describe('synthesis', () => {
    const speaking = { ...DEFAULT_VOICE_PREFERENCES, speakReplies: true };

    function service(mock: MockTtsProvider) {
      return new TtsService(new TtsRegistry([mock], 'mock'), ttsConfig);
    }

    it('produces playable audio and marks it as a stand-in', async () => {
      const mock = new MockTtsProvider();
      const outcome = await service(mock).speak('Saved it.', speaking, 'en-IN');

      expect(outcome.spoken).toBe(true);
      if (!outcome.spoken) return;
      // A real WAV, not a stub buffer: anything downstream that parses
      // audio behaves as it would with a genuine file.
      expect(sniffContainer(outcome.speech.audio)).toBe('wav');
      expect(readWavProperties(outcome.speech.audio)!.durationMs).toBe(250);
      expect(outcome.speech.isMock).toBe(true);
      expect(mock.calls[0].text).toBe('Saved it.');
    });

    it('stays silent when the user has not asked for spoken replies', async () => {
      const mock = new MockTtsProvider();
      const outcome = await service(mock).speak('Saved it.', DEFAULT_VOICE_PREFERENCES, null);

      expect(outcome.spoken).toBe(false);
      if (outcome.spoken) return;
      expect(outcome.reason).toContain('turned off');
      // Nothing was asked of the provider at all.
      expect(mock.calls).toHaveLength(0);
    });

    it('declines an empty reply without calling the provider', async () => {
      const mock = new MockTtsProvider();
      const outcome = await service(mock).speak('   ', speaking, null);
      expect(outcome.spoken).toBe(false);
      expect(mock.calls).toHaveLength(0);
    });

    it('never throws, whatever the provider does', async () => {
      for (const [error, expected] of [
        [new TtsError('auth', 'mock', 'no key'), 'No speech service is configured.'],
        [new TtsError('timeout', 'mock', 'slow'), 'The speech service took too long.'],
        [new TtsError('rate_limited', 'mock', 'busy'), 'The speech service is busy.'],
        [new TtsError('unknown', 'mock', 'odd'), 'The reply could not be spoken.'],
      ] as const) {
        const mock = new MockTtsProvider().failWith(error);
        const outcome = await service(mock).speak('Here you go.', speaking, null);

        // The text reply is the product; speech is an enhancement. Every
        // failure is a reason string, never an exception.
        expect(outcome.spoken).toBe(false);
        if (outcome.spoken) continue;
        expect(outcome.reason).toBe(expected);
      }
    });

    it('survives a synthesiser that stalls', async () => {
      const mock = new MockTtsProvider().stallFor(30_000);
      const outcome = await service(mock).speak('Hello.', speaking, null);
      expect(outcome.spoken).toBe(false);
    }, 20_000);

    it('passes the chosen voice and rate through, where supported', async () => {
      const mock = new MockTtsProvider();
      await service(mock).speak('Hi.', { ...speaking, voiceId: 'nova', rate: 1.4 }, 'hi-IN');

      expect(mock.calls[0].voice).toBe('nova');
      expect(mock.calls[0].language).toBe('hi-IN');
    });

    it('offers a voice catalogue from whichever provider is active', () => {
      const catalogue = service(new MockTtsProvider()).catalogue();
      expect(catalogue.providerId).toBe('mock');
      expect(catalogue.isMock).toBe(true);
      expect(catalogue.voices.length).toBeGreaterThan(0);
    });
  });

  describe('synthesiser adapters', () => {
    it('expose the same interface and a usable voice list', () => {
      for (const provider of [
        new OpenAiTtsProvider('k', 'gpt-4o-mini-tts', 'alloy', 1_000),
        new GoogleTtsProvider('k', 1_000),
        new MockTtsProvider(),
      ]) {
        expect(typeof provider.synthesize).toBe('function');
        expect(provider.voices().length).toBeGreaterThan(0);
        for (const voice of provider.voices()) {
          expect(voice.languages.length).toBeGreaterThan(0);
        }
      }
    });

    it('keeps the speaking rate inside what providers accept', () => {
      expect(clampRate(5)).toBe(2);
      expect(clampRate(0.1)).toBe(0.5);
      expect(clampRate(1.25)).toBe(1.25);
    });

    it('offers Hindi and Indian-English voices where a voice is language-bound', () => {
      const languages = new GoogleTtsProvider('k', 1_000).voices().flatMap((v) => v.languages);
      expect(languages).toContain('hi-IN');
      expect(languages).toContain('en-IN');
    });

    it('does not select an unconfigured synthesiser', () => {
      const registry = new TtsRegistry(
        [new MockTtsProvider(), new OpenAiTtsProvider(undefined, 'm', 'alloy', 1_000)],
        'openai',
      );
      expect(registry.active().id).toBe('mock');
    });

    it('builds a silent WAV whose header matches its contents', () => {
      const audio = silentWav(1_000);
      const properties = readWavProperties(audio);
      expect(properties!.durationMs).toBe(1_000);
      expect(properties!.channels).toBe(1);
      // Silent on purpose: a tone could be mistaken for working synthesis.
      expect(audio.subarray(44).every((byte) => byte === 0)).toBe(true);
    });
  });

  // ───────────────────────────────────────────────── shared error layer

  describe('one error vocabulary across modalities', () => {
    it('maps transport status codes the same way everywhere', () => {
      expect(codeForStatus(401)).toBe('auth');
      expect(codeForStatus(429)).toBe('rate_limited');
      expect(codeForStatus(503)).toBe('unavailable');
      expect(codeForStatus(415)).toBe('invalid_audio');
      expect(codeForStatus(413)).toBe('invalid_audio');
      expect(codeForStatus(400)).toBe('invalid_request');
    });

    it('classifies retryable failures identically for speech and language', () => {
      expect(new SttError('timeout', 'x', 'm').retryable).toBe(true);
      expect(new TtsError('rate_limited', 'x', 'm').retryable).toBe(true);
      expect(new SttError('auth', 'x', 'm').retryable).toBe(false);
      expect(new SttError('invalid_audio', 'x', 'm').retryable).toBe(false);
    });

    it('keeps the subclasses distinguishable by type', () => {
      const stt = new SttError('timeout', 'x', 'm');
      expect(stt).toBeInstanceOf(SttError);
      expect(stt).toBeInstanceOf(ProviderError);
      expect(new TtsError('timeout', 'x', 'm')).not.toBeInstanceOf(SttError);
      expect(stt.name).toBe('SttError');
    });
  });

  // ──────────────────────────────────────────────────── preferences

  describe('voice preferences', () => {
    it('does not speak replies unless asked', () => {
      // Speech is something a user turns on, not something that starts
      // talking unprompted.
      expect(DEFAULT_VOICE_PREFERENCES.speakReplies).toBe(false);
      expect(DEFAULT_VOICE_PREFERENCES.audioRetention).toBe('DISCARD');
      expect(DEFAULT_VOICE_PREFERENCES.wakeWordEnabled).toBe(false);
    });

    it('reads a stored document', () => {
      const parsed = parseVoicePreferences({
        speakReplies: true,
        voiceId: 'nova',
        rate: 1.2,
        audioRetention: 'RETAIN',
        audioRetentionDays: 30,
      });
      expect(parsed.speakReplies).toBe(true);
      expect(parsed.voiceId).toBe('nova');
      expect(parsed.audioRetentionDays).toBe(30);
    });

    it('falls back to defaults for anything absent or absurd', () => {
      expect(parseVoicePreferences(null)).toEqual(DEFAULT_VOICE_PREFERENCES);
      expect(parseVoicePreferences('nonsense')).toEqual(DEFAULT_VOICE_PREFERENCES);
      expect(parseVoicePreferences({ rate: 99 }).rate).toBe(1);
      expect(parseVoicePreferences({ audioRetention: 'FOREVER' }).audioRetention).toBe('DISCARD');
    });

    it('keeps the valid parts of a document that has one bad field', () => {
      // A user who set a voice three releases ago keeps it even when
      // another field has since changed shape.
      const parsed = parseVoicePreferences({ speakReplies: true, voiceId: 'nova', rate: 'fast' });
      expect(parsed.speakReplies).toBe(true);
      expect(parsed.voiceId).toBe('nova');
      expect(parsed.rate).toBe(1);
    });
  });
});
