import type { ConnectionProvider } from '@prisma/client';

/**
 * The integration contract.
 *
 * Three kinds of connector, kept apart because they differ in what they can
 * honestly promise — and conflating them is how an assistant comes to claim
 * it sent a message it only drafted.
 */
export type ConnectorKind =
  /**
   * An official API with authorised credentials. Can act on the user's
   * behalf and read back what happened, so a result can be verified.
   */
  | 'official-api'
  /**
   * The server prepares something and the person completes it elsewhere —
   * a draft opened in an app, a compose window. Nothing is sent by us, and
   * whether the person pressed send is unknowable from here.
   */
  | 'user-assisted'
  /**
   * A descriptor handed to the device, which decides whether to open it.
   * No credential, no account, no observable outcome.
   */
  | 'native-launch';

/**
 * What an operation can be.
 *
 * Named rather than free strings so the capability table and the action
 * registry cannot drift: a provider advertising `messages.send` is making a
 * specific claim that something checks.
 */
export type IntegrationOperation =
  | 'messages.send'
  | 'messages.prepare'
  | 'messages.list'
  | 'threads.list'
  | 'email.send'
  | 'email.draft'
  | 'email.list'
  | 'calendar.events.list'
  | 'calendar.events.create'
  | 'profile.read';

/**
 * How well an outcome can be known.
 *
 * This is the field that stops a hand-off being reported as a send. It is
 * per operation, not per provider: Gmail can verify a draft it created and
 * cannot verify that a recipient read it.
 */
export type OutcomeFidelity =
  /** The effect was performed and read back. */
  | 'verified'
  /** The provider accepted it and gave a handle. Delivery is its business. */
  | 'accepted'
  /** Something was prepared. A person must still act. */
  | 'prepared';

export interface OperationCapability {
  readonly operation: IntegrationOperation;
  readonly fidelity: OutcomeFidelity;
  /** Scopes this operation needs, beyond the connection's own. */
  readonly scopes: readonly string[];
  /** Whether the server requires explicit user confirmation first. */
  readonly requiresConfirmation: boolean;
  /**
   * Stated eligibility limits in the provider's own terms — app review,
   * business verification, a 24-hour messaging window. Written here because
   * "the API exists" and "this account may use it" are different facts, and
   * the second is the one that decides whether an action works.
   */
  readonly limitations: readonly string[];
}

/** What a provider can do, as it actually is rather than as advertised. */
export interface IntegrationCapabilities {
  readonly provider: ConnectionProvider;
  readonly label: string;
  readonly kind: ConnectorKind;
  /** Whether this backend holds the credentials to talk to the provider. */
  readonly configured: boolean;
  /** Whether a user can start an OAuth flow for it. */
  readonly supportsOAuth: boolean;
  readonly supportsRefresh: boolean;
  readonly supportsRevoke: boolean;
  readonly operations: readonly OperationCapability[];
  /** Limits that apply to the whole connection, not one operation. */
  readonly limitations: readonly string[];
  /** Where a user goes to understand what they are granting. */
  readonly documentationUrl: string | null;
}

// ─────────────────────────────────────────────────────────────── OAuth

export interface AuthorizationRequest {
  readonly state: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  /** PKCE challenge, where the provider supports it. */
  readonly codeChallenge?: string | null;
}

export interface AuthorizationUrl {
  readonly url: string;
  /** Scopes actually requested, after the provider's own normalisation. */
  readonly scopes: readonly string[];
  readonly usesPkce: boolean;
}

export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  /** When the access token stops working. Null when the provider says never. */
  readonly expiresAt: Date | null;
  /** What was actually granted, which may be less than what was asked. */
  readonly grantedScopes: readonly string[];
  readonly externalAccountId: string | null;
  readonly displayName: string | null;
}

export interface ExchangeRequest {
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier?: string | null;
}

// ────────────────────────────────────────────────────────── operations

export interface OperationRequest {
  readonly operation: IntegrationOperation;
  /** Validated by the provider against its own schema. */
  readonly input: Record<string, unknown>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface OperationResult<T = unknown> {
  readonly fidelity: OutcomeFidelity;
  /** One sentence for the user, in the provider's own honest terms. */
  readonly detail: string;
  /** The provider's handle, where it gives one. */
  readonly providerRef: string | null;
  readonly data: T;
}

export interface ConnectionContext {
  readonly userId: string;
  readonly connectionId: string;
  readonly accessToken: string;
  readonly externalAccountId: string | null;
  readonly grantedScopes: readonly string[];
}

export interface ProviderHealth {
  readonly provider: ConnectionProvider;
  readonly configured: boolean;
  readonly reachable: boolean | null;
  readonly checkedAt: string;
  readonly detail: string;
}

/**
 * One integration.
 *
 * Every method is optional except `capabilities` and `health`, because
 * **not every provider supports every operation** — Telegram has no OAuth,
 * a native launch has no credentials to refresh, and a user-assisted
 * connector has nothing to revoke. A caller asks the capability table
 * first; an absent method means the operation is not available, which is a
 * different answer from one that fails.
 */
export interface IntegrationProvider {
  readonly provider: ConnectionProvider;
  readonly kind: ConnectorKind;
  readonly configured: boolean;

  capabilities(): IntegrationCapabilities;
  health(): Promise<ProviderHealth>;

  /** Builds the URL a user is sent to. Absent when there is no OAuth flow. */
  authorizationUrl?(request: AuthorizationRequest): AuthorizationUrl;
  /** Turns a callback code into tokens. Absent when there is no OAuth flow. */
  exchange?(request: ExchangeRequest, timeoutMs: number): Promise<TokenSet>;
  /** Absent when the provider issues no refresh token. */
  refresh?(refreshToken: string, timeoutMs: number): Promise<TokenSet>;
  /** Absent when the provider has no revocation endpoint. */
  revoke?(token: string, timeoutMs: number): Promise<void>;

  /**
   * Connects without OAuth — a bot token, an API key the user pastes.
   * Absent for providers where that is not how it works.
   */
  connectWithSecret?(secret: string, timeoutMs: number): Promise<TokenSet>;

  /** Performs an operation. Absent for a connector that performs nothing. */
  execute?(context: ConnectionContext, request: OperationRequest): Promise<OperationResult>;
}

export const INTEGRATION_PROVIDERS = Symbol('INTEGRATION_PROVIDERS');

/** A capability lookup that does not need the provider instance. */
export function findOperation(
  capabilities: IntegrationCapabilities,
  operation: IntegrationOperation,
): OperationCapability | undefined {
  return capabilities.operations.find((o) => o.operation === operation);
}
