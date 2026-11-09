/**
 * The speech-synthesis contract.
 *
 * Hand over text, get back audio bytes and the metadata needed to play
 * them. Voice choice and language are inputs, not provider internals, so a
 * user preference maps onto any adapter.
 */

export interface TtsVoice {
  readonly id: string;
  readonly label: string;
  /** BCP-47 tags this voice is suitable for. */
  readonly languages: readonly string[];
  readonly gender: 'female' | 'male' | 'neutral';
}

export interface TtsCapabilities {
  /** Whether the provider can return audio progressively. */
  readonly streaming: boolean;
  readonly mimeTypes: readonly string[];
  readonly languages: readonly string[];
  /** Whether speaking rate can be set. */
  readonly rate: boolean;
}

export interface TtsRequest {
  readonly text: string;
  /** Voice id, as advertised by the provider. Falls back to its default. */
  readonly voice?: string | null;
  /** BCP-47 tag, usually whatever the recogniser detected. */
  readonly language?: string | null;
  /** 0.5–2.0 where supported. */
  readonly rate?: number | null;
  readonly mimeType?: string | null;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface TtsAudio {
  readonly audio: Buffer;
  readonly mimeType: string;
  /** Length where the provider reports one; null rather than estimated. */
  readonly durationMs: number | null;
  readonly voice: string;
  readonly model: string;
}

export interface TtsProviderHealth {
  readonly id: string;
  readonly configured: boolean;
  readonly reachable: boolean | null;
  readonly checkedAt: string;
  readonly detail: string;
}

export interface TtsProvider {
  readonly id: string;
  readonly label: string;
  readonly kind: 'real' | 'mock';
  readonly configured: boolean;
  readonly capabilities: TtsCapabilities;
  voices(): readonly TtsVoice[];

  synthesize(request: TtsRequest): Promise<TtsAudio>;
  health(): Promise<TtsProviderHealth>;
}

export const TTS_PROVIDER = Symbol('TTS_PROVIDER');
