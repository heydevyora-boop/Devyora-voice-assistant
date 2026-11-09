import { TtsError, codeForStatus } from './errors';
import { withTimeout } from './reliability';
import { clampRate } from './openai.provider';
import type {
  TtsAudio,
  TtsCapabilities,
  TtsProvider,
  TtsProviderHealth,
  TtsRequest,
  TtsVoice,
} from './types';

/**
 * A small, named set rather than the full catalogue.
 *
 * Google publishes hundreds of voices; listing them all would make the
 * preference screen unusable and would need a network call to stay
 * accurate. These are the Indian-English and Hindi neural voices, which is
 * what this assistant actually speaks.
 */
const VOICES: readonly TtsVoice[] = [
  { id: 'en-IN-Neural2-A', label: 'Indian English — A', languages: ['en-IN'], gender: 'female' },
  { id: 'en-IN-Neural2-B', label: 'Indian English — B', languages: ['en-IN'], gender: 'male' },
  { id: 'hi-IN-Neural2-A', label: 'Hindi — A', languages: ['hi-IN'], gender: 'female' },
  { id: 'hi-IN-Neural2-B', label: 'Hindi — B', languages: ['hi-IN'], gender: 'male' },
];

/**
 * Google Cloud Text-to-Speech.
 *
 * Unlike the OpenAI endpoint, a voice here is tied to a language, so the
 * detected language picks the voice when the user has not chosen one. That
 * is the reason both adapters exist: the preference layer above expresses
 * the same choice against two different models of what a "voice" is.
 */
export class GoogleTtsProvider implements TtsProvider {
  readonly id = 'google';
  readonly label = 'Google Cloud Text-to-Speech';
  readonly kind = 'real' as const;

  readonly capabilities: TtsCapabilities = {
    streaming: false,
    mimeTypes: ['audio/mpeg', 'audio/wav', 'audio/ogg'],
    languages: ['en-IN', 'hi-IN'],
    rate: true,
  };

  constructor(
    private readonly apiKey: string | undefined,
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
      throw new TtsError('auth', this.id, 'No Google TTS API key is configured.');
    }

    const voice = pickVoice(request.voice, request.language);
    const mimeType = request.mimeType && this.capabilities.mimeTypes.includes(request.mimeType)
      ? request.mimeType
      : 'audio/mpeg';

    const payload = await withTimeout(
      this.id,
      request.timeoutMs || this.defaultTimeoutMs,
      async (signal) => {
        let response: Response;
        try {
          response = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Goog-Api-Key': this.apiKey!,
            },
            body: JSON.stringify({
              input: { text: request.text },
              voice: { languageCode: voice.languages[0], name: voice.id },
              audioConfig: {
                audioEncoding: encodingFor(mimeType),
                ...(request.rate ? { speakingRate: clampRate(request.rate) } : {}),
              },
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

        try {
          return (await response.json()) as { audioContent?: unknown };
        } catch (error) {
          throw new TtsError('invalid_output', this.id, 'Speech service returned unparsable JSON.', {
            cause: error,
          });
        }
      },
      request.signal,
    );

    if (typeof payload.audioContent !== 'string' || !payload.audioContent) {
      throw new TtsError('invalid_output', this.id, 'Speech service returned no audio.');
    }

    return {
      audio: Buffer.from(payload.audioContent, 'base64'),
      mimeType,
      durationMs: null,
      voice: voice.id,
      model: 'google-neural2',
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

/**
 * The user's chosen voice wins. Otherwise the detected language picks one,
 * which is why a Hindi reply is not read out in an English voice.
 */
function pickVoice(requested: string | null | undefined, language: string | null | undefined): TtsVoice {
  const exact = VOICES.find((v) => v.id === requested);
  if (exact) return exact;

  const primary = language?.slice(0, 2).toLowerCase();
  const byLanguage = VOICES.find((v) => v.languages[0].slice(0, 2).toLowerCase() === primary);
  return byLanguage ?? VOICES[0];
}

function encodingFor(mimeType: string): string {
  switch (mimeType) {
    case 'audio/wav':
      return 'LINEAR16';
    case 'audio/ogg':
      return 'OGG_OPUS';
    default:
      return 'MP3';
  }
}
