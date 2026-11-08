import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaService } from '../src/database/prisma.service';
import {
  createTestApp,
  uniqueEmail,
  STRONG_PASSWORD,
  NATIVE_DEVICE,
  type AuthBody,
  type ErrorBody,
} from './helpers/app';

describe('authentication', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => Server;

  beforeAll(async () => {
    ({ app, prisma, http } = await createTestApp());
  });

  afterAll(async () => {
    await app?.close();
  });

  const register = (overrides: Record<string, unknown> = {}) =>
    request(http())
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail(), password: STRONG_PASSWORD, device: NATIVE_DEVICE, ...overrides });

  // ───────────────────────────────────────────────────────── registration

  describe('registration', () => {
    it('creates an account and returns tokens for a native client', async () => {
      const res = await register().expect(201);
      const body = res.body as AuthBody;

      expect(body.data.user.id).toBeDefined();
      expect(body.data.tokens.accessToken).toBeDefined();
      expect(body.data.tokens.refreshToken).toBeDefined();
      expect(body.data.tokens.tokenType).toBe('Bearer');
      expect(body.data.device.publicId).toBeDefined();
    });

    it('never returns the password or its hash', async () => {
      const res = await register().expect(201);
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain(STRONG_PASSWORD);
      expect(raw).not.toMatch(/\$argon2/);
      expect(raw).not.toMatch(/passwordHash/);
    });

    it('stores an Argon2id hash, never the plaintext', async () => {
      const email = uniqueEmail();
      await register({ email }).expect(201);

      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(user.passwordHash).toMatch(/^\$argon2id\$/);
      expect(user.passwordHash).not.toContain(STRONG_PASSWORD);
    });

    it('does not mark the address verified on registration', async () => {
      const email = uniqueEmail();
      await register({ email }).expect(201);
      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      // Nothing fakes verification: it stays null until a real token is used.
      expect(user.emailVerifiedAt).toBeNull();
    });

    it('rejects a weak password', async () => {
      const res = await register({ password: 'short' }).expect(400);
      expect((res.body as ErrorBody).code).toBe('VALIDATION_FAILED');
    });

    it('rejects a malformed email', async () => {
      await register({ email: 'not-an-email' }).expect(400);
    });

    it('treats a duplicate address without revealing that it exists', async () => {
      const email = uniqueEmail();
      await register({ email }).expect(201);
      const res = await register({ email }).expect(409);
      // Generic by design — this must not become an account-existence oracle.
      expect((res.body as ErrorBody).message).not.toContain(email);
    });

    it('normalises the address so case cannot create a second account', async () => {
      const email = uniqueEmail('Case');
      await register({ email: email.toUpperCase() }).expect(201);
      await register({ email: email.toLowerCase() }).expect(409);
    });

    it('sets browser cookies and withholds tokens from the body', async () => {
      const res = await register({ clientType: 'browser' }).expect(201);
      const cookies = res.headers['set-cookie'] as unknown as string[];

      expect(cookies.some((c) => c.startsWith('dvy_at='))).toBe(true);
      expect(cookies.some((c) => c.startsWith('dvy_rt='))).toBe(true);
      expect(cookies.some((c) => c.startsWith('dvy_csrf='))).toBe(true);

      const body = res.body as AuthBody;
      expect(body.data.tokens.accessToken).toBeUndefined();
      expect(body.data.tokens.refreshToken).toBeUndefined();
      expect(body.data.tokens.csrfToken).toBeDefined();
    });

    it('marks token cookies HttpOnly and the CSRF cookie readable', async () => {
      const res = await register({ clientType: 'browser' }).expect(201);
      const cookies = res.headers['set-cookie'] as unknown as string[];

      const access = cookies.find((c) => c.startsWith('dvy_at='))!;
      const refresh = cookies.find((c) => c.startsWith('dvy_rt='))!;
      const csrf = cookies.find((c) => c.startsWith('dvy_csrf='))!;

      expect(access).toMatch(/HttpOnly/i);
      expect(refresh).toMatch(/HttpOnly/i);
      expect(access).toMatch(/SameSite=Lax/i);
      // Readable on purpose: the client echoes it in a header.
      expect(csrf).not.toMatch(/HttpOnly/i);
      // Scoped so it is not attached to every ordinary API call.
      expect(refresh).toMatch(/Path=\/api\/v1\/auth/i);
    });
  });

  // ─────────────────────────────────────────────────────────────── login

  describe('login', () => {
    it('authenticates with correct credentials', async () => {
      const email = uniqueEmail();
      await register({ email }).expect(201);

      const res = await request(http())
        .post('/api/v1/auth/login')
        .send({ email, password: STRONG_PASSWORD, device: NATIVE_DEVICE })
        .expect(200);

      expect((res.body as AuthBody).data.tokens.accessToken).toBeDefined();
    });

    it('rejects a wrong password', async () => {
      const email = uniqueEmail();
      await register({ email }).expect(201);

      const res = await request(http())
        .post('/api/v1/auth/login')
        .send({ email, password: 'a-different-long-passphrase', device: NATIVE_DEVICE })
        .expect(401);

      expect((res.body as ErrorBody).code).toBe('UNAUTHENTICATED');
    });

    it('gives the same answer for an unknown account as for a wrong password', async () => {
      const email = uniqueEmail();
      await register({ email }).expect(201);

      const wrongPassword = await request(http())
        .post('/api/v1/auth/login')
        .send({ email, password: 'a-different-long-passphrase', device: NATIVE_DEVICE })
        .expect(401);

      const unknownAccount = await request(http())
        .post('/api/v1/auth/login')
        .send({ email: uniqueEmail('ghost'), password: STRONG_PASSWORD, device: NATIVE_DEVICE })
        .expect(401);

      expect((wrongPassword.body as ErrorBody).message).toBe(
        (unknownAccount.body as ErrorBody).message,
      );
    });

    it('locks the account after repeated failures, then rejects the right password too', async () => {
      const email = uniqueEmail();
      await register({ email }).expect(201);

      for (let i = 0; i < 8; i += 1) {
        await request(http())
          .post('/api/v1/auth/login')
          .send({ email, password: `wrong-attempt-number-${i}`, device: NATIVE_DEVICE })
          .expect(401);
      }

      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(user.lockedUntil).not.toBeNull();

      // The correct password is refused while the lock holds — which is the
      // point of an account-level lockout.
      await request(http())
        .post('/api/v1/auth/login')
        .send({ email, password: STRONG_PASSWORD, device: NATIVE_DEVICE })
        .expect(401);
    });

    it('clears the failure counter after a successful login', async () => {
      const email = uniqueEmail();
      await register({ email }).expect(201);

      await request(http())
        .post('/api/v1/auth/login')
        .send({ email, password: 'wrong-but-long-enough', device: NATIVE_DEVICE })
        .expect(401);
      await request(http())
        .post('/api/v1/auth/login')
        .send({ email, password: STRONG_PASSWORD, device: NATIVE_DEVICE })
        .expect(200);

      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(user.failedLoginAttempts).toBe(0);
      expect(user.lastLoginAt).not.toBeNull();
    });

    it('creates a separate device and session per login', async () => {
      const email = uniqueEmail();
      const first = await register({ email }).expect(201);

      const second = await request(http())
        .post('/api/v1/auth/login')
        .send({ email, password: STRONG_PASSWORD, device: { ...NATIVE_DEVICE, name: 'Laptop', platform: 'MACOS' } })
        .expect(200);

      expect((second.body as AuthBody).data.device.id).not.toBe(
        (first.body as AuthBody).data.device.id,
      );

      const userId = (first.body as AuthBody).data.user.id;
      expect(await prisma.session.count({ where: { userId, endedAt: null } })).toBe(2);
    });

    it('reuses a device when its identifier is presented with the right password', async () => {
      const email = uniqueEmail();
      const first = await register({ email }).expect(201);
      const publicId = (first.body as AuthBody).data.device.publicId;

      const second = await request(http())
        .post('/api/v1/auth/login')
        .send({ email, password: STRONG_PASSWORD, device: NATIVE_DEVICE, devicePublicId: publicId })
        .expect(200);

      expect((second.body as AuthBody).data.device.id).toBe(
        (first.body as AuthBody).data.device.id,
      );
    });

    it("ignores another account's device identifier instead of adopting it", async () => {
      const victim = await register().expect(201);
      const victimDevice = (victim.body as AuthBody).data.device;

      const attackerEmail = uniqueEmail('attacker');
      await register({ email: attackerEmail }).expect(201);

      const res = await request(http())
        .post('/api/v1/auth/login')
        .send({
          email: attackerEmail,
          password: STRONG_PASSWORD,
          device: NATIVE_DEVICE,
          devicePublicId: victimDevice.publicId,
        })
        .expect(200);

      // A device id is not a credential. It is scoped to the account, so the
      // attacker simply gets a new device of their own.
      expect((res.body as AuthBody).data.device.id).not.toBe(victimDevice.id);
    });
  });
});
