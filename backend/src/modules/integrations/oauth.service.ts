import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConnectionProvider, ConnectionStatus } from '@prisma/client';
import { AppError } from '../../common/errors/app-error';
import { AppConfigService } from '../../config/app-config.module';
import { PrismaService } from '../../database/prisma.service';
import { AuditAction, AuditService } from '../../security/services/audit.service';
import { CryptoService } from '../../security/services/crypto.service';
import { IntegrationError } from '../../providers/integrations/errors';
import type { IntegrationProvider } from '../../providers/integrations/types';
import { IntegrationRegistry } from './integration.registry';

/** How long a user has to finish an authorisation before it lapses. */
const STATE_TTL_MS = 10 * 60 * 1000;

/** How long a consumed or lapsed state row is kept, for the audit trail. */
const STATE_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface StartAuthorizationInput {
  readonly userId: string;
  readonly deviceId: string;
  readonly provider: ConnectionProvider;
  /** Extra scopes beyond the provider's defaults. Validated against it. */
  readonly scopes?: readonly string[];
  readonly meta?: { ipAddress?: string; userAgent?: string };
}

export interface CallbackInput {
  readonly userId: string;
  readonly deviceId: string;
  readonly state: string;
  readonly code: string;
  readonly meta?: { ipAddress?: string; userAgent?: string };
}

/**
 * The OAuth framework.
 *
 * ## The state parameter
 *
 * A single-use **server-side record**, not a signed blob. The difference
 * matters: a signed state can be replayed until it expires, whereas a row
 * that is consumed in one conditional update cannot be used twice. A
 * callback either matches exactly one in-flight authorisation or it matches
 * none.
 *
 * The record also carries who started the flow, so the callback is checked
 * against the authenticated user **and** the device that began it. A valid
 * code arriving on a different session is refused — that is the CSRF
 * defence, and it is what stops an attacker who can make a victim's browser
 * follow a callback URL from attaching their own account to the victim's.
 *
 * ## PKCE
 *
 * Used wherever the provider supports it. The verifier is sealed at rest
 * because it has to be presented to the token endpoint, so it cannot be
 * hashed — and it must never reach the browser, so it cannot live in the
 * state parameter. Providers that do not support PKCE say so in their
 * capability metadata rather than having a challenge quietly ignored.
 *
 * ## Scopes
 *
 * Requested scopes are checked against what the provider declares. What was
 * actually *granted* is read back from the provider and stored — a user can
 * untick a permission on the consent screen and still be issued a token, so
 * assuming the request was honoured is how an action fails later with a
 * confusing error.
 */
@Injectable()
export class OAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: IntegrationRegistry,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
  ) {}

  // ───────────────────────────────────────────────────────────── starting

  /**
   * Begins an authorisation.
   *
   * Refuses before anything is written when the preconditions are not met,
   * so a user is never sent to a consent screen for a connection that
   * could not have been stored.
   */
  async start(input: StartAuthorizationInput) {
    const provider = this.requireProvider(input.provider);
    const capabilities = provider.capabilities();

    if (!capabilities.supportsOAuth || !provider.authorizationUrl) {
      throw AppError.validation(
        `${capabilities.label} is not connected through OAuth. ${
          provider.connectWithSecret
            ? 'It is connected with a token you supply.'
            : 'It needs no connection.'
        }`,
      );
    }
    if (!provider.configured) {
      throw AppError.dependencyUnavailable(
        `${capabilities.label} is not configured on this server.`,
      );
    }
    // Checked before the consent screen, not after it: a user should not
    // grant access only to have the result discarded.
    if (!this.crypto.available) {
      throw AppError.dependencyUnavailable(
        'Credential encryption is not configured, so accounts cannot be connected.',
      );
    }

    const requested = this.validateScopes(capabilities, input.scopes ?? []);

    const state = randomBytes(32).toString('base64url');
    const usesPkce = capabilities.supportsOAuth;
    const verifier = usesPkce ? randomBytes(32).toString('base64url') : null;
    const challenge = verifier
      ? createHash('sha256').update(verifier).digest('base64url')
      : null;

    const redirectUri = this.redirectUriFor(input.provider);

    const url = provider.authorizationUrl({
      state,
      redirectUri,
      scopes: requested,
      codeChallenge: challenge,
    });

    const sealed = verifier && url.usesPkce ? this.crypto.seal(verifier) : null;

    await this.prisma.oAuthState.create({
      data: {
        state,
        userId: input.userId,
        deviceId: input.deviceId,
        provider: input.provider,
        codeVerifierEnc: sealed?.ciphertext ?? null,
        keyVersion: sealed?.keyVersion ?? this.crypto.version,
        redirectUri,
        scopes: [...url.scopes],
        expiresAt: new Date(Date.now() + STATE_TTL_MS),
        ipAddress: input.meta?.ipAddress,
        userAgent: input.meta?.userAgent?.slice(0, 500),
      },
    });

    await this.audit.record({
      action: AuditAction.INTEGRATION_AUTH_STARTED,
      userId: input.userId,
      deviceId: input.deviceId,
      resource: 'connected_account',
      metadata: { provider: input.provider, usesPkce: url.usesPkce, scopes: url.scopes.length },
      ...input.meta,
    });

    return {
      authorizationUrl: url.url,
      state,
      scopes: url.scopes,
      usesPkce: url.usesPkce,
      expiresAt: new Date(Date.now() + STATE_TTL_MS).toISOString(),
      provider: input.provider,
      // Said plainly, because a user is about to grant access to their mail
      // or their messages.
      note: 'Nothing is connected until you finish on the provider’s page.',
    };
  }

  // ───────────────────────────────────────────────────────────── callback

  /**
   * Completes an authorisation.
   *
   * The state row is consumed with a conditional update, so two callbacks
   * racing produce one connection and one refusal. Everything after that
   * point knows it is the only attempt.
   */
  async callback(input: CallbackInput) {
    const record = await this.consumeState(input);
    const provider = this.requireProvider(record.provider);

    if (!provider.exchange) {
      throw AppError.validation('That provider cannot complete an OAuth exchange.');
    }

    const verifier = record.codeVerifierEnc
      ? this.crypto.open(Buffer.from(record.codeVerifierEnc), record.keyVersion)
      : null;

    if (record.codeVerifierEnc && !verifier) {
      // The row says PKCE was used and the verifier cannot be opened —
      // a rotated-away key, or tampering. Either way the exchange would
      // fail at the provider, so it is refused here with a clear reason.
      await this.audit.record({
        action: AuditAction.INTEGRATION_AUTH_FAILED,
        userId: input.userId,
        deviceId: input.deviceId,
        actorType: 'SYSTEM',
        metadata: { provider: record.provider, reason: 'verifier_unreadable' },
        ...input.meta,
      });
      throw AppError.validation('That authorisation could not be completed. Start again.');
    }

    let tokens;
    try {
      tokens = await provider.exchange(
        { code: input.code, redirectUri: record.redirectUri, codeVerifier: verifier },
        this.config.providers.integrations.timeoutMs,
      );
    } catch (error) {
      await this.audit.record({
        action: AuditAction.INTEGRATION_AUTH_FAILED,
        userId: input.userId,
        deviceId: input.deviceId,
        actorType: 'SYSTEM',
        metadata: {
          provider: record.provider,
          reason: error instanceof IntegrationError ? error.integrationCode : 'unknown',
        },
        ...input.meta,
      });
      throw this.toHttpError(error);
    }

    // What was granted, not what was asked. A user may have unticked a
    // permission and still been issued a token.
    const granted = tokens.grantedScopes.length > 0 ? tokens.grantedScopes : record.scopes;
    const connection = await this.store(record.userId, record.provider, tokens, granted);

    await this.audit.record({
      action: AuditAction.INTEGRATION_CONNECTED,
      userId: input.userId,
      deviceId: input.deviceId,
      resource: 'connected_account',
      resourceId: connection.id,
      metadata: {
        provider: record.provider,
        scopes: granted.length,
        // Recorded so a later "why did that action fail" has an answer.
        narrowedScopes: granted.length < record.scopes.length,
      },
      ...input.meta,
    });

    return {
      connectionId: connection.id,
      provider: record.provider,
      displayName: connection.displayName,
      grantedScopes: granted,
      /** True when the user granted less than was asked for. */
      scopesNarrowed: granted.length < record.scopes.length,
      expiresAt: connection.expiresAt?.toISOString() ?? null,
      status: connection.status,
    };
  }

  /**
   * Finds and consumes the state record.
   *
   * Every refusal is deliberately the same shape, because telling a caller
   * *which* check failed would help somebody probing the flow — an unknown
   * state, an expired one, one already used, and one belonging to another
   * user all read alike.
   */
  private async consumeState(input: CallbackInput) {
    if (!input.state || input.state.length > 64) {
      throw AppError.validation('That authorisation could not be completed. Start again.');
    }

    const record = await this.prisma.oAuthState.findUnique({
      where: { state: input.state },
    });

    const reject = async (reason: string) => {
      await this.audit.record({
        action: AuditAction.INTEGRATION_AUTH_FAILED,
        userId: input.userId,
        deviceId: input.deviceId,
        actorType: 'SYSTEM',
        metadata: { reason },
        ...input.meta,
      });
      throw AppError.validation('That authorisation could not be completed. Start again.');
    };

    if (!record) await reject('state_unknown');
    if (record!.consumedAt) await reject('state_replayed');
    if (record!.expiresAt <= new Date()) await reject('state_expired');

    // The flow must finish on the session that began it. This is the CSRF
    // defence: a code delivered to somebody else's browser is useless.
    if (!constantTimeEquals(record!.userId, input.userId)) await reject('state_wrong_user');
    if (!constantTimeEquals(record!.deviceId, input.deviceId)) await reject('state_wrong_device');

    // Consumed conditionally, so two callbacks racing produce one winner.
    const { count } = await this.prisma.oAuthState.updateMany({
      where: { id: record!.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (count === 0) await reject('state_replayed');

    return record!;
  }

  // ─────────────────────────────────────────────────── secret connection

  /**
   * Connects a provider that uses a supplied secret rather than OAuth.
   *
   * The secret is verified against the provider before anything is stored,
   * so a typo is a failed attempt rather than a connection that looks fine
   * and fails on first use.
   */
  async connectWithSecret(
    userId: string,
    deviceId: string,
    providerId: ConnectionProvider,
    secret: string,
    meta?: { ipAddress?: string; userAgent?: string },
  ) {
    const provider = this.requireProvider(providerId);

    if (!provider.connectWithSecret) {
      throw AppError.validation(
        `${provider.capabilities().label} is not connected with a token. Use the OAuth flow.`,
      );
    }
    if (!this.crypto.available) {
      throw AppError.dependencyUnavailable(
        'Credential encryption is not configured, so accounts cannot be connected.',
      );
    }

    let tokens;
    try {
      tokens = await provider.connectWithSecret(
        secret,
        this.config.providers.integrations.timeoutMs,
      );
    } catch (error) {
      await this.audit.record({
        action: AuditAction.INTEGRATION_AUTH_FAILED,
        userId,
        deviceId,
        actorType: 'SYSTEM',
        metadata: {
          provider: providerId,
          reason: error instanceof IntegrationError ? error.integrationCode : 'unknown',
        },
        ...meta,
      });
      throw this.toHttpError(error);
    }

    const connection = await this.store(userId, providerId, tokens, tokens.grantedScopes);

    await this.audit.record({
      action: AuditAction.INTEGRATION_CONNECTED,
      userId,
      deviceId,
      resource: 'connected_account',
      resourceId: connection.id,
      metadata: { provider: providerId, method: 'secret' },
      ...meta,
    });

    return {
      connectionId: connection.id,
      provider: providerId,
      displayName: connection.displayName,
      grantedScopes: tokens.grantedScopes,
      scopesNarrowed: false,
      expiresAt: connection.expiresAt?.toISOString() ?? null,
      status: connection.status,
    };
  }

  // ──────────────────────────────────────────────────────────── storage

  /**
   * Writes the connection, sealing both tokens.
   *
   * One live connection per provider per user, enforced by the unique index
   * on `(userId, provider, revokedAt)`. Reconnecting replaces the
   * credential in place rather than accumulating rows, so there is never a
   * question of which token is current.
   */
  private async store(
    userId: string,
    providerId: ConnectionProvider,
    tokens: { accessToken: string; refreshToken: string | null; expiresAt: Date | null; externalAccountId: string | null; displayName: string | null },
    grantedScopes: readonly string[],
  ) {
    const access = this.crypto.seal(tokens.accessToken);
    const refresh = tokens.refreshToken ? this.crypto.seal(tokens.refreshToken) : null;

    const existing = await this.prisma.connectedAccount.findFirst({
      where: { userId, provider: providerId, revokedAt: null },
      select: { id: true, refreshTokenEnc: true, keyVersion: true },
    });

    const data = {
      externalAccountId: tokens.externalAccountId,
      displayName: tokens.displayName,
      scopes: [...grantedScopes],
      accessTokenEnc: access.ciphertext,
      // A refresh response often omits the refresh token; keeping the one
      // we already hold is the difference between a connection that keeps
      // working and one that dies in an hour.
      refreshTokenEnc: refresh?.ciphertext ?? existing?.refreshTokenEnc ?? null,
      keyVersion: access.keyVersion,
      expiresAt: tokens.expiresAt,
      status: ConnectionStatus.CONNECTED,
      lastErrorCode: null,
      lastError: null,
      refreshFailures: 0,
      lastRefreshAt: new Date(),
    };

    if (existing) {
      return this.prisma.connectedAccount.update({
        where: { id: existing.id },
        data,
        select: { id: true, displayName: true, expiresAt: true, status: true },
      });
    }

    return this.prisma.connectedAccount.create({
      data: { userId, provider: providerId, ...data },
      select: { id: true, displayName: true, expiresAt: true, status: true },
    });
  }

  // ─────────────────────────────────────────────────────────── cleanup

  /**
   * Removes state rows that are no longer useful.
   *
   * A consumed or lapsed row is kept for a day so a replay can be told
   * apart from a forgery in the audit log, then removed — there is no
   * reason to hold a record of an authorisation attempt forever.
   */
  async purgeStates(now = new Date()): Promise<number> {
    const { count } = await this.prisma.oAuthState.deleteMany({
      where: {
        OR: [
          { consumedAt: { lt: new Date(now.getTime() - STATE_RETENTION_MS) } },
          { expiresAt: { lt: new Date(now.getTime() - STATE_RETENTION_MS) } },
        ],
      },
    });
    return count;
  }

  // ─────────────────────────────────────────────────────────── private

  private requireProvider(providerId: ConnectionProvider): IntegrationProvider {
    const provider = this.registry.official(providerId);
    if (!provider) {
      throw AppError.validation(`${providerId} is not an integration this server knows.`);
    }
    return provider;
  }

  /**
   * Checks requested scopes against what the provider declares.
   *
   * A scope the provider never lists is a client asking for something that
   * does not exist, which is a bug worth surfacing rather than passing on
   * to a provider that will reject the whole request.
   */
  private validateScopes(
    capabilities: { operations: readonly { scopes: readonly string[] }[] },
    requested: readonly string[],
  ): string[] {
    const known = new Set(capabilities.operations.flatMap((o) => o.scopes));

    const unknown = requested.filter((scope) => !known.has(scope));
    if (unknown.length > 0) {
      throw AppError.validation(`Unknown scope: ${unknown.slice(0, 3).join(', ')}.`);
    }

    // Default to everything the provider can do, so a user connects once
    // rather than being asked again per feature.
    return requested.length > 0 ? [...requested] : [...known];
  }

  private redirectUriFor(providerId: ConnectionProvider): string {
    const base = this.config.providers.integrations.redirectBaseUrl.replace(/\/+$/, '');
    return `${base}/${providerId.toLowerCase()}`;
  }

  private toHttpError(error: unknown): AppError {
    if (!(error instanceof IntegrationError)) {
      return AppError.dependencyUnavailable('That provider could not be reached.');
    }

    switch (error.integrationCode) {
      case 'auth':
        return AppError.validation(
          'The provider rejected the authorisation. Try connecting again.',
        );
      case 'scope_missing':
        return AppError.validation('The connection was not granted the access it needs.');
      case 'unsupported':
        return AppError.validation(error.message);
      case 'invalid_request':
        return AppError.validation(error.message);
      default:
        return AppError.dependencyUnavailable('That provider could not be reached.');
    }
  }
}

/** Constant-time comparison for identifiers checked against a request. */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
