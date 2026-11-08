import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  createTestApp,
  uniqueEmail,
  STRONG_PASSWORD,
  NATIVE_DEVICE,
  type AuthBody,
  type ErrorBody,
} from './helpers/app';

/**
 * The suite raises the per-route ceilings under NODE_ENV=test, because every
 * request comes from one address and the limits would otherwise throttle the
 * tests rather than the thing under test. The limiter itself is not disabled,
 * and this file proves it: it drives a route past its ceiling and expects a
 * rejection.
 */
describe('rate limiting and CSRF', () => {
  let app: INestApplication;
  let http: () => Server;

  beforeAll(async () => {
    ({ app, http } = await createTestApp());
  });
  afterAll(async () => {
    await app?.close();
  });

  describe('rate limiting', () => {
    it('is installed and rejects once a ceiling is passed', async () => {
      // The scaled login ceiling is 10 × 200. Exceeding it proves the guard
      // is wired in and counting, rather than silently absent.
      const ceiling = 10 * 200;
      const email = uniqueEmail();
      let limited = false;

      for (let i = 0; i < ceiling + 5; i += 1) {
        const res = await request(http())
          .post('/api/v1/auth/login')
          .send({ email, password: 'a-wrong-but-long-passphrase', device: NATIVE_DEVICE });

        if (res.status === 429) {
          limited = true;
          expect((res.body as ErrorBody).code).toBe('RATE_LIMITED');
          break;
        }
      }

      expect(limited).toBe(true);
    }, 120_000);
  });

  describe('CSRF for cookie sessions', () => {
    /** Registers a browser-style session and returns its cookies. */
    async function browserSession() {
      const res = await request(http())
        .post('/api/v1/auth/register')
        .send({
          email: uniqueEmail('browser'),
          password: STRONG_PASSWORD,
          device: { ...NATIVE_DEVICE, platform: 'WEB', name: 'Browser' },
          clientType: 'browser',
        })
        .expect(201);

      const cookies = res.headers['set-cookie'] as unknown as string[];
      const csrfToken = (res.body as AuthBody).data.tokens.csrfToken!;
      return { cookies, csrfToken };
    }

    it('authenticates a GET from cookies alone', async () => {
      const { cookies } = await browserSession();
      // Safe methods need no CSRF token.
      await request(http()).get('/api/v1/me').set('Cookie', cookies).expect(200);
    });

    it('rejects a state-changing request with no CSRF header', async () => {
      const { cookies } = await browserSession();
      const res = await request(http())
        .patch('/api/v1/me')
        .set('Cookie', cookies)
        .send({ displayName: 'Changed' })
        .expect(403);

      expect((res.body as ErrorBody).code).toBe('FORBIDDEN');
    });

    it('rejects a mismatched CSRF header', async () => {
      const { cookies } = await browserSession();
      await request(http())
        .patch('/api/v1/me')
        .set('Cookie', cookies)
        .set('X-CSRF-Token', 'not-the-right-value')
        .send({ displayName: 'Changed' })
        .expect(403);
    });

    it('accepts a state-changing request when the header matches the cookie', async () => {
      const { cookies, csrfToken } = await browserSession();
      await request(http())
        .patch('/api/v1/me')
        .set('Cookie', cookies)
        .set('X-CSRF-Token', csrfToken)
        .send({ displayName: 'Changed' })
        .expect(200);
    });

    it('does not impose CSRF on bearer clients, which cannot be targeted by it', async () => {
      const res = await request(http())
        .post('/api/v1/auth/register')
        .send({ email: uniqueEmail('native'), password: STRONG_PASSWORD, device: NATIVE_DEVICE })
        .expect(201);
      const access = (res.body as AuthBody).data.tokens.accessToken!;

      // A cross-site page cannot obtain a bearer token in the first place,
      // so requiring a second one would burden native clients for nothing.
      await request(http())
        .patch('/api/v1/me')
        .set('Authorization', `Bearer ${access}`)
        .send({ displayName: 'Changed' })
        .expect(200);
    });

    it('clears the cookies on logout', async () => {
      const { cookies, csrfToken } = await browserSession();
      const res = await request(http())
        .post('/api/v1/auth/logout')
        .set('Cookie', cookies)
        .set('X-CSRF-Token', csrfToken)
        .expect(204);

      const cleared = res.headers['set-cookie'] as unknown as string[];
      expect(cleared.some((c) => /^dvy_at=;/.test(c))).toBe(true);
      expect(cleared.some((c) => /^dvy_rt=;/.test(c))).toBe(true);
    });

    it('protects cookie-based refresh with CSRF too', async () => {
      const { cookies } = await browserSession();
      // Refresh is a state-changing, cookie-authenticated endpoint: without
      // this, a hostile page could silently rotate a victim's tokens.
      await request(http()).post('/api/v1/auth/refresh').set('Cookie', cookies).expect(403);
    });

    it('refreshes from the cookie when the CSRF header is present', async () => {
      const { cookies, csrfToken } = await browserSession();
      const res = await request(http())
        .post('/api/v1/auth/refresh')
        .set('Cookie', cookies)
        .set('X-CSRF-Token', csrfToken)
        .expect(200);

      // Still cookie transport: no tokens in the body.
      const body = res.body as AuthBody;
      expect(body.data.tokens.accessToken).toBeUndefined();
      expect(
        (res.headers['set-cookie'] as unknown as string[]).some((c) => c.startsWith('dvy_at=')),
      ).toBe(true);
    });
  });
});
