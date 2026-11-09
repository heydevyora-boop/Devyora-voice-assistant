import { DevicePlatform } from '@prisma/client';
import { PushError } from './errors';
import { withTimeout } from './reliability';
import type { PushMessage, PushProvider, PushProviderHealth, PushResult, PushTarget } from './types';

/**
 * A deterministic stand-in for push delivery.
 *
 * It records what it was asked to send and sends nothing. That is the point:
 * a notification pipeline is exactly the sort of thing where a stand-in
 * could quietly become "it worked", so every result it produces carries
 * `isMock` upward and the notification row records which provider accepted
 * it. A notification accepted here is never presented as delivered.
 */
export class MockPushProvider implements PushProvider {
  readonly id = 'mock';
  readonly label = 'Recorded test transport';
  readonly kind = 'mock' as const;
  readonly configured = true;
  readonly platforms: readonly DevicePlatform[] = [
    DevicePlatform.ANDROID,
    DevicePlatform.IOS,
    DevicePlatform.MACOS,
    DevicePlatform.WINDOWS,
    DevicePlatform.WEB,
  ];

  /** Everything it was asked to send, for assertions. */
  readonly sent: { message: PushMessage; target: PushTarget }[] = [];

  private failure: PushError | null = null;
  private delayMs = 0;
  /** Fails this many times before succeeding, to exercise retries. */
  private failuresRemaining = 0;

  failWith(error: PushError | null): this {
    this.failure = error;
    return this;
  }

  /** Fail the next `times` attempts, then behave. */
  failTimes(times: number, error: PushError): this {
    this.failuresRemaining = times;
    this.failure = error;
    return this;
  }

  stallFor(ms: number): this {
    this.delayMs = ms;
    return this;
  }

  reset(): this {
    this.failure = null;
    this.failuresRemaining = 0;
    this.delayMs = 0;
    this.sent.length = 0;
    return this;
  }

  send(message: PushMessage, target: PushTarget, timeoutMs: number): Promise<PushResult> {
    if (this.failure) {
      if (this.failuresRemaining > 0) {
        this.failuresRemaining -= 1;
        if (this.failuresRemaining === 0) this.failure = null;
      }
      return Promise.reject(this.failure ?? new PushError('unavailable', this.id, 'transient'));
    }

    return withTimeout(this.id, timeoutMs || 5_000, async (signal) => {
      if (this.delayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, this.delayMs);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new PushError('timeout', this.id, 'Aborted while stalling.'));
            },
            { once: true },
          );
        });
      }

      this.sent.push({ message, target });
      return { providerRef: `mock-${this.sent.length}`, accepted: true as const };
    });
  }

  health(): Promise<PushProviderHealth> {
    return Promise.resolve({
      id: this.id,
      configured: true,
      reachable: true,
      checkedAt: new Date().toISOString(),
      detail: 'Deterministic stand-in. Records messages; delivers nothing.',
    });
  }
}
