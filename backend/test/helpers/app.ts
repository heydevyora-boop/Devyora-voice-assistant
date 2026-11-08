import type { Server } from 'node:http';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../../src/app.module';
import { AppConfigService } from '../../src/config/app-config.module';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { PrismaService } from '../../src/database/prisma.service';

/**
 * Boots the real application with the same global pipeline `main.ts`
 * installs. Nothing is stubbed and no guard is relaxed: a test that passes
 * here passes against the shipped configuration.
 */
export async function createTestApp(): Promise<{
  app: INestApplication;
  prisma: PrismaService;
  http: () => Server;
}> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  const config = app.get(AppConfigService);

  app.use(cookieParser());
  app.setGlobalPrefix(config.app.apiPrefix, { exclude: ['health/live', 'health/ready'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: config.app.apiVersion });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  await app.init();

  const http = (): Server => app.getHttpServer();
  return { app, prisma: app.get(PrismaService), http };
}

let counter = 0;
export function uniqueEmail(prefix = 'user'): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@test.local`;
}

export const STRONG_PASSWORD = 'a-sufficiently-long-passphrase';

export const NATIVE_DEVICE = {
  platform: 'ANDROID' as const,
  name: 'Test Pixel',
  deviceType: 'phone',
  appVersion: '1.0.0',
};

export interface AuthBody {
  success: true;
  data: {
    user: { id: string; email: string; displayName: string | null; emailVerified: boolean };
    device: { id: string; publicId: string; platform: string; name: string };
    tokens: {
      accessToken?: string;
      refreshToken?: string;
      csrfToken?: string;
      expiresIn: number;
      tokenType: string;
    };
  };
}

export interface ErrorBody {
  success: false;
  code: string;
  message: string;
  statusCode: number;
}

export interface Envelope<T> {
  success: true;
  data: T;
}
