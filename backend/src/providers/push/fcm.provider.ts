import { createSign } from 'node:crypto';
import { DevicePlatform } from '@prisma/client';
import { PushError, codeForStatus } from './errors';
import { withTimeout } from './reliability';
import type { PushMessage, PushProvider, PushProviderHealth, PushResult, PushTarget } from './types';

/** The service account fields this adapter needs. */
export interface FcmServiceAccount {
  readonly projectId: string;
  readonly clientEmail: string;
  /** PEM private key. Newlines may be escaped, as they are in the JSON file. */
  readonly privateKey: string;
}

/**
 * Parses a service-account JSON document.
 *
 * Returns null rather than throwing, so a malformed credential leaves the
 * provider unconfigured — and therefore never selected — instead of
 * crashing the process at startup.
 */
export function parseServiceAccount(json: string | undefined): FcmServiceAccount | null {
  if (!json?.trim()) return null;

  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const projectId = parsed.project_id ?? parsed.projectId;
    const clientEmail = parsed.client_email ?? parsed.clientEmail;
    const privateKey = parsed.private_key ?? parsed.privateKey;

    if (
      typeof projectId !== 'string' ||
      typeof clientEmail !== 'string' ||
      typeof privateKey !== 'string'
    ) {
      return null;
    }

    return {
      projectId,
      clientEmail,
      // The JSON file carries literal `\n`; a PEM needs real newlines.
      privateKey: privateKey.replace(/\\n/g, '\n'),
    };
  } catch {
    return null;
  }
}

/** Google's token endpoint, and the scope FCM needs. */
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/**
 * Firebase Cloud Messaging, HTTP v1.
 *
 * Reaches Android, and iOS where the app is registered through Firebase.
 *
 * The authentication is the substantial part and it is implemented properly:
 * a service account signs an RS256 JWT, exchanges it for an access token,
 * and the token is cached until shortly before it expires. There is no
 * long-lived API key for v1 — the legacy server key it replaced is
 * deprecated and sends to a different endpoint — so doing this any other way
 * would mean not actually supporting FCM.
 *
 * Without a service account the provider is unconfigured and the registry
 * will not select it. Nothing here pretends to send.
 */
export class FcmPushProvider implements PushProvider {
  readonly id = 'fcm';
  readonly label = 'Firebase Cloud Messaging';
  readonly kind = 'real' as const;
  readonly platforms: readonly DevicePlatform[] = [DevicePlatform.ANDROID, DevicePlatform.IOS];

  private readonly account: FcmServiceAccount | null;
  private cachedToken: { value: string; expiresAt: number } | null = null;

  constructor(serviceAccountJson: string | undefined) {
    this.account = parseServiceAccount(serviceAccountJson);
  }

  get configured(): boolean {
    return this.account !== null;
  }

  async send(message: PushMessage, target: PushTarget, timeoutMs: number): Promise<PushResult> {
    if (!this.account) {
      throw new PushError('auth', this.id, 'No Firebase service account is configured.');
    }

    const token = await this.accessToken(timeoutMs);

    return withTimeout(this.id, timeoutMs, async (signal) => {
      let response: Response;
      try {
        response = await fetch(
          `https://fcm.googleapis.com/v1/projects/${this.account!.projectId}/messages:send`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              message: {
                token: target.token,
                notification: { title: message.title, body: message.body ?? undefined },
                data: message.data,
                android: {
                  priority: message.urgent ? 'HIGH' : 'NORMAL',
                  ...(message.collapseKey ? { collapse_key: message.collapseKey } : {}),
                },
                apns: {
                  headers: {
                    'apns-priority': message.urgent ? '10' : '5',
                    ...(message.collapseKey ? { 'apns-collapse-id': message.collapseKey } : {}),
                  },
                },
              },
            }),
            signal,
          },
        );
      } catch (error) {
        if (signal.aborted) throw error;
        throw new PushError('unavailable', this.id, 'Could not reach Firebase.', { cause: error });
      }

      if (!response.ok) {
        const retryAfter = Number(response.headers.get('retry-after'));
        throw new PushError(
          codeForStatus(response.status),
          this.id,
          `Firebase returned ${response.status}.`,
          {
            status: response.status,
            retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : undefined,
          },
        );
      }

      const payload = (await response.json().catch(() => ({}))) as { name?: unknown };
      return {
        providerRef: typeof payload.name === 'string' ? payload.name : null,
        accepted: true as const,
      };
    });
  }

  /**
   * An OAuth access token, cached.
   *
   * Refreshed a minute before expiry rather than at expiry, so a request
   * that starts just in time does not finish just too late.
   */
  private async accessToken(timeoutMs: number): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + 60_000) {
      return this.cachedToken.value;
    }

    const assertion = this.signAssertion();

    const payload = await withTimeout(this.id, timeoutMs, async (signal) => {
      let response: Response;
      try {
        response = await fetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion,
          }),
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new PushError('unavailable', this.id, 'Could not reach the token endpoint.', {
          cause: error,
        });
      }

      if (!response.ok) {
        // The body can quote the assertion, so it is not logged or relayed.
        throw new PushError(
          codeForStatus(response.status),
          this.id,
          `Token endpoint returned ${response.status}.`,
          { status: response.status },
        );
      }

      return (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    });

    if (typeof payload.access_token !== 'string') {
      throw new PushError('invalid_output', this.id, 'Token endpoint returned no access token.');
    }

    const lifetimeSeconds =
      typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in)
        ? payload.expires_in
        : 3_600;

    this.cachedToken = {
      value: payload.access_token,
      expiresAt: Date.now() + lifetimeSeconds * 1_000,
    };
    return this.cachedToken.value;
  }

  /** The RS256 JWT a service account presents to get a token. */
  signAssertion(now = Math.floor(Date.now() / 1000)): string {
    if (!this.account) throw new PushError('auth', this.id, 'No service account.');

    const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64Url(
      JSON.stringify({
        iss: this.account.clientEmail,
        scope: SCOPE,
        aud: TOKEN_URL,
        iat: now,
        // An hour is the maximum Google accepts.
        exp: now + 3_600,
      }),
    );

    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    const signature = signer.sign(this.account.privateKey, 'base64url');

    return `${header}.${claims}.${signature}`;
  }

  health(): Promise<PushProviderHealth> {
    return Promise.resolve({
      id: this.id,
      configured: this.configured,
      // Not probed: a readiness check must not spend a token exchange, and
      // a successful exchange would not prove a device token is valid.
      reachable: null,
      checkedAt: new Date().toISOString(),
      detail: this.configured
        ? `Service account configured for project ${this.account!.projectId}.`
        : 'No Firebase service account configured.',
    });
  }
}

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}
