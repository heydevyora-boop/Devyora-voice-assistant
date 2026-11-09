import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { isTokenStale } from '../token-watermark';
import { TokenService } from './token.service';

/** Identity established from an access token. */
export interface ResolvedPrincipal {
  readonly userId: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly email: string;
}

/**
 * Turns an access token into a principal, or into nothing.
 *
 * This is the single implementation of "is this credential currently good",
 * used by the HTTP guard and by the WebSocket gateway. It lives in one place
 * on purpose: an authorization check that exists twice is an authorization
 * check that will eventually differ in one of them, and the transport a
 * credential arrived over is no reason to apply different rules to it.
 *
 * A valid signature is necessary but not sufficient. The session must still
 * be open, the device not revoked, the account active, and the token issued
 * after the user's `tokensValidFrom` watermark — which is what makes
 * revocation immediate rather than effective whenever a token expires.
 */
@Injectable()
export class PrincipalService {
  constructor(
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Returns the principal, or null.
   *
   * Null for every reason, deliberately: distinguishing "no such session"
   * from "device revoked" would map out account state for a caller holding
   * a stale token.
   */
  async fromAccessToken(token: string): Promise<ResolvedPrincipal | null> {
    const claims = await this.tokens.verifyAccessToken(token);
    if (!claims) return null;

    const session = await this.prisma.session.findUnique({
      where: { id: claims.sid },
      select: {
        id: true,
        endedAt: true,
        user: {
          select: { id: true, email: true, status: true, deletedAt: true, tokensValidFrom: true },
        },
        device: { select: { id: true, revokedAt: true } },
      },
    });

    if (!session || session.endedAt) return null;
    if (session.device.id !== claims.did || session.device.revokedAt) return null;
    if (session.user.id !== claims.sub) return null;
    if (session.user.deletedAt || session.user.status !== 'ACTIVE') return null;
    // `iat` is whole seconds, so the comparison lives in one place that
    // knows that — see token-watermark.ts.
    if (isTokenStale(claims.iat, session.user.tokensValidFrom)) return null;

    return {
      userId: session.user.id,
      sessionId: session.id,
      deviceId: session.device.id,
      email: session.user.email,
    };
  }

  /** Best-effort activity stamp. A failure here never fails a request. */
  touchDevice(deviceId: string): void {
    void this.prisma.device
      .update({ where: { id: deviceId }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);
  }
}
