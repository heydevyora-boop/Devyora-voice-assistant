import { Logger } from '@nestjs/common';
import { LlmError } from './errors';

export interface RetryPolicy {
  /** Total attempts, including the first. 1 disables retrying. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 400, maxDelayMs: 4_000 };

const logger = new Logger('LlmReliability');

/**
 * Runs an operation with a deadline the provider cannot overrun.
 *
 * The abort signal is passed down so a slow provider's socket is actually
 * closed, rather than left running while the caller has already given up.
 */
export async function withTimeout<T>(
  providerId: string,
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>,
  outerSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  outerSignal?.addEventListener('abort', onOuterAbort, { once: true });

  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await work(controller.signal);
  } catch (error) {
    if (controller.signal.aborted && !outerSignal?.aborted) {
      throw new LlmError('timeout', providerId, `Provider did not respond within ${timeoutMs}ms.`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * Retries an operation that is safe to repeat.
 *
 * Only failures classified as retryable are tried again — a bad credential
 * or a malformed request will fail identically however many times it is
 * sent, and retrying them only burns quota.
 *
 * The caller is responsible for only wrapping idempotent work. Generating a
 * completion is idempotent in the sense that matters here: it reads, and a
 * discarded attempt leaves nothing behind. Anything that writes, sends or
 * charges is not retried at this layer.
 */
export async function withRetry<T>(
  policy: RetryPolicy,
  work: (attempt: number) => Promise<T>,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      return await work(attempt);
    } catch (error) {
      lastError = error;

      const retryable = error instanceof LlmError && error.retryable;
      if (!retryable || attempt === policy.maxAttempts) break;

      // Honour the provider's own backoff hint when it gives one.
      const hinted = error instanceof LlmError ? error.retryAfterSeconds : undefined;
      const backoff = hinted
        ? hinted * 1000
        : Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
      // Jitter, so concurrent callers do not retry in lockstep.
      const delay = backoff + Math.floor(Math.random() * 200);

      logger.warn(
        `Attempt ${attempt} failed (${error instanceof LlmError ? error.code : 'unknown'}); ` +
          `retrying in ${delay}ms`,
      );
      await sleep(delay);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
