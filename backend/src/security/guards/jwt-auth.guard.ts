import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC } from '../../common/decorators/public.decorator';
import { AppError } from '../../common/errors/app-error';
import { requestContext } from '../../common/request-context';
import { PrismaService } from '../../database/prisma.service';
import { TokenService } from '../services/token.service';
import { ACCESS_TOKEN_COOKIE, readCookie } from '../cookies';
import { isTokenStale } from '../token-watermark';

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
 * A valid signature is necessary but not sufficient. The guard also confirms,
 * against the database, that the session is still open, the device has not
 * been revoked, the account is still active, and the token was issued after
 * the user's `tokensValidFrom` watermark. That is what makes revocation take
 * effect immediately instead of whenever the token happens to expire.
 *
 * The lookup costs one indexed query per request. Chunk 6 introduces Redis
 * and this becomes a cache read; correctness first.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const extracted = extractAccessToken(request);
    if (!extracted) throw AppError.unauthenticated();

    const claims = await this.tokens.verifyAccessToken(extracted.token);
    if (!claims) throw AppError.unauthenticated();

    const session = await this.prisma.session.findUnique({
      where: { id: claims.sid },
      select: {
        id: true,
        endedAt: true,
        user: { select: { id: true, email: true, status: true, deletedAt: true, tokensValidFrom: true } },
        device: { select: { id: true, revokedAt: true } },
      },
    });

    // Every failure below is the same 401. Telling a caller which check
    // failed would map out the account and device state for them.
    if (!session || session.endedAt) throw AppError.unauthenticated();
    if (session.device.id !== claims.did || session.device.revokedAt) throw AppError.unauthenticated();
    if (session.user.id !== claims.sub) throw AppError.unauthenticated();
    if (session.user.deletedAt || session.user.status !== 'ACTIVE') throw AppError.unauthenticated();

    // Tokens minted before the watermark are rejected, which is how a
    // password change or a global logout invalidates tokens already issued.
    // `iat` is whole seconds, so the comparison is done in one place that
    // knows that — see token-watermark.ts.
    if (isTokenStale(claims.iat, session.user.tokensValidFrom)) throw AppError.unauthenticated();

    request.principal = {
      userId: session.user.id,
      sessionId: session.id,
      deviceId: session.device.id,
      email: session.user.email,
      viaCookie: extracted.viaCookie,
    };
    requestContext.setPrincipal(session.user.id, session.device.id);

    // Best-effort activity stamp; a failure here must not fail the request.
    void this.prisma.device
      .update({ where: { id: session.device.id }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);

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
