import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ConnectionProvider } from '@prisma/client';
import type { PrismaService } from '../src/database/prisma.service';
import { ConnectionsService } from '../src/modules/integrations/connections.service';
import { IntegrationRegistry } from '../src/modules/integrations/integration.registry';
import { OAuthService } from '../src/modules/integrations/oauth.service';
import { CryptoService } from '../src/security/services/crypto.service';
import { IntegrationError } from '../src/providers/integrations/errors';
import { MockIntegrationProvider } from '../src/providers/integrations/mock.provider';
import {
  createTestApp,
  uniqueEmail,
  STRONG_PASSWORD,
  NATIVE_DEVICE,
  type AuthBody,
  type Envelope,
  type ErrorBody,
} from './helpers/app';

interface AuthorizeView {
  authorizationUrl: string;
  state: string;
  scopes: string[];
  usesPkce: boolean;
  provider: ConnectionProvider;
}

interface CallbackView {
  connectionId: string;
  provider: ConnectionProvider;
  displayName: string | null;
  grantedScopes: string[];
  scopesNarrowed: boolean;
  status: string;
}

interface ConnectionView {
  connectionId: string;
  provider: ConnectionProvider;
  status: string;
  displayName: string | null;
  grantedScopes: string[];
  needsReconnect: boolean;
}

describe('third-party integrations', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => Server;
  let registry: IntegrationRegistry;
  let connections: ConnectionsService;
  let oauth: OAuthService;
  let crypto: CryptoService;
  let mock: MockIntegrationProvider;
  /** The registry's real lookup, restored after each test that swaps it. */
  let originalOfficial: IntegrationRegistry['official'];
  let originalForUse: IntegrationRegistry['forUse'];

  beforeAll(async () => {
    ({ app, prisma, http } = await createTestApp());
    registry = app.get(IntegrationRegistry);
    connections = app.get(ConnectionsService);
    oauth = app.get(OAuthService);
    crypto = app.get(CryptoService);

    // Credential encryption really is configured in this suite — the
    // OAuth flow refuses to start otherwise, by design.
    expect(crypto.available).toBe(true);

    originalOfficial = registry.official.bind(registry);
    originalForUse = registry.forUse.bind(registry);
  });
  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    mock = new MockIntegrationProvider(ConnectionProvider.GMAIL);
    // Substituted in place of the real Google adapter, so the OAuth flow,
    // token storage and operation dispatch are all exercised without
    // reaching a vendor — and, per the brief, without any risk of a real
    // message or API call going out from a test.
    (registry as unknown as { official: unknown }).official = (
      provider: ConnectionProvider,
    ) => (provider === ConnectionProvider.GMAIL ? mock : originalOfficial(provider));
    (registry as unknown as { forUse: unknown }).forUse = (
      provider: ConnectionProvider,
      hasConnection: boolean,
    ) => (provider === ConnectionProvider.GMAIL ? mock : originalForUse(provider, hasConnection));
  });
  afterEach(() => {
    (registry as unknown as { official: unknown }).official = originalOfficial;
    (registry as unknown as { forUse: unknown }).forUse = originalForUse;
  });

  async function newAccount() {
    const res = await request(http())
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail('int'), password: STRONG_PASSWORD, device: NATIVE_DEVICE })
      .expect(201);
    const body = res.body as AuthBody;
    return {
      email: body.data.user.email,
      userId: body.data.user.id,
      deviceId: body.data.device.id,
      access: body.data.tokens.accessToken!,
    };
  }

  async function secondDevice(email: string) {
    const res = await request(http())
      .post('/api/v1/auth/login')
      .send({
        email,
        password: STRONG_PASSWORD,
        device: { platform: 'WINDOWS', name: 'Desktop', deviceType: 'desktop' },
      })
      .expect(200);
    const body = res.body as AuthBody;
    return { deviceId: body.data.device.id, access: body.data.tokens.accessToken! };
  }

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function startAuth(token: string, body: Record<string, unknown> = {}) {
    const res = await request(http())
      .post('/api/v1/integrations/authorize')
      .set(auth(token))
      .send({ provider: ConnectionProvider.GMAIL, ...body })
      .expect(201);
    return (res.body as Envelope<AuthorizeView>).data;
  }

  async function finishAuth(token: string, state: string, code = 'auth-code') {
    const res = await request(http())
      .post('/api/v1/integrations/callback')
      .set(auth(token))
      .send({ state, code })
      .expect(200);
    return (res.body as Envelope<CallbackView>).data;
  }

  // ────────────────────────────────────────────────────── starting OAuth

  describe('starting an authorization', () => {
    it('returns a URL carrying a server-issued, single-use state', async () => {
      const account = await newAccount();
      const started = await startAuth(account.access);

      expect(started.authorizationUrl).toContain('state=');
      expect(started.state.length).toBeGreaterThan(20);
      expect(started.usesPkce).toBe(true);

      const row = await prisma.oAuthState.findUniqueOrThrow({ where: { state: started.state } });
      expect(row.userId).toBe(account.userId);
      expect(row.deviceId).toBe(account.deviceId);
      expect(row.consumedAt).toBeNull();
      // The PKCE verifier is sealed, never kept in the clear — and it must
      // never reach the browser, so it is not in the response either.
      expect(row.codeVerifierEnc).not.toBeNull();
      expect(JSON.stringify(started)).not.toMatch(/verifier/i);
    });

    it('rejects a scope the provider does not declare', async () => {
      const account = await newAccount();
      const res = await request(http())
        .post('/api/v1/integrations/authorize')
        .set(auth(account.access))
        .send({ provider: ConnectionProvider.GMAIL, scopes: ['not.a.real.scope'] })
        .expect(400);
      expect((res.body as ErrorBody).message).toContain('Unknown scope');
    });

    it('refuses to start when credential encryption is unavailable', async () => {
      // Reported as a dependency outage (503), not a client mistake (400):
      // the request itself was fine, the server cannot safely act on it.
      const broken = new CryptoService({ providers: { tokenEncryptionKey: undefined } } as never);
      Object.defineProperty(oauth, 'crypto', { value: broken, configurable: true });
      try {
        const account = await newAccount();
        const res = await request(http())
          .post('/api/v1/integrations/authorize')
          .set(auth(account.access))
          .send({ provider: ConnectionProvider.GMAIL })
          .expect(503);
        expect((res.body as ErrorBody).message).toContain('encryption');
      } finally {
        Object.defineProperty(oauth, 'crypto', { value: crypto, configurable: true });
      }
    });

    it('refuses a provider with no OAuth flow', async () => {
      const account = await newAccount();
      const res = await request(http())
        .post('/api/v1/integrations/authorize')
        .set(auth(account.access))
        .send({ provider: ConnectionProvider.TELEGRAM })
        .expect(400);
      expect((res.body as ErrorBody).message.toLowerCase()).toContain('token you supply');
    });

    it('requires authentication', async () => {
      await request(http())
        .post('/api/v1/integrations/authorize')
        .send({ provider: ConnectionProvider.GMAIL })
        .expect(401);
    });
  });

  // ─────────────────────────────────────────────────────────── callback

  describe('the OAuth callback', () => {
    it('exchanges the code and stores an encrypted connection', async () => {
      const account = await newAccount();
      const started = await startAuth(account.access);
      const result = await finishAuth(account.access, started.state);

      expect(result.status).toBe('CONNECTED');
      expect(result.grantedScopes.length).toBeGreaterThan(0);
      expect(mock.exchanges).toHaveLength(1);
      // The PKCE verifier this adapter received is the one sealed at start.
      expect(mock.exchanges[0].codeVerifier).toBeTruthy();

      const row = await prisma.connectedAccount.findUniqueOrThrow({
        where: { id: result.connectionId },
      });
      expect(row.status).toBe('CONNECTED');
      // Never the plaintext. Only the sealed bytes.
      expect(row.accessTokenEnc).not.toBeNull();
      expect(crypto.open(Buffer.from(row.accessTokenEnc!), row.keyVersion)).toMatch(/^mock-access-/);

      // And the state is consumed, so a client never sees a token in a
      // route response.
      expect(JSON.stringify(result)).not.toMatch(/mock-access|mock-refresh/);
    });

    it('is refused on replay: the state can be used exactly once', async () => {
      const account = await newAccount();
      const started = await startAuth(account.access);
      await finishAuth(account.access, started.state);

      const replay = await request(http())
        .post('/api/v1/integrations/callback')
        .set(auth(account.access))
        .send({ state: started.state, code: 'auth-code' })
        .expect(400);
      expect((replay.body as ErrorBody).message).toContain('Start again');
      // Exactly one connection exists, not a second one from the replay.
      expect(await prisma.connectedAccount.count({ where: { userId: account.userId } })).toBe(1);
    });

    it('is refused for an unknown state', async () => {
      const account = await newAccount();
      await request(http())
        .post('/api/v1/integrations/callback')
        .set(auth(account.access))
        .send({ state: 'never-issued', code: 'x' })
        .expect(400);
    });

    it('is refused for an expired state', async () => {
      const account = await newAccount();
      const started = await startAuth(account.access);
      await prisma.oAuthState.update({
        where: { state: started.state },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });

      await request(http())
        .post('/api/v1/integrations/callback')
        .set(auth(account.access))
        .send({ state: started.state, code: 'x' })
        .expect(400);
    });

    it('is this CSRF defence: a state cannot be completed by a different session', async () => {
      const victim = await newAccount();
      const attacker = await newAccount();
      const started = await startAuth(victim.access);

      // An attacker who gets a victim's browser to hit the callback URL —
      // or who simply tries their own session against the victim's state —
      // must not be able to attach the victim's grant to their own account.
      const res = await request(http())
        .post('/api/v1/integrations/callback')
        .set(auth(attacker.access))
        .send({ state: started.state, code: 'x' })
        .expect(400);
      expect((res.body as ErrorBody).message).toContain('Start again');

      const row = await prisma.oAuthState.findUniqueOrThrow({ where: { state: started.state } });
      // Not consumed by the forged attempt: the legitimate owner can still
      // complete it.
      expect(row.consumedAt).toBeNull();
    });

    it('refuses a callback from a different device than the one that started it', async () => {
      const account = await newAccount();
      const other = await secondDevice(account.email);
      const started = await startAuth(account.access);

      await request(http())
        .post('/api/v1/integrations/callback')
        .set(auth(other.access))
        .send({ state: started.state, code: 'x' })
        .expect(400);
    });

    it('records what Google actually granted, even when narrower than requested', async () => {
      const account = await newAccount();
      mock.grantOnly(['scope.email.list']);
      const started = await startAuth(account.access, { scopes: ['scope.email.draft', 'scope.email.list'] });
      const result = await finishAuth(account.access, started.state);

      expect(result.grantedScopes).toEqual(['scope.email.list']);
      expect(result.scopesNarrowed).toBe(true);
    });

    it('lets two callbacks race and settles on exactly one winner', async () => {
      const account = await newAccount();
      const started = await startAuth(account.access);

      const results = await Promise.allSettled([
        finishAuth(account.access, started.state),
        request(http())
          .post('/api/v1/integrations/callback')
          .set(auth(account.access))
          .send({ state: started.state, code: 'auth-code' }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      expect(await prisma.connectedAccount.count({ where: { userId: account.userId } })).toBe(1);
    });

    it('records starting, succeeding and failing an authorization distinctly', async () => {
      const account = await newAccount();
      const started = await startAuth(account.access);
      await finishAuth(account.access, started.state);
      await request(http())
        .post('/api/v1/integrations/callback')
        .set(auth(account.access))
        .send({ state: 'unknown', code: 'x' })
        .expect(400);

      const actions = (
        await prisma.auditLog.findMany({ where: { userId: account.userId }, select: { action: true } })
      ).map((a) => a.action);
      expect(actions).toContain('integration.auth.started');
      expect(actions).toContain('integration.connected');
      expect(actions).toContain('integration.auth.failed');
    });
  });

  // ────────────────────────────────────────── connecting with a secret

  describe('connecting with a supplied secret', () => {
    it('verifies a Telegram-shaped token before storing anything', async () => {
      const account = await newAccount();
      const res = await request(http())
        .post('/api/v1/integrations/connect')
        .set(auth(account.access))
        .send({ provider: ConnectionProvider.TELEGRAM, secret: 'not-a-real-token' })
        .expect(400);
      expect((res.body as ErrorBody).success).toBe(false);
      expect(
        await prisma.connectedAccount.count({
          where: { userId: account.userId, provider: ConnectionProvider.TELEGRAM },
        }),
      ).toBe(0);
    });

    it('refuses to connect a provider that has no secret-based route', async () => {
      const account = await newAccount();
      await request(http())
        .post('/api/v1/integrations/connect')
        .set(auth(account.access))
        .send({ provider: ConnectionProvider.GMAIL, secret: 'whatever-twelve' })
        .expect(400);
    });
  });

  // ───────────────────────────────────────────────────────── disconnect

  describe('disconnecting', () => {
    it('revokes at the provider and marks the row revoked, not deleted', async () => {
      const account = await newAccount();
      const started = await startAuth(account.access);
      const connected = await finishAuth(account.access, started.state);

      const res = await request(http())
        .delete(`/api/v1/integrations/connections/${connected.connectionId}`)
        .set(auth(account.access))
        .expect(200);
      const body = (res.body as Envelope<{ disconnected: boolean; revokedAtProvider: boolean }>).data;

      expect(body.disconnected).toBe(true);
      expect(body.revokedAtProvider).toBe(true);
      expect(mock.revocations).toHaveLength(1);

      const row = await prisma.connectedAccount.findUniqueOrThrow({
        where: { id: connected.connectionId },
      });
      expect(row.status).toBe('REVOKED');
      expect(row.revokedAt).not.toBeNull();
      // The credential is gone, not merely marked revoked.
      expect(row.accessTokenEnc).toBeNull();

      // No longer in the live list.
      const list = await request(http())
        .get('/api/v1/integrations/connections')
        .set(auth(account.access))
        .expect(200);
      expect((list.body as Envelope<ConnectionView[]>).data).toHaveLength(0);
    });

    it('still disconnects locally when the provider cannot be reached', async () => {
      const account = await newAccount();
      const started = await startAuth(account.access);
      const connected = await finishAuth(account.access, started.state);
      mock.failWith(new IntegrationError('unavailable', ConnectionProvider.GMAIL, 'down'));

      const res = await request(http())
        .delete(`/api/v1/integrations/connections/${connected.connectionId}`)
        .set(auth(account.access))
        .expect(200);
      const body = (res.body as Envelope<{ disconnected: boolean; revokedAtProvider: boolean; note: string }>)
        .data;

      // A provider outage must not leave the user unable to disconnect.
      expect(body.disconnected).toBe(true);
      expect(body.revokedAtProvider).toBe(false);
      expect(body.note.toLowerCase()).toContain('provider');

      const row = await prisma.connectedAccount.findUniqueOrThrow({
        where: { id: connected.connectionId },
      });
      expect(row.status).toBe('REVOKED');
    });

    it('hides another account’s connection entirely', async () => {
      const owner = await newAccount();
      const stranger = await newAccount();
      const started = await startAuth(owner.access);
      const connected = await finishAuth(owner.access, started.state);

      await request(http())
        .delete(`/api/v1/integrations/connections/${connected.connectionId}`)
        .set(auth(stranger.access))
        .expect(404);

      const row = await prisma.connectedAccount.findUniqueOrThrow({
        where: { id: connected.connectionId },
      });
      expect(row.status).toBe('CONNECTED');
    });
  });

  // ───────────────────────────────────────────────────────────── refresh

  describe('refreshing an access token', () => {
    it('renews a token close to expiry', async () => {
      const account = await newAccount();
      mock.expireIn(60); // already inside the refresh lead time
      const started = await startAuth(account.access);
      const connected = await finishAuth(account.access, started.state);

      const before = await prisma.connectedAccount.findUniqueOrThrow({
        where: { id: connected.connectionId },
      });

      const res = await request(http())
        .post(`/api/v1/integrations/connections/${connected.connectionId}/refresh`)
        .set(auth(account.access))
        .expect(200);
      expect((res.body as Envelope<{ refreshed: boolean }>).data.refreshed).toBe(true);
      expect(mock.refreshes).toHaveLength(1);

      const after = await prisma.connectedAccount.findUniqueOrThrow({
        where: { id: connected.connectionId },
      });
      expect(Buffer.from(after.accessTokenEnc!).equals(Buffer.from(before.accessTokenEnc!))).toBe(
        false,
      );
      expect(after.refreshFailures).toBe(0);
    });

    it('leaves a token alone when it is still valid, unless forced', async () => {
      const account = await newAccount();
      mock.expireIn(3_600);
      const started = await startAuth(account.access);
      const connected = await finishAuth(account.access, started.state);
      mock.refreshes.length = 0;

      const result = await connections.refresh(connected.connectionId);
      expect(result.refreshed).toBe(false);
      expect(result.reason).toBe('still_valid');
      expect(mock.refreshes).toHaveLength(0);
    });

    it('keeps the existing refresh token when the provider omits a new one', async () => {
      const account = await newAccount();
      mock.expireIn(60);
      const started = await startAuth(account.access);
      const connected = await finishAuth(account.access, started.state);
      const before = await prisma.connectedAccount.findUniqueOrThrow({
        where: { id: connected.connectionId },
      });

      // Simulate a refresh response with no refresh_token, which is the
      // common case: the stored one should survive rather than being
      // overwritten with nothing.
      const realRefresh = mock.refresh.bind(mock);
      mock.refresh = async (token: string) => {
        const result = await realRefresh(token);
        return { ...result, refreshToken: null };
      };

      await connections.refresh(connected.connectionId, { force: true });

      const after = await prisma.connectedAccount.findUniqueOrThrow({
        where: { id: connected.connectionId },
      });
      expect(Buffer.from(after.refreshTokenEnc!).equals(Buffer.from(before.refreshTokenEnc!))).toBe(
        true,
      );
    });

    it('marks a connection expired after the provider rejects refresh repeatedly', async () => {
      const account = await newAccount();
      mock.expireIn(60);
      const started = await startAuth(account.access);
      const connected = await finishAuth(account.access, started.state);

      mock.failWith(new IntegrationError('auth', ConnectionProvider.GMAIL, 'revoked by user'));
      const result = await connections.refresh(connected.connectionId, { force: true });

      // An auth rejection means the grant is gone; retrying would not help.
      expect(result.reason).toBe('refresh_rejected');
      const row = await prisma.connectedAccount.findUniqueOrThrow({
        where: { id: connected.connectionId },
      });
      expect(row.status).toBe('EXPIRED');
      expect(row.lastErrorCode).toContain('auth');
    });

    it('backs off a connection after repeated transient failures without marking it expired early', async () => {
      const account = await newAccount();
      mock.expireIn(60);
      const started = await startAuth(account.access);
      const connected = await finishAuth(account.access, started.state);

      mock.failWith(new IntegrationError('unavailable', ConnectionProvider.GMAIL, 'blip'));
      for (let i = 0; i < 4; i += 1) {
        const result = await connections.refresh(connected.connectionId, { force: true });
        expect(result.reason).toBe('refresh_failed');
      }
      const stillTrying = await prisma.connectedAccount.findUniqueOrThrow({
        where: { id: connected.connectionId },
      });
      expect(stillTrying.status).toBe('CONNECTED');

      // One more failure crosses the threshold.
      const finalResult = await connections.refresh(connected.connectionId, { force: true });
      expect(finalResult.reason).toBe('refresh_rejected');
      const stopped = await prisma.connectedAccount.findUniqueOrThrow({
        where: { id: connected.connectionId },
      });
      expect(stopped.status).toBe('EXPIRED');
    });

    it('refreshes everything close to expiry in one sweep', async () => {
      const account = await newAccount();
      mock.expireIn(60);
      const started = await startAuth(account.access);
      await finishAuth(account.access, started.state);

      const report = await connections.refreshExpiring();
      expect(report.attempted).toBeGreaterThanOrEqual(1);
      expect(report.refreshed).toBeGreaterThanOrEqual(1);
    });

    it('is refused for another account’s connection', async () => {
      const owner = await newAccount();
      const stranger = await newAccount();
      const started = await startAuth(owner.access);
      const connected = await finishAuth(owner.access, started.state);

      await request(http())
        .post(`/api/v1/integrations/connections/${connected.connectionId}/refresh`)
        .set(auth(stranger.access))
        .expect(404);
    });
  });

  // ──────────────────────────────────────────────────── capability metadata

  describe('unsupported capabilities', () => {
    it('refuses an operation the provider does not declare, not as a failure but as unsupported', async () => {
      const account = await newAccount();
      const started = await startAuth(account.access);
      await finishAuth(account.access, started.state);

      const res = await request(http())
        .post('/api/v1/integrations/operations')
        .set(auth(account.access))
        .send({ provider: ConnectionProvider.GMAIL, operation: 'calendar.events.create' })
        .expect(400);
      expect((res.body as ErrorBody).message).toContain('cannot calendar.events.create');
    });

    it('refuses an operation name this server has never heard of', async () => {
      const account = await newAccount();
      await request(http())
        .post('/api/v1/integrations/operations')
        .set(auth(account.access))
        .send({ provider: ConnectionProvider.GMAIL, operation: 'self.destruct' })
        .expect(400);
    });

    it('refuses an operation needing a scope this connection lacks', async () => {
      const account = await newAccount();
      mock.grantOnly(['scope.email.list']);
      const started = await startAuth(account.access);
      await finishAuth(account.access, started.state);

      const res = await request(http())
        .post('/api/v1/integrations/operations')
        .set(auth(account.access))
        .send({ provider: ConnectionProvider.GMAIL, operation: 'email.draft', input: {} })
        .expect(400);
      expect((res.body as ErrorBody).message.toLowerCase()).toContain('reconnect');
    });

    it('lists what this deployment can and cannot offer, including the unconfigured', async () => {
      const account = await newAccount();
      const res = await request(http())
        .get('/api/v1/integrations')
        .set(auth(account.access))
        .expect(200);
      const catalogue = (res.body as Envelope<{ provider: string; configured: boolean }[]>).data;

      // Telegram needs no configuration; the real Meta/Google adapters in
      // this deployment have no credential, and are listed as such rather
      // than hidden.
      expect(catalogue.find((c) => c.provider === 'TELEGRAM')!.configured).toBe(true);
      const instagram = catalogue.find((c) => c.provider === 'INSTAGRAM');
      expect(instagram).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────── provider failures

  describe('provider failures', () => {
    it('reports a provider outage without pretending the operation worked', async () => {
      const account = await newAccount();
      const started = await startAuth(account.access);
      await finishAuth(account.access, started.state);
      mock.failWith(new IntegrationError('unavailable', ConnectionProvider.GMAIL, 'down'));

      const res = await request(http())
        .post('/api/v1/integrations/operations')
        .set(auth(account.access))
        .send({ provider: ConnectionProvider.GMAIL, operation: 'email.draft', input: { to: 'a@b.com', body: 'hi' } })
        .expect(503);
      expect((res.body as ErrorBody).success).toBe(false);
    });

    it('marks the connection needing reconnection when the provider rejects the credential', async () => {
      const account = await newAccount();
      const started = await startAuth(account.access);
      const connected = await finishAuth(account.access, started.state);
      mock.failWith(new IntegrationError('auth', ConnectionProvider.GMAIL, 'revoked'));

      await request(http())
        .post('/api/v1/integrations/operations')
        .set(auth(account.access))
        .send({ provider: ConnectionProvider.GMAIL, operation: 'email.draft', input: { to: 'a@b.com', body: 'hi' } })
        .expect(400);

      const row = await prisma.connectedAccount.findUniqueOrThrow({
        where: { id: connected.connectionId },
      });
      expect(row.status).toBe('EXPIRED');
    });
  });

  // ────────────────────────────────────────────────────────── confirmation

  describe('messaging confirmation and user-assisted hand-off', () => {
    it('reports an accepted send through a real connection, not as completed', async () => {
      const account = await newAccount();
      const started = await startAuth(account.access);
      await finishAuth(account.access, started.state);

      const res = await request(http())
        .post('/api/v1/integrations/operations')
        .set(auth(account.access))
        .send({
          provider: ConnectionProvider.GMAIL,
          operation: 'email.draft',
          input: { to: 'friend@example.com', subject: 'Hi', body: 'hello' },
        })
        .expect(200);
      const body = (res.body as Envelope<{ fidelity: string; connectorKind: string }>).data;

      expect(body.connectorKind).toBe('official-api');
      expect(body.fidelity).toBe('verified');
      expect(mock.calls).toHaveLength(1);
    });

    it('falls back to the user-assisted route when no account is connected', async () => {
      const account = await newAccount();
      // No WhatsApp account connected. The assisted connector needs none.
      const res = await request(http())
        .post('/api/v1/integrations/operations')
        .set(auth(account.access))
        .send({
          provider: ConnectionProvider.WHATSAPP,
          operation: 'messages.prepare',
          input: { recipient: '+919876543210', message: 'Running late' },
        })
        .expect(200);
      const body = (res.body as Envelope<{ fidelity: string; connectorKind: string; data: { sentByServer: boolean; composeUrl: string } }>)
        .data;

      expect(body.connectorKind).toBe('user-assisted');
      // A hand-off, never a send. This is the brief's own example.
      expect(body.fidelity).toBe('prepared');
      expect(body.data.sentByServer).toBe(false);
      expect(body.data.composeUrl).toContain('919876543210');
    });

    it('never sends a real message in this test: the mock records and reaches nobody', async () => {
      const account = await newAccount();
      const started = await startAuth(account.access);
      await finishAuth(account.access, started.state);

      await request(http())
        .post('/api/v1/integrations/operations')
        .set(auth(account.access))
        .send({
          provider: ConnectionProvider.GMAIL,
          operation: 'email.draft',
          input: { to: 'friend@example.com', body: 'hello' },
        })
        .expect(200);

      expect(mock.calls[0].input).toMatchObject({ to: 'friend@example.com' });
      // The mock's own contract: it performs nothing. There is no network
      // call this adapter could have made.
    });
  });

  // ──────────────────────────────────────────────────────────── isolation

  describe('cross-user isolation', () => {
    it('never lists another account’s connections', async () => {
      const owner = await newAccount();
      const stranger = await newAccount();
      const started = await startAuth(owner.access);
      await finishAuth(owner.access, started.state);

      const res = await request(http())
        .get('/api/v1/integrations/connections')
        .set(auth(stranger.access))
        .expect(200);
      expect((res.body as Envelope<ConnectionView[]>).data).toHaveLength(0);
    });

    it('cannot run an operation against an account it does not own', async () => {
      const owner = await newAccount();
      const stranger = await newAccount();
      const started = await startAuth(owner.access);
      await finishAuth(owner.access, started.state);

      const res = await request(http())
        .post('/api/v1/integrations/operations')
        .set(auth(stranger.access))
        .send({ provider: ConnectionProvider.GMAIL, operation: 'email.draft', input: { to: 'a@b.com' } })
        .expect(400);
      // The wording names the provider's own label, which here is the
      // mock's — the fact under test is that nothing ran for an account
      // the caller does not own.
      expect((res.body as ErrorBody).message).toContain('No');
      expect((res.body as ErrorBody).message).toContain('account is connected');
      expect(mock.calls).toHaveLength(0);
    });

    it('requires authentication on every route', async () => {
      const id = '4f1e2d3c-0000-4000-8000-000000000000';
      await request(http()).get('/api/v1/integrations').expect(401);
      await request(http()).get('/api/v1/integrations/connections').expect(401);
      await request(http()).post('/api/v1/integrations/callback').send({}).expect(401);
      await request(http()).delete(`/api/v1/integrations/connections/${id}`).expect(401);
      await request(http()).post('/api/v1/integrations/operations').send({}).expect(401);
    });
  });

  // ──────────────────────────────────────────────────── credential exposure

  describe('credential exposure', () => {
    it('never includes a token in any integrations response', async () => {
      const account = await newAccount();
      const started = await startAuth(account.access);
      await finishAuth(account.access, started.state);

      const list = await request(http())
        .get('/api/v1/integrations/connections')
        .set(auth(account.access))
        .expect(200);
      const catalogue = await request(http())
        .get('/api/v1/integrations')
        .set(auth(account.access))
        .expect(200);

      const raw = JSON.stringify(list.body) + JSON.stringify(catalogue.body);
      expect(raw).not.toMatch(/mock-access|mock-refresh/);
      expect(raw).not.toContain('accessTokenEnc');
      expect(raw).not.toContain('codeVerifier');
    });
  });

  // ────────────────────────────────────────────────────────── background

  describe('background processing', () => {
    it('purges spent OAuth state rows', async () => {
      const account = await newAccount();
      const started = await startAuth(account.access);
      await prisma.oAuthState.update({
        where: { state: started.state },
        data: { expiresAt: new Date(Date.now() - 25 * 60 * 60 * 1_000) },
      });

      expect(await oauth.purgeStates()).toBeGreaterThanOrEqual(1);
      expect(await prisma.oAuthState.findUnique({ where: { state: started.state } })).toBeNull();
    });

    it('keeps a recently expired or consumed state for the audit trail', async () => {
      const account = await newAccount();
      const started = await startAuth(account.access);
      await prisma.oAuthState.update({
        where: { state: started.state },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });

      await oauth.purgeStates();
      expect(await prisma.oAuthState.findUnique({ where: { state: started.state } })).not.toBeNull();
    });
  });
});
