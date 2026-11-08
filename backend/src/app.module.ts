import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AppConfigModule } from './config/app-config.module';
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { PrismaModule } from './database/prisma.module';
import { HealthModule } from './modules/health/health.module';

/**
 * Composition root.
 *
 * Core modules are global, so feature modules declare only what they own.
 * Feature modules are added here as each chunk lands; the dependency
 * direction is always core → feature, never the reverse.
 */
@Module({
  imports: [
    // Core
    AppConfigModule,
    PrismaModule,

    // Features
    HealthModule,

    // Chunk 3: AuthModule, UsersModule, DevicesModule
    // Chunk 4: NotesModule, RemindersModule, PreferencesModule
    // Chunk 5: AiModule, ConversationsModule
    // Chunk 6: ActionsModule, JobsModule, NotificationsModule
    // Chunk 7: VoiceModule, StorageModule
    // Chunk 8: ConnectionsModule
  ],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // First in the chain: everything downstream logs the same correlation id.
    // `{*path}` is the Express 5 / path-to-regexp spelling of a catch-all;
    // a bare '*' is no longer valid and only works via a deprecation shim.
    consumer.apply(CorrelationIdMiddleware).forRoutes('{*path}');
  }
}
