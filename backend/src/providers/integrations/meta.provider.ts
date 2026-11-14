import { ConnectionProvider } from '@prisma/client';
import { z } from 'zod';
import { IntegrationError, codeForStatus } from './errors';
import { withTimeout } from './reliability';
import type {
  AuthorizationRequest,
  AuthorizationUrl,
  ConnectionContext,
  ExchangeRequest,
  IntegrationCapabilities,
  IntegrationProvider,
  OperationRequest,
  OperationResult,
  ProviderHealth,
  TokenSet,
} from './types';

const GRAPH = 'https://graph.facebook.com/v21.0';
const AUTH_URL = 'https://www.facebook.com/v21.0/dialog/oauth';

/**
 * Scopes per surface.
 *
 * Every one of these is behind Advanced Access, which means App Review and,
 * for WhatsApp, Business Verification. Standard Access only reaches
 * accounts with a role on the app itself — enough to develop against, not
 * enough to ship. That distinction is the single most important fact about
 * these integrations and it is in the capability metadata, not a comment.
 */
export const META_SCOPES = {
  whatsapp: ['whatsapp_business_messaging', 'whatsapp_business_management'],
  instagram: ['instagram_basic', 'instagram_manage_messages', 'pages_show_list'],
  messenger: ['pages_messaging', 'pages_show_list', 'pages_manage_metadata'],
} as const;

const sendInput = z.object({
  /** A phone number in international form, or a provider-scoped user id. */
  recipient: z.string().trim().min(3).max(200),
  message: z.string().trim().min(1).max(4_096),
});

const listThreadsInput = z.object({
  limit: z.number().int().min(1).max(25).default(10),
});

/**
 * Meta: WhatsApp Business Platform, Instagram messaging, Messenger.
 *
 * One adapter because all three go through the Graph API with one OAuth
 * client and one token endpoint, and differ mainly in which edge a message
 * is posted to.
 *
 * ## What this can and cannot do
 *
 * **It cannot touch a personal WhatsApp account.** There is no official API
 * for one, and there is no supported way to automate WhatsApp on somebody's
 * phone. What exists is the WhatsApp Business Platform: a business phone
 * number, a verified business, and a reviewed app. A user with an ordinary
 * WhatsApp account connects nothing here — the honest route for them is the
 * user-assisted connector, which opens a draft on their device.
 *
 * **Messaging is windowed.** WhatsApp allows free-form replies only within
 * 24 hours of the user's last message; outside that window only an approved
 * template may be sent. Instagram and Messenger have the same shape of rule.
 * This adapter does not try to work around it: a send outside the window
 * fails with the provider's own error, reported as a failure rather than
 * retried or disguised.
 *
 * **A send is `accepted`, never `verified`.** The Graph API returns a
 * message id meaning it has taken the message. Whether it reached the
 * recipient's phone is a webhook away, and this build has no webhook
 * receiver — so nothing here claims delivery.
 */
export class MetaIntegrationProvider implements IntegrationProvider {
  readonly kind = 'official-api' as const;

  constructor(
    readonly provider: ConnectionProvider,
    private readonly appId: string | undefined,
    private readonly appSecret: string | undefined,
    /** The business phone number id, for WhatsApp only. */
    private readonly whatsappPhoneNumberId: string | undefined,
  ) {}

  get configured(): boolean {
    if (!this.appId || !this.appSecret) return false;
    // WhatsApp additionally needs a business phone number; without one
    // there is nothing to send from, so the connection would be useless.
    if (this.provider === ConnectionProvider.WHATSAPP) {
      return Boolean(this.whatsappPhoneNumberId);
    }
    return true;
  }

  private get scopes(): readonly string[] {
    switch (this.provider) {
      case ConnectionProvider.WHATSAPP:
        return META_SCOPES.whatsapp;
      case ConnectionProvider.INSTAGRAM:
        return META_SCOPES.instagram;
      default:
        return META_SCOPES.messenger;
    }
  }

  capabilities(): IntegrationCapabilities {
    const shared = [
      'Every scope below is Advanced Access: it requires App Review before the ' +
        'integration works for anyone without a role on the app.',
      'Message delivery is confirmed by webhook, which this build does not receive. ' +
        'A send is therefore reported as accepted by Meta, never as delivered.',
    ];

    if (this.provider === ConnectionProvider.WHATSAPP) {
      return {
        provider: this.provider,
        label: 'WhatsApp Business',
        kind: this.kind,
        configured: this.configured,
        supportsOAuth: true,
        supportsRefresh: false,
        supportsRevoke: true,
        operations: [
          {
            operation: 'messages.send',
            fidelity: 'accepted',
            scopes: [...META_SCOPES.whatsapp],
            requiresConfirmation: true,
            limitations: [
              'Free-form text only within 24 hours of the recipient’s last message. ' +
                'Outside that window, only an approved template may be sent — this ' +
                'adapter does not send templates, so such an attempt fails.',
              'Sends from a business phone number, not the user’s own.',
            ],
          },
        ],
        limitations: [
          ...shared,
          'This is the WhatsApp Business Platform. A personal WhatsApp account cannot ' +
            'be connected here: no official API exists for one, and no supported way ' +
            'to automate the app on a phone. For a personal account the assistant uses ' +
            'the user-assisted connector, which prepares a draft and opens WhatsApp.',
          'Requires Business Verification and a WhatsApp Business Account in addition ' +
            'to App Review.',
          'Access tokens from this flow are long-lived rather than refreshable; when ' +
            'one expires the user reconnects.',
        ],
        documentationUrl: 'https://developers.facebook.com/docs/whatsapp/cloud-api',
      };
    }

    const isInstagram = this.provider === ConnectionProvider.INSTAGRAM;
    return {
      provider: this.provider,
      label: isInstagram ? 'Instagram' : 'Facebook Messenger',
      kind: this.kind,
      configured: this.configured,
      supportsOAuth: true,
      supportsRefresh: false,
      supportsRevoke: true,
      operations: [
        {
          operation: 'messages.send',
          fidelity: 'accepted',
          scopes: [...this.scopes],
          requiresConfirmation: true,
          limitations: [
            'Replies only within 24 hours of the person’s last message; outside that ' +
              'window a send fails unless it qualifies for a documented exception, ' +
              'which this adapter does not claim.',
            isInstagram
              ? 'Requires a Professional (Business or Creator) Instagram account linked ' +
                'to a Facebook Page. A personal Instagram account cannot be connected.'
              : 'Sends as the Page, not as the person. A personal Facebook profile ' +
                'cannot be connected.',
          ],
        },
        {
          operation: 'threads.list',
          fidelity: 'verified',
          scopes: [...this.scopes],
          requiresConfirmation: false,
          limitations: ['Conversations the Page or professional account participates in.'],
        },
      ],
      limitations: [
        ...shared,
        isInstagram
          ? 'Instagram messaging goes through the linked Facebook Page’s token.'
          : 'Messenger acts on behalf of a Page the user administers.',
      ],
      documentationUrl: isInstagram
        ? 'https://developers.facebook.com/docs/messenger-platform/instagram'
        : 'https://developers.facebook.com/docs/messenger-platform',
    };
  }

  authorizationUrl(request: AuthorizationRequest): AuthorizationUrl {
    if (!this.appId) {
      throw new IntegrationError('auth', this.provider, 'No Meta app is configured.');
    }

    const scopes = [...new Set([...this.scopes, ...request.scopes])];
    const params = new URLSearchParams({
      client_id: this.appId,
      redirect_uri: request.redirectUri,
      response_type: 'code',
      scope: scopes.join(','),
      state: request.state,
    });

    // Meta's dialog does not support PKCE for the server-side flow, so it
    // is not claimed. The state parameter plus a server-side single-use
    // record is what protects this flow — see `OAuthService`.
    return { url: `${AUTH_URL}?${params.toString()}`, scopes, usesPkce: false };
  }

  async exchange(request: ExchangeRequest, timeoutMs: number): Promise<TokenSet> {
    if (!this.appId || !this.appSecret) {
      throw new IntegrationError('auth', this.provider, 'No Meta app is configured.');
    }

    const params = new URLSearchParams({
      client_id: this.appId,
      client_secret: this.appSecret,
      redirect_uri: request.redirectUri,
      code: request.code,
    });

    const payload = await this.graph<{
      access_token?: unknown;
      expires_in?: unknown;
    }>(`${GRAPH}/oauth/access_token?${params.toString()}`, timeoutMs);

    if (typeof payload.access_token !== 'string') {
      throw new IntegrationError('invalid_output', this.provider, 'Meta returned no access token.');
    }

    const identity = await this.identity(payload.access_token, timeoutMs);
    const granted = await this.grantedScopes(payload.access_token, timeoutMs);

    return {
      accessToken: payload.access_token,
      // Meta's server-side flow issues a long-lived token rather than a
      // refresh token. Reported as null rather than invented.
      refreshToken: null,
      expiresAt:
        typeof payload.expires_in === 'number'
          ? new Date(Date.now() + payload.expires_in * 1_000)
          : null,
      grantedScopes: granted,
      externalAccountId: identity.id,
      displayName: identity.name,
    };
  }

  /**
   * Revokes the app's permissions on the user's account.
   *
   * `DELETE /me/permissions` is the whole grant, not one scope — which is
   * what disconnecting should mean.
   */
  async revoke(token: string, timeoutMs: number): Promise<void> {
    await this.graph(`${GRAPH}/me/permissions?access_token=${encodeURIComponent(token)}`, timeoutMs, {
      method: 'DELETE',
    }).catch((error: unknown) => {
      // An already-invalid token is the desired end state.
      if (error instanceof IntegrationError && error.status === 400) return;
      throw error;
    });
  }

  async execute(
    context: ConnectionContext,
    request: OperationRequest,
  ): Promise<OperationResult> {
    const capability = this.capabilities().operations.find(
      (o) => o.operation === request.operation,
    );
    if (!capability) {
      throw new IntegrationError(
        'unsupported',
        this.provider,
        `${this.provider} cannot ${request.operation}.`,
      );
    }
    for (const scope of capability.scopes) {
      if (!context.grantedScopes.includes(scope)) {
        throw new IntegrationError(
          'scope_missing',
          this.provider,
          'This connection was not granted the access that needs.',
        );
      }
    }

    switch (request.operation) {
      case 'messages.send':
        return this.send(context, request);
      case 'threads.list':
        return this.listThreads(context, request);
      default:
        throw new IntegrationError(
          'unsupported',
          this.provider,
          `${this.provider} cannot ${request.operation}.`,
        );
    }
  }

  health(): Promise<ProviderHealth> {
    return Promise.resolve({
      provider: this.provider,
      configured: this.configured,
      reachable: null,
      checkedAt: new Date().toISOString(),
      detail: this.configured
        ? 'Meta app configured; not probed.'
        : this.provider === ConnectionProvider.WHATSAPP
          ? 'Needs META_APP_ID, META_APP_SECRET and WHATSAPP_PHONE_NUMBER_ID.'
          : 'Needs META_APP_ID and META_APP_SECRET.',
    });
  }

  // ───────────────────────────────────────────────────────── operations

  private async send(
    context: ConnectionContext,
    request: OperationRequest,
  ): Promise<OperationResult> {
    const input = sendInput.parse(request.input);

    if (this.provider === ConnectionProvider.WHATSAPP) {
      if (!this.whatsappPhoneNumberId) {
        throw new IntegrationError(
          'unsupported',
          this.provider,
          'No business phone number is configured, so there is nothing to send from.',
        );
      }

      const payload = await this.graph<{ messages?: { id?: string }[] }>(
        `${GRAPH}/${this.whatsappPhoneNumberId}/messages`,
        request.timeoutMs,
        {
          method: 'POST',
          token: context.accessToken,
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: input.recipient.replace(/\D/g, ''),
            type: 'text',
            text: { preview_url: false, body: input.message },
          }),
        },
      );

      const id = payload.messages?.[0]?.id ?? null;
      return {
        // Accepted, not verified. Delivery is a webhook away and this build
        // has no receiver, so claiming it would be a guess.
        fidelity: 'accepted',
        detail: 'WhatsApp accepted the message. Delivery is not confirmed.',
        providerRef: id,
        data: { messageId: id, deliveryConfirmed: false as const },
      };
    }

    // Instagram and Messenger both post to the Page's message edge.
    const payload = await this.graph<{ message_id?: string }>(
      `${GRAPH}/me/messages`,
      request.timeoutMs,
      {
        method: 'POST',
        token: context.accessToken,
        body: JSON.stringify({
          recipient: { id: input.recipient },
          message: { text: input.message },
          messaging_type: 'RESPONSE',
        }),
      },
    );

    return {
      fidelity: 'accepted',
      detail: `${this.provider === ConnectionProvider.INSTAGRAM ? 'Instagram' : 'Messenger'} accepted the message. Delivery is not confirmed.`,
      providerRef: payload.message_id ?? null,
      data: { messageId: payload.message_id ?? null, deliveryConfirmed: false as const },
    };
  }

  private async listThreads(
    context: ConnectionContext,
    request: OperationRequest,
  ): Promise<OperationResult> {
    const input = listThreadsInput.parse(request.input);

    const payload = await this.graph<{
      data?: { id: string; updated_time?: string; snippet?: string }[];
    }>(
      `${GRAPH}/me/conversations?fields=id,updated_time,snippet&limit=${input.limit}`,
      request.timeoutMs,
      { token: context.accessToken },
    );

    const threads = (payload.data ?? []).map((t) => ({
      threadId: t.id,
      updatedAt: t.updated_time ?? null,
      snippet: t.snippet ?? null,
    }));

    return {
      fidelity: 'verified',
      detail: `${threads.length} conversation${threads.length === 1 ? '' : 's'}.`,
      providerRef: null,
      data: { threads },
    };
  }

  // ─────────────────────────────────────────────────────────── plumbing

  private identity(
    token: string,
    timeoutMs: number,
  ): Promise<{ id: string | null; name: string | null }> {
    return this.graph<{ id?: string; name?: string }>(`${GRAPH}/me?fields=id,name`, timeoutMs, {
      token,
    })
      .then((payload) => ({ id: payload.id ?? null, name: payload.name ?? null }))
      .catch(() => ({ id: null, name: null }));
  }

  /**
   * What Meta actually granted.
   *
   * Read back from `/me/permissions` rather than assumed from the request,
   * because a user can untick individual permissions on the consent screen
   * and the token will still be issued.
   */
  private grantedScopes(token: string, timeoutMs: number): Promise<string[]> {
    return this.graph<{ data?: { permission?: string; status?: string }[] }>(
      `${GRAPH}/me/permissions`,
      timeoutMs,
      { token },
    )
      .then((payload) =>
        (payload.data ?? [])
          .filter((entry) => entry.status === 'granted' && typeof entry.permission === 'string')
          .map((entry) => entry.permission!),
      )
      .catch(() => []);
  }

  private graph<T>(
    url: string,
    timeoutMs: number,
    init: { method?: string; body?: string; token?: string } = {},
  ): Promise<T> {
    return withTimeout(this.provider, timeoutMs, async (signal) => {
      let response: Response;
      try {
        response = await fetch(url, {
          method: init.method ?? 'GET',
          headers: {
            ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
            ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: init.body,
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new IntegrationError('unavailable', this.provider, 'Could not reach Meta.', {
          cause: error,
        });
      }

      if (!response.ok) {
        // Meta's error body names the app and echoes parameters, so it is
        // not relayed. The status and its own code are enough to act on.
        const retryAfter = Number(response.headers.get('retry-after'));
        throw new IntegrationError(
          codeForStatus(response.status),
          this.provider,
          `Meta returned ${response.status}.`,
          {
            status: response.status,
            retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : undefined,
          },
        );
      }

      if (response.status === 204) return {} as T;
      return (await response.json()) as T;
    });
  }
}
