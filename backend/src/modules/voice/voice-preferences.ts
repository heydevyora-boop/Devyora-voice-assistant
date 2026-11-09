import { z } from 'zod';

/**
 * The voice half of a user's preferences.
 *
 * `UserPreference.voice` is a JSON column — the shape changes as features
 * land, and a column per setting would mean a migration for each. The cost
 * of that choice is that nothing stops a malformed document being stored,
 * so it is parsed on every read with defaults for everything. A preference
 * document from an older version of the app is therefore usable rather
 * than fatal.
 */
export const voicePreferencesSchema = z.object({
  /**
   * Whether replies are spoken. Off by default: speech is something a user
   * asks for, not something that starts talking unprompted.
   */
  speakReplies: z.boolean().default(false),
  /** Provider voice id. Null means the provider's default. */
  voiceId: z.string().max(80).nullable().default(null),
  /** 0.5–2.0 where the provider supports it. */
  rate: z.number().min(0.5).max(2).default(1),
  /**
   * BCP-47 hint sent to the recogniser. Null means let it detect, which is
   * usually better for mixed Hindi–English speech than forcing one.
   */
  languageHint: z.string().max(24).nullable().default(null),
  /**
   * What happens to recordings. `DISCARD` deletes each one as soon as it
   * has been transcribed, and is the default.
   */
  audioRetention: z.enum(['DISCARD', 'SESSION', 'RETAIN']).default('DISCARD'),
  /** Only meaningful with `RETAIN`. */
  audioRetentionDays: z.number().int().min(1).max(365).default(7),
  /**
   * Whether this user's devices may start a session from a local wake
   * word. Detection happens on the device; this is the server's own switch
   * for honouring such an activation.
   */
  wakeWordEnabled: z.boolean().default(false),
});

export type VoicePreferences = z.infer<typeof voicePreferencesSchema>;

/** Defaults, used when a user has no preference row at all. */
export const DEFAULT_VOICE_PREFERENCES: VoicePreferences = voicePreferencesSchema.parse({});

/**
 * Reads a stored document, falling back to defaults field by field.
 *
 * A partially valid document yields the valid parts: a user who set a voice
 * three releases ago keeps it even if another field has since changed
 * shape.
 */
export function parseVoicePreferences(stored: unknown): VoicePreferences {
  if (!stored || typeof stored !== 'object') return DEFAULT_VOICE_PREFERENCES;

  const parsed = voicePreferencesSchema.safeParse(stored);
  if (parsed.success) return parsed.data;

  // Field-by-field salvage, so one bad key does not discard the rest.
  const salvaged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
    const shape = voicePreferencesSchema.shape as Record<string, z.ZodTypeAny>;
    const field = shape[key];
    if (field && field.safeParse(value).success) salvaged[key] = value;
  }
  return voicePreferencesSchema.parse(salvaged);
}
