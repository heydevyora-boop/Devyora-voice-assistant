import { Injectable, Logger } from '@nestjs/common';
import {
  ConnectionProvider,
  ConnectionStatus,
  type ConnectedAccount,
} from '@prisma/client';
import { AppError } from '../../common/errors/app-error';
import { AppConfigService } from '../../config/app-config.module';
import { PrismaService } from '../../database/prisma.service';
import { AuditAction, AuditService } from '../../security/services/audit.service';
import { CryptoService } from '../../security/services/crypto.service';
import { IntegrationError } from '../../providers/integrations/errors';
import {
  findOperation,
  type ConnectionContext,
  type IntegrationOperation,
  type IntegrationProvider,
  type OperationResult,
} from '../../providers/integrations/types';
import { IntegrationRegistry } from './integration.registry';

/** After this many consecutive failures a connection stops being retried. */
const MAX_REFRESH_FAILURES = 5;

export interface ConnectionView {
  readonly connectionId: string;
  readonly provider: ConnectionProvider;
  readonly label: string;
  readonly kind: string;
  readonly status: ConnectionStatus;
  readonly displayName: string | null;
  readonly grantedScopes: readonly string[];
  readonly expiresAt: string | null;
  /** True when the access token has run out and cannot be refreshed. */
  readonly needsReconnect: boolean;
  readonly lastErrorCode: string | null;
  readonly connectedAt: string;
  /** What this connection can actually do, given what was granted. */
  readonly availableOperations: readonly string[];
  /** Operations the provider supports but this connection was not granted. */
  readonly unavailableOperations: readonly { operation: string; reason: string }[];
}

/**
 * Connected accounts.
 *
 * Holds the one rule that the whole integration layer rests on: **a
 * credential never leaves this service.** `ConnectionView` has no token
 * field, the controller cannot reach one, and the only place a plaintext
 * token exists is a local variable inside `withAccessToken`, for the
 * duration of one provider call.
 *
 * It also owns the distinction between *what a provider can do* and *what
 * this connection may do*. The first is capability metadata; the second is
 * the intersection with the scopes the user actually granted — and a user
 * can untick a permission on the consent screen and still be issued a
 * token. Reporting the first as if it were the second is how an action
 * fails later with a confusing provider error instead of a clear refusal.
 */
@Injectable()
export class ConnectionsService {
  private readonly logger = new Logger(ConnectionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: IntegrationRegistry,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
  ) {}

  // ───────────────────────────────────────────────────────────────── read

  /** This account's live connections. */
  async list(userId: string): Promise<ConnectionView[]> {
    const rows = await this.prisma.connectedAccount.findMany({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => this.toView(row));
  }

  /**
   * What the user could connect, and what each would actually give them.
   *
   * Includes providers with nothing configured, marked as such: a user
   * should be able to see that Instagram exists and that this deployment
   * cannot offer it, rather than wondering why it is missing.
   */
  async catalogue(userId: string) {
    const connections = await this.prisma.connectedAccount.findMany({
      where: { userId, revokedAt: null },
      select: { provider: true, status: true, scopes: true },
    });
    const connected = new Map(connections.map((c) => [c.provider, c]));

    return this.registry.describe().map((capabilities) => {
      const live = connected.get(capabilities.provider);
      return {
        provider: capabilities.provider,
        label: capabilities.label,
        kind: capabilities.kind,
        configured: capabilities.configured,
        connected: Boolean(live) && capabilities.kind === 'official-api',
        status: live?.status ?? null,
        supportsOAuth: capabilities.supportsOAuth,
        supportsRefresh: capabilities.supportsRefresh,
        supportsRevoke: capabilities.supportsRevoke,
        operations: capabilities.operations.map((o) => ({
          operation: o.operation,
          // The honest field: what the outcome can be known to be.
          fidelity: o.fidelity,
          requiresConfirmation: o.requiresConfirmation,
          scopes: o.scopes,
          limitations: o.limitations,
          // Whether *this user* can use it right now.
          available:
            capabilities.kind !== 'official-api'
              ? capabilities.configured
              : Boolean(live) && o.scopes.every((scope) => live!.scopes.includes(scope)),
        })),
        limitations: capabilities.limitations,
        documentationUrl: capabilities.documentationUrl,
      };
    });
  }

  /** One connection the caller owns, or a 404. */
  async requireOwned(userId: string, connectionId: string): Promise<ConnectedAccount> {
    const row = await this.prisma.connectedAccount.findFirst({
      where: { id: connectionId, userId, revokedAt: null },
    });
    // Another user's id reads as missing, as everywhere else.
    if (!row) throw AppError.notFound('Connection');
    return row;
  }

  // ───────────────────────────────────────────────────── disconnect

  /**
   * Disconnects, revoking at the provider where that is possible.
   *
   * Deleting our row alone would leave the grant live in the user's Google
   * or Meta account — the sort of thing people discover years later. So the
   * provider is told first, and the row is marked revoked either way: a
   * provider that cannot be reached must not leave the user unable to
   * disconnect.
   */
  async disconnect(
    userId: string,
    connectionId: string,
    meta?: { ipAddress?: string; userAgent?: string; deviceId?: string },
  ) {
    const row = await this.requireOwned(userId, connectionId);
    const provider = this.registry.official(row.provider);

    let revokedAtProvider = false;
    let revocationNote: string | null = null;

    if (provider?.revoke) {
      const token = this.openAccessToken(row);
      if (token) {
        try {
          await provider.revoke(token, this.config.providers.integrations.timeoutMs);
          revokedAtProvider = true;
        } catch (error) {
          // Reported, not hidden. The user is entitled to know their grant
          // may still be live on the provider's side.
          this.logger.warn(
            `Revoking ${row.provider} at the provider failed: ` +
              (error instanceof IntegrationError ? error.integrationCode : 'unknown'),
          );
          revocationNote =
            'The provider could not be reached, so the grant may still be active there. ' +
            'You can remove it in the provider’s own security settings.';
        }
      } else {
        revocationNote =
          'The stored credential could not be read, so nothing was revoked at the provider.';
      }
    } else if (provider && !provider.capabilities().supportsRevoke) {
      revocationNote =
        `${provider.capabilities().label} has no revocation endpoint. The credential has ` +
        'been removed here; revoke it in the provider’s own settings.';
    }

    // Marked revoked rather than deleted: the row is the record that a
    // connection existed, and the unique index is on `revokedAt` precisely
    // so revoked rows may accumulate.
    await this.prisma.connectedAccount.update({
      where: { id: row.id },
      data: {
        status: ConnectionStatus.REVOKED,
        revokedAt: new Date(),
        // The credential goes now. Keeping it would mean a disconnected
        // account whose token is still sitting in the database.
        accessTokenEnc: null,
        refreshTokenEnc: null,
      },
    });

    await this.audit.record({
      action: revokedAtProvider
        ? AuditAction.INTEGRATION_REVOKED
        : AuditAction.INTEGRATION_DISCONNECTED,
      userId,
      deviceId: meta?.deviceId,
      resource: 'connected_account',
      resourceId: row.id,
      metadata: { provider: row.provider, revokedAtProvider },
      ...meta,
    });

    return {
      disconnected: true,
      provider: row.provider,
      revokedAtProvider,
      note:
        revocationNote ??
        'Disconnected, and the authorisation was revoked at the provider.',
    };
  }

  // ─────────────────────────────────────────────────────────── refresh

  /**
   * Refreshes an access token.
   *
   * Idempotent in the way that matters: a token that is still valid is left
   * alone, so a retried job does not churn credentials. A refresh the
   * provider rejects increments a failure counter and, past a threshold,
   * marks the connection `EXPIRED` — a connection the provider keeps
   * refusing should stop being retried every few minutes and should start
   * telling the user to reconnect.
   */
  async refresh(
    connectionId: string,
    options: { force?: boolean } = {},
  ): Promise<{ refreshed: boolean; reason: string }> {
    const row = await this.prisma.connectedAccount.findUnique({ where: { id: connectionId } });
    if (!row || row.revokedAt) return { refreshed: false, reason: 'not_connected' };

    const provider = this.registry.official(row.provider);
    if (!provider?.refresh || !provider.capabilities().supportsRefresh) {
      return { refreshed: false, reason: 'provider_has_no_refresh' };
    }

    const lead = this.config.providers.integrations.refreshLeadMs;
    const needsIt =
      options.force ||
      row.expiresAt === null ||
      row.expiresAt.getTime() - Date.now() <= lead;
    if (!needsIt) return { refreshed: false, reason: 'still_valid' };

    const refreshToken = row.refreshTokenEnc
      ? this.crypto.open(Buffer.from(row.refreshTokenEnc), row.keyVersion)
      : null;

    if (!refreshToken) {
      await this.markBroken(row.id, 'no_refresh_token', 'There is no refresh token to use.');
      return { refreshed: false, reason: 'no_refresh_token' };
    }

    try {
      const tokens = await provider.refresh(
        refreshToken,
        this.config.providers.integrations.timeoutMs,
      );

      const access = this.crypto.seal(tokens.accessToken);
      // A refresh response usually omits the refresh token. Keeping the one
      // we hold is the difference between a connection that keeps working
      // and one that dies at the next expiry.
      const refresh = tokens.refreshToken ? this.crypto.seal(tokens.refreshToken) : null;

      await this.prisma.connectedAccount.update({
        where: { id: row.id },
        data: {
          accessTokenEnc: access.ciphertext,
          refreshTokenEnc: refresh?.ciphertext ?? row.refreshTokenEnc,
          keyVersion: access.keyVersion,
          expiresAt: tokens.expiresAt,
          ...(tokens.grantedScopes.length > 0 ? { scopes: [...tokens.grantedScopes] } : {}),
          status: ConnectionStatus.CONNECTED,
          lastErrorCode: null,
          lastError: null,
          refreshFailures: 0,
          lastRefreshAt: new Date(),
        },
      });

      await this.audit.record({
        action: AuditAction.INTEGRATION_REFRESHED,
        userId: row.userId,
        actorType: 'SYSTEM',
        resource: 'connected_account',
        resourceId: row.id,
        metadata: { provider: row.provider },
      });

      return { refreshed: true, reason: 'refreshed' };
    } catch (error) {
      const code = error instanceof IntegrationError ? error.integrationCode : 'unknown';
      const failures = row.refreshFailures + 1;

      // A provider refusing the refresh token means the grant is gone —
      // the user revoked it, or it aged out. Retrying will not help.
      const terminal = code === 'auth' || failures >= MAX_REFRESH_FAILURES;

      await this.prisma.connectedAccount.update({
        where: { id: row.id },
        data: {
          refreshFailures: failures,
          lastRefreshAt: new Date(),
          lastErrorCode: `refresh_${code}`.slice(0, 40),
          lastError: terminal
            ? 'The provider would not renew access. Reconnect the account.'
            : 'Renewing access failed; it will be tried again.',
          ...(terminal ? { status: ConnectionStatus.EXPIRED } : {}),
        },
      });

      await this.audit.record({
        action: AuditAction.INTEGRATION_REFRESH_FAILED,
        userId: row.userId,
        actorType: 'SYSTEM',
        resource: 'connected_account',
        resourceId: row.id,
        metadata: { provider: row.provider, code, failures, terminal },
      });

      return { refreshed: false, reason: terminal ? 'refresh_rejected' : 'refresh_failed' };
    }
  }

  /**
   * Refreshes everything close to expiry.
   *
   * Run from the maintenance queue. Ordered by expiry so the most urgent
   * goes first, and bounded so one sweep cannot take an unbounded amount of
   * time with a large user base.
   */
  async refreshExpiring(now = new Date()): Promise<{ attempted: number; refreshed: number }> {
    const lead = this.config.providers.integrations.refreshLeadMs;

    const due = await this.prisma.connectedAccount.findMany({
      where: {
        revokedAt: null,
        status: ConnectionStatus.CONNECTED,
        expiresAt: { not: null, lte: new Date(now.getTime() + lead) },
        // A connection the provider keeps refusing is left alone until the
        // user reconnects.
        refreshFailures: { lt: MAX_REFRESH_FAILURES },
      },
      select: { id: true },
      orderBy: { expiresAt: 'asc' },
      take: 200,
    });

    let refreshed = 0;
    for (const row of due) {
      const result = await this.refresh(row.id);
      if (result.refreshed) refreshed += 1;
    }

    if (due.length > 0) {
      this.logger.log(`Refreshed ${refreshed} of ${due.length} expiring connection(s).`);
    }
    return { attempted: due.length, refreshed };
  }

  // ─────────────────────────────────────────────────────────── execute

  /**
   * Performs an operation through a connected provider.
   *
   * Four gates before anything is sent, in order of cheapness: the
   * connection must be the caller's and live; the provider must support the
   * operation; the connection must have been *granted* the scopes; and the
   * access token must be current, refreshed first if not.
   */
  async execute(
    userId: string,
    provider: ConnectionProvider,
    operation: IntegrationOperation,
    input: Record<string, unknown>,
    meta?: { deviceId?: string; ipAddress?: string; userAgent?: string },
  ): Promise<OperationResult & { provider: ConnectionProvider; connectorKind: string }> {
    const row = await this.prisma.connectedAccount.findFirst({
      where: { userId, provider, revokedAt: null },
    });

    const connector = this.registry.forUse(provider, Boolean(row));
    if (!connector) {
      throw AppError.validation(`${provider} is not an integration this server knows.`);
    }

    const capabilities = connector.capabilities();
    const capability = findOperation(capabilities, operation);

    if (!capability || !connector.execute) {
      // Not a failure to retry: a capability that does not exist.
      throw AppError.validation(
        `${capabilities.label} cannot ${operation}.` +
          (capabilities.limitations.length > 0 ? ` ${capabilities.limitations[0]}` : ''),
      );
    }

    // The assisted and native connectors need no credential, which is
    // exactly why they work without an account.
    if (capabilities.kind !== 'official-api') {
      const result = await connector.execute(
        {
          userId,
          connectionId: '',
          accessToken: '',
          externalAccountId: null,
          grantedScopes: [],
        },
        { operation, input, timeoutMs: this.config.providers.integrations.timeoutMs },
      );
      return { ...result, provider, connectorKind: capabilities.kind };
    }

    if (!row) {
      throw AppError.validation(
        `No ${capabilities.label} account is connected.`,
      );
    }
    if (row.status !== ConnectionStatus.CONNECTED) {
      throw AppError.validation(
        `That ${capabilities.label} connection needs attention: ${
          row.lastError ?? 'reconnect the account'
        }.`,
      );
    }

    const missing = capability.scopes.filter((scope) => !row.scopes.includes(scope));
    if (missing.length > 0) {
      // The user granted less than was asked for. A reconnection with
      // wider consent is the fix, and saying so is more useful than
      // relaying the provider's own error later.
      throw AppError.validation(
        `That needs access this connection was not granted. Reconnect ${capabilities.label} to allow it.`,
      );
    }

    const result = await this.withAccessToken(row, async (context) => {
      try {
        return await connector.execute!(context, {
          operation,
          input,
          timeoutMs: this.config.providers.integrations.timeoutMs,
        });
      } catch (error) {
        await this.recordOperationFailure(row, operation, error);
        throw this.toHttpError(error, capabilities.label);
      }
    });

    await this.audit.record({
      action: AuditAction.INTEGRATION_OPERATION,
      userId,
      deviceId: meta?.deviceId,
      resource: 'connected_account',
      resourceId: row.id,
      metadata: {
        provider,
        operation,
        // The honest field, recorded so history cannot be read as more
        // than it was.
        fidelity: result.fidelity,
        providerRef: result.providerRef,
      },
      ...meta,
    });

    return { ...result, provider, connectorKind: capabilities.kind };
  }

  /**
   * Runs work with a usable access token.
   *
   * Refreshes first when the token is close to expiry, so an operation does
   * not fail for a reason the server could have prevented. The plaintext
   * token exists only as an argument to the callback — it is never
   * returned, logged, or stored anywhere but the sealed column.
   */
  private async withAccessToken<T>(
    row: ConnectedAccount,
    work: (context: ConnectionContext) => Promise<T>,
  ): Promise<T> {
    const lead = this.config.providers.integrations.refreshLeadMs;
    let current = row;

    if (current.expiresAt && current.expiresAt.getTime() - Date.now() <= lead) {
      const outcome = await this.refresh(current.id);
      if (outcome.refreshed) {
        current = await this.prisma.connectedAccount.findUniqueOrThrow({
          where: { id: current.id },
        });
      } else if (current.expiresAt.getTime() <= Date.now()) {
        // Expired and could not be renewed. Nothing to attempt.
        throw AppError.validation(
          'That connection has expired and could not be renewed. Reconnect the account.',
        );
      }
    }

    const token = this.openAccessToken(current);
    if (!token) {
      await this.markBroken(
        current.id,
        'credential_unreadable',
        'The stored credential could not be read. Reconnect the account.',
      );
      throw AppError.validation(
        'That connection could not be used. Reconnect the account.',
      );
    }

    return work({
      userId: current.userId,
      connectionId: current.id,
      accessToken: token,
      externalAccountId: current.externalAccountId,
      grantedScopes: current.scopes,
    });
  }

  // ─────────────────────────────────────────────────────────── private

  private openAccessToken(row: ConnectedAccount): string | null {
    return row.accessTokenEnc
      ? this.crypto.open(Buffer.from(row.accessTokenEnc), row.keyVersion)
      : null;
  }

  private async markBroken(id: string, code: string, detail: string): Promise<void> {
    await this.prisma.connectedAccount.update({
      where: { id },
      data: { status: ConnectionStatus.ERROR, lastErrorCode: code.slice(0, 40), lastError: detail },
    });
  }

  private async recordOperationFailure(
    row: ConnectedAccount,
    operation: string,
    error: unknown,
  ): Promise<void> {
    const code = error instanceof IntegrationError ? error.integrationCode : 'unknown';

    // An auth failure means the credential is no longer good, which is a
    // connection-level fact rather than a one-off error.
    if (code === 'auth' || code === 'scope_missing') {
      await this.prisma.connectedAccount.update({
        where: { id: row.id },
        data: {
          status: code === 'auth' ? ConnectionStatus.EXPIRED : ConnectionStatus.ERROR,
          lastErrorCode: `${operation}_${code}`.slice(0, 40),
          lastError:
            code === 'auth'
              ? 'The provider rejected the stored credential. Reconnect the account.'
              : 'This connection was not granted the access that needs. Reconnect to allow it.',
        },
      });
    }
  }

  private toHttpError(error: unknown, label: string): AppError {
    if (!(error instanceof IntegrationError)) {
      return AppError.dependencyUnavailable(`${label} could not be reached.`);
    }

    switch (error.integrationCode) {
      case 'unsupported':
        return AppError.validation(error.message);
      case 'scope_missing':
        return AppError.validation(
          `That needs access this connection was not granted. Reconnect ${label} to allow it.`,
        );
      case 'auth':
        return AppError.validation(
          `${label} rejected the stored credential. Reconnect the account.`,
        );
      case 'invalid_request':
        return AppError.validation(error.message);
      case 'rate_limited':
        return AppError.dependencyUnavailable(
          `${label} is rate-limiting this account. Try again shortly.`,
        );
      default:
        return AppError.dependencyUnavailable(`${label} could not be reached.`);
    }
  }

  private toView(row: ConnectedAccount): ConnectionView {
    const provider: IntegrationProvider | undefined = this.registry.official(row.provider);
    const capabilities = provider?.capabilities();

    const available: string[] = [];
    const unavailable: { operation: string; reason: string }[] = [];

    for (const operation of capabilities?.operations ?? []) {
      const missing = operation.scopes.filter((scope) => !row.scopes.includes(scope));
      if (missing.length === 0) available.push(operation.operation);
      else {
        unavailable.push({
          operation: operation.operation,
          reason: 'This connection was not granted the access it needs.',
        });
      }
    }

    return {
      connectionId: row.id,
      provider: row.provider,
      label: capabilities?.label ?? row.provider,
      kind: capabilities?.kind ?? 'official-api',
      status: row.status,
      displayName: row.displayName,
      // The scopes, which are not secret. Never the tokens, which have no
      // field on this type at all.
      grantedScopes: row.scopes,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      needsReconnect:
        row.status === ConnectionStatus.EXPIRED ||
        row.status === ConnectionStatus.ERROR ||
        (row.expiresAt !== null &&
          row.expiresAt.getTime() <= Date.now() &&
          !capabilities?.supportsRefresh),
      lastErrorCode: row.lastErrorCode,
      connectedAt: row.createdAt.toISOString(),
      availableOperations: available,
      unavailableOperations: unavailable,
    };
  }
}
