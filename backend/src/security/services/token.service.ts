import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppConfigService } from '../../config/app-config.module';

/** Claims carried by an access token. Nothing sensitive goes in here. */
export interface AccessTokenClaims {
  /** User id. */
  sub: string;
  /** Session id — lets a single session be revoked without touching others. */
  sid: string;
  /** Device id — bound at login so a token cannot be replayed from elsewhere. */
  did: string;
  /** Token id, for audit correlation. */
  jti: string;
  iat?: number;
  exp?: number;
}

export interface IssuedRefreshToken {
  /** Returned to the client exactly once. */
  readonly plaintext: string;
  /** What gets stored. */
  readonly hash: string;
  readonly expiresAt: Date;
}

/**
 * Issues and verifies tokens.
 *
 * Access tokens are short-lived JWTs. Refresh tokens are opaque random
 * strings — there is nothing to gain from making them self-describing, and
 * an opaque value cannot leak claims if it is logged by accident.
 *
 * Only hashes of refresh tokens are ever persisted.
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
  ) {}

  private requireSecret(kind: 'access' | 'refresh'): string {
    const { jwt } = this.config.providers;
    const secret = kind === 'access' ? jwt.accessSecret : jwt.refreshSecret;
    if (!secret || secret.length < 32) {
      // Fail loudly rather than fall back to a default: a weak or missing
      // signing key is the one misconfiguration that silently voids auth.
      throw new Error(
        `JWT_${kind.toUpperCase()}_SECRET is missing or shorter than 32 characters. ` +
          'Generate one with: openssl rand -base64 48',
      );
    }
    return secret;
  }

  async signAccessToken(claims: Omit<AccessTokenClaims, 'jti'>): Promise<{ token: string; jti: string; expiresInSeconds: number }> {
    const jti = randomBytes(16).toString('hex');
    const ttl = this.config.providers.jwt.accessTtl;

    // The generic overload is selected explicitly: an object literal here
    // otherwise matches the `string` overload first and fails to compile.
    const payload: Omit<AccessTokenClaims, 'iat' | 'exp'> = {
      sub: claims.sub,
      sid: claims.sid,
      did: claims.did,
      jti,
    };
    // `expiresIn` is typed as a template-literal union upstream. The
    // duration is already parsed here, so seconds are passed instead —
    // same result, no dependence on that type's exact shape.
    const expiresInSeconds = parseDuration(ttl);
    const token = await this.jwt.signAsync<typeof payload>(payload, {
      secret: this.requireSecret('access'),
      expiresIn: expiresInSeconds,
    });

    return { token, jti, expiresInSeconds };
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
    try {
      return await this.jwt.verifyAsync<AccessTokenClaims>(token, {
        secret: this.requireSecret('access'),
      });
    } catch {
      // Expiry, tampering and a wrong key are all the same to a caller:
      // the token is not usable. The distinction only helps an attacker.
      return null;
    }
  }

  /** A refresh token is 32 random bytes; the hash is what is stored. */
  issueRefreshToken(): IssuedRefreshToken {
    const plaintext = randomBytes(32).toString('base64url');
    return {
      plaintext,
      hash: hashToken(plaintext),
      expiresAt: new Date(Date.now() + parseDuration(this.config.providers.jwt.refreshTtl) * 1000),
    };
  }

  /** Single-use token for email verification or password reset. */
  issueVerificationToken(ttlMinutes: number): { plaintext: string; hash: string; expiresAt: Date } {
    const plaintext = randomBytes(32).toString('base64url');
    return {
      plaintext,
      hash: hashToken(plaintext),
      expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
    };
  }

  /** Warns at startup if a secret is absent, rather than at first login. */
  checkConfiguration(): void {
    for (const kind of ['access', 'refresh'] as const) {
      try {
        this.requireSecret(kind);
      } catch (error) {
        this.logger.error((error as Error).message);
      }
    }
  }
}

/** SHA-256 is right here: the input is already 256 bits of entropy, so a
 *  slow hash would buy nothing and only add latency to every refresh. */
export function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/** Constant-time comparison, so a lookup cannot be timed. */
export function tokenHashEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Accepts `900`, `15m`, `24h`, `30d`. */
export function parseDuration(value: string): number {
  const match = /^(\d+)\s*([smhd])?$/.exec(value.trim());
  if (!match) throw new Error(`Cannot parse duration: "${value}"`);
  const amount = Number(match[1]);
  const unit = match[2] ?? 's';
  const multiplier = { s: 1, m: 60, h: 3600, d: 86_400 }[unit] ?? 1;
  return amount * multiplier;
}
