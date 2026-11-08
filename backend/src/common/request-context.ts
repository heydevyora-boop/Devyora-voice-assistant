import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestContext {
  readonly correlationId: string;
  /** Populated by the auth guard once authentication exists. */
  userId?: string;
  deviceId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Per-request context, carried without threading an argument through every
 * signature. Logging, auditing and error responses all read the same
 * correlation id, so one identifier ties a log line to a response body.
 */
export const requestContext = {
  run<T>(context: RequestContext, fn: () => T): T {
    return storage.run(context, fn);
  },
  get(): RequestContext | undefined {
    return storage.getStore();
  },
  correlationId(): string {
    return storage.getStore()?.correlationId ?? 'no-context';
  },
  /** Attaches identity once a guard has resolved it. */
  setPrincipal(userId: string, deviceId?: string): void {
    const store = storage.getStore();
    if (store) {
      (store as { userId?: string }).userId = userId;
      (store as { deviceId?: string }).deviceId = deviceId;
    }
  },
  newCorrelationId(): string {
    return randomUUID();
  },
};
