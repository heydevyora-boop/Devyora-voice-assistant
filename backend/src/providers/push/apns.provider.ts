import { createSign } from 'node:crypto';
import { DevicePlatform } from '@prisma/client';
import { PushError, codeForStatus } from './errors';
import { withTimeout } from './reliability';
import type { PushMessage, PushProvider, PushProviderHealth, PushResult, PushTarget } from './types';

export interface ApnsCredentials {
  /** The ten-character key id from the Apple developer portal. */
  readonly keyId: string;
  /** The ten-character team id. */
  readonly teamId: string;
  /** The app's bundle identifier, which APNs uses as the topic. */
  readonly bundleId: string;
  /** The PEM-encoded ES256 private key (.p8 contents). */
  readonly privateKey: string;
  /** Apple's sandbox endpoint for development builds. */
  readonly sandbox: boolean;
}

/**
 * Apple Push Notification service, token-based.
 *
 * Reaches iOS, and macOS where a native client is registered.
 *
 * As with FCM, the authentication is the real work and it is implemented:
 * an ES256 JWT signed with the .p8 key, cached and reused — Apple allows a
 * token to live up to an hour and rejects one older than that, so refreshing
 * every request would be both slow and wrong.
 *
 * Certificate-based authentication is deliberately not supported. Apple has
 * deprecated it, it needs a TLS client certificate rather than a header, and
 * supporting both would double this file for a path nobody should take.
 *
 * Without credentials the provider is unconfigured and the registry will not
 * select it.
 */
export class ApnsPushProvider implements PushProvider {
  readonly id = 'apns';
  readonly label = 'Apple Push Notification service';
  readonly kind = 'real' as const;
  readonly platforms: readonly DevicePlatform[] = [DevicePlatform.IOS, DevicePlatform.MACOS];

  private readonly credentials: ApnsCredentials | null;
  private cachedToken: { value: string; issuedAt: number } | null = null;

  constructor(credentials: Partial<ApnsCredentials> | null) {
    this.credentials =
      credentials?.keyId && credentials.teamId && credentials.bundleId && credentials.privateKey
        ? {
            keyId: credentials.keyId,
            teamId: credentials.teamId,
            bundleId: credentials.bundleId,
            privateKey: credentials.privateKey.replace(/\\n/g, '\n'),
            sandbox: credentials.sandbox ?? false,
          }
        : null;
  }

  get configured(): boolean {
    return this.credentials !== null;
  }

  async send(message: PushMessage, target: PushTarget, timeoutMs: number): Promise<PushResult> {
    if (!this.credentials) {
      throw new PushError('auth', this.id, 'No APNs credentials are configured.');
    }

    const token = this.authToken();
    const host = this.credentials.sandbox
      ? 'api.sandbox.push.apple.com'
      : 'api.push.apple.com';

    return withTimeout(this.id, timeoutMs, async (signal) => {
      let response: Response;
      try {
        response = await fetch(`https://${host}/3/device/${encodeURIComponent(target.token)}`, {
          method: 'POST',
          headers: {
            authorization: `bearer ${token}`,
            'apns-topic': this.credentials!.bundleId,
            'apns-push-type': 'alert',
            'apns-priority': message.urgent ? '10' : '5',
            ...(message.collapseKey ? { 'apns-collapse-id': message.collapseKey } : {}),
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            aps: {
              alert: { title: message.title, body: message.body ?? undefined },
              sound: message.urgent ? 'default' : undefined,
            },
            // Custom keys sit alongside `aps`, not inside it.
            ...message.data,
          }),
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new PushError('unavailable', this.id, 'Could not reach APNs.', { cause: error });
      }

      if (!response.ok) {
        throw new PushError(
          codeForStatus(response.status),
          this.id,
          `APNs returned ${response.status}.`,
          { status: response.status },
        );
      }

      return {
        // APNs returns its id in a header, not a body.
        providerRef: response.headers.get('apns-id'),
        accepted: true as const,
      };
    });
  }

  /**
   * The ES256 JWT APNs accepts as a bearer token.
   *
   * Reused while it is young. Apple rejects a token older than an hour and
   * also rejects one minted too often, so this refreshes at fifty minutes —
   * comfortably inside the window from both directions.
   */
  authToken(now = Math.floor(Date.now() / 1000)): string {
    if (!this.credentials) throw new PushError('auth', this.id, 'No APNs credentials.');

    if (this.cachedToken && now - this.cachedToken.issuedAt < 3_000) {
      return this.cachedToken.value;
    }

    const header = base64Url(
      JSON.stringify({ alg: 'ES256', kid: this.credentials.keyId, typ: 'JWT' }),
    );
    const claims = base64Url(JSON.stringify({ iss: this.credentials.teamId, iat: now }));

    const signer = createSign('SHA256');
    signer.update(`${header}.${claims}`);
    // APNs requires the JOSE form (r||s), not the DER form Node emits by
    // default. Getting this wrong produces a 403 that looks like a bad key.
    const signature = signer.sign(
      { key: this.credentials.privateKey, dsaEncoding: 'ieee-p1363' },
      'base64url',
    );

    this.cachedToken = { value: `${header}.${claims}.${signature}`, issuedAt: now };
    return this.cachedToken.value;
  }

  health(): Promise<PushProviderHealth> {
    return Promise.resolve({
      id: this.id,
      configured: this.configured,
      reachable: null,
      checkedAt: new Date().toISOString(),
      detail: this.configured
        ? `Token authentication configured for ${this.credentials!.bundleId}` +
          `${this.credentials!.sandbox ? ' (sandbox)' : ''}.`
        : 'No APNs credentials configured.',
    });
  }
}

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}
