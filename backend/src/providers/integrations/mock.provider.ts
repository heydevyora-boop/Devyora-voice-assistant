import { ConnectionProvider } from '@prisma/client';
import { IntegrationError } from './errors';
import type {
  AuthorizationRequest,
  AuthorizationUrl,
  ConnectionContext,
  ExchangeRequest,
  IntegrationCapabilities,
  IntegrationOperation,
  IntegrationProvider,
  OperationRequest,
  OperationResult,
  ProviderHealth,
  TokenSet,
} from './types';

/**
 * A deterministic stand-in for an integration.
 *
 * It exists so the OAuth flow, the capability checks, the token refresh and
 * the execution path can all be exercised end to end without contacting a
 * vendor — and, crucially, **without sending a real message in a test**.
 *
 * It records everything it was asked to do and performs nothing. Its
 * connection is real in the sense that matters for testing: a genuine state
 * record, a genuine sealed token, a genuine expiry. What it will not do is
 * reach anybody.
 */
export class MockIntegrationProvider implements IntegrationProvider {
  readonly kind = 'official-api' as const;
  readonly configured = true;

  /** Everything it was asked to do, for assertions. */
  readonly calls: { operation: string; input: Record<string, unknown> }[] = [];
  readonly exchanges: ExchangeRequest[] = [];
  readonly refreshes: string[] = [];
  readonly revocations: string[] = [];

  private failure: IntegrationError | null = null;
  private tokenCounter = 0;
  /** What `exchange` will report as granted. Narrower than asked, if set. */
  private grantOverride: readonly string[] | null = null;
  private expiresInSeconds: number | null = 3_600;

  constructor(
    readonly provider: ConnectionProvider = ConnectionProvider.GMAIL,
    private readonly supported: readonly IntegrationOperation[] = [
      'email.draft',
      'email.list',
      'messages.send',
    ],
  ) {}

  failWith(error: IntegrationError | null): this {
    this.failure = error;
    return this;
  }

  /** Make the next exchange grant only these scopes. */
  grantOnly(scopes: readonly string[]): this {
    this.grantOverride = scopes;
    return this;
  }

  /** Make issued tokens expire this many seconds from now; null for never. */
  expireIn(seconds: number | null): this {
    this.expiresInSeconds = seconds;
    return this;
  }

  reset(): this {
    this.failure = null;
    this.grantOverride = null;
    this.expiresInSeconds = 3_600;
    this.calls.length = 0;
    this.exchanges.length = 0;
    this.refreshes.length = 0;
    this.revocations.length = 0;
    return this;
  }

  capabilities(): IntegrationCapabilities {
    return {
      provider: this.provider,
      label: 'Recorded test integration',
      kind: this.kind,
      configured: true,
      supportsOAuth: true,
      supportsRefresh: true,
      supportsRevoke: true,
      operations: this.supported.map((operation) => ({
        operation,
        fidelity: operation === 'messages.send' ? ('accepted' as const) : ('verified' as const),
        scopes: [`scope.${operation}`],
        requiresConfirmation: operation === 'messages.send' || operation === 'email.draft',
        limitations: ['A stand-in. Records the request and reaches nobody.'],
      })),
      limitations: ['Performs nothing. Present so the flow can be tested without a vendor.'],
      documentationUrl: null,
    };
  }

  authorizationUrl(request: AuthorizationRequest): AuthorizationUrl {
    const params = new URLSearchParams({
      state: request.state,
      redirect_uri: request.redirectUri,
      scope: request.scopes.join(' '),
      ...(request.codeChallenge
        ? { code_challenge: request.codeChallenge, code_challenge_method: 'S256' }
        : {}),
    });
    return {
      url: `https://mock.invalid/authorize?${params.toString()}`,
      scopes: request.scopes,
      usesPkce: Boolean(request.codeChallenge),
    };
  }

  exchange(request: ExchangeRequest): Promise<TokenSet> {
    if (this.failure) return Promise.reject(this.failure);
    this.exchanges.push(request);
    this.tokenCounter += 1;

    return Promise.resolve({
      accessToken: `mock-access-${this.tokenCounter}`,
      refreshToken: `mock-refresh-${this.tokenCounter}`,
      expiresAt:
        this.expiresInSeconds === null
          ? null
          : new Date(Date.now() + this.expiresInSeconds * 1_000),
      grantedScopes:
        this.grantOverride ?? this.supported.map((operation) => `scope.${operation}`),
      externalAccountId: 'mock-account-1',
      displayName: 'test@example.invalid',
    });
  }

  refresh(refreshToken: string): Promise<TokenSet> {
    if (this.failure) return Promise.reject(this.failure);
    this.refreshes.push(refreshToken);
    this.tokenCounter += 1;

    return Promise.resolve({
      accessToken: `mock-access-${this.tokenCounter}`,
      // Rotated, so a test can see the stored token change.
      refreshToken: `mock-refresh-${this.tokenCounter}`,
      expiresAt:
        this.expiresInSeconds === null
          ? null
          : new Date(Date.now() + this.expiresInSeconds * 1_000),
      grantedScopes:
        this.grantOverride ?? this.supported.map((operation) => `scope.${operation}`),
      externalAccountId: 'mock-account-1',
      displayName: 'test@example.invalid',
    });
  }

  revoke(token: string): Promise<void> {
    this.revocations.push(token);
    return this.failure ? Promise.reject(this.failure) : Promise.resolve();
  }

  execute(context: ConnectionContext, request: OperationRequest): Promise<OperationResult> {
    if (this.failure) return Promise.reject(this.failure);

    const capability = this.capabilities().operations.find(
      (o) => o.operation === request.operation,
    );
    if (!capability) {
      return Promise.reject(
        new IntegrationError(
          'unsupported',
          this.provider,
          `The stand-in does not support ${request.operation}.`,
        ),
      );
    }
    for (const scope of capability.scopes) {
      if (!context.grantedScopes.includes(scope)) {
        return Promise.reject(
          new IntegrationError(
            'scope_missing',
            this.provider,
            'This connection was not granted the access that needs.',
          ),
        );
      }
    }

    this.calls.push({ operation: request.operation, input: request.input });

    return Promise.resolve({
      fidelity: capability.fidelity,
      detail: `Recorded ${request.operation}. Nothing was sent.`,
      providerRef: `mock-ref-${this.calls.length}`,
      data: { recorded: true, operation: request.operation, reachedAnybody: false as const },
    });
  }

  health(): Promise<ProviderHealth> {
    return Promise.resolve({
      provider: this.provider,
      configured: true,
      reachable: true,
      checkedAt: new Date().toISOString(),
      detail: 'Deterministic stand-in. Records requests; contacts nothing.',
    });
  }
}
