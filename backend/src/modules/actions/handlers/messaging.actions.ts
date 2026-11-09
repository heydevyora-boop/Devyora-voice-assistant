import { ActionKind, ExecutionMode } from '@prisma/client';
import { z } from 'zod';
import type { ActionDefinition, AnyActionDefinition } from '../registry/types';
import {
  findMessagingSurface,
  isUsableAddress,
  MESSAGING_SURFACES,
} from './launch-catalog';

const prepareInput = z.object({
platform: z.enum(['whatsapp', 'telegram', 'email']),
/**
 * A phone number or an email address. A name is refused here as well as
 * upstream — see `isUsableAddress`.
 */
recipient: z.string().trim().min(1).max(200),
message: z.string().trim().min(1).max(5_000),
});

const prepareResult = z.object({
platform: z.string(),
surface: z.string(),
/** A deep link the device opens. Built from a template, both values escaped. */
composeUrl: z.string().nullable(),
/**
 * Literal `false`. Nothing in this backend can send a message, and the
 * result schema says so rather than leaving a client to assume.
 */
sentByServer: z.literal(false),
/** What the person still has to do. */
remainingStep: z.string(),
});

/**
 * Messaging.
 *
 * The category the whole confirmation system exists for, and the one where
 * being exact matters most.
 *
 * **Nothing here sends anything.** The handler prepares a draft and returns
 * a deep link; the device opens it and the person presses send. That is a
 * deliberate capability choice, not a gap waiting to be filled: a message
 * that goes out in someone's name should be seen by them first.
 *
 * So: `confirmationPolicy: 'always'` — the user approves the exact text
 * before a draft is even prepared — and every outcome is HANDOFF with
 * `sentByServer: false` and a `remainingStep` that names what is left.
 */
const prepare: ActionDefinition<z.infer<typeof prepareInput>, z.infer<typeof prepareResult>> = {
  id: 'messaging.prepare',
  category: 'messaging',
  description: 'Prepare a message for the user to send.',
  inputSchema: prepareInput,
  requiredParams: ['platform', 'recipient', 'message'],
  requiredPermissions: [
    'account.active',
    'device.active',
    'assistant.enabled',
    'messaging.prepare',
  ],
  // No connected account is needed to open a draft, which is exactly why
  // this capability is available at all without OAuth.
  requiresConnection: null,
  // Another person will see this. Always confirmed, without exception.
  confirmationPolicy: 'always',
  idempotency: 'pending-action',
  kind: ActionKind.MESSAGE_WHATSAPP,
  executionMode: ExecutionMode.ASSISTED,
  resultSchema: prepareResult,

  preview: (input) => [
    { key: 'platform', label: 'App', value: input.platform, editable: false },
    { key: 'recipient', label: 'To', value: input.recipient, editable: true },
    { key: 'message', label: 'Message', value: input.message, editable: true, multiline: true },
  ],

  handler: (input) => {
    const surface = findMessagingSurface(input.platform);
    if (!surface) {
      return Promise.resolve({
        status: 'FAILED' as const,
        detail: `I cannot prepare messages for ${input.platform}.`,
        verified: true,
        failureCode: 'platform_not_supported',
        result: {
          platform: input.platform,
          surface: input.platform,
          composeUrl: null,
          sentByServer: false as const,
          remainingStep: 'Nothing was prepared.',
        },
      });
    }

    // Checked again, at the last point before a draft is built for a real
    // person. A check that only runs upstream stops running the moment
    // somebody adds another caller.
    if (!isUsableAddress(input.recipient, surface.addressKind)) {
      return Promise.resolve({
        status: 'FAILED' as const,
        detail:
          surface.addressKind === 'phone'
            ? 'That does not look like a phone number.'
            : 'That does not look like an email address.',
        verified: true,
        failureCode: 'recipient_not_addressable',
        result: {
          platform: input.platform,
          surface: surface.label,
          composeUrl: null,
          sentByServer: false as const,
          remainingStep: 'Nothing was prepared.',
        },
      });
    }

    return Promise.resolve({
      status: 'HANDOFF' as const,
      detail: `Draft ready in ${surface.label}.`,
      // The draft exists; the send does not. Never `verified: true`.
      verified: false,
      result: {
        platform: input.platform,
        surface: surface.label,
        composeUrl: surface.compose(input.recipient, input.message),
        sentByServer: false as const,
        remainingStep: `Open ${surface.label} and press send.`,
      },
    });
  },
};

export const MESSAGING_ACTIONS: readonly AnyActionDefinition[] = Object.freeze([
prepare,
] as unknown as AnyActionDefinition[]);

export const MESSAGING_PLATFORMS = MESSAGING_SURFACES.map((s) => ({
id: s.id,
label: s.label,
addressKind: s.addressKind,
}));
