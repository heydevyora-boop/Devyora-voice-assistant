/**
 * The speech-recognition contract.
 *
 * Deliberately narrow: hand over bytes, get back a transcript. Audio
 * validation, temporary storage, cleanup and session state all live above
 * this layer, so adding a vendor is one file and does not touch any of them.
 */

/** What a provider can actually do. Advertised, not assumed. */
export interface SttCapabilities {
  /** Whether the provider exposes an incremental/streaming interface. */
  readonly streaming: boolean;
  /**
   * Whether the provider reports which language it heard. When false the
   * detected language stays null rather than being filled in with the hint
   * the client sent — an echoed guess is not a detection.
   */
  readonly languageDetection: boolean;
  /** Whether the provider reports a confidence score. */
  readonly confidence: boolean;
  /** Container/codec types this provider accepts, as MIME types. */
  readonly mimeTypes: readonly string[];
  /**
   * BCP-47 tags the provider documents support for. `['*']` means the
   * provider auto-detects across its whole language set.
   */
  readonly languages: readonly string[];
  /**
   * Whether mixed Hindi–English speech in one utterance is handled, and
   * how. Stated per provider because it varies and must not be promised
   * generically.
   */
  readonly codeSwitching: 'none' | 'detected-as-one' | 'alternatives';
}

export interface SttRequest {
  readonly audio: Buffer;
  readonly mimeType: string;
  /**
   * BCP-47 hint from the client, e.g. `hi-IN`. Advisory: a provider may
   * detect something else, and what it detected wins.
   */
  readonly languageHint?: string | null;
  readonly timeoutMs: number;
  /** Cancellation from the caller — a user who pressed cancel. */
  readonly signal?: AbortSignal;
}

export interface SttResult {
  /** The transcript. May be empty when nothing was said. */
  readonly text: string;
  /** What the provider detected, or null when it does not report one. */
  readonly detectedLanguage: string | null;
  /** 0–1, or null when the provider does not report one. */
  readonly confidence: number | null;
  /** Audio length as the provider measured it, or null. */
  readonly durationMs: number | null;
  readonly model: string;
}

export interface SttProviderHealth {
  readonly id: string;
  readonly configured: boolean;
  readonly reachable: boolean | null;
  readonly checkedAt: string;
  readonly detail: string;
}

export interface SttProvider {
  readonly id: string;
  readonly label: string;
  readonly kind: 'real' | 'mock';
  /** False when no credential is present. The registry will not select it. */
  readonly configured: boolean;
  readonly capabilities: SttCapabilities;

  transcribe(request: SttRequest): Promise<SttResult>;
  health(): Promise<SttProviderHealth>;
}

export const STT_PROVIDER = Symbol('STT_PROVIDER');
