/** Timeout and retry helpers, raising speech-recognition errors. */
export { DEFAULT_RETRY, withRetry, type RetryPolicy } from '../shared/reliability';

import { withTimeout as withTimeoutBase } from '../shared/reliability';
import { SttError } from './errors';

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
    (id, message, cause) => new SttError('timeout', id, message, { cause }),
    outerSignal,
  );
}
