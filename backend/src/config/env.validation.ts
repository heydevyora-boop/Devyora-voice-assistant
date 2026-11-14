import { z } from 'zod';

/**
 * Environment schema.
 *
 * Parsed once at boot. If anything is missing or malformed the process exits
 * immediately with a readable list, rather than failing later at the first
 * request that happens to need the value.
 *
 * Values reserved for later chunks are optional here and validated again,
 * as required, by the module that introduces them — so the application boots
 * today without secrets it does not yet use.
 */
/** Comma-separated list. The default is applied to the raw string, before
 *  the split, so the parsed type stays `string[]`. */
const csv = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((value) => value.split(',').map((s) => s.trim()).filter(Boolean));

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),

  API_PREFIX: z.string().min(1).default('api'),
  API_VERSION: z.string().regex(/^\d+$/, 'API_VERSION must be a number').default('1'),

  /** `*` is accepted only outside production; see the refinement below. */
  CORS_ORIGINS: csv('http://localhost:5173'),

  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine((v) => v.startsWith('postgres://') || v.startsWith('postgresql://'), {
      message: 'DATABASE_URL must be a PostgreSQL connection string',
    }),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_PRETTY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  SWAGGER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  SWAGGER_PATH: z.string().min(1).default('docs'),

  // ── AI providers ──
  // No credential is required: without one the registry selects the local
  // stand-in and says so, rather than failing to boot.
  AI_PROVIDER: z.enum(['mock', 'openai', 'gemini']).default('mock'),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(20_000),
  AI_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(3),
  /** How many prior messages are replayed as context. */
  AI_CONTEXT_MESSAGES: z.coerce.number().int().min(0).max(40).default(10),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-2.0-flash'),

  // ── Speech recognition ──
  // `whisper` points at any Whisper-compatible endpoint, hosted or
  // self-hosted, so STT_BASE_URL is deployment, not code.
  STT_PROVIDER: z.enum(['mock', 'whisper', 'google']).default('mock'),
  STT_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  STT_MODEL: z.string().default('whisper-1'),
  STT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
  STT_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(2),
  /** Only used by the Google adapter; harmless when another is selected. */
  GOOGLE_SPEECH_API_KEY: z.string().optional(),
  GOOGLE_SPEECH_MODEL: z.string().default('latest_short'),

  // ── Speech synthesis ──
  TTS_PROVIDER: z.enum(['mock', 'openai', 'google']).default('mock'),
  TTS_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(20_000),
  TTS_MODEL: z.string().default('gpt-4o-mini-tts'),
  TTS_DEFAULT_VOICE: z.string().default('alloy'),
  GOOGLE_TTS_API_KEY: z.string().optional(),

  // ── Audio handling ──
  /**
   * Upload ceiling. Roughly four minutes of Opus at 32 kbps, which is far
   * more than a spoken command and still small enough that a hostile
   * client cannot fill the disk with one request.
   */
  AUDIO_MAX_BYTES: z.coerce.number().int().min(1_024).max(50 * 1_024 * 1_024).default(10 * 1_024 * 1_024),
  AUDIO_MAX_DURATION_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
  AUDIO_MIN_BYTES: z.coerce.number().int().min(16).default(512),
  /**
   * Where recordings live while they are being transcribed. Created with
   * owner-only permissions; emptied on startup and after every request.
   */
  AUDIO_TEMP_DIR: z.string().default('/tmp/devyora-audio'),
  /**
   * Default retention. `DISCARD` deletes a recording the moment it has
   * been transcribed; anything else is opt-in, per user.
   */
  AUDIO_RETENTION_DEFAULT: z.enum(['DISCARD', 'SESSION', 'RETAIN']).default('DISCARD'),
  AUDIO_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(7),

  // ── Action execution ──
  /**
   * How long one attempt may run. A handler that overruns it is aborted and
   * the outcome is reported as unverified, because a timeout does not tell
   * us whether the work had an effect first.
   */
  ACTION_TIMEOUT_MS: z.coerce.number().int().min(500).max(120_000).default(20_000),
  /**
   * How long a claimed attempt may stay claimed before reconciliation gives
   * up on it. Longer than the attempt timeout, so a slow but live attempt is
   * not reconciled out from under itself.
   */
  ACTION_STALE_CLAIM_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
  /** How long a proposal awaits a decision. */
  ACTION_CONFIRMATION_TTL_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(90_000),

  // ── Voice sessions ──
  VOICE_SESSION_TTL_MS: z.coerce.number().int().min(10_000).max(1_800_000).default(300_000),
  /** How long a cancelled or finished session stays readable for a
   *  reconnecting client before the sweep removes it. */
  VOICE_SESSION_GRACE_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(900_000),

  // ── Push notifications ──
  // No credential is required. Without one there is no push transport:
  // notifications still land in-app, and anything that cannot be delivered
  // is recorded as undeliverable rather than reported as sent.
  /** Comma-separated preference order, e.g. `fcm,apns`. */
  PUSH_PREFERRED: z
    .string()
    .default('fcm,apns')
    .transform((v) => v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)),
  PUSH_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
  /** The service-account JSON document, as a single string. */
  FCM_SERVICE_ACCOUNT: z.string().optional(),
  APNS_KEY_ID: z.string().optional(),
  APNS_TEAM_ID: z.string().optional(),
  APNS_BUNDLE_ID: z.string().optional(),
  /** The .p8 private key contents. */
  APNS_PRIVATE_KEY: z.string().optional(),
  APNS_SANDBOX: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // ── Background work ──
  /**
   * Whether this instance installs the recurring maintenance schedule.
   *
   * Configuration rather than a constant because an operator may want one
   * instance sweeping and the others only serving requests — and because a
   * test suite wants the workers without a cleanup job firing underneath it.
   */
  JOBS_MAINTENANCE_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // ── Reminders and sync ──
  /** Default zone for an account that has not set one. */
  DEFAULT_TIMEZONE: z.string().default('Asia/Kolkata'),
  /** How long a soft-deleted note or reminder is kept, so an offline device
   *  still learns it was deleted. */
  SYNC_TOMBSTONE_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /** Largest batch a client may push or pull in one request. */
  SYNC_MAX_BATCH: z.coerce.number().int().min(1).max(500).default(200),
  /** How far ahead the upcoming-reminders view looks, in days. */
  REMINDER_UPCOMING_DAYS: z.coerce.number().int().min(1).max(365).default(30),

  // ── Third-party integrations ──
  // No credential is required. Without one the provider reports itself
  // unconfigured and a user cannot start its OAuth flow — the assisted
  // route, which needs no account, still works.
  /** Where provider callbacks land. The provider path is appended. */
  INTEGRATION_REDIRECT_BASE_URL: z
    .string()
    .url()
    .default('http://localhost:3000/api/v1/integrations/callback'),
  INTEGRATION_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
  /** Refresh an access token this long before it expires. */
  INTEGRATION_REFRESH_LEAD_MS: z.coerce.number().int().min(60_000).max(3_600_000).default(300_000),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  /** The business phone number WhatsApp sends from. */
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),

  // ── Reserved for later chunks; absent is valid today. ──
  JWT_ACCESS_SECRET: z.string().optional(),
  JWT_ACCESS_TTL: z.string().default('10m'),
  JWT_REFRESH_SECRET: z.string().optional(),
  JWT_REFRESH_TTL: z.string().default('30d'),
  REDIS_URL: z.string().optional(),
  TOKEN_ENCRYPTION_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

/** Rules that depend on more than one variable. */
const crossFieldChecks = (env: Env): string[] => {
  const problems: string[] = [];
  if (env.NODE_ENV === 'production') {
    if (env.CORS_ORIGINS.includes('*')) {
      problems.push('CORS_ORIGINS: "*" is not allowed in production');
    }
    if (env.LOG_PRETTY) {
      problems.push('LOG_PRETTY: pretty logs are not allowed in production');
    }
  }
  return problems;
};

/**
 * Nest calls this through `ConfigModule.forRoot({ validate })`.
 * Throwing here aborts startup, which is the intent.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);

  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }

  const problems = crossFieldChecks(parsed.data);
  if (problems.length > 0) {
    throw new Error(`Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }

  return parsed.data;
}
