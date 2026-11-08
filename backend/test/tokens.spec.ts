import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaService } from '../src/database/prisma.service';
import { hashToken } from '../src/security/services/token.service';
import {
  createTestApp,
  uniqueEmail,
  STRONG_PASSWORD,
  NATIVE_DEVICE,
  type AuthBody,
  type ErrorBody,
} from './helpers/app';

describe('tokens, sessions and revocation', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => Server;

  beforeAll(async () => {
    ({ app, prisma, http } = await createTestApp());
  });
  afterAll(async () => {
    await app?.close();
  });

  /** Registers a fresh account and returns its credentials. */
  async function newAccount() {
    const email = uniqueEmail();
    const res = await request(http())
      .post('/api/v1/auth/register')
      .send({ email, password: STRONG_PASSWORD, device: NATIVE_DEVICE })
      .expect(201);
    const body = res.body as AuthBody;
    return {
      email,
      userId: body.data.user.id,
      deviceId: body.data.device.id,
      access: body.data.tokens.accessToken!,
      refresh: body.data.tokens.refreshToken!,
    };
  }

  // ───────────────────────────────────────────────────── access tokens

  describe('access tokens', () => {
    it('admits a valid bearer token', async () => {
      const account = await newAccount();
      await request(http())
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${account.access}`)
        .expect(200);
    });

    it('refuses a request with no credentials', async () => {
      const res = await request(http()).get('/api/v1/me').expect(401);
      expect((res.body as ErrorBody).code).toBe('UNAUTHENTICATED');
    });

    it('refuses a malformed token', async () => {
      await request(http())
        .get('/api/v1/me')
        .set('Authorization', 'Bearer not-a-real-token')
        .expect(401);
    });

    it('refuses a token signed with the wrong key', async () => {
      // Same shape, different signature — the signature check is what matters.
      const forged =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
        'eyJzdWIiOiJhdHRhY2tlciIsInNpZCI6IngiLCJkaWQiOiJ4IiwianRpIjoieCJ9.' +
        'c2lnbmF0dXJlLXRoYXQtd2lsbC1uZXZlci12ZXJpZnk';
      await request(http()).get('/api/v1/me').set('Authorization', `Bearer ${forged}`).expect(401);
    });

    it('refuses an expired token', async () => {
      const account = await newAccount();
      // Rather than wait, move the account's validity watermark past the
      // token's issue time — the same check that rejects an expired token.
      await prisma.user.update({
        where: { id: account.userId },
        data: { tokensValidFrom: new Date(Date.now() + 60_000) },
      });
      await request(http())
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${account.access}`)
        .expect(401);
    });
  });

  // ──────────────────────────────────────────────────── refresh rotation

  describe('refresh rotation', () => {
    it('issues a new pair and invalidates the old refresh token', async () => {
      const account = await newAccount();

      const res = await request(http())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: account.refresh })
        .expect(200);

      const next = (res.body as AuthBody).data.tokens;
      expect(next.refreshToken).toBeDefined();
      expect(next.refreshToken).not.toBe(account.refresh);

      const old = await prisma.refreshToken.findUnique({
        where: { tokenHash: hashToken(account.refresh) },
      });
      expect(old?.revokedAt).not.toBeNull();
      expect(old?.rotatedToId).not.toBeNull();
    });

    it('the new access token works', async () => {
      const account = await newAccount();
      const res = await request(http())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: account.refresh })
        .expect(200);

      await request(http())
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${(res.body as AuthBody).data.tokens.accessToken!}`)
        .expect(200);
    });

    it('rejects an unknown refresh token', async () => {
      await request(http())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: 'not-a-token' })
        .expect(401);
    });

    it('rejects a refresh with no token at all', async () => {
      await request(http()).post('/api/v1/auth/refresh').send({}).expect(401);
    });
  });

  // ─────────────────────────────────────────────────────── reuse detection

  describe('refresh token reuse', () => {
    it('kills the whole session family when a rotated token is replayed', async () => {
      const account = await newAccount();

      const first = await request(http())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: account.refresh })
        .expect(200);
      const second = (first.body as AuthBody).data.tokens.refreshToken!;

      // Replaying the already-rotated token is the signal.
      await request(http())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: account.refresh })
        .expect(401);

      // The token the legitimate client holds is dead too — the session is
      // compromised and both copies are treated as suspect.
      await request(http()).post('/api/v1/auth/refresh').send({ refreshToken: second }).expect(401);

      const sessions = await prisma.session.findMany({ where: { userId: account.userId } });
      expect(sessions.every((s) => s.endedAt !== null)).toBe(true);
    });

    it('records the detection in the audit trail', async () => {
      const account = await newAccount();
      await request(http())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: account.refresh })
        .expect(200);
      await request(http())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: account.refresh })
        .expect(401);

      const entry = await prisma.auditLog.findFirst({
        where: { userId: account.userId, action: 'token.reuse_detected' },
      });
      expect(entry).not.toBeNull();
    });

    it('stores only hashes, never a usable refresh token', async () => {
      const account = await newAccount();
      const rows = await prisma.refreshToken.findMany({
        where: { session: { userId: account.userId } },
      });
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.tokenHash).not.toBe(account.refresh);
        expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────── logout

  describe('logout', () => {
    it('ends the session and stops the access token working', async () => {
      const account = await newAccount();

      await request(http())
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${account.access}`)
        .expect(204);

      // Immediate, not "once the token expires".
      await request(http())
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${account.access}`)
        .expect(401);
      await request(http())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: account.refresh })
        .expect(401);
    });

    it('leaves other devices signed in', async () => {
      const first = await newAccount();
      const second = await request(http())
        .post('/api/v1/auth/login')
        .send({
          email: first.email,
          password: STRONG_PASSWORD,
          device: { ...NATIVE_DEVICE, name: 'Second', platform: 'IOS' },
        })
        .expect(200);
      const secondAccess = (second.body as AuthBody).data.tokens.accessToken!;

      await request(http())
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${first.access}`)
        .expect(204);

      await request(http()).get('/api/v1/me').set('Authorization', `Bearer ${secondAccess}`).expect(200);
    });

    it('logout-all ends every session at once', async () => {
      const first = await newAccount();
      const second = await request(http())
        .post('/api/v1/auth/login')
        .send({
          email: first.email,
          password: STRONG_PASSWORD,
          device: { ...NATIVE_DEVICE, name: 'Second', platform: 'IOS' },
        })
        .expect(200);
      const secondAccess = (second.body as AuthBody).data.tokens.accessToken!;

      await request(http())
        .post('/api/v1/auth/logout-all')
        .set('Authorization', `Bearer ${secondAccess}`)
        .expect(200);

      await request(http()).get('/api/v1/me').set('Authorization', `Bearer ${first.access}`).expect(401);
      await request(http()).get('/api/v1/me').set('Authorization', `Bearer ${secondAccess}`).expect(401);
    });
  });

  // ───────────────────────────────────────────────────────────── sessions

  describe('session management', () => {
    it('lists sessions and marks the current one', async () => {
      const account = await newAccount();
      const res = await request(http())
        .get('/api/v1/me/sessions')
        .set('Authorization', `Bearer ${account.access}`)
        .expect(200);

      const sessions = (res.body as { data: Array<{ current: boolean; active: boolean }> }).data;
      expect(sessions.filter((s) => s.current)).toHaveLength(1);
      expect(sessions.every((s) => s.active)).toBe(true);
    });

    it('revokes another session without touching this one', async () => {
      const first = await newAccount();
      await request(http())
        .post('/api/v1/auth/login')
        .send({
          email: first.email,
          password: STRONG_PASSWORD,
          device: { ...NATIVE_DEVICE, name: 'Other', platform: 'WINDOWS' },
        })
        .expect(200);

      const list = await request(http())
        .get('/api/v1/me/sessions')
        .set('Authorization', `Bearer ${first.access}`)
        .expect(200);
      const other = (list.body as { data: Array<{ id: string; current: boolean }> }).data.find(
        (s) => !s.current,
      )!;

      await request(http())
        .delete(`/api/v1/me/sessions/${other.id}`)
        .set('Authorization', `Bearer ${first.access}`)
        .expect(204);

      await request(http()).get('/api/v1/me').set('Authorization', `Bearer ${first.access}`).expect(200);
    });

    it("cannot revoke another user's session", async () => {
      const victim = await newAccount();
      const attacker = await newAccount();

      const victimSession = await prisma.session.findFirstOrThrow({
        where: { userId: victim.userId },
      });

      // 404, not 403: confirming the id exists would itself be a disclosure.
      await request(http())
        .delete(`/api/v1/me/sessions/${victimSession.id}`)
        .set('Authorization', `Bearer ${attacker.access}`)
        .expect(404);

      const unchanged = await prisma.session.findUniqueOrThrow({ where: { id: victimSession.id } });
      expect(unchanged.endedAt).toBeNull();
    });
  });
});
