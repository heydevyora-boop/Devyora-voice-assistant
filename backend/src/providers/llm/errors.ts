/**
 * One error vocabulary for every provider.
 *
 * Each adapter maps its own failures onto these, so retry policy, logging
 * and user-facing messages are written once rather than per vendor.
 */
export type LlmErrorCode =
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
  /** Provider refused on content grounds. */
  | 'content_filtered'
  | 'unknown';

/** Which failures are worth trying again. */
const RETRYABLE: ReadonlySet<LlmErrorCode> = new Set<LlmErrorCode>([
  'rate_limited',
  'timeout',
  'unavailable',
]);

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly providerId: string;
  readonly status?: number;
  /** Seconds the provider asked us to wait, when it said. */
  readonly retryAfterSeconds?: number;

  constructor(
    code: LlmErrorCode,
    providerId: string,
    message: string,
    options: { status?: number; retryAfterSeconds?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'LlmError';
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
export function codeForStatus(status: number): LlmErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  if (status === 400 || status === 404 || status === 422) return 'invalid_request';
  if (status >= 500) return 'unavailable';
  return 'unknown';
}
