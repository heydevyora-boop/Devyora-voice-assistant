import type { CookieOptions, Request, Response } from 'express';

/**
 * Reads a cookie, narrowed through `unknown`.
 *
 * `cookie-parser` types `Request.cookies` as `any`, which would otherwise
 * spread untyped values into the guards. This is the one place that deals
 * with it.
 */
export function readCookie(request: Request, name: string): string | undefined {
  const bag = (request as unknown as { cookies?: unknown }).cookies;
  if (typeof bag !== 'object' || bag === null) return undefined;
  const value = (bag as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}

export const ACCESS_TOKEN_COOKIE = 'dvy_at';
export const REFRESH_TOKEN_COOKIE = 'dvy_rt';
/** Readable by script on purpose — it is the double-submit CSRF value. */
export const CSRF_COOKIE = 'dvy_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/** Path the refresh cookie is scoped to, so it is not sent on every request. */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

interface CookieContext {
  readonly secure: boolean;
}

/**
 * Cookie settings for browser clients.
 *
 * HttpOnly on both token cookies, so script cannot read them even if the
 * page is compromised by XSS. `SameSite=Lax` blocks the ordinary
 * cross-site POST while still allowing top-level navigation back into the
 * app. `Secure` is on everywhere except local HTTP development, because a
 * browser silently drops a Secure cookie over http://localhost otherwise.
 */
export function accessCookieOptions({ secure }: CookieContext, maxAgeSeconds: number): CookieOptions {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds * 1000,
  };
}

export function refreshCookieOptions({ secure }: CookieContext, maxAgeSeconds: number): CookieOptions {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    // Scoped: the refresh token is only ever presented to the auth routes,
    // so it is not attached to every ordinary API call.
    path: REFRESH_COOKIE_PATH,
    maxAge: maxAgeSeconds * 1000,
  };
}

/** Deliberately NOT HttpOnly: the client must read it to echo it back. */
export function csrfCookieOptions({ secure }: CookieContext, maxAgeSeconds: number): CookieOptions {
  return {
    httpOnly: false,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds * 1000,
  };
}

export function clearAuthCookies(res: Response, ctx: CookieContext): void {
  res.clearCookie(ACCESS_TOKEN_COOKIE, { ...accessCookieOptions(ctx, 0), maxAge: undefined });
  res.clearCookie(REFRESH_TOKEN_COOKIE, { ...refreshCookieOptions(ctx, 0), maxAge: undefined });
  res.clearCookie(CSRF_COOKIE, { ...csrfCookieOptions(ctx, 0), maxAge: undefined });
}
