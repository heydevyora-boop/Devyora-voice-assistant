import type { Env } from './env.validation';

/**
 * The shape the application reads configuration through.
 *
 * Nothing outside this file touches `process.env`: a module asks the
 * ConfigService for a typed namespace, so a renamed variable breaks in one
 * place instead of silently returning undefined somewhere deep.
 */
export interface AppConfig {
  readonly env: Env['NODE_ENV'];
  readonly isProduction: boolean;
  readonly isDevelopment: boolean;
  readonly isTest: boolean;
  readonly port: number;
  readonly apiPrefix: string;
  readonly apiVersion: string;
  readonly corsOrigins: string[];
}

export interface DatabaseConfig {
  readonly url: string;
}

export interface LoggingConfig {
  readonly level: Env['LOG_LEVEL'];
  readonly pretty: boolean;
}

export interface DocsConfig {
  readonly enabled: boolean;
  readonly path: string;
}

/** Provider settings arrive in later chunks; the namespace exists now so
 *  modules can depend on a stable shape rather than reaching for env. */
export interface AiConfig {
  readonly provider: 'mock' | 'openai' | 'gemini';
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly contextMessages: number;
  readonly openAiApiKey?: string;
  readonly openAiModel: string;
  readonly geminiApiKey?: string;
  readonly geminiModel: string;
}

export interface SttConfig {
  readonly provider: 'mock' | 'whisper' | 'google';
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly googleApiKey?: string;
  readonly googleModel: string;
}

export interface TtsConfig {
  readonly provider: 'mock' | 'openai' | 'google';
  readonly timeoutMs: number;
  readonly model: string;
  readonly defaultVoice: string;
  readonly googleApiKey?: string;
}

export interface AudioConfig {
  readonly maxBytes: number;
  readonly minBytes: number;
  readonly maxDurationMs: number;
  readonly tempDir: string;
  readonly retentionDefault: 'DISCARD' | 'SESSION' | 'RETAIN';
  readonly retentionDays: number;
}

export interface ActionsConfig {
  readonly timeoutMs: number;
  readonly staleClaimMs: number;
  readonly confirmationTtlMs: number;
}

export interface VoiceConfig {
  readonly sessionTtlMs: number;
  readonly sessionGraceMs: number;
}

export interface ProvidersConfig {
  readonly ai: AiConfig;
  readonly stt: SttConfig;
  readonly tts: TtsConfig;
  readonly audio: AudioConfig;
  readonly voice: VoiceConfig;
  readonly actions: ActionsConfig;
  readonly redisUrl?: string;
  readonly jwt: {
    readonly accessSecret?: string;
    readonly accessTtl: string;
    readonly refreshSecret?: string;
    readonly refreshTtl: string;
  };
  readonly tokenEncryptionKey?: string;
}

export interface Configuration {
  readonly app: AppConfig;
  readonly database: DatabaseConfig;
  readonly logging: LoggingConfig;
  readonly docs: DocsConfig;
  readonly providers: ProvidersConfig;
}

export const CONFIG_NAMESPACE = 'configuration';

export function buildConfiguration(env: Env): Configuration {
  return {
    app: {
      env: env.NODE_ENV,
      isProduction: env.NODE_ENV === 'production',
      isDevelopment: env.NODE_ENV === 'development',
      isTest: env.NODE_ENV === 'test',
      port: env.PORT,
      apiPrefix: env.API_PREFIX,
      apiVersion: env.API_VERSION,
      corsOrigins: env.CORS_ORIGINS,
    },
    database: { url: env.DATABASE_URL },
    logging: { level: env.LOG_LEVEL, pretty: env.LOG_PRETTY },
    docs: { enabled: env.SWAGGER_ENABLED, path: env.SWAGGER_PATH },
    providers: {
      ai: {
        provider: env.AI_PROVIDER,
        timeoutMs: env.AI_TIMEOUT_MS,
        maxAttempts: env.AI_MAX_ATTEMPTS,
        contextMessages: env.AI_CONTEXT_MESSAGES,
        openAiApiKey: env.OPENAI_API_KEY,
        openAiModel: env.OPENAI_MODEL,
        geminiApiKey: env.GEMINI_API_KEY,
        geminiModel: env.GEMINI_MODEL,
      },
      stt: {
        provider: env.STT_PROVIDER,
        baseUrl: env.STT_BASE_URL,
        model: env.STT_MODEL,
        timeoutMs: env.STT_TIMEOUT_MS,
        maxAttempts: env.STT_MAX_ATTEMPTS,
        googleApiKey: env.GOOGLE_SPEECH_API_KEY,
        googleModel: env.GOOGLE_SPEECH_MODEL,
      },
      tts: {
        provider: env.TTS_PROVIDER,
        timeoutMs: env.TTS_TIMEOUT_MS,
        model: env.TTS_MODEL,
        defaultVoice: env.TTS_DEFAULT_VOICE,
        googleApiKey: env.GOOGLE_TTS_API_KEY,
      },
      audio: {
        maxBytes: env.AUDIO_MAX_BYTES,
        minBytes: env.AUDIO_MIN_BYTES,
        maxDurationMs: env.AUDIO_MAX_DURATION_MS,
        tempDir: env.AUDIO_TEMP_DIR,
        retentionDefault: env.AUDIO_RETENTION_DEFAULT,
        retentionDays: env.AUDIO_RETENTION_DAYS,
      },
      voice: {
        sessionTtlMs: env.VOICE_SESSION_TTL_MS,
        sessionGraceMs: env.VOICE_SESSION_GRACE_MS,
      },
      actions: {
        timeoutMs: env.ACTION_TIMEOUT_MS,
        staleClaimMs: env.ACTION_STALE_CLAIM_MS,
        confirmationTtlMs: env.ACTION_CONFIRMATION_TTL_MS,
      },
      redisUrl: env.REDIS_URL,
      jwt: {
        accessSecret: env.JWT_ACCESS_SECRET,
        accessTtl: env.JWT_ACCESS_TTL,
        refreshSecret: env.JWT_REFRESH_SECRET,
        refreshTtl: env.JWT_REFRESH_TTL,
      },
      tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY,
    },
  };
}
