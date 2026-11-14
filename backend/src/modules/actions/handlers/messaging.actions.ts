import { ActionKind, ExecutionMode } from '@prisma/client';
import { z } from 'zod';
import { ConnectionProvider } from '@prisma/client';
import type { ActionDefinition, AnyActionDefinition } from '../registry/types';
import {
  findMessagingSurface,
  isUsableAddress,
  MESSAGING_SURFACES,
} from './launch-catalog';

/** Which connection each messaging surface belongs to. */
const PROVIDER_FOR: Record<'whatsapp' | 'telegram' | 'email', ConnectionProvider> = {
  whatsapp: ConnectionProvider.WHATSAPP,
  telegram: ConnectionProvider.TELEGRAM,
  email: ConnectionProvider.GMAIL,
};

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
 * Whether the server sent it.
 *
 * No longer a literal `false`: with an official API connection — a WhatsApp
 * Business account, a Telegram bot — the server genuinely can send. It
 * stays false for the assisted route, which only prepares a draft, and the
 * two are told apart by the outcome status: HANDOFF for a draft,
 * UNVERIFIED for an API send.
 */
sentByServer: z.boolean(),
/**
 * Still a literal `false`, and the strongest claim this action makes.
 *
 * Even an accepted API send is not a confirmed delivery: that arrives by
 * webhook, which this build does not receive. So there is no value a
 * handler could put here that would say a message arrived.
 */
deliveryConfirmed: z.literal(false),
/** What the person still has to do. */
remainingStep: z.string(),
});

/**
 * Messaging.
 *
 * The category the whole confirmation system exists for, and the one where
 * being exact matters most.
 *
 * **What happens depends on what is connected.** With no account, the
 * handler prepares a draft and returns a deep link: the device opens it and
 * the person presses send. With a WhatsApp Business account or a Telegram
 * bot connected, the integration layer sends through the official API —
 * and the outcome says which happened, HANDOFF for a draft and UNVERIFIED
 * for an accepted send. Neither is COMPLETED, because delivery is
 * confirmed by webhook and this build receives none.
 *
 * So: `confirmationPolicy: 'always'` — the user approves the exact text
 * before a draft is even prepared — and every outcome is HANDOFF with
 * `deliveryConfirmed: false` and a `remainingStep` that names what is left.
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

  handler: async (input, context) => {
    const surface = findMessagingSurface(input.platform);
    if (!surface) {
      return {
        status: 'FAILED' as const,
        detail: `I cannot prepare messages for ${input.platform}.`,
        verified: true,
        failureCode: 'platform_not_supported',
        result: {
          platform: input.platform,
          surface: input.platform,
          composeUrl: null,
          sentByServer: false,
          deliveryConfirmed: false as const,
          remainingStep: 'Nothing was prepared.',
        },
      };
    }

    // Checked again, at the last point before anything is built for a real
    // person. A check that only runs upstream stops running the moment
    // somebody adds another caller.
    if (!isUsableAddress(input.recipient, surface.addressKind)) {
      return {
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
          sentByServer: false,
          deliveryConfirmed: false as const,
          remainingStep: 'Nothing was prepared.',
        },
      };
    }

    const provider = PROVIDER_FOR[input.platform];

    // The integration layer decides which connector applies: the official
    // API when a live connection exists, the assisted route otherwise. The
    // outcome's `fidelity` is what tells us which happened — and it is the
    // only thing allowed to decide the wording.
    const outcome = await context.deps.integrations.execute(
      context.userId,
      provider,
      'messages.send',
      { recipient: input.recipient, message: input.message },
      { deviceId: context.deviceId },
    ).catch(() => null);

    if (outcome && outcome.fidelity === 'accepted') {
      return {
        // ACCEPTED through an official API. Still not COMPLETED: delivery
        // is confirmed by webhook, which this build does not receive.
        status: 'UNVERIFIED' as const,
        detail: outcome.detail,
        verified: false,
        resultRef: outcome.providerRef,
        result: {
          platform: input.platform,
          surface: surface.label,
          composeUrl: null,
          // The server did send it — through the provider's API.
          sentByServer: true,
          deliveryConfirmed: false as const,
          remainingStep: 'Nothing. Delivery is not confirmed.',
        },
      };
    }

    // Prepared, not sent. Either no account is connected or the assisted
    // route is the one that applies.
    const prepared =
      outcome && outcome.fidelity === 'prepared'
        ? (outcome.data as { composeUrl?: string }).composeUrl ?? null
        : surface.compose(input.recipient, input.message);

    return {
      status: 'HANDOFF' as const,
      detail: outcome?.detail ?? `Draft ready in ${surface.label}.`,
      // The draft exists; the send does not. Never `verified: true`.
      verified: false,
      result: {
        platform: input.platform,
        surface: surface.label,
        composeUrl: prepared,
        sentByServer: false,
        deliveryConfirmed: false as const,
        remainingStep: `Open ${surface.label} and press send.`,
      },
    };
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
