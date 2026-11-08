import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error';
import { CSRF_COOKIE, CSRF_HEADER, readCookie } from '../cookies';
import type { AuthenticatedRequest } from './jwt-auth.guard';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Double-submit CSRF protection, applied only to cookie-authenticated
 * requests.
 *
 * A cross-site page can cause the browser to send cookies, but it cannot
 * read them, so it cannot reproduce the value in a header. A request
 * carrying a bearer token needs none of this — an attacker's page has no way
 * to obtain that token in the first place — so the check is skipped there
 * rather than imposed on native clients that cannot satisfy it.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (SAFE_METHODS.has(request.method)) return true;
    if (request.principal && !request.principal.viaCookie) return true;

    const fromCookie = readCookie(request, CSRF_COOKIE);
    if (!fromCookie) return true; // not a cookie session

    const header = request.headers[CSRF_HEADER];
    const fromHeader = Array.isArray(header) ? header[0] : header;

    if (!fromHeader || fromHeader !== fromCookie) {
      throw AppError.forbidden('CSRF token missing or does not match.');
    }
    return true;
  }
}
