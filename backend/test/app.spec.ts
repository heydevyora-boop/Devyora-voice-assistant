import type { Server } from 'node:http';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AppConfigService } from '../src/config/app-config.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { PrismaService } from '../src/database/prisma.service';
import { CORRELATION_ID_HEADER } from '../src/common/middleware/correlation-id.middleware';

/**
 * Boots the real application against the real database.
 *
 * These are integration tests on purpose: the things most likely to break in
 * a foundation — wiring, lifecycle, the global pipeline — are exactly the
 * things a mocked unit test cannot see.
 */
/** Shapes the endpoints return, so assertions are not written against `any`. */
interface ReadinessBody {
  status: 'ready' | 'degraded';
  checks: Record<string, { status: string; latencyMs?: number }>;
}
interface ErrorBody {
  success: false;
  code: string;
  message: string;
  statusCode: number;
  correlationId: string;
  timestamp: string;
  path: string;
  stack?: unknown;
}

describe('application', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  /** `getHttpServer()` is typed `any`; narrow it once here. */
  const http = (): Server => app.getHttpServer() as Server;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    const config = app.get(AppConfigService);

    // Mirror main.ts so the tests exercise the pipeline that ships.
    app.setGlobalPrefix(config.app.apiPrefix, { exclude: ['health/live', 'health/ready'] });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: config.app.apiVersion });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());

    prisma = app.get(PrismaService);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('startup', () => {
    it('boots the module graph', () => {
      expect(app).toBeDefined();
    });

    it('resolves validated configuration', () => {
      const config = app.get(AppConfigService);
      expect(config.app.apiPrefix).toBe('api');
      expect(config.database.url).toMatch(/^postgres/);
    });
  });

  describe('database', () => {
    it('is connected', async () => {
      await expect(prisma.ping()).resolves.toBe(true);
    });

    it('answers a real query', async () => {
      const rows = await prisma.$queryRaw<Array<{ one: number }>>`SELECT 1 AS one`;
      expect(rows[0].one).toBe(1);
    });

    it('exposes every model from the approved schema', () => {
      for (const model of [
        'user', 'device', 'session', 'refreshToken', 'conversation', 'message',
        'assistantCommand', 'pendingAction', 'actionExecution', 'note',
        'reminder', 'connectedAccount', 'userPreference', 'notification', 'auditLog',
      ]) {
        expect(prisma[model as keyof PrismaService]).toBeDefined();
      }
    });

    it('rolls a transaction back when the work throws', async () => {
      const email = `tx-${Date.now()}@test.local`;
      await expect(
        prisma.transaction(async (tx) => {
          await tx.user.create({ data: { email, passwordHash: 'x' } });
          throw new Error('deliberate');
        }),
      ).rejects.toThrow('deliberate');

      await expect(prisma.user.findUnique({ where: { email } })).resolves.toBeNull();
    });

    it('commits a transaction that succeeds', async () => {
      const email = `tx-ok-${Date.now()}@test.local`;
      const id = await prisma.transaction(async (tx) => {
        const user = await tx.user.create({ data: { email, passwordHash: 'x' } });
        return user.id;
      });

      await expect(prisma.user.findUnique({ where: { id } })).resolves.not.toBeNull();
      await prisma.user.delete({ where: { id } });
    });

    it('cascades owned rows when a user is deleted', async () => {
      const user = await prisma.user.create({
        data: {
          email: `cascade-${Date.now()}@test.local`,
          passwordHash: 'x',
          notes: { create: { text: 'to be removed' } },
        },
      });

      await prisma.user.delete({ where: { id: user.id } });
      await expect(prisma.note.count({ where: { userId: user.id } })).resolves.toBe(0);
    });

    it('keeps the audit trail after its user is deleted, with the reference nulled', async () => {
      const user = await prisma.user.create({
        data: { email: `audit-${Date.now()}@test.local`, passwordHash: 'x' },
      });
      const log = await prisma.auditLog.create({
        data: { userId: user.id, action: 'test.event', actorType: 'SYSTEM' },
      });

      await prisma.user.delete({ where: { id: user.id } });

      const kept = await prisma.auditLog.findUnique({ where: { id: log.id } });
      expect(kept).not.toBeNull();
      expect(kept?.userId).toBeNull();
      await prisma.auditLog.delete({ where: { id: log.id } });
    });

    it('rejects a duplicate email at the database level', async () => {
      const email = `dupe-${Date.now()}@test.local`;
      const first = await prisma.user.create({ data: { email, passwordHash: 'x' } });
      await expect(prisma.user.create({ data: { email, passwordHash: 'y' } })).rejects.toThrow();
      await prisma.user.delete({ where: { id: first.id } });
    });
  });

  describe('health endpoints', () => {
    it('reports liveness without touching a dependency', async () => {
      const res = await request(http()).get('/health/live').expect(200);
      expect(res.body as { status: string }).toEqual({ status: 'ok' });
    });

    it('reports readiness with per-dependency state', async () => {
      const body = (await request(http()).get('/health/ready').expect(200)).body as ReadinessBody;
      expect(body.status).toBe('ready');
      expect(body.checks.database.status).toBe('up');
      expect(typeof body.checks.database.latencyMs).toBe('number');
    });

    it('reports Redis as not-configured rather than failing readiness', async () => {
      const body = (await request(http()).get('/health/ready').expect(200)).body as ReadinessBody;
      expect(body.checks.redis.status).toBe('not-configured');
    });

    it('does not disclose infrastructure details', async () => {
      const res = await request(http()).get('/health/ready').expect(200);
      const body = JSON.stringify(res.body as ReadinessBody);
      expect(body).not.toMatch(/postgres(ql)?:\/\//);
      expect(body).not.toMatch(/localhost/);
      expect(body).not.toMatch(/password/i);
      expect(body).not.toMatch(/5432|55432/);
    });

    it('sits outside the version prefix so probes survive a version bump', async () => {
      await request(http()).get('/health/live').expect(200);
      await request(http()).get('/api/v1/health/live').expect(404);
    });
  });

  describe('request correlation', () => {
    it('returns a correlation id when the caller sends none', async () => {
      const res = await request(http()).get('/health/live').expect(200);
      expect(res.headers[CORRELATION_ID_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('echoes an inbound correlation id so a trace can span services', async () => {
      const res = await request(http())
        .get('/health/live')
        .set(CORRELATION_ID_HEADER, 'trace-from-the-client')
        .expect(200);
      expect(res.headers[CORRELATION_ID_HEADER]).toBe('trace-from-the-client');
    });
  });

  describe('error handling', () => {
    it('returns the standard envelope for an unknown route', async () => {
      const body = (await request(http()).get('/api/v1/does-not-exist').expect(404))
        .body as ErrorBody;
      expect(body).toMatchObject({
        success: false,
        code: 'NOT_FOUND',
        statusCode: 404,
        path: '/api/v1/does-not-exist',
      });
      expect(body.correlationId).toBeDefined();
      expect(body.timestamp).toBeDefined();
    });

    it('never leaks a stack trace', async () => {
      const body = (await request(http()).get('/api/v1/does-not-exist').expect(404))
        .body as ErrorBody;
      expect(JSON.stringify(body)).not.toMatch(/at .*\.ts:\d+/);
      expect(body.stack).toBeUndefined();
    });

    it('ties the error body to the response header', async () => {
      const res = await request(http())
        .get('/api/v1/does-not-exist')
        .set(CORRELATION_ID_HEADER, 'tie-me')
        .expect(404);
      expect((res.body as ErrorBody).correlationId).toBe('tie-me');
      expect(res.headers[CORRELATION_ID_HEADER]).toBe('tie-me');
    });
  });
});
