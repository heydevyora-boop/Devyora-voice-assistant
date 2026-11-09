/**
 * Timeout and retry helpers, shared with the other provider modalities.
 *
 * Kept as a re-export so the language-model adapters import from beside
 * themselves, while there is only one implementation to reason about.
 */
export { DEFAULT_RETRY, withRetry, type RetryPolicy } from '../shared/reliability';

import { withTimeout as withTimeoutBase } from '../shared/reliability';
import { LlmError } from './errors';

/** `withTimeout`, raising an `LlmError` on expiry. */
export function withTimeout<T>(
  providerId: string,
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>,
  outerSignal?: AbortSignal,
): Promise<T> {
  return withTimeoutBase(
    providerId,
    timeoutMs,
    work,
    (id, message, cause) => new LlmError('timeout', id, message, { cause }),
    outerSignal,
  );
}
