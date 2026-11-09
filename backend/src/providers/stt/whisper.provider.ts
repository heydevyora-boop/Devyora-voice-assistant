import { SttError, codeForStatus } from './errors';
import { withTimeout } from './reliability';
import type { SttCapabilities, SttProvider, SttProviderHealth, SttRequest, SttResult } from './types';

/**
 * Whisper-compatible speech recognition.
 *
 * One adapter covers OpenAI's hosted endpoint and every self-hosted server
 * that speaks the same shape — faster-whisper-server, whisper.cpp's HTTP
 * mode, vLLM's audio endpoint — because `baseUrl` is configuration, not a
 * constant. Pointing `STT_BASE_URL` at a machine you run yourself is
 * therefore a deployment choice and needs no code change, which matters for
 * voice: the audio is the user's own speech.
 *
 * Language handling: Whisper auto-detects, and asking it for `verbose_json`
 * is what makes the detected language and the measured duration available.
 * Mixed Hindi–English in one utterance comes back as a single transcript
 * with one detected language, usually `hi` — the words are kept, the mix is
 * not labelled. That is reported as `codeSwitching: 'detected-as-one'`
 * rather than described as Hinglish support.
 */
export class WhisperSttProvider implements SttProvider {
  readonly id = 'whisper';
  readonly label = 'Whisper-compatible speech recognition';
  readonly kind = 'real' as const;

  readonly capabilities: SttCapabilities = {
    // The HTTP transcription endpoint is request/response. Whisper streaming
    // exists but not over this interface, so it is not claimed here.
    streaming: false,
    languageDetection: true,
    // Whisper returns segment-level log-probabilities, not a single
    // utterance confidence. Rather than derive a number that looks
    // authoritative, none is reported.
    confidence: false,
    mimeTypes: [
      'audio/webm',
      'audio/ogg',
      'audio/wav',
      'audio/x-wav',
      'audio/mpeg',
      'audio/mp4',
      'audio/m4a',
      'audio/flac',
    ],
    languages: ['*'],
    codeSwitching: 'detected-as-one',
  };

  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly model: string,
    private readonly defaultTimeoutMs: number,
    baseUrl: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /**
   * A hosted endpoint needs a key; a server you run yourself may not.
   * `configured` therefore depends on which one this is pointed at, so a
   * local Whisper is usable without inventing a credential for it.
   */
  get configured(): boolean {
    return Boolean(this.apiKey) || !isHostedOpenAi(this.baseUrl);
  }

  async transcribe(request: SttRequest): Promise<SttResult> {
    if (!this.configured) {
      throw new SttError('auth', this.id, 'No API key is configured for this endpoint.');
    }

    const form = new FormData();
    // The filename is server-generated and carries only the extension the
    // endpoint uses to pick a decoder. No user-supplied name reaches it.
    form.append('file', new Blob([new Uint8Array(request.audio)], { type: request.mimeType }), `audio${extensionFor(request.mimeType)}`);
    form.append('model', this.model);
    // Gives us `language` and `duration`; the default `json` gives neither.
    form.append('response_format', 'verbose_json');

    // Sent only when the client stated one. Forcing a language on an
    // utterance that might be in the other one makes recognition worse, so
    // an absent hint stays absent rather than defaulting to English.
    const hint = normaliseLanguage(request.languageHint);
    if (hint) form.append('language', hint);

    const payload = await withTimeout(
      this.id,
      request.timeoutMs || this.defaultTimeoutMs,
      async (signal) => {
        let response: Response;
        try {
          response = await fetch(`${this.baseUrl}/audio/transcriptions`, {
            method: 'POST',
            headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
            body: form,
            signal,
          });
        } catch (error) {
          if (signal.aborted) throw error;
          throw new SttError('unavailable', this.id, 'Could not reach the speech service.', {
            cause: error,
          });
        }

        if (!response.ok) {
          const retryAfter = Number(response.headers.get('retry-after'));
          // The body may quote the audio's content; it is not logged here.
          throw new SttError(
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
          return (await response.json()) as WhisperResponse;
        } catch (error) {
          throw new SttError('invalid_output', this.id, 'Speech service returned unparsable JSON.', {
            cause: error,
          });
        }
      },
      request.signal,
    );

    if (typeof payload.text !== 'string') {
      throw new SttError('invalid_output', this.id, 'Speech service returned no transcript field.');
    }

    return {
      text: payload.text.trim(),
      detectedLanguage: typeof payload.language === 'string' ? payload.language : null,
      confidence: null,
      durationMs:
        typeof payload.duration === 'number' && Number.isFinite(payload.duration)
          ? Math.round(payload.duration * 1000)
          : null,
      model: this.model,
    };
  }

  health(): Promise<SttProviderHealth> {
    // Reported without a network call: a readiness probe must not spend a
    // transcription quota, and there is no free endpoint that proves a
    // speech service will accept audio.
    return Promise.resolve({
      id: this.id,
      configured: this.configured,
      reachable: null,
      checkedAt: new Date().toISOString(),
      detail: this.configured
        ? `Configured against ${redactHost(this.baseUrl)}; not probed.`
        : 'No API key configured.',
    });
  }
}

interface WhisperResponse {
  text?: unknown;
  language?: unknown;
  duration?: unknown;
}

function isHostedOpenAi(baseUrl: string): boolean {
  return /(^|\.)openai\.com$/i.test(hostOf(baseUrl));
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return '';
  }
}

/** Host only, so a probe never echoes a path or a query that held a key. */
function redactHost(baseUrl: string): string {
  return hostOf(baseUrl) || 'an unparsable endpoint';
}

/**
 * Whisper wants a bare ISO-639-1 code, not a region. `hi-IN` becomes `hi`.
 * An unrecognisable hint is dropped rather than passed through, because a
 * rejected request is worse than auto-detection.
 */
export function normaliseLanguage(tag: string | null | undefined): string | null {
  if (!tag) return null;
  const primary = /^([a-z]{2,3})(?:[-_]|$)/i.exec(tag.trim());
  return primary ? primary[1].toLowerCase() : null;
}

/** The decoder hint in the filename. Never derived from client input. */
export function extensionFor(mimeType: string): string {
  switch (mimeType) {
    case 'audio/webm':
      return '.webm';
    case 'audio/ogg':
      return '.ogg';
    case 'audio/wav':
    case 'audio/x-wav':
      return '.wav';
    case 'audio/mpeg':
      return '.mp3';
    case 'audio/mp4':
    case 'audio/m4a':
      return '.m4a';
    case 'audio/flac':
      return '.flac';
    default:
      return '.bin';
  }
}
