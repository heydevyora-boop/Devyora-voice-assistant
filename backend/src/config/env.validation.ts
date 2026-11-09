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
