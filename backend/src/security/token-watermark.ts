/**
 * Reconciles the one-second resolution of a JWT `iat` claim with the
 * millisecond resolution of a database timestamp.
 *
 * Without this the two never line up: a user created at 10:00:00.750 gets a
 * watermark of …750, while a token minted a moment later carries `iat`
 * 10:00:00 — which compares as *earlier* and rejects a token that was just
 * issued.
 *
 * The two directions are deliberately asymmetric, and both err towards
 * rejecting rather than admitting:
 *
 *  - `startOfSecond` is used when a watermark is established at account
 *    creation, so the first token issued in that same second is accepted.
 *  - `nextSecond` is used when revoking, so a token minted earlier in the
 *    same second is also rejected rather than slipping through.
 */

/** Floor to the second. For establishing a baseline. */
export function startOfSecond(at: Date = new Date()): Date {
  return new Date(Math.floor(at.getTime() / 1000) * 1000);
}

/** Ceil to the next second. For revocation, which must not under-reject. */
export function nextSecond(at: Date = new Date()): Date {
  return new Date((Math.floor(at.getTime() / 1000) + 1) * 1000);
}

/**
 * True when a token minted at `iat` (seconds since the epoch) predates the
 * watermark and must therefore be refused.
 */
export function isTokenStale(iat: number | undefined, watermark: Date): boolean {
  if (iat === undefined) return true;
  return iat * 1000 < watermark.getTime();
}
