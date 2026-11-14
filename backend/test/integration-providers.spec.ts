import { ConnectionProvider } from '@prisma/client';
import { GOOGLE_SCOPES, GoogleIntegrationProvider } from '../src/providers/integrations/google.provider';
import { META_SCOPES, MetaIntegrationProvider } from '../src/providers/integrations/meta.provider';
import { TelegramIntegrationProvider } from '../src/providers/integrations/telegram.provider';
import { AssistedIntegrationProvider } from '../src/providers/integrations/assisted.provider';
import { MockIntegrationProvider } from '../src/providers/integrations/mock.provider';
import { IntegrationError } from '../src/providers/integrations/errors';
import { findOperation, type IntegrationProvider } from '../src/providers/integrations/types';

describe('integration provider adapters', () => {
  // ──────────────────────────────────────────────────────────── Google

  describe('Google (Gmail and Calendar)', () => {
    it('is unconfigured without a client id and secret', () => {
      const gmail = new GoogleIntegrationProvider(ConnectionProvider.GMAIL, undefined, undefined);
      expect(gmail.configured).toBe(false);
      expect(gmail.capabilities().configured).toBe(false);
    });

    it('is configured once both are present', () => {
      const gmail = new GoogleIntegrationProvider(ConnectionProvider.GMAIL, 'id', 'secret');
      expect(gmail.configured).toBe(true);
    });

    it('declares gmail.compose, never gmail.send', () => {
      const gmail = new GoogleIntegrationProvider(ConnectionProvider.GMAIL, 'id', 'secret');
      const scopes = gmail.capabilities().operations.flatMap((o) => o.scopes);
      expect(scopes).toContain(GOOGLE_SCOPES.gmailCompose[0]);
      expect(scopes).not.toContain('https://www.googleapis.com/auth/gmail.send');
      // The whole point: this adapter cannot send even if asked to.
      expect(gmail.capabilities().limitations.join(' ')).toContain('cannot send');
    });

    it('presents Gmail and Calendar as two distinct, correctly labelled providers', () => {
      const gmail = new GoogleIntegrationProvider(ConnectionProvider.GMAIL, 'id', 'secret');
      const calendar = new GoogleIntegrationProvider(
        ConnectionProvider.GOOGLE_CALENDAR,
        'id',
        'secret',
      );
      expect(gmail.capabilities().label).toBe('Gmail');
      expect(calendar.capabilities().label).toBe('Google Calendar');
      expect(findOperation(gmail.capabilities(), 'email.draft')).toBeDefined();
      expect(findOperation(calendar.capabilities(), 'calendar.events.create')).toBeDefined();
      expect(findOperation(gmail.capabilities(), 'calendar.events.create')).toBeUndefined();
    });

    it('requires confirmation for anything externally visible, not for a read', () => {
      const gmail = new GoogleIntegrationProvider(ConnectionProvider.GMAIL, 'id', 'secret');
      expect(findOperation(gmail.capabilities(), 'email.draft')!.requiresConfirmation).toBe(true);
      expect(findOperation(gmail.capabilities(), 'email.list')!.requiresConfirmation).toBe(false);
    });

    it('builds an authorization URL carrying PKCE and state', () => {
      const gmail = new GoogleIntegrationProvider(ConnectionProvider.GMAIL, 'client-id', 'secret');
      const result = gmail.authorizationUrl({
        state: 'opaque-state',
        redirectUri: 'https://app.test/callback',
        scopes: [...GOOGLE_SCOPES.gmailCompose],
        codeChallenge: 'challenge-value',
      });

      const url = new URL(result.url);
      expect(url.hostname).toBe('accounts.google.com');
      expect(url.searchParams.get('state')).toBe('opaque-state');
      expect(url.searchParams.get('client_id')).toBe('client-id');
      expect(url.searchParams.get('code_challenge')).toBe('challenge-value');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      // offline + consent is what actually produces a refresh token.
      expect(url.searchParams.get('access_type')).toBe('offline');
      expect(url.searchParams.get('prompt')).toBe('consent');
      expect(result.usesPkce).toBe(true);
      // The identity scopes are always included, so there is something to
      // show the user about which account they connected.
      expect(result.scopes).toEqual(expect.arrayContaining(['email', 'profile', 'openid']));
    });

    it('refuses to build an authorization URL with no client configured', () => {
      const gmail = new GoogleIntegrationProvider(ConnectionProvider.GMAIL, undefined, undefined);
      expect(() =>
        gmail.authorizationUrl({ state: 's', redirectUri: 'https://x', scopes: [] }),
      ).toThrow(IntegrationError);
    });

    it('never claims to send mail: the operation does not exist', () => {
      const gmail = new GoogleIntegrationProvider(ConnectionProvider.GMAIL, 'id', 'secret');
      expect(findOperation(gmail.capabilities(), 'email.send' as never)).toBeUndefined();
    });

    it('states the unverified-app and refresh-token limitations plainly', () => {
      const gmail = new GoogleIntegrationProvider(ConnectionProvider.GMAIL, 'id', 'secret');
      const text = gmail.capabilities().limitations.join(' ');
      expect(text).toContain('unverified');
      expect(text).toContain('100 users');
      expect(text.toLowerCase()).toContain('refresh token');
    });
  });

  // ─────────────────────────────────────────────────────────────── Meta

  describe('Meta (WhatsApp, Instagram, Messenger)', () => {
    it('is unconfigured without an app id and secret', () => {
      const wa = new MetaIntegrationProvider(ConnectionProvider.WHATSAPP, undefined, undefined, undefined);
      expect(wa.configured).toBe(false);
    });

    it('needs a business phone number specifically for WhatsApp', () => {
      const wa = new MetaIntegrationProvider(ConnectionProvider.WHATSAPP, 'app', 'secret', undefined);
      expect(wa.configured).toBe(false);

      const configured = new MetaIntegrationProvider(ConnectionProvider.WHATSAPP, 'app', 'secret', 'phone-id');
      expect(configured.configured).toBe(true);
    });

    it('does not need a phone number for Instagram or Messenger', () => {
      const instagram = new MetaIntegrationProvider(
        ConnectionProvider.INSTAGRAM,
        'app',
        'secret',
        undefined,
      );
      expect(instagram.configured).toBe(true);
    });

    it('states plainly that a personal WhatsApp account cannot be connected here', () => {
      const wa = new MetaIntegrationProvider(ConnectionProvider.WHATSAPP, 'app', 'secret', 'phone-id');
      const text = wa.capabilities().limitations.join(' ');
      expect(text.toLowerCase()).toContain('personal whatsapp account cannot be connected');
    });

    it('reports a WhatsApp send as accepted, never verified', () => {
      const wa = new MetaIntegrationProvider(ConnectionProvider.WHATSAPP, 'app', 'secret', 'phone-id');
      expect(findOperation(wa.capabilities(), 'messages.send')!.fidelity).toBe('accepted');
    });

    it('declares the 24-hour messaging window as a limitation, for every surface', () => {
      for (const provider of [ConnectionProvider.WHATSAPP, ConnectionProvider.INSTAGRAM, ConnectionProvider.FACEBOOK]) {
        const meta = new MetaIntegrationProvider(provider, 'app', 'secret', 'phone-id');
        const op = findOperation(meta.capabilities(), 'messages.send')!;
        expect(op.limitations.join(' ')).toMatch(/24 hours?/);
      }
    });

    it('requires App Review / Advanced Access for every scope, stated once per provider', () => {
      for (const provider of [ConnectionProvider.WHATSAPP, ConnectionProvider.INSTAGRAM, ConnectionProvider.FACEBOOK]) {
        const meta = new MetaIntegrationProvider(provider, 'app', 'secret', 'phone-id');
        expect(meta.capabilities().limitations.join(' ')).toContain('App Review');
      }
    });

    it('requests the right scopes per surface', () => {
      expect(
        new MetaIntegrationProvider(ConnectionProvider.WHATSAPP, 'app', 'secret', 'phone').authorizationUrl({
          state: 's',
          redirectUri: 'https://x',
          scopes: [],
        }).scopes,
      ).toEqual(expect.arrayContaining([...META_SCOPES.whatsapp]));

      expect(
        new MetaIntegrationProvider(ConnectionProvider.INSTAGRAM, 'app', 'secret', undefined).authorizationUrl({
          state: 's',
          redirectUri: 'https://x',
          scopes: [],
        }).scopes,
      ).toEqual(expect.arrayContaining([...META_SCOPES.instagram]));
    });

    it('does not claim PKCE, which Meta’s server-side flow does not support', () => {
      const wa = new MetaIntegrationProvider(ConnectionProvider.WHATSAPP, 'app', 'secret', 'phone');
      const result = wa.authorizationUrl({
        state: 's',
        redirectUri: 'https://x',
        scopes: [],
        codeChallenge: 'ignored-if-sent',
      });
      expect(result.usesPkce).toBe(false);
      expect(result.url).not.toContain('code_challenge');
    });

    it('cannot message a surface with no scope granted', async () => {
      const wa = new MetaIntegrationProvider(ConnectionProvider.WHATSAPP, 'app', 'secret', 'phone');
      await expect(
        wa.execute(
          { userId: 'u', connectionId: 'c', accessToken: 't', externalAccountId: null, grantedScopes: [] },
          { operation: 'messages.send', input: { recipient: '+1', message: 'hi' }, timeoutMs: 1000 },
        ),
      ).rejects.toMatchObject({ integrationCode: 'scope_missing' });
    });

    it('refuses an operation it does not support', async () => {
      const wa = new MetaIntegrationProvider(ConnectionProvider.WHATSAPP, 'app', 'secret', 'phone');
      await expect(
        wa.execute(
          {
            userId: 'u',
            connectionId: 'c',
            accessToken: 't',
            externalAccountId: null,
            grantedScopes: [...META_SCOPES.whatsapp],
          },
          { operation: 'calendar.events.list', input: {}, timeoutMs: 1000 },
        ),
      ).rejects.toMatchObject({ integrationCode: 'unsupported' });
    });
  });

  // ─────────────────────────────────────────────────────────── Telegram

  describe('Telegram', () => {
    it('is always configured: there is nothing for this backend to hold', () => {
      const telegram = new TelegramIntegrationProvider();
      expect(telegram.configured).toBe(true);
    });

    it('has no OAuth flow at all', () => {
      // Typed through the interface, not the concrete class: these are
      // genuinely optional methods a connector may not implement, and the
      // class itself does not declare them at all.
      const telegram: IntegrationProvider = new TelegramIntegrationProvider();
      expect('authorizationUrl' in telegram).toBe(false);
      expect('exchange' in telegram).toBe(false);
      expect('refresh' in telegram).toBe(false);
      expect(telegram.capabilities().supportsOAuth).toBe(false);
      expect(typeof telegram.connectWithSecret).toBe('function');
    });

    it('rejects a token that does not look like a bot token, before any request', async () => {
      const telegram = new TelegramIntegrationProvider();
      await expect(telegram.connectWithSecret('not-a-token', 1000)).rejects.toMatchObject({
        integrationCode: 'invalid_request',
      });
    });

    it('refuses a phone number as a send target, with an explanation', async () => {
      const telegram = new TelegramIntegrationProvider();
      await expect(
        telegram.execute(
          { userId: 'u', connectionId: 'c', accessToken: 'tok', externalAccountId: null, grantedScopes: [] },
          { operation: 'messages.send', input: { recipient: '+919876543210', message: 'hi' }, timeoutMs: 1000 },
        ),
      ).rejects.toMatchObject({ integrationCode: 'unsupported' });
    });

    it('states that a bot cannot message an arbitrary chat', () => {
      const telegram = new TelegramIntegrationProvider();
      const op = findOperation(telegram.capabilities(), 'messages.send')!;
      expect(op.limitations.join(' ')).toContain('started with it');
    });

    it('has no revoke endpoint and says so', () => {
      const telegram: IntegrationProvider = new TelegramIntegrationProvider();
      expect('revoke' in telegram).toBe(false);
      expect(telegram.capabilities().supportsRevoke).toBe(false);
      expect(telegram.capabilities().limitations.join(' ')).toContain('BotFather');
    });
  });

  // ──────────────────────────────────────────────────────── user-assisted

  describe('the assisted connector', () => {
    it('needs no account: there is nothing to authorise', () => {
      const assisted = new AssistedIntegrationProvider(ConnectionProvider.WHATSAPP);
      expect(assisted.capabilities().supportsOAuth).toBe(false);
      expect(assisted.configured).toBe(true);
    });

    it('prepares a draft rather than sending, and says so in its fidelity', async () => {
      const assisted = new AssistedIntegrationProvider(ConnectionProvider.WHATSAPP);
      const result = await assisted.execute(
        { userId: 'u', connectionId: '', accessToken: '', externalAccountId: null, grantedScopes: [] },
        { operation: 'messages.prepare', input: { recipient: '+919876543210', message: 'hi' }, timeoutMs: 1000 },
      );

      expect(result.fidelity).toBe('prepared');
      expect(result.data).toMatchObject({ sentByServer: false });
      expect((result.data as { composeUrl: string }).composeUrl).toContain('919876543210');
    });

    it('refuses a name where an address is required', async () => {
      const assisted = new AssistedIntegrationProvider(ConnectionProvider.WHATSAPP);
      await expect(
        assisted.execute(
          { userId: 'u', connectionId: '', accessToken: '', externalAccountId: null, grantedScopes: [] },
          { operation: 'messages.prepare', input: { recipient: 'Rahul', message: 'hi' }, timeoutMs: 1000 },
        ),
      ).rejects.toMatchObject({ integrationCode: 'invalid_request' });
    });

    it('has no assisted route for a provider with no messaging surface', () => {
      const facebook = new AssistedIntegrationProvider(ConnectionProvider.FACEBOOK);
      expect(facebook.capabilities().configured).toBe(false);
      expect(facebook.capabilities().operations).toEqual([]);
    });

    it('performs only messages.prepare', async () => {
      const assisted = new AssistedIntegrationProvider(ConnectionProvider.WHATSAPP);
      await expect(
        assisted.execute(
          { userId: 'u', connectionId: '', accessToken: '', externalAccountId: null, grantedScopes: [] },
          { operation: 'messages.send', input: {}, timeoutMs: 1000 },
        ),
      ).rejects.toMatchObject({ integrationCode: 'unsupported' });
    });
  });

  // ──────────────────────────────────────────────────────────────── mock

  describe('the mock integration provider', () => {
    it('records what it is asked and performs nothing', async () => {
      const mock = new MockIntegrationProvider();
      const result = await mock.execute(
        { userId: 'u', connectionId: 'c', accessToken: 't', externalAccountId: null, grantedScopes: ['scope.email.draft'] },
        { operation: 'email.draft', input: { to: 'a@b.com' }, timeoutMs: 1000 },
      );
      expect(mock.calls).toHaveLength(1);
      expect(result.data).toMatchObject({ reachedAnybody: false });
    });

    it('can report a narrower grant than was requested', async () => {
      const mock = new MockIntegrationProvider().grantOnly(['scope.email.list']);
      const tokens = await mock.exchange({ code: 'c', redirectUri: 'https://x' });
      expect(tokens.grantedScopes).toEqual(['scope.email.list']);
    });

    it('can simulate a provider with no expiry', async () => {
      const mock = new MockIntegrationProvider().expireIn(null);
      const tokens = await mock.exchange({ code: 'c', redirectUri: 'https://x' });
      expect(tokens.expiresAt).toBeNull();
    });

    it('rejects an operation outside its granted scopes', async () => {
      const mock = new MockIntegrationProvider();
      await expect(
        mock.execute(
          { userId: 'u', connectionId: 'c', accessToken: 't', externalAccountId: null, grantedScopes: [] },
          { operation: 'email.draft', input: {}, timeoutMs: 1000 },
        ),
      ).rejects.toMatchObject({ integrationCode: 'scope_missing' });
    });
  });
});
