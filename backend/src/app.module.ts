import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { RateLimit } from './security/rate-limits';
import { AppConfigModule } from './config/app-config.module';
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { PrismaModule } from './database/prisma.module';
import { SecurityModule } from './security/security.module';
import { CsrfGuard } from './security/guards/csrf.guard';
import { JwtAuthGuard } from './security/guards/jwt-auth.guard';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { DevicesModule } from './modules/devices/devices.module';
import { LlmModule } from './providers/llm/llm.module';
import { AiModule } from './modules/ai/ai.module';
import { ConversationsModule } from './modules/conversations/conversations.module';
import { AssistantModule } from './modules/assistant/assistant.module';
import { ActionsModule } from './modules/actions/actions.module';
import { SttModule } from './providers/stt/stt.module';
import { TtsModule } from './providers/tts/tts.module';
import { VoiceModule } from './modules/voice/voice.module';

/**
 * Composition root.
 *
 * Guard order matters and is the reason these are listed explicitly:
 * throttling first so an abusive caller is rejected before any work,
 * then authentication, then CSRF — which needs to know whether the
 * credential arrived in a cookie, so it has to run after the guard that
 * establishes that.
 */
@Module({
  imports: [
    // Core
    AppConfigModule,
    PrismaModule,
    SecurityModule,

    // In-memory counters today. Chunk 6 introduces Redis, which is what
    // makes these limits hold across more than one instance.
    ThrottlerModule.forRoot([{ name: 'default', ...RateLimit.global }]),

    // Features
    HealthModule,
    AuthModule,
    UsersModule,
    DevicesModule,

    // The assistant. LlmModule is listed even though it is @Global, so the
    // provider wiring is visible here rather than only by side effect.
    LlmModule,
    ActionsModule,
    AiModule,
    ConversationsModule,
    AssistantModule,

    // Voice: recognition, synthesis, sessions and the realtime gateway.
    SttModule,
    TtsModule,
    VoiceModule,

    // Chunk 6: NotesModule, RemindersModule, PreferencesModule
    // Chunk 6: ActionsModule, JobsModule, NotificationsModule
    // Chunk 7: VoiceModule, StorageModule
    // Chunk 8: ConnectionsModule
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Registered globally, so every route is private unless it carries
    // `@Public()`. A new route is therefore closed by default.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('{*path}');
  }
}
