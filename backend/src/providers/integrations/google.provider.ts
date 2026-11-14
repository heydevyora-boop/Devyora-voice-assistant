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

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

/**
 * Scopes, narrowest first.
 *
 * `gmail.compose` rather than `gmail.send`: it allows creating a draft and
 * sending one the user composed, without granting the ability to send
 * arbitrary mail as them. `calendar.events` rather than `calendar`: it
 * reaches events without granting control of calendars themselves.
 *
 * Google treats several of these as sensitive or restricted, which means an
 * unverified app sees an "unverified" interstitial and is capped at a
 * hundred users. That is a real constraint on what this integration can be,
 * so it is stated in the capability metadata rather than discovered later.
 */
export const GOOGLE_SCOPES = {
  identity: ['openid', 'email', 'profile'],
  gmailRead: ['https://www.googleapis.com/auth/gmail.readonly'],
  gmailCompose: ['https://www.googleapis.com/auth/gmail.compose'],
  calendarRead: ['https://www.googleapis.com/auth/calendar.events.readonly'],
  calendarWrite: ['https://www.googleapis.com/auth/calendar.events'],
} as const;

const draftInput = z.object({
  to: z.string().trim().min(3).max(320),
  subject: z.string().trim().max(500).default(''),
  body: z.string().max(100_000),
});

const listEventsInput = z.object({
  from: z.string().datetime({ offset: true }).nullish(),
  to: z.string().datetime({ offset: true }).nullish(),
  limit: z.number().int().min(1).max(50).default(10),
});

const createEventInput = z.object({
  title: z.string().trim().min(1).max(300),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  timezone: z.string().trim().min(1).max(64),
  location: z.string().trim().max(300).nullish(),
  description: z.string().max(5_000).nullish(),
});

const listMessagesInput = z.object({
  query: z.string().trim().max(200).nullish(),
  limit: z.number().int().min(1).max(25).default(10),
});

/**
 * Google, covering Gmail and Calendar.
 *
 * One adapter for both because they share an OAuth client, a token endpoint
 * and a refresh mechanism; splitting them would mean a user authorising
 * twice and two sets of credentials for one grant. Which of the two a
 * connection can actually touch is decided by the scopes that were granted,
 * not by which adapter was used — and `grantedScopes` is checked per
 * operation, because Google may grant less than was asked for.
 *
 * The `provider` field says `GMAIL` or `GOOGLE_CALENDAR` so a user sees two
 * entries in their connections list, which is how they think about it.
 */
export class GoogleIntegrationProvider implements IntegrationProvider {
  readonly kind = 'official-api' as const;

  constructor(
    readonly provider: ConnectionProvider,
    private readonly clientId: string | undefined,
    private readonly clientSecret: string | undefined,
  ) {}

  get configured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  private get isGmail(): boolean {
    return this.provider === ConnectionProvider.GMAIL;
  }

  capabilities(): IntegrationCapabilities {
    const shared = [
      'Google treats Gmail and Calendar scopes as sensitive or restricted. ' +
        'Until the OAuth client passes Google’s verification, the consent screen ' +
        'shows an unverified-app warning and the app is limited to 100 users.',
      'A refresh token is only issued on the first consent, or when access is ' +
        'requested offline with prompt=consent. Losing it means the user must ' +
        'reconnect.',
    ];

    return this.isGmail
      ? {
          provider: this.provider,
          label: 'Gmail',
          kind: this.kind,
          configured: this.configured,
          supportsOAuth: true,
          supportsRefresh: true,
          supportsRevoke: true,
          operations: [
            {
              operation: 'email.list',
              fidelity: 'verified',
              scopes: [...GOOGLE_SCOPES.gmailRead],
              requiresConfirmation: false,
              limitations: ['Reads metadata and snippets only; this adapter never downloads attachments.'],
            },
            {
              operation: 'email.draft',
              fidelity: 'verified',
              scopes: [...GOOGLE_SCOPES.gmailCompose],
              requiresConfirmation: true,
              limitations: [
                'Creates a draft the user sends themselves. The draft is read back, ' +
                  'so its existence is verified — but nothing has been sent.',
              ],
            },
            {
              operation: 'profile.read',
              fidelity: 'verified',
              scopes: [...GOOGLE_SCOPES.identity],
              requiresConfirmation: false,
              limitations: [],
            },
          ],
          limitations: [
            ...shared,
            'Sending mail directly is deliberately not implemented: `gmail.compose` ' +
              'is requested instead of `gmail.send`, so this integration can draft ' +
              'but cannot send on the user’s behalf.',
          ],
          documentationUrl: 'https://developers.google.com/gmail/api/auth/scopes',
        }
      : {
          provider: this.provider,
          label: 'Google Calendar',
          kind: this.kind,
          configured: this.configured,
          supportsOAuth: true,
          supportsRefresh: true,
          supportsRevoke: true,
          operations: [
            {
              operation: 'calendar.events.list',
              fidelity: 'verified',
              scopes: [...GOOGLE_SCOPES.calendarRead],
              requiresConfirmation: false,
              limitations: ['Primary calendar only; this adapter does not enumerate calendars.'],
            },
            {
              operation: 'calendar.events.create',
              fidelity: 'verified',
              scopes: [...GOOGLE_SCOPES.calendarWrite],
              requiresConfirmation: true,
              limitations: [
                'Creates an event on the primary calendar and reads it back. Guests are ' +
                  'not invited: that would send mail to other people, which needs its own ' +
                  'consent.',
              ],
            },
          ],
          limitations: shared,
          documentationUrl: 'https://developers.google.com/calendar/api/auth',
        };
  }

  /**
   * The consent URL.
   *
   * `access_type=offline` with `prompt=consent` is what produces a refresh
   * token. Without both, a re-authorisation silently returns none and the
   * connection expires in an hour with no way back.
   */
  authorizationUrl(request: AuthorizationRequest): AuthorizationUrl {
    if (!this.clientId) {
      throw new IntegrationError('auth', this.provider, 'No Google OAuth client is configured.');
    }

    const scopes = [...new Set([...GOOGLE_SCOPES.identity, ...request.scopes])];

    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: request.redirectUri,
      response_type: 'code',
      scope: scopes.join(' '),
      state: request.state,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
    });

    if (request.codeChallenge) {
      params.set('code_challenge', request.codeChallenge);
      params.set('code_challenge_method', 'S256');
    }

    return {
      url: `${AUTH_URL}?${params.toString()}`,
      scopes,
      usesPkce: Boolean(request.codeChallenge),
    };
  }

  async exchange(request: ExchangeRequest, timeoutMs: number): Promise<TokenSet> {
    this.requireClient();

    const payload = await this.tokenRequest(
      {
        grant_type: 'authorization_code',
        code: request.code,
        redirect_uri: request.redirectUri,
        ...(request.codeVerifier ? { code_verifier: request.codeVerifier } : {}),
      },
      timeoutMs,
    );

    const identity = await this.identity(payload.access_token, timeoutMs);

    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token ?? null,
      expiresAt: payload.expires_in ? new Date(Date.now() + payload.expires_in * 1_000) : null,
      // What Google actually granted, which can be narrower than requested
      // if the user unticked something on the consent screen.
      grantedScopes: payload.scope ? payload.scope.split(' ') : [],
      externalAccountId: identity.sub,
      displayName: identity.email,
    };
  }

  async refresh(refreshToken: string, timeoutMs: number): Promise<TokenSet> {
    this.requireClient();

    const payload = await this.tokenRequest(
      { grant_type: 'refresh_token', refresh_token: refreshToken },
      timeoutMs,
    );

    return {
      accessToken: payload.access_token,
      // A refresh response does not repeat the refresh token, so the
      // caller keeps the one it has rather than overwriting it with null.
      refreshToken: payload.refresh_token ?? null,
      expiresAt: payload.expires_in ? new Date(Date.now() + payload.expires_in * 1_000) : null,
      grantedScopes: payload.scope ? payload.scope.split(' ') : [],
      externalAccountId: null,
      displayName: null,
    };
  }

  /**
   * Revokes at Google, not just locally.
   *
   * Deleting our row would leave the grant live in the user's Google
   * account, which is the sort of thing people discover years later.
   */
  async revoke(token: string, timeoutMs: number): Promise<void> {
    await withTimeout(this.provider, timeoutMs, async (signal) => {
      const response = await fetch(REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }),
        signal,
      }).catch((error: unknown) => {
        if (signal.aborted) throw error;
        throw new IntegrationError('unavailable', this.provider, 'Could not reach Google.', {
          cause: error,
        });
      });

      // 400 means the token was already invalid, which is the desired end
      // state rather than a failure.
      if (!response.ok && response.status !== 400) {
        throw new IntegrationError(
          codeForStatus(response.status),
          this.provider,
          `Google returned ${response.status} when revoking.`,
          { status: response.status },
        );
      }
    });
  }

  async execute(
    context: ConnectionContext,
    request: OperationRequest,
  ): Promise<OperationResult> {
    // The granted scopes decide what this connection may do, not the
    // capability table — the user may have unticked something.
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
      case 'email.list':
        return this.listMessages(context, request);
      case 'email.draft':
        return this.createDraft(context, request);
      case 'calendar.events.list':
        return this.listEvents(context, request);
      case 'calendar.events.create':
        return this.createEvent(context, request);
      case 'profile.read': {
        const identity = await this.identity(context.accessToken, request.timeoutMs);
        return {
          fidelity: 'verified',
          detail: `Signed in as ${identity.email ?? 'an unnamed account'}.`,
          providerRef: identity.sub,
          data: { email: identity.email, accountId: identity.sub },
        };
      }
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
      // Not probed: a readiness check must not spend a token exchange, and
      // a reachable Google says nothing about whether a user's grant is
      // still good.
      reachable: null,
      checkedAt: new Date().toISOString(),
      detail: this.configured
        ? 'OAuth client configured; not probed.'
        : 'No GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET configured.',
    });
  }

  // ───────────────────────────────────────────────────────── operations

  private async listMessages(
    context: ConnectionContext,
    request: OperationRequest,
  ): Promise<OperationResult> {
    const input = listMessagesInput.parse(request.input);

    const params = new URLSearchParams({
      maxResults: String(input.limit),
      ...(input.query ? { q: input.query } : {}),
    });

    const list = await this.api<{ messages?: { id: string }[] }>(
      context.accessToken,
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`,
      request.timeoutMs,
    );

    const ids = (list.messages ?? []).slice(0, input.limit).map((m) => m.id);

    // Metadata only. The adapter deliberately does not fetch bodies: a
    // summary needs headers and a snippet, and pulling whole messages
    // would move far more of someone's mail through this server than the
    // task requires.
    const messages = await Promise.all(
      ids.map((id) =>
        this.api<{
          id: string;
          snippet?: string;
          payload?: { headers?: { name: string; value: string }[] };
        }>(
          context.accessToken,
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}` +
            '?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date',
          request.timeoutMs,
        ),
      ),
    );

    return {
      fidelity: 'verified',
      detail: `Found ${messages.length} message${messages.length === 1 ? '' : 's'}.`,
      providerRef: null,
      data: {
        messages: messages.map((m) => ({
          id: m.id,
          snippet: m.snippet ?? null,
          from: header(m.payload?.headers, 'From'),
          subject: header(m.payload?.headers, 'Subject'),
          date: header(m.payload?.headers, 'Date'),
        })),
      },
    };
  }

  /**
   * Creates a draft, and says so.
   *
   * Not a send. The scope requested is `gmail.compose`, which is what makes
   * this honest at the API level rather than only in wording: this adapter
   * could not send even if something asked it to.
   */
  private async createDraft(
    context: ConnectionContext,
    request: OperationRequest,
  ): Promise<OperationResult> {
    const input = draftInput.parse(request.input);

    const mime = [
      `To: ${input.to}`,
      `Subject: ${input.subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      input.body,
    ].join('\r\n');

    const created = await this.api<{ id: string; message?: { id: string } }>(
      context.accessToken,
      'https://gmail.googleapis.com/gmail/v1/users/me/drafts',
      request.timeoutMs,
      {
        method: 'POST',
        body: JSON.stringify({
          message: { raw: Buffer.from(mime, 'utf8').toString('base64url') },
        }),
      },
    );

    // Read back, which is what earns `verified` — for the draft's
    // existence, not for anything being sent.
    const confirmed = await this.api<{ id: string }>(
      context.accessToken,
      `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${created.id}`,
      request.timeoutMs,
    );

    return {
      fidelity: 'verified',
      detail: 'Draft saved in Gmail. You still need to send it.',
      providerRef: confirmed.id,
      data: {
        draftId: confirmed.id,
        to: input.to,
        subject: input.subject,
        sentByServer: false as const,
        remainingStep: 'Open Gmail and send the draft.',
      },
    };
  }

  private async listEvents(
    context: ConnectionContext,
    request: OperationRequest,
  ): Promise<OperationResult> {
    const input = listEventsInput.parse(request.input);

    const params = new URLSearchParams({
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: String(input.limit),
      timeMin: input.from ?? new Date().toISOString(),
      ...(input.to ? { timeMax: input.to } : {}),
    });

    const payload = await this.api<{
      items?: {
        id: string;
        summary?: string;
        location?: string;
        start?: { dateTime?: string; date?: string };
        end?: { dateTime?: string; date?: string };
      }[];
    }>(
      context.accessToken,
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
      request.timeoutMs,
    );

    const events = (payload.items ?? []).map((e) => ({
      eventId: e.id,
      title: e.summary ?? '(no title)',
      startsAt: e.start?.dateTime ?? e.start?.date ?? null,
      endsAt: e.end?.dateTime ?? e.end?.date ?? null,
      location: e.location ?? null,
    }));

    return {
      fidelity: 'verified',
      detail:
        events.length === 0
          ? 'Nothing on the calendar for that period.'
          : `${events.length} event${events.length === 1 ? '' : 's'}.`,
      providerRef: null,
      data: { events, source: 'primary' },
    };
  }

  private async createEvent(
    context: ConnectionContext,
    request: OperationRequest,
  ): Promise<OperationResult> {
    const input = createEventInput.parse(request.input);

    if (new Date(input.endsAt).getTime() <= new Date(input.startsAt).getTime()) {
      throw new IntegrationError(
        'invalid_request',
        this.provider,
        'An event cannot end before it starts.',
      );
    }

    const created = await this.api<{ id: string; htmlLink?: string }>(
      context.accessToken,
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      request.timeoutMs,
      {
        method: 'POST',
        body: JSON.stringify({
          summary: input.title,
          location: input.location ?? undefined,
          description: input.description ?? undefined,
          start: { dateTime: input.startsAt, timeZone: input.timezone },
          end: { dateTime: input.endsAt, timeZone: input.timezone },
          // No attendees. Inviting people would send them mail, which is a
          // different act needing its own confirmation.
        }),
      },
    );

    const confirmed = await this.api<{ id: string; summary?: string }>(
      context.accessToken,
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${created.id}`,
      request.timeoutMs,
    );

    return {
      fidelity: 'verified',
      detail: `"${confirmed.summary ?? input.title}" added to your calendar.`,
      providerRef: confirmed.id,
      data: { eventId: confirmed.id, link: created.htmlLink ?? null, invitedGuests: false as const },
    };
  }

  // ─────────────────────────────────────────────────────────── plumbing

  private requireClient(): void {
    if (!this.clientId || !this.clientSecret) {
      throw new IntegrationError('auth', this.provider, 'No Google OAuth client is configured.');
    }
  }

  private async tokenRequest(
    fields: Record<string, string>,
    timeoutMs: number,
  ): Promise<{
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  }> {
    return withTimeout(this.provider, timeoutMs, async (signal) => {
      let response: Response;
      try {
        response = await fetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            ...fields,
            client_id: this.clientId!,
            client_secret: this.clientSecret!,
          }),
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new IntegrationError('unavailable', this.provider, 'Could not reach Google.', {
          cause: error,
        });
      }

      if (!response.ok) {
        // The body echoes the code and the client id, so it is neither
        // logged nor relayed.
        throw new IntegrationError(
          response.status === 400 ? 'auth' : codeForStatus(response.status),
          this.provider,
          `Google returned ${response.status} from the token endpoint.`,
          { status: response.status },
        );
      }

      const payload = (await response.json()) as { access_token?: unknown };
      if (typeof payload.access_token !== 'string') {
        throw new IntegrationError(
          'invalid_output',
          this.provider,
          'Google returned no access token.',
        );
      }
      return payload as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };
    });
  }

  private identity(
    accessToken: string,
    timeoutMs: number,
  ): Promise<{ sub: string | null; email: string | null }> {
    return this.api<{ sub?: string; email?: string }>(
      accessToken,
      'https://openidconnect.googleapis.com/v1/userinfo',
      timeoutMs,
    )
      .then((payload) => ({ sub: payload.sub ?? null, email: payload.email ?? null }))
      // Identity is a nicety for the connections list, not a reason to
      // fail a working authorisation.
      .catch(() => ({ sub: null, email: null }));
  }

  private api<T>(
    accessToken: string,
    url: string,
    timeoutMs: number,
    init: { method?: string; body?: string } = {},
  ): Promise<T> {
    return withTimeout(this.provider, timeoutMs, async (signal) => {
      let response: Response;
      try {
        response = await fetch(url, {
          method: init.method ?? 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: init.body,
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new IntegrationError('unavailable', this.provider, 'Could not reach Google.', {
          cause: error,
        });
      }

      if (!response.ok) {
        const retryAfter = Number(response.headers.get('retry-after'));
        throw new IntegrationError(
          codeForStatus(response.status),
          this.provider,
          `Google returned ${response.status}.`,
          {
            status: response.status,
            retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : undefined,
          },
        );
      }

      // A 204 has no body; the callers that can receive one tolerate {}.
      if (response.status === 204) return {} as T;
      return (await response.json()) as T;
    });
  }
}

function header(
  headers: { name: string; value: string }[] | undefined,
  name: string,
): string | null {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;
}
