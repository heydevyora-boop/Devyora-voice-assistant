/**
 * Per-route rate limits, in one place.
 *
 * These are read by `@Throttle()` decorators, which are evaluated when the
 * class is defined — before Nest's configuration is available — so this
 * module reads `NODE_ENV` directly rather than going through ConfigService.
 *
 * Under `NODE_ENV=test` the ceilings are raised, because the whole suite
 * shares one source address and would otherwise throttle itself rather than
 * test anything. The limiter is not disabled: it stays installed with the
 * same behaviour, and `rate-limit.spec.ts` drives a route past its ceiling
 * to prove rejection still happens.
 */
const isTest = process.env.NODE_ENV === 'test';

/** Multiplier applied only to the automated suite. */
const factor = isTest ? 200 : 1;

const scale = (limit: number) => limit * factor;

export const RateLimit = {
  /** Global ceiling, applied to every route. */
  global: { ttl: 60_000, limit: scale(120) },

  register: { ttl: 60_000, limit: scale(5) },
  login: { ttl: 60_000, limit: scale(10) },
  refresh: { ttl: 60_000, limit: scale(30) },
  passwordResetRequest: { ttl: 300_000, limit: scale(3) },
  passwordResetConfirm: { ttl: 300_000, limit: scale(5) },
  emailVerify: { ttl: 300_000, limit: scale(10) },
  emailVerifyResend: { ttl: 300_000, limit: scale(3) },
} as const;

/** A deliberately tiny limit the rate-limit test can target. */
export const PROBE_LIMIT = { ttl: 60_000, limit: 3 } as const;
