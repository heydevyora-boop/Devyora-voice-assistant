import { TtsError, codeForStatus } from './errors';
import { withTimeout } from './reliability';
import type {
  TtsAudio,
  TtsCapabilities,
  TtsProvider,
  TtsProviderHealth,
  TtsRequest,
  TtsVoice,
} from './types';

/** The voices this endpoint offers. Multilingual, so one set covers both. */
const VOICES: readonly TtsVoice[] = [
  { id: 'alloy', label: 'Alloy', languages: ['*'], gender: 'neutral' },
  { id: 'echo', label: 'Echo', languages: ['*'], gender: 'male' },
  { id: 'fable', label: 'Fable', languages: ['*'], gender: 'neutral' },
  { id: 'onyx', label: 'Onyx', languages: ['*'], gender: 'male' },
  { id: 'nova', label: 'Nova', languages: ['*'], gender: 'female' },
  { id: 'shimmer', label: 'Shimmer', languages: ['*'], gender: 'female' },
];

/**
 * OpenAI speech synthesis.
 *
 * The model reads the text in whatever language it is written in, so no
 * language parameter is sent: a Hindi reply is spoken as Hindi because the
 * characters are Hindi. Hinglish written in Latin script is read as
 * English-accented Hindi, which is what a person reading it aloud does too.
 */
export class OpenAiTtsProvider implements TtsProvider {
  readonly id = 'openai';
  readonly label = 'OpenAI speech';
  readonly kind = 'real' as const;

  readonly capabilities: TtsCapabilities = {
    // The endpoint streams, but this adapter buffers: a reply is a sentence
    // or two, and a complete file is simpler for every client to play.
    // Progressive delivery arrives with the streaming transport.
    streaming: false,
    mimeTypes: ['audio/mpeg', 'audio/opus', 'audio/aac', 'audio/flac', 'audio/wav'],
    languages: ['*'],
    rate: true,
  };

  constructor(
    private readonly apiKey: string | undefined,
    private readonly model: string,
    private readonly defaultVoice: string,
    private readonly defaultTimeoutMs: number,
  ) {}

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  voices(): readonly TtsVoice[] {
    return VOICES;
  }

  async synthesize(request: TtsRequest): Promise<TtsAudio> {
    if (!this.configured) {
      throw new TtsError('auth', this.id, 'No API key is configured for speech synthesis.');
    }

    const voice = pickVoice(request.voice, this.defaultVoice);
    const mimeType = request.mimeType && this.capabilities.mimeTypes.includes(request.mimeType)
      ? request.mimeType
      : 'audio/mpeg';

    const audio = await withTimeout(
      this.id,
      request.timeoutMs || this.defaultTimeoutMs,
      async (signal) => {
        let response: Response;
        try {
          response = await fetch('https://api.openai.com/v1/audio/speech', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.apiKey!}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: this.model,
              input: request.text,
              voice,
              response_format: formatFor(mimeType),
              ...(request.rate ? { speed: clampRate(request.rate) } : {}),
            }),
            signal,
          });
        } catch (error) {
          if (signal.aborted) throw error;
          throw new TtsError('unavailable', this.id, 'Could not reach the speech service.', {
            cause: error,
          });
        }

        if (!response.ok) {
          const retryAfter = Number(response.headers.get('retry-after'));
          throw new TtsError(
            codeForStatus(response.status),
            this.id,
            `Speech service returned ${response.status}.`,
            {
              status: response.status,
              retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : undefined,
            },
          );
        }

        return Buffer.from(await response.arrayBuffer());
      },
      request.signal,
    );

    if (audio.byteLength === 0) {
      throw new TtsError('invalid_output', this.id, 'Speech service returned no audio.');
    }

    return {
      audio,
      mimeType,
      // Not reported by the endpoint, and deliberately not estimated: a
      // made-up duration in metadata is worse than its absence.
      durationMs: null,
      voice,
      model: this.model,
    };
  }

  health(): Promise<TtsProviderHealth> {
    return Promise.resolve({
      id: this.id,
      configured: this.configured,
      reachable: null,
      checkedAt: new Date().toISOString(),
      detail: this.configured ? 'API key configured; not probed.' : 'No API key configured.',
    });
  }
}

function pickVoice(requested: string | null | undefined, fallback: string): string {
  const match = VOICES.find((v) => v.id === requested);
  if (match) return match.id;
  return VOICES.some((v) => v.id === fallback) ? fallback : VOICES[0].id;
}

function formatFor(mimeType: string): string {
  switch (mimeType) {
    case 'audio/opus':
      return 'opus';
    case 'audio/aac':
      return 'aac';
    case 'audio/flac':
      return 'flac';
    case 'audio/wav':
      return 'wav';
    default:
      return 'mp3';
  }
}

export function clampRate(rate: number): number {
  return Math.min(2, Math.max(0.5, rate));
}
