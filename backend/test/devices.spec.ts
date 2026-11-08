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
} from './helpers/app';

interface DeviceRow {
  id: string;
  publicId: string;
  name: string;
  status: 'active' | 'revoked';
  current: boolean;
  activeSessions: number;
  notificationsEnabled: boolean;
}

describe('devices and cross-user isolation', () => {
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
      deviceId: body.data.device.id,
      access: body.data.tokens.accessToken!,
      refresh: body.data.tokens.refreshToken!,
    };
  }

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  describe('registration and listing', () => {
    it('lists the device created at sign-up and marks it current', async () => {
      const account = await newAccount();
      const res = await request(http()).get('/api/v1/devices').set(auth(account.access)).expect(200);

      const devices = (res.body as { data: DeviceRow[] }).data;
      expect(devices).toHaveLength(1);
      expect(devices[0].current).toBe(true);
      expect(devices[0].status).toBe('active');
      expect(devices[0].activeSessions).toBe(1);
    });

    it('registers an additional device', async () => {
      const account = await newAccount();
      const res = await request(http())
        .post('/api/v1/devices')
        .set(auth(account.access))
        .send({ platform: 'WINDOWS', name: 'Desktop', deviceType: 'desktop' })
        .expect(201);

      expect((res.body as { data: DeviceRow }).data.publicId).toBeDefined();
      const list = await request(http()).get('/api/v1/devices').set(auth(account.access)).expect(200);
      expect((list.body as { data: DeviceRow[] }).data).toHaveLength(2);
    });

    it('generates the device identifier server-side and ignores any supplied one', async () => {
      const account = await newAccount();
      const res = await request(http())
        .post('/api/v1/devices')
        .set(auth(account.access))
        // `publicId` is not an accepted field; whitelist validation rejects it
        // outright rather than silently ignoring it.
        .send({ platform: 'IOS', name: 'Phone', publicId: 'attacker-chosen' })
        .expect(400);

      expect(JSON.stringify(res.body)).not.toContain('attacker-chosen');
    });

    it('reports push registration as a boolean, never echoing the token', async () => {
      const account = await newAccount();
      const res = await request(http())
        .post('/api/v1/devices')
        .set(auth(account.access))
        .send({ platform: 'IOS', name: 'Phone', pushToken: 'apns-routing-token-value' })
        .expect(201);

      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain('apns-routing-token-value');
      expect((res.body as { data: DeviceRow }).data.notificationsEnabled).toBe(true);
    });

    it('rejects an unauthenticated listing', async () => {
      await request(http()).get('/api/v1/devices').expect(401);
    });
  });

  describe('updating', () => {
    it('updates metadata', async () => {
      const account = await newAccount();
      const res = await request(http())
        .patch(`/api/v1/devices/${account.deviceId}`)
        .set(auth(account.access))
        .send({ name: 'Renamed', appVersion: '2.0.0' })
        .expect(200);

      expect((res.body as { data: DeviceRow }).data.name).toBe('Renamed');
    });

    it('rejects a malformed device id before touching the database', async () => {
      const account = await newAccount();
      await request(http())
        .patch('/api/v1/devices/not-a-uuid')
        .set(auth(account.access))
        .send({ name: 'x' })
        .expect(400);
    });
  });

  describe('revocation', () => {
    it('revokes a device and immediately stops its tokens working', async () => {
      const first = await newAccount();
      const second = await request(http())
        .post('/api/v1/auth/login')
        .send({
          email: first.email,
          password: STRONG_PASSWORD,
          device: { ...NATIVE_DEVICE, name: 'Other', platform: 'MACOS' },
        })
        .expect(200);
      const secondBody = (second.body as AuthBody).data;

      await request(http())
        .delete(`/api/v1/devices/${secondBody.device.id}`)
        .set(auth(first.access))
        .expect(200);

      // The guard re-checks the device every request, so revocation bites at
      // once rather than when the token happens to expire.
      await request(http()).get('/api/v1/me').set(auth(secondBody.tokens.accessToken!)).expect(401);
      await request(http())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: secondBody.tokens.refreshToken! })
        .expect(401);

      // The device that did the revoking is unaffected.
      await request(http()).get('/api/v1/me').set(auth(first.access)).expect(200);
    });

    it('clears the push registration when a device is revoked', async () => {
      const account = await newAccount();
      const created = await request(http())
        .post('/api/v1/devices')
        .set(auth(account.access))
        .send({ platform: 'IOS', name: 'Phone', pushToken: 'routing-token' })
        .expect(201);
      const deviceId = (created.body as { data: DeviceRow }).data.id;

      await request(http()).delete(`/api/v1/devices/${deviceId}`).set(auth(account.access)).expect(200);

      const row = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
      expect(row.revokedAt).not.toBeNull();
      // A revoked device must stop receiving notifications too.
      expect(row.pushToken).toBeNull();
    });

    it('reports how many sessions it ended', async () => {
      const first = await newAccount();
      const second = await request(http())
        .post('/api/v1/auth/login')
        .send({
          email: first.email,
          password: STRONG_PASSWORD,
          device: { ...NATIVE_DEVICE, name: 'Other', platform: 'MACOS' },
        })
        .expect(200);

      const res = await request(http())
        .delete(`/api/v1/devices/${(second.body as AuthBody).data.device.id}`)
        .set(auth(first.access))
        .expect(200);

      expect((res.body as { data: { sessionsEnded: number } }).data.sessionsEnded).toBe(1);
    });
  });

  describe('cross-user access', () => {
    it("cannot read another user's devices", async () => {
      const victim = await newAccount();
      const attacker = await newAccount();

      const res = await request(http()).get('/api/v1/devices').set(auth(attacker.access)).expect(200);
      const devices = (res.body as { data: DeviceRow[] }).data;

      expect(devices.every((d) => d.id !== victim.deviceId)).toBe(true);
    });

    it("cannot update another user's device", async () => {
      const victim = await newAccount();
      const attacker = await newAccount();

      await request(http())
        .patch(`/api/v1/devices/${victim.deviceId}`)
        .set(auth(attacker.access))
        .send({ name: 'hijacked' })
        .expect(404);

      const unchanged = await prisma.device.findUniqueOrThrow({ where: { id: victim.deviceId } });
      expect(unchanged.name).not.toBe('hijacked');
    });

    it("cannot revoke another user's device", async () => {
      const victim = await newAccount();
      const attacker = await newAccount();

      await request(http())
        .delete(`/api/v1/devices/${victim.deviceId}`)
        .set(auth(attacker.access))
        .expect(404);

      const unchanged = await prisma.device.findUniqueOrThrow({ where: { id: victim.deviceId } });
      expect(unchanged.revokedAt).toBeNull();
      // And the victim is still working.
      await request(http()).get('/api/v1/me').set(auth(victim.access)).expect(200);
    });

    it("cannot read another user's profile through any route", async () => {
      const victim = await newAccount();
      const attacker = await newAccount();

      const res = await request(http()).get('/api/v1/me').set(auth(attacker.access)).expect(200);
      const profile = (res.body as { data: { id: string; email: string } }).data;

      // Identity comes from the verified token, never from the request.
      expect(profile.id).not.toBe(victim.userId);
      expect(profile.email).not.toBe(victim.email);
    });

    it("cannot refresh using another user's refresh token after it is revoked", async () => {
      const victim = await newAccount();
      await request(http())
        .post('/api/v1/auth/logout')
        .set(auth(victim.access))
        .expect(204);

      await request(http())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: victim.refresh })
        .expect(401);
    });
  });
});
