import { z } from 'zod';

/**
 * The only intents the assistant recognises.
 *
 * This is an allow-list, not a suggestion. A model that returns anything
 * outside it fails validation and the turn is reported as unsupported —
 * which is how a model cannot invent a capability for itself.
 */
export const INTENTS = [
  'save_note',
  'retrieve_note',
  'create_reminder',
  'send_message',
  'prepare_message',
  'open_application',
  'get_calendar_events',
  'general_question',
] as const;

export const intentSchema = z.enum(INTENTS);
export type Intent = (typeof INTENTS)[number];

/** Messaging surfaces the assistant knows about. */
export const messagingPlatformSchema = z.enum(['whatsapp', 'telegram', 'instagram', 'facebook', 'email']);
export type MessagingPlatform = z.infer<typeof messagingPlatformSchema>;

/**
 * An ISO-8601 instant, or null when the model could not determine one.
 *
 * Null is an accepted answer on purpose. A guessed date is worse than an
 * absent one: the assistant can ask about an absent date, but it cannot
 * un-send a reminder set for the wrong day.
 */
const isoInstant = z
  .string()
  .datetime({ offset: true })
  .nullable()
  .describe('ISO-8601 with offset, or null if not stated');

const shortText = z.string().trim().min(1).max(500);
const longText = z.string().trim().min(1).max(5_000);

/** Per-intent entities. A discriminated union, so each carries only its own. */
export const commandSchema = z.discriminatedUnion('intent', [
  z.object({
    intent: z.literal('save_note'),
    entities: z.object({ text: longText }),
  }),
  z.object({
    intent: z.literal('retrieve_note'),
    entities: z.object({ query: shortText.nullable() }),
  }),
  z.object({
    intent: z.literal('create_reminder'),
    entities: z.object({
      text: shortText,
      dueAt: isoInstant,
      /** Echoed back so a mis-parse is visible to the user. */
      spokenTime: z.string().max(200).nullable(),
    }),
  }),
  z.object({
    intent: z.literal('send_message'),
    entities: z.object({
      platform: messagingPlatformSchema,
      recipient: shortText.nullable(),
      message: longText,
    }),
  }),
  z.object({
    intent: z.literal('prepare_message'),
    entities: z.object({
      platform: messagingPlatformSchema,
      recipient: shortText.nullable(),
      message: longText,
    }),
  }),
  z.object({
    intent: z.literal('open_application'),
    entities: z.object({ application: shortText }),
  }),
  z.object({
    intent: z.literal('get_calendar_events'),
    entities: z.object({ from: isoInstant, to: isoInstant, query: shortText.nullable() }),
  }),
  z.object({
    intent: z.literal('general_question'),
    entities: z.object({ question: longText }),
  }),
]);

export type Command = z.infer<typeof commandSchema>;

/**
 * The full structured reply the model must produce.
 *
 * Note what it deliberately cannot set: whether confirmation is required,
 * whether the user is permitted, or whether anything succeeded. Those are
 * server decisions, and leaving them out of the schema means a model cannot
 * express an opinion about them at all.
 */
export const modelOutputSchema = z.object({
  /** Null when the model cannot map the utterance to an allowed intent. */
  command: commandSchema.nullable(),

  /** 0–1. Low confidence routes to clarification rather than to an action. */
  confidence: z.number().min(0).max(1),

  /** Set when something required is missing or ambiguous. */
  clarification: z
    .object({
      question: shortText,
      reason: shortText,
      /** Which entity the answer fills in. */
      field: z.string().max(60),
      options: z
        .array(z.object({ label: shortText, value: z.string().max(500).nullable() }))
        .max(5)
        .default([]),
    })
    .nullable()
    .default(null),

  /** One sentence for the user. Never a claim that something has happened. */
  reply: z.string().trim().max(600),

  /** BCP-47 tag the model detected, e.g. `en-IN`, `hi-IN`, `hi-Latn-IN`. */
  detectedLanguage: z.string().max(24).nullable().default(null),
});

export type ModelOutput = z.infer<typeof modelOutputSchema>;

/**
 * JSON Schema handed to providers that support structured output.
 *
 * Written by hand rather than generated: the wire contract is part of the
 * prompt and should be reviewable as one artefact, and it stays identical
 * across providers whose generators differ.
 */
export const MODEL_OUTPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['command', 'confidence', 'clarification', 'reply', 'detectedLanguage'],
  properties: {
    command: {
      type: ['object', 'null'],
      required: ['intent', 'entities'],
      properties: {
        intent: { type: 'string', enum: [...INTENTS] },
        entities: { type: 'object' },
      },
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    clarification: {
      type: ['object', 'null'],
      required: ['question', 'reason', 'field'],
      properties: {
        question: { type: 'string' },
        reason: { type: 'string' },
        field: { type: 'string' },
        options: {
          type: 'array',
          items: {
            type: 'object',
            required: ['label', 'value'],
            properties: { label: { type: 'string' }, value: { type: ['string', 'null'] } },
          },
        },
      },
    },
    reply: { type: 'string' },
    detectedLanguage: { type: ['string', 'null'] },
  },
};
