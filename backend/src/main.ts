import 'reflect-metadata';
import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  const config = app.get(AppConfigService);
  const { app: appConfig, docs } = config;

  // ── Security headers ───────────────────────────────────────────────
  // CSP is left off here: this service returns JSON, and a policy written
  // for an API would only mislead. The frontend sets its own.
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } }));

  // ── CORS ───────────────────────────────────────────────────────────
  const allowAll = appConfig.corsOrigins.includes('*');
  app.enableCors({
    origin: allowAll ? true : appConfig.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Correlation-Id', 'Idempotency-Key'],
    exposedHeaders: ['X-Correlation-Id'],
    maxAge: 86_400,
  });

  // ── Routing ────────────────────────────────────────────────────────
  // `/api/v1/...`. Health sits outside the version prefix so probes keep
  // working across versions.
  app.setGlobalPrefix(appConfig.apiPrefix, { exclude: ['health/live', 'health/ready'] });
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: appConfig.apiVersion,
  });

  // ── Validation ─────────────────────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      // Strip unknown properties, and reject rather than ignore them, so a
      // client cannot smuggle a field a future version might honour.
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      validationError: { target: false, value: false },
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  // ── API documentation ──────────────────────────────────────────────
  if (docs.enabled && !appConfig.isProduction) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Devyora API')
        .setDescription(
          'Central backend for the Devyora voice assistant. ' +
            'One assistant, one backend, many platforms.',
        )
        .setVersion(appConfig.apiVersion)
        .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
        .addServer(`/${appConfig.apiPrefix}/v${appConfig.apiVersion}`)
        .build(),
    );
    SwaggerModule.setup(docs.path, app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
    logger.log(`API documentation at /${docs.path}`);
  }

  await app.listen(appConfig.port, '0.0.0.0');
  logger.log(
    `Devyora backend listening on :${appConfig.port} ` +
      `(${appConfig.env}, /${appConfig.apiPrefix}/v${appConfig.apiVersion})`,
  );
}

void bootstrap();
