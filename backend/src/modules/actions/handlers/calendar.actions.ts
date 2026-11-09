import { ActionKind, ExecutionMode } from '@prisma/client';
import { z } from 'zod';
import type { ActionDefinition, AnyActionDefinition } from '../registry/types';

const listInput = z.object({
  from: z.string().datetime({ offset: true }).nullish(),
  to: z.string().datetime({ offset: true }).nullish(),
  query: z.string().trim().min(1).max(200).nullish(),
});

const listResult = z.object({
  events: z.array(
    z.object({
      eventId: z.string(),
      title: z.string(),
      startsAt: z.string(),
      endsAt: z.string().nullable(),
      location: z.string().nullable(),
    }),
  ),
  /** Which account these came from. Null when none is connected. */
  source: z.string().nullable(),
});

/**
 * Read calendar events.
 *
 * This action exists and is registered, and it currently cannot run: reading
 * an agenda needs an authorised Google Calendar connection, and the OAuth
 * flow that creates one arrives in a later chunk.
 *
 * It is here rather than omitted because that is the honest arrangement. The
 * permission check refuses it with `integration_not_connected`, the user is
 * told what is missing, and the result is an empty list with a null source
 * — never an invented event. The alternative, leaving the action out, would
 * make the assistant say it does not understand a request it understands
 * perfectly well.
 */
const list: ActionDefinition<z.infer<typeof listInput>, z.infer<typeof listResult>> = {
  id: 'calendar.list',
  category: 'calendar',
  description: 'Read calendar events from a connected account.',
  inputSchema: listInput,
  requiredParams: [],
  requiredPermissions: [
    'account.active',
    'device.active',
    'assistant.enabled',
    'integration.read',
  ],
  // The executor refuses before the handler runs while this is absent.
  requiresConnection: 'GOOGLE_CALENDAR',
  confirmationPolicy: 'never',
  idempotency: 'pending-action-and-params',
  kind: ActionKind.CALENDAR_EVENT,
  executionMode: ExecutionMode.ACCOUNT,
  resultSchema: listResult,

  preview: (input) => [
    { key: 'from', label: 'From', value: input.from ?? 'now', editable: false },
    { key: 'to', label: 'To', value: input.to ?? 'end of day', editable: false },
  ],

  handler: async (_input, context) => {
    // Reached only if a connection exists, because the permission check
    // runs first. Should one exist without a working provider adapter, this
    // reports that it cannot read rather than returning nothing and letting
    // the assistant say "you have no events today".
    const connection = await context.deps.prisma.connectedAccount.findFirst({
      where: {
        userId: context.userId,
        provider: 'GOOGLE_CALENDAR',
        status: 'CONNECTED',
        revokedAt: null,
      },
      select: { id: true },
    });

    if (!connection) {
      return {
        status: 'FAILED',
        detail: 'No calendar account is connected.',
        verified: true,
        failureCode: 'integration_not_connected',
        result: { events: [], source: null },
      };
    }

    return {
      status: 'FAILED',
      detail: 'A calendar account is connected but reading it is not available in this build.',
      verified: true,
      failureCode: 'integration_not_implemented',
      // Empty, with a null source. An empty list and "no events today" are
      // different answers, and the status is what tells them apart.
      result: { events: [], source: null },
    };
  },
};

export const CALENDAR_ACTIONS: readonly AnyActionDefinition[] = Object.freeze([
  list,
] as unknown as AnyActionDefinition[]);
