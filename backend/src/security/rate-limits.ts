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

  /// An assistant turn costs a provider call, so this ceiling is about
  /// spend as much as abuse: generous for a person talking, far below what
  /// a script could run up.
  assistantTurn: { ttl: 60_000, limit: scale(30) },
  assistantDecision: { ttl: 60_000, limit: scale(60) },

  /// Opening a session is cheap; the work happens later.
  voiceSessionStart: { ttl: 60_000, limit: scale(60) },
  /// A turn costs an interpretation. Same reasoning as assistantTurn.
  voiceTurn: { ttl: 60_000, limit: scale(30) },
  /// An upload costs a transcription as well, and moves real bytes, so it
  /// is the tightest ceiling here.
  voiceAudioUpload: { ttl: 60_000, limit: scale(20) },

  /// Executing has a real effect, so the ceiling is tight. It is not the
  /// duplicate guard — that is the idempotency key — but it bounds how fast
  /// a compromised client could work through a list of proposals.
  actionExecute: { ttl: 60_000, limit: scale(30) },

  /// Sync is chatty by nature — a device catching up pulls repeatedly — so
  /// these are generous. The batch size limit is the real bound on work.
  syncPull: { ttl: 60_000, limit: scale(120) },
  syncPush: { ttl: 60_000, limit: scale(60) },

  /// Starting an OAuth flow writes a state row and is a step a person takes
  /// deliberately, so the ceiling is low — it also bounds how fast someone
  /// could probe callbacks.
  integrationAuthorize: { ttl: 60_000, limit: scale(10) },
  /// A provider operation costs an upstream call and may be rate-limited
  /// there too, so this sits below what most providers allow.
  integrationOperation: { ttl: 60_000, limit: scale(30) },
} as const;

/** A deliberately tiny limit the rate-limit test can target. */
export const PROBE_LIMIT = { ttl: 60_000, limit: 3 } as const;
