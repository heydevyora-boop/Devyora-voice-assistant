import { SttError, codeForStatus } from './errors';
import { withTimeout } from './reliability';
import type { SttCapabilities, SttProvider, SttProviderHealth, SttRequest, SttResult } from './types';

/**
 * Google Cloud Speech-to-Text.
 *
 * Included as a second real adapter because it approaches mixed-language
 * speech differently from Whisper, and the difference is worth having
 * available rather than hidden behind one choice: Google takes a primary
 * `languageCode` plus `alternativeLanguageCodes` and picks per utterance,
 * so Hindi–English switching is handled by listing both. It reports a
 * confidence score; Whisper does not.
 *
 * The API key travels in the `X-Goog-Api-Key` header, never in the query
 * string, so it cannot end up in an access log or a proxy trace.
 */
export class GoogleSttProvider implements SttProvider {
  readonly id = 'google';
  readonly label = 'Google Cloud Speech-to-Text';
  readonly kind = 'real' as const;

  readonly capabilities: SttCapabilities = {
    // The v1 `speech:recognize` method used here is request/response.
    // Google's streaming method is a separate bidirectional interface and
    // is not wired up, so it is not advertised.
    streaming: false,
    languageDetection: true,
    confidence: true,
    // Google infers the codec from the container for these; `encoding` is
    // left unset so it is not asserted wrongly.
    mimeTypes: ['audio/webm', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/flac', 'audio/mpeg'],
    languages: ['hi-IN', 'en-IN', 'en-US', 'en-GB'],
    codeSwitching: 'alternatives',
  };

  constructor(
    private readonly apiKey: string | undefined,
    private readonly model: string,
    private readonly defaultTimeoutMs: number,
  ) {}

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  async transcribe(request: SttRequest): Promise<SttResult> {
    if (!this.configured) {
      throw new SttError('auth', this.id, 'No Google Speech API key is configured.');
    }

    const primary = request.languageHint?.trim() || 'en-IN';
    // Both scripts offered, so a sentence that switches mid-way is still
    // recognised instead of being forced into one language.
    const alternatives = ['hi-IN', 'en-IN'].filter((tag) => tag !== primary);

    const payload = await withTimeout(
      this.id,
      request.timeoutMs || this.defaultTimeoutMs,
      async (signal) => {
        let response: Response;
        try {
          response = await fetch('https://speech.googleapis.com/v1/speech:recognize', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              // Header, not a query parameter: a URL ends up in logs.
              'X-Goog-Api-Key': this.apiKey!,
            },
            body: JSON.stringify({
              config: {
                languageCode: primary,
                alternativeLanguageCodes: alternatives,
                model: this.model,
                enableAutomaticPunctuation: true,
                // Only the best transcript is wanted; alternatives would be
                // more data about the user's speech for no benefit here.
                maxAlternatives: 1,
                profanityFilter: false,
              },
              audio: { content: request.audio.toString('base64') },
            }),
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
          return (await response.json()) as GoogleResponse;
        } catch (error) {
          throw new SttError('invalid_output', this.id, 'Speech service returned unparsable JSON.', {
            cause: error,
          });
        }
      },
      request.signal,
    );

    const results = Array.isArray(payload.results) ? payload.results : [];
    // Google splits long audio into results; one utterance is the join.
    const parts: string[] = [];
    const confidences: number[] = [];
    let language: string | null = null;

    for (const result of results) {
      const best = result?.alternatives?.[0];
      if (best && typeof best.transcript === 'string') parts.push(best.transcript.trim());
      if (best && typeof best.confidence === 'number') confidences.push(best.confidence);
      if (!language && typeof result?.languageCode === 'string') language = result.languageCode;
    }

    // An empty result set means nothing was recognised. That is a real
    // outcome and is returned as empty text, not as a failure, so the
    // caller can tell the user nothing was heard.
    return {
      text: parts.join(' ').trim(),
      detectedLanguage: language,
      confidence: confidences.length
        ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
        : null,
      // v1 does not report audio length.
      durationMs: null,
      model: this.model,
    };
  }

  health(): Promise<SttProviderHealth> {
    return Promise.resolve({
      id: this.id,
      configured: this.configured,
      reachable: null,
      checkedAt: new Date().toISOString(),
      detail: this.configured ? 'API key configured; not probed.' : 'No API key configured.',
    });
  }
}

interface GoogleResponse {
  results?: {
    languageCode?: unknown;
    alternatives?: { transcript?: unknown; confidence?: unknown }[];
  }[];
}
