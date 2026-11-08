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

describe('account lifecycle, password reset and email verification', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => Server;

  beforeAll(async () => {
    ({ app, prisma, http } = await createTestApp());
  });
  afterAll(async () => {
    await app?.close();
  });

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
      access: body.data.tokens.accessToken!,
      refresh: body.data.tokens.refreshToken!,
    };
  }
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /**
   * Reads the token the mail provider would have delivered.
   *
   * It is taken from the database, not from any API response — nothing in
   * the application hands a verification or reset token back to the caller,
   * because an endpoint that did would be an account-takeover endpoint.
   */
  /** Unique per run, so the unique index on tokenHash is not hit twice. */
  let tokenSeq = 0;
  const freshPlaintext = (label: string) => {
    tokenSeq += 1;
    return `${label}-${Date.now()}-${tokenSeq}`;
  };

  async function deliveredToken(userId: string, type: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET') {
    const row = await prisma.verificationToken.findFirstOrThrow({
      where: { userId, type, usedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return row;
  }

  // ──────────────────────────────────────────────────────────── profile

  describe('profile', () => {
    it('returns the current user without any credential material', async () => {
      const account = await newAccount();
      const res = await request(http()).get('/api/v1/me').set(auth(account.access)).expect(200);

      const raw = JSON.stringify(res.body);
      expect(raw).not.toMatch(/passwordHash|\$argon2/);
      expect((res.body as { data: { email: string } }).data.email).toBe(account.email.toLowerCase());
    });

    it('updates display name, locale and time zone', async () => {
      const account = await newAccount();
      const res = await request(http())
        .patch('/api/v1/me')
        .set(auth(account.access))
        .send({ displayName: 'Renamed', locale: 'hi-IN', timezone: 'Asia/Kolkata' })
        .expect(200);

      const data = (res.body as { data: { displayName: string; locale: string } }).data;
      expect(data.displayName).toBe('Renamed');
      expect(data.locale).toBe('hi-IN');
    });

    it('refuses an attempt to change the email address through the profile', async () => {
      const account = await newAccount();
      // Changing an address has to re-run verification, so it is not a
      // field on a profile update; whitelist validation rejects it.
      await request(http())
        .patch('/api/v1/me')
        .set(auth(account.access))
        .send({ email: 'new@test.local' })
        .expect(400);
    });

    it('rejects an invalid time zone', async () => {
      const account = await newAccount();
      await request(http())
        .patch('/api/v1/me')
        .set(auth(account.access))
        .send({ timezone: 'Mars/Olympus Mons' })
        .expect(400);
    });
  });

  // ─────────────────────────────────────────────────────────── password

  describe('password change', () => {
    it('changes the password and ends every session', async () => {
      const account = await newAccount();

      await request(http())
        .post('/api/v1/auth/password/change')
        .set(auth(account.access))
        .send({ currentPassword: STRONG_PASSWORD, newPassword: 'another-long-enough-passphrase' })
        .expect(204);

      // A changed password must not leave a stolen token usable.
      await request(http()).get('/api/v1/me').set(auth(account.access)).expect(401);

      await request(http())
        .post('/api/v1/auth/login')
        .send({ email: account.email, password: 'another-long-enough-passphrase', device: NATIVE_DEVICE })
        .expect(200);
    });

    it('refuses a wrong current password', async () => {
      const account = await newAccount();
      await request(http())
        .post('/api/v1/auth/password/change')
        .set(auth(account.access))
        .send({ currentPassword: 'not-the-current-one', newPassword: 'another-long-passphrase' })
        .expect(401);
    });

    it('refuses a weak new password', async () => {
      const account = await newAccount();
      await request(http())
        .post('/api/v1/auth/password/change')
        .set(auth(account.access))
        .send({ currentPassword: STRONG_PASSWORD, newPassword: 'short' })
        .expect(400);
    });
  });

  describe('password reset', () => {
    it('accepts a request for an unknown address without revealing that', async () => {
      const unknown = await request(http())
        .post('/api/v1/auth/password/reset/request')
        .send({ email: uniqueEmail('ghost') })
        .expect(202);

      const account = await newAccount();
      const known = await request(http())
        .post('/api/v1/auth/password/reset/request')
        .send({ email: account.email })
        .expect(202);

      // The envelope carries a per-request correlation id, so the payload is
      // what must be indistinguishable between the two cases.
      const payload = (r: { body: unknown }) => (r.body as { data: unknown }).data;
      expect(payload(unknown)).toEqual(payload(known));
      expect(unknown.status).toBe(known.status);
    });

    it('never returns the reset token in the response', async () => {
      const account = await newAccount();
      const res = await request(http())
        .post('/api/v1/auth/password/reset/request')
        .send({ email: account.email })
        .expect(202);

      const stored = await deliveredToken(account.userId, 'PASSWORD_RESET');
      const raw = JSON.stringify(res.body);

      // Neither the token nor its hash may appear anywhere in the response:
      // an endpoint that returned its own reset token would be an account
      // takeover endpoint.
      expect(raw).not.toContain(stored.tokenHash);
      expect(raw).not.toMatch(/token/i);
      expect((res.body as { data: { accepted: boolean } }).data).toEqual({ accepted: true });
    });

    it('stores only the hash of the reset token', async () => {
      const account = await newAccount();
      await request(http())
        .post('/api/v1/auth/password/reset/request')
        .send({ email: account.email })
        .expect(202);

      const stored = await deliveredToken(account.userId, 'PASSWORD_RESET');
      expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('rejects an invented reset token', async () => {
      const res = await request(http())
        .post('/api/v1/auth/password/reset/confirm')
        .send({ token: 'made-up-token', newPassword: 'a-brand-new-long-passphrase' })
        .expect(400);
      expect((res.body as ErrorBody).code).toBe('VALIDATION_FAILED');
    });

    it('completes a reset with a genuinely issued token, then refuses to reuse it', async () => {
      const account = await newAccount();
      // Stand in for the delivered email by issuing a token and recording
      // its plaintext the same way the mail provider would receive it.
      const plaintext = freshPlaintext('reset-plaintext-for-this-test');
      await prisma.verificationToken.create({
        data: {
          userId: account.userId,
          type: 'PASSWORD_RESET',
          tokenHash: hashToken(plaintext),
          emailAtIssue: account.email.toLowerCase(),
          expiresAt: new Date(Date.now() + 600_000),
        },
      });

      await request(http())
        .post('/api/v1/auth/password/reset/confirm')
        .send({ token: plaintext, newPassword: 'a-brand-new-long-passphrase' })
        .expect(204);

      await request(http())
        .post('/api/v1/auth/login')
        .send({ email: account.email, password: 'a-brand-new-long-passphrase', device: NATIVE_DEVICE })
        .expect(200);

      // Single use.
      await request(http())
        .post('/api/v1/auth/password/reset/confirm')
        .send({ token: plaintext, newPassword: 'yet-another-long-passphrase' })
        .expect(400);
    });

    it('ends every session when a reset completes', async () => {
      const account = await newAccount();
      const plaintext = freshPlaintext('reset-plaintext-sessions');
      await prisma.verificationToken.create({
        data: {
          userId: account.userId,
          type: 'PASSWORD_RESET',
          tokenHash: hashToken(plaintext),
          emailAtIssue: account.email.toLowerCase(),
          expiresAt: new Date(Date.now() + 600_000),
        },
      });

      await request(http())
        .post('/api/v1/auth/password/reset/confirm')
        .send({ token: plaintext, newPassword: 'a-replacement-long-passphrase' })
        .expect(204);

      // A reset is the remedy for a compromise, so existing sessions go too.
      await request(http()).get('/api/v1/me').set(auth(account.access)).expect(401);
    });

    it('rejects an expired reset token', async () => {
      const account = await newAccount();
      const plaintext = freshPlaintext('reset-plaintext-expired');
      await prisma.verificationToken.create({
        data: {
          userId: account.userId,
          type: 'PASSWORD_RESET',
          tokenHash: hashToken(plaintext),
          emailAtIssue: account.email.toLowerCase(),
          expiresAt: new Date(Date.now() - 1000),
        },
      });

      await request(http())
        .post('/api/v1/auth/password/reset/confirm')
        .send({ token: plaintext, newPassword: 'a-replacement-long-passphrase' })
        .expect(400);
    });
  });

  // ────────────────────────────────────────────────── email verification

  describe('email verification', () => {
    it('leaves a new account unverified', async () => {
      const account = await newAccount();
      const res = await request(http()).get('/api/v1/me').set(auth(account.access)).expect(200);
      expect((res.body as { data: { emailVerified: boolean } }).data.emailVerified).toBe(false);
    });

    it('issues a token at registration without returning it', async () => {
      const account = await newAccount();
      const stored = await deliveredToken(account.userId, 'EMAIL_VERIFICATION');
      expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(stored.emailAtIssue).toBe(account.email.toLowerCase());
    });

    it('verifies only against a token that was really issued', async () => {
      const account = await newAccount();

      await request(http())
        .post('/api/v1/auth/email/verify')
        .send({ token: 'a-token-nobody-issued' })
        .expect(400);

      // Still unverified — nothing fakes this.
      const before = await prisma.user.findUniqueOrThrow({ where: { id: account.userId } });
      expect(before.emailVerifiedAt).toBeNull();

      const plaintext = freshPlaintext('verification-plaintext-for-this-test');
      await prisma.verificationToken.updateMany({
        where: { userId: account.userId, type: 'EMAIL_VERIFICATION' },
        data: { usedAt: new Date() },
      });
      await prisma.verificationToken.create({
        data: {
          userId: account.userId,
          type: 'EMAIL_VERIFICATION',
          tokenHash: hashToken(plaintext),
          emailAtIssue: account.email.toLowerCase(),
          expiresAt: new Date(Date.now() + 600_000),
        },
      });

      await request(http()).post('/api/v1/auth/email/verify').send({ token: plaintext }).expect(204);

      const after = await prisma.user.findUniqueOrThrow({ where: { id: account.userId } });
      expect(after.emailVerifiedAt).not.toBeNull();
    });

    it('refuses a password-reset token presented to the verification endpoint', async () => {
      const account = await newAccount();
      const plaintext = freshPlaintext('cross-type-token');
      await prisma.verificationToken.create({
        data: {
          userId: account.userId,
          type: 'PASSWORD_RESET',
          tokenHash: hashToken(plaintext),
          emailAtIssue: account.email.toLowerCase(),
          expiresAt: new Date(Date.now() + 600_000),
        },
      });

      await request(http()).post('/api/v1/auth/email/verify').send({ token: plaintext }).expect(400);
    });
  });

  // ──────────────────────────────────────────── deactivation and deletion

  describe('deactivation and deletion', () => {
    it('suspends the account and stops access', async () => {
      const account = await newAccount();
      await request(http()).post('/api/v1/me/deactivate').set(auth(account.access)).expect(200);

      await request(http()).get('/api/v1/me').set(auth(account.access)).expect(401);
      await request(http())
        .post('/api/v1/auth/login')
        .send({ email: account.email, password: STRONG_PASSWORD, device: NATIVE_DEVICE })
        .expect(401);
    });

    it('starts deletion, ends access and reports the grace period honestly', async () => {
      const account = await newAccount();
      const res = await request(http()).delete('/api/v1/me').set(auth(account.access)).expect(202);

      const data = (res.body as { data: { status: string; purgeAfter: string; note: string } }).data;
      expect(data.status).toBe('PENDING_DELETION');
      expect(new Date(data.purgeAfter).getTime()).toBeGreaterThan(Date.now());
      // The response does not claim the data is already gone.
      expect(data.note).toMatch(/after the grace period/i);

      await request(http()).get('/api/v1/me').set(auth(account.access)).expect(401);

      const row = await prisma.user.findUniqueOrThrow({ where: { id: account.userId } });
      expect(row.deletedAt).not.toBeNull();
    });

    it('revokes devices as part of deletion', async () => {
      const account = await newAccount();
      await request(http()).delete('/api/v1/me').set(auth(account.access)).expect(202);

      const devices = await prisma.device.findMany({ where: { userId: account.userId } });
      expect(devices.every((d) => d.revokedAt !== null)).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────── export

  describe('data export', () => {
    it('returns the account contents without any credential', async () => {
      const account = await newAccount();
      const res = await request(http()).get('/api/v1/me/export').set(auth(account.access)).expect(200);

      const raw = JSON.stringify(res.body);
      expect(raw).not.toMatch(/passwordHash|\$argon2/);
      expect(raw).not.toContain(account.refresh);
      expect(raw).not.toMatch(/accessTokenEnc|refreshTokenEnc|tokenHash/);

      const data = (res.body as { data: { format: string; user: unknown; notes: unknown[] } }).data;
      expect(data.format).toBe('devyora.export.v1');
      expect(data.user).toBeDefined();
      expect(Array.isArray(data.notes)).toBe(true);
    });

    it('records the export in the audit trail', async () => {
      const account = await newAccount();
      await request(http()).get('/api/v1/me/export').set(auth(account.access)).expect(200);

      const entry = await prisma.auditLog.findFirst({
        where: { userId: account.userId, action: 'user.data_exported' },
      });
      expect(entry).not.toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────── audit

  describe('audit trail', () => {
    it('records registration and login without storing any credential', async () => {
      const account = await newAccount();
      await request(http())
        .post('/api/v1/auth/login')
        .send({ email: account.email, password: STRONG_PASSWORD, device: NATIVE_DEVICE })
        .expect(200);

      const entries = await prisma.auditLog.findMany({ where: { userId: account.userId } });
      const actions = entries.map((e) => e.action);
      expect(actions).toContain('user.registered');
      expect(actions).toContain('user.login.succeeded');

      const raw = JSON.stringify(entries);
      expect(raw).not.toContain(STRONG_PASSWORD);
      expect(raw).not.toContain(account.refresh);
      expect(raw).not.toMatch(/\$argon2/);
    });

    it('records a failed login attempt', async () => {
      const account = await newAccount();
      await request(http())
        .post('/api/v1/auth/login')
        .send({ email: account.email, password: 'wrong-but-long-enough', device: NATIVE_DEVICE })
        .expect(401);

      const entry = await prisma.auditLog.findFirst({
        where: { userId: account.userId, action: 'user.login.failed' },
      });
      expect(entry).not.toBeNull();
    });
  });
});
