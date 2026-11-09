import type { DevicePlatform } from '@prisma/client';

/**
 * The push contract.
 *
 * One message, one device token, one answer. Everything about *whether* to
 * send — preferences, quiet hours, deduplication — lives above this layer,
 * so adding a transport is one file.
 */

export interface PushMessage {
  readonly title: string;
  readonly body: string | null;
  /** Routing payload: deep link, entity ids. Never sensitive content. */
  readonly data: Record<string, string>;
  /** Grouping key, so a second notification about one thing replaces the first. */
  readonly collapseKey?: string | null;
  /** True for something time-critical, which some transports treat differently. */
  readonly urgent?: boolean;
}

export interface PushTarget {
  readonly token: string;
  readonly platform: DevicePlatform;
}

export interface PushResult {
  /** The transport's handle, where it gives one. */
  readonly providerRef: string | null;
  /**
   * What a transport accepting a message actually means. Spelled out
   * because it is the thing most easily overstated: it has taken
   * responsibility for trying, and nothing more. It has not reached the
   * device, and nobody has seen it.
   */
  readonly accepted: true;
}

export interface PushProviderHealth {
  readonly id: string;
  readonly configured: boolean;
  readonly reachable: boolean | null;
  readonly checkedAt: string;
  readonly detail: string;
}

export interface PushProvider {
  readonly id: string;
  readonly label: string;
  readonly kind: 'real' | 'mock';
  readonly configured: boolean;
  /** Which device platforms this transport can reach. */
  readonly platforms: readonly DevicePlatform[];

  send(message: PushMessage, target: PushTarget, timeoutMs: number): Promise<PushResult>;
  health(): Promise<PushProviderHealth>;
}

export const PUSH_PROVIDER = Symbol('PUSH_PROVIDER');
