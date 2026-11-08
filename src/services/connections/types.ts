import type { GlyphName } from '@/features/orb/types';

/**
 * How a capability can be carried out today.
 *
 * - `local`    — this device does it and can verify the result.
 * - `assisted` — the app prepares it and hands it over; the user finishes.
 * - `account`  — needs an authorised account connection that does not exist yet.
 */
export type CapabilityMode = 'local' | 'assisted' | 'account';

export interface Capability {
  readonly id: string;
  readonly label: string;
  readonly mode: CapabilityMode;
  /** What the user has to do, or why it is not possible yet. */
  readonly note: string;
  /** Present for `assisted` capabilities the card can trigger directly. */
  readonly launchUrl?: string;
}

export interface AppIntegration {
  readonly id: string;
  readonly name: string;
  readonly brandColor: string;
  readonly glyph: GlyphName;
  /** What this integration is for, in one line. */
  readonly summary: string;
  readonly capabilities: readonly Capability[];
  /** The authorisation an account connection would require. */
  readonly authScopes: readonly string[];
}

export type ConnectionState =
  /** Works now, on this device, with no account. */
  | { readonly status: 'local'; readonly detail: string }
  /** No account is linked. The only honest default without a service. */
  | { readonly status: 'not-connected'; readonly detail: string }
  /** An authorisation attempt is open. */
  | { readonly status: 'connecting'; readonly detail: string }
  /** Confirmed by the integration service. */
  | { readonly status: 'connected'; readonly account: string; readonly since: string }
  | { readonly status: 'error'; readonly detail: string };

export class ConnectionError extends Error {
  readonly reason: 'no-service' | 'cancelled' | 'failed';
  constructor(reason: ConnectionError['reason'], message: string) {
    super(message);
    this.name = 'ConnectionError';
    this.reason = reason;
  }
}

/**
 * The integration service contract.
 *
 * A connection is only ever reported as live because this provider said so.
 * Nothing about an account is stored in the browser: OAuth tokens belong to a
 * backend the frontend never sees, which is why `connect` here cannot
 * succeed on its own.
 */
export interface ConnectionsProvider {
  readonly id: string;
  /** False when no integration backend is configured for this build. */
  readonly configured: boolean;
  /** Why connections cannot be made, when `configured` is false. */
  readonly unavailableReason: string;
  state: (appId: string) => ConnectionState;
  connect: (appId: string) => Promise<ConnectionState>;
  disconnect: (appId: string) => Promise<ConnectionState>;
}
