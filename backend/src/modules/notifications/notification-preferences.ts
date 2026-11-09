import { z } from 'zod';

/**
 * The notification half of a user's preferences.
 *
 * Stored in `UserPreference.assistant` alongside the action switches rather
 * than in a table of its own, and **not duplicated**: the timezone lives on
 * the user record, voice settings live in `UserPreference.voice`, and
 * nothing here restates either. A second copy of a preference is a second
 * answer waiting to disagree with the first.
 */
export const notificationPreferencesSchema = z.object({
  /** The master switch. Off means nothing is created, not created-and-held. */
  enabled: z.boolean().default(true),
  /** Types the user does not want, e.g. `reminder.due`. */
  mutedTypes: z.array(z.string().max(60)).max(40).default([]),
  /**
   * Quiet hours in the user's own zone, as minutes from midnight. A
   * reminder due inside them is still delivered — a silenced alarm is not
   * an alarm — but anything not time-critical waits.
   */
  quietFromMinute: z.number().int().min(0).max(1_439).nullable().default(null),
  quietToMinute: z.number().int().min(0).max(1_439).nullable().default(null),
});

export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences =
  notificationPreferencesSchema.parse({});

/** Reads a stored document, salvaging the valid parts of a malformed one. */
export function parseNotificationPreferences(stored: unknown): NotificationPreferences {
  if (!stored || typeof stored !== 'object') return DEFAULT_NOTIFICATION_PREFERENCES;

  const parsed = notificationPreferencesSchema.safeParse(stored);
  if (parsed.success) return parsed.data;

  const salvaged: Record<string, unknown> = {};
  const shape = notificationPreferencesSchema.shape as Record<string, z.ZodTypeAny>;
  for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
    const field = shape[key];
    if (field && field.safeParse(value).success) salvaged[key] = value;
  }
  return notificationPreferencesSchema.parse(salvaged);
}

/**
 * Whether a moment falls inside the user's quiet hours.
 *
 * Handles a window that crosses midnight, which is the common case: 22:00
 * to 07:00 is not "from 1320 to 420" read naively.
 */
export function isQuiet(
  preferences: NotificationPreferences,
  minuteOfDay: number,
): boolean {
  const { quietFromMinute: from, quietToMinute: to } = preferences;
  if (from === null || to === null) return false;
  if (from === to) return false;

  return from < to
    ? minuteOfDay >= from && minuteOfDay < to
    : minuteOfDay >= from || minuteOfDay < to;
}
