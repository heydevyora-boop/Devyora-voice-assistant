import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC } from '../../common/decorators/public.decorator';
import { AppError } from '../../common/errors/app-error';
import { requestContext } from '../../common/request-context';
import { PrincipalService } from '../services/principal.service';
import { ACCESS_TOKEN_COOKIE, readCookie } from '../cookies';

/** What a handler can rely on once the guard has run. */
export interface AuthenticatedPrincipal {
  readonly userId: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly email: string;
  /** True when the credential arrived in a cookie rather than a header. */
  readonly viaCookie: boolean;
}

export interface AuthenticatedRequest extends Request {
  principal?: AuthenticatedPrincipal;
}

/**
 * The only thing that establishes identity.
 *
 * Registered globally, so every route is private unless it carries
 * `@Public()`. A route added without thinking about auth is therefore closed,
 * not open.
 *
 * A valid signature is necessary but not sufficient: the session must still
 * be open, the device not revoked, the account active, and the token issued
 * after the user's `tokensValidFrom` watermark. Those checks live in
 * `PrincipalService`, shared with the WebSocket gateway, so a credential is
 * judged identically however it arrived.
 *
 * The lookup costs one indexed query per request. Chunk 6 introduces Redis
 * and this becomes a cache read; correctness first.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly principals: PrincipalService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // HTTP only. A WebSocket is authenticated once, at the handshake, by
    // `VoiceGateway` using the same `PrincipalService` this guard uses —
    // there is no per-frame request to read a header from, and reaching for
    // one here would fail every socket message instead of checking it.
    if (context.getType() !== 'http') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const extracted = extractAccessToken(request);
    if (!extracted) throw AppError.unauthenticated();

    // Every failure is the same 401. Telling a caller which check failed
    // would map out the account and device state for them.
    const principal = await this.principals.fromAccessToken(extracted.token);
    if (!principal) throw AppError.unauthenticated();

    request.principal = { ...principal, viaCookie: extracted.viaCookie };
    requestContext.setPrincipal(principal.userId, principal.deviceId);

    this.principals.touchDevice(principal.deviceId);

    return true;
  }
}

/** Header first, cookie second. Native clients never have cookies. */
export function extractAccessToken(
  request: Request,
): { token: string; viaCookie: boolean } | null {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (token) return { token, viaCookie: false };
  }

  const fromCookie = readCookie(request, ACCESS_TOKEN_COOKIE);
  if (fromCookie) return { token: fromCookie, viaCookie: true };

  return null;
}
