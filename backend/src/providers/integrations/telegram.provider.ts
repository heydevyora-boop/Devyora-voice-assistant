import { ConnectionProvider } from '@prisma/client';
import { z } from 'zod';
import { IntegrationError, codeForStatus } from './errors';
import { withTimeout } from './reliability';
import type {
  ConnectionContext,
  IntegrationCapabilities,
  IntegrationProvider,
  OperationRequest,
  OperationResult,
  ProviderHealth,
  TokenSet,
} from './types';

const sendInput = z.object({
  /** A numeric chat id, or `@channelusername`. Not a phone number. */
  recipient: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(4_096),
});

/**
 * Telegram, through the Bot API.
 *
 * Deliberately the odd one out, and the differences are the point:
 *
 * **There is no OAuth.** A Telegram bot is authorised by a token the user
 * creates with BotFather and pastes in. So `authorizationUrl`, `exchange`,
 * `refresh` — all absent, and `connectWithSecret` present instead. A caller
 * asks the capability table rather than assuming every provider has the
 * same shape.
 *
 * **A bot cannot message whoever it likes.** It can only reply to a chat
 * someone has started with it, or post to a channel it administers. There
 * is no way to make a bot message an arbitrary phone number, and the
 * assistant does not pretend otherwise — a Telegram message to someone who
 * has not spoken to the bot goes through the user-assisted connector
 * instead.
 *
 * **The token is the bot, not the user.** It grants whoever holds it full
 * control of that bot, which is why it is sealed like any other credential
 * and verified against `getMe` before being stored.
 */
export class TelegramIntegrationProvider implements IntegrationProvider {
  readonly provider = ConnectionProvider.TELEGRAM;
  readonly kind = 'official-api' as const;

  /**
   * Always configured: there is nothing for this backend to hold. The
   * credential belongs to the user's own bot, which is what makes Telegram
   * usable without any app registration on our side.
   */
  readonly configured = true;

  capabilities(): IntegrationCapabilities {
    return {
      provider: this.provider,
      label: 'Telegram',
      kind: this.kind,
      configured: true,
      // No OAuth flow exists for the Bot API.
      supportsOAuth: false,
      supportsRefresh: false,
      // A token is revoked with BotFather, not through an API.
      supportsRevoke: false,
      operations: [
        {
          operation: 'messages.send',
          fidelity: 'accepted',
          scopes: [],
          requiresConfirmation: true,
          limitations: [
            'A bot can only message a chat that the person has started with it, or a ' +
              'channel the bot administers. There is no supported way to message an ' +
              'arbitrary phone number.',
            'The message arrives from the bot, not from the user’s own Telegram account.',
            'Roughly 30 messages a second overall, and about one a second to the same ' +
              'chat. A 429 carries the provider’s own retry-after, which is honoured.',
          ],
        },
        {
          operation: 'profile.read',
          fidelity: 'verified',
          scopes: [],
          requiresConfirmation: false,
          limitations: ['Reads the bot’s own identity, not the user’s.'],
        },
      ],
      limitations: [
        'Connected with a bot token from BotFather rather than OAuth, so there is no ' +
          'authorisation URL and nothing to refresh.',
        'Disconnecting here removes our copy of the token. Revoking the bot itself is ' +
          'done in BotFather, and the connection view says so.',
      ],
      documentationUrl: 'https://core.telegram.org/bots/api',
    };
  }

  /**
   * Verifies a bot token and turns it into a connection.
   *
   * `getMe` is called before anything is stored, so a typo or a revoked
   * token is a failed connection attempt rather than a connection that
   * looks fine and fails on first use.
   */
  async connectWithSecret(secret: string, timeoutMs: number): Promise<TokenSet> {
    const token = secret.trim();
    if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) {
      // Checked before it is sent anywhere, so a mistyped secret does not
      // travel.
      throw new IntegrationError(
        'invalid_request',
        this.provider,
        'That does not look like a Telegram bot token.',
      );
    }

    const me = await this.api<{ id: number; username?: string; first_name?: string }>(
      token,
      'getMe',
      timeoutMs,
    );

    return {
      accessToken: token,
      refreshToken: null,
      // A bot token does not expire; it is revoked.
      expiresAt: null,
      grantedScopes: [],
      externalAccountId: String(me.id),
      displayName: me.username ? `@${me.username}` : (me.first_name ?? 'Telegram bot'),
    };
  }

  async execute(
    context: ConnectionContext,
    request: OperationRequest,
  ): Promise<OperationResult> {
    switch (request.operation) {
      case 'messages.send': {
        const input = sendInput.parse(request.input);

        // A phone number is not a chat id, and sending to one is not
        // something the Bot API can do. Caught here with an explanation
        // rather than relayed as a confusing provider error.
        if (/^\+?\d{7,15}$/.test(input.recipient.replace(/[\s()-]/g, ''))) {
          throw new IntegrationError(
            'unsupported',
            this.provider,
            'A Telegram bot cannot message a phone number. It needs a chat id from ' +
              'someone who has messaged the bot, or a channel it administers.',
          );
        }

        const payload = await this.api<{ message_id: number; chat: { id: number } }>(
          context.accessToken,
          'sendMessage',
          request.timeoutMs,
          { chat_id: input.recipient, text: input.message },
        );

        return {
          // Telegram confirms it accepted and stored the message. Whether
          // the person has read it is not ours to know.
          fidelity: 'accepted',
          detail: 'Telegram accepted the message.',
          providerRef: String(payload.message_id),
          data: {
            messageId: payload.message_id,
            chatId: payload.chat.id,
            sentAsBot: true as const,
          },
        };
      }

      case 'profile.read': {
        const me = await this.api<{ id: number; username?: string }>(
          context.accessToken,
          'getMe',
          request.timeoutMs,
        );
        return {
          fidelity: 'verified',
          detail: `Connected as ${me.username ? `@${me.username}` : 'a Telegram bot'}.`,
          providerRef: String(me.id),
          data: { botId: me.id, username: me.username ?? null },
        };
      }

      default:
        throw new IntegrationError(
          'unsupported',
          this.provider,
          `Telegram cannot ${request.operation}.`,
        );
    }
  }

  health(): Promise<ProviderHealth> {
    return Promise.resolve({
      provider: this.provider,
      configured: true,
      reachable: null,
      checkedAt: new Date().toISOString(),
      detail: 'Needs no app registration; each user supplies their own bot token.',
    });
  }

  /**
   * One Bot API call.
   *
   * The token is in the URL path, which is how Telegram's API works — so it
   * never appears in a header that might be logged, but it does mean the URL
   * itself is a secret and is never included in an error message.
   */
  private api<T>(
    token: string,
    method: string,
    timeoutMs: number,
    body?: Record<string, unknown>,
  ): Promise<T> {
    return withTimeout(this.provider, timeoutMs, async (signal) => {
      let response: Response;
      try {
        response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
          method: body ? 'POST' : 'GET',
          headers: body ? { 'Content-Type': 'application/json' } : {},
          body: body ? JSON.stringify(body) : undefined,
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new IntegrationError('unavailable', this.provider, 'Could not reach Telegram.', {
          cause: error,
        });
      }

      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        result?: unknown;
        description?: string;
        parameters?: { retry_after?: number };
      };

      if (!response.ok || payload.ok !== true) {
        // 401 and 404 both mean the token is wrong — Telegram answers a bad
        // token with 404 on the path, which would otherwise read as a
        // missing method.
        const code =
          response.status === 404 || response.status === 401
            ? 'auth'
            : codeForStatus(response.status);

        throw new IntegrationError(code, this.provider, `Telegram returned ${response.status}.`, {
          status: response.status,
          retryAfterSeconds: payload.parameters?.retry_after,
        });
      }

      return payload.result as T;
    });
  }
}
