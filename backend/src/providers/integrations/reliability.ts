/** Timeout and retry helpers, raising integration errors. */
export { DEFAULT_RETRY, withRetry, type RetryPolicy } from '../shared/reliability';

import type { ConnectionProvider } from '@prisma/client';
import { withTimeout as withTimeoutBase } from '../shared/reliability';
import { IntegrationError } from './errors';

export function withTimeout<T>(
  provider: ConnectionProvider,
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>,
  outerSignal?: AbortSignal,
): Promise<T> {
  return withTimeoutBase(
    provider,
    timeoutMs,
    work,
    (id, message, cause) =>
      new IntegrationError('timeout', id as ConnectionProvider, message, { cause }),
    outerSignal,
  );
}
