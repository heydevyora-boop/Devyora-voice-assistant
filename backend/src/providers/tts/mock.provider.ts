import { TtsError } from './errors';
import { withTimeout } from './reliability';
import type {
  TtsAudio,
  TtsCapabilities,
  TtsProvider,
  TtsProviderHealth,
  TtsRequest,
  TtsVoice,
} from './types';

const VOICES: readonly TtsVoice[] = [
  { id: 'mock-neutral', label: 'Test voice', languages: ['*'], gender: 'neutral' },
];

/**
 * A deterministic stand-in for speech synthesis.
 *
 * It produces a valid, silent WAV file of a fixed length. Silent on
 * purpose: a stand-in that played a tone could be mistaken for working
 * synthesis, and a client that receives this gets `isMock: true` alongside
 * it so it can say the reply is not actually spoken.
 */
export class MockTtsProvider implements TtsProvider {
  readonly id = 'mock';
  readonly label = 'Silent test synthesiser';
  readonly kind = 'mock' as const;
  readonly configured = true;

  readonly capabilities: TtsCapabilities = {
    streaming: false,
    mimeTypes: ['audio/wav'],
    languages: ['*'],
    rate: false,
  };

  readonly calls: { text: string; voice: string | null; language: string | null }[] = [];

  private failure: TtsError | null = null;
  private delayMs = 0;

  failWith(error: TtsError | null): this {
    this.failure = error;
    return this;
  }

  stallFor(ms: number): this {
    this.delayMs = ms;
    return this;
  }

  reset(): this {
    this.failure = null;
    this.delayMs = 0;
    this.calls.length = 0;
    return this;
  }

  voices(): readonly TtsVoice[] {
    return VOICES;
  }

  synthesize(request: TtsRequest): Promise<TtsAudio> {
    this.calls.push({
      text: request.text,
      voice: request.voice ?? null,
      language: request.language ?? null,
    });

    if (this.failure) return Promise.reject(this.failure);

    return withTimeout(
      this.id,
      request.timeoutMs || 5_000,
      (signal) => this.respond(signal),
      request.signal,
    );
  }

  private async respond(signal: AbortSignal): Promise<TtsAudio> {
    if (this.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new TtsError('timeout', this.id, 'Aborted while stalling.'));
          },
          { once: true },
        );
      });
    }

    return {
      audio: silentWav(250),
      mimeType: 'audio/wav',
      // Known exactly here, because this adapter generated the file.
      durationMs: 250,
      voice: VOICES[0].id,
      model: 'mock-tts-1',
    };
  }

  health(): Promise<TtsProviderHealth> {
    return Promise.resolve({
      id: this.id,
      configured: true,
      reachable: true,
      checkedAt: new Date().toISOString(),
      detail: 'Deterministic stand-in. Produces silence; nothing is spoken.',
    });
  }
}

/**
 * A real, playable WAV: 8 kHz, mono, 16-bit, all zero samples.
 *
 * Built properly rather than returned as a stub buffer, so anything
 * downstream that parses audio — the validator, a client's player — behaves
 * the way it would with a genuine file.
 */
export function silentWav(durationMs: number): Buffer {
  const sampleRate = 8_000;
  const samples = Math.round((sampleRate * durationMs) / 1000);
  const dataBytes = samples * 2;

  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  // The sample region is already zero-filled by Buffer.alloc.
  return buffer;
}
