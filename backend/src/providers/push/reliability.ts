/** Timeout and retry helpers, raising push errors. */
export { DEFAULT_RETRY, withRetry, type RetryPolicy } from '../shared/reliability';

import { withTimeout as withTimeoutBase } from '../shared/reliability';
import { PushError } from './errors';

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
    (id, message, cause) => new PushError('timeout', id, message, { cause }),
    outerSignal,
  );
}
