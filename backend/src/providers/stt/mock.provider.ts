import { SttError } from './errors';
import { withTimeout } from './reliability';
import type { SttCapabilities, SttProvider, SttProviderHealth, SttRequest, SttResult } from './types';

export interface MockSttScript {
  /** Matched against the declared MIME type, or against the audio's bytes. */
  readonly match: (request: SttRequest) => boolean;
  readonly result: Partial<SttResult> & { text: string };
}

/**
 * A deterministic stand-in for speech recognition.
 *
 * It does not recognise anything. It returns text a test asked it to
 * return, so a failure means the pipeline is wrong rather than the weather
 * at a vendor, and so the voice flow can be exercised before any speech
 * credential exists.
 *
 * It reports `kind: 'mock'`, and the voice service passes that through to
 * every response and event, so a transcript produced here is never
 * presented as something that was heard. There is no path by which this
 * becomes a fallback recogniser: unscripted audio yields empty text, which
 * the pipeline reports as nothing heard.
 */
export class MockSttProvider implements SttProvider {
  readonly id = 'mock';
  readonly label = 'Scripted test transcript';
  readonly kind = 'mock' as const;
  readonly configured = true;

  readonly capabilities: SttCapabilities = {
    streaming: true,
    languageDetection: true,
    confidence: true,
    mimeTypes: ['audio/webm', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp4', 'audio/m4a', 'audio/flac'],
    languages: ['*'],
    codeSwitching: 'detected-as-one',
  };

  /** Requests recorded for assertions. Audio is kept by length only. */
  readonly calls: { mimeType: string; bytes: number; languageHint: string | null }[] = [];

  private scripts: MockSttScript[] = [];
  private failure: SttError | null = null;
  private delayMs = 0;

  /** Queue a transcript for requests the predicate accepts. */
  script(match: (request: SttRequest) => boolean, result: Partial<SttResult> & { text: string }): this {
    this.scripts.push({ match, result });
    return this;
  }

  /** Queue a transcript for every request. */
  alwaysReturn(text: string, extra: Partial<SttResult> = {}): this {
    return this.script(() => true, { text, ...extra });
  }

  failWith(error: SttError | null): this {
    this.failure = error;
    return this;
  }

  /** Stall, to exercise the timeout. */
  stallFor(ms: number): this {
    this.delayMs = ms;
    return this;
  }

  reset(): this {
    this.scripts = [];
    this.failure = null;
    this.delayMs = 0;
    this.calls.length = 0;
    return this;
  }

  transcribe(request: SttRequest): Promise<SttResult> {
    this.calls.push({
      mimeType: request.mimeType,
      bytes: request.audio.byteLength,
      languageHint: request.languageHint ?? null,
    });

    if (this.failure) return Promise.reject(this.failure);

    // Enforcing the configured deadline is part of the contract, so the
    // stand-in does it too: a mock that ignored `timeoutMs` would let a
    // timeout bug ship, because the suite would wait where production
    // would not.
    return withTimeout(
      this.id,
      request.timeoutMs || 5_000,
      (signal) => this.respond(request, signal),
      request.signal,
    );
  }

  private async respond(request: SttRequest, signal: AbortSignal): Promise<SttResult> {
    if (this.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new SttError('timeout', this.id, 'Aborted while stalling.'));
          },
          { once: true },
        );
      });
    }

    const matched = this.scripts.find((s) => s.match(request));

    return {
      text: matched?.result.text ?? '',
      detectedLanguage: matched?.result.detectedLanguage ?? request.languageHint ?? null,
      confidence: matched?.result.confidence ?? (matched ? 0.95 : null),
      durationMs: matched?.result.durationMs ?? null,
      model: matched?.result.model ?? 'mock-stt-1',
    };
  }

  health(): Promise<SttProviderHealth> {
    return Promise.resolve({
      id: this.id,
      configured: true,
      reachable: true,
      checkedAt: new Date().toISOString(),
      detail: 'Deterministic stand-in. No network, and no speech is recognised.',
    });
  }
}
