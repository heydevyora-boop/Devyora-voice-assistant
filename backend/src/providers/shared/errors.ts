/**
 * One error vocabulary for every external provider — language, speech
 * recognition, speech synthesis, and whatever comes next.
 *
 * Each adapter maps its own failures onto these codes, so retry policy,
 * logging and user-facing wording are written once rather than per vendor
 * and per modality.
 */
export type ProviderErrorCode =
  /** Credential missing, invalid or lacking permission. */
  | 'auth'
  /** Provider asked us to slow down. */
  | 'rate_limited'
  /** Exceeded our own deadline. */
  | 'timeout'
  /** Network failure before a response. */
  | 'unavailable'
  /** Provider rejected the request as malformed or too large. */
  | 'invalid_request'
  /** Response arrived but was not usable — unparsable or schema-invalid. */
  | 'invalid_output'
  /** The audio itself is the problem: wrong format, truncated, silent. */
  | 'invalid_audio'
  /** Provider refused on content grounds. */
  | 'content_filtered'
  | 'unknown';

/** Which failures are worth trying again. */
const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>([
  'rate_limited',
  'timeout',
  'unavailable',
]);

export interface ProviderErrorOptions {
  status?: number;
  retryAfterSeconds?: number;
  cause?: unknown;
}

/**
 * The base every provider error extends.
 *
 * Subclasses exist so a caller can tell a recognition failure from a
 * synthesis failure without inspecting strings, while the retry and timeout
 * helpers only ever need this shape.
 */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly providerId: string;
  readonly status?: number;
  /** Seconds the provider asked us to wait, when it said. */
  readonly retryAfterSeconds?: number;

  constructor(
    code: ProviderErrorCode,
    providerId: string,
    message: string,
    options: ProviderErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.providerId = providerId;
    this.status = options.status;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }
}

/** Maps an HTTP status onto the shared vocabulary. */
export function codeForStatus(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 413 || status === 415 || status === 422) return 'invalid_audio';
  if (status >= 500) return 'unavailable';
  if (status >= 400) return 'invalid_request';
  return 'unknown';
}
