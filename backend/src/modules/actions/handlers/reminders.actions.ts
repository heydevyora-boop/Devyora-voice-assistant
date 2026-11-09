import { ActionKind, ExecutionMode } from '@prisma/client';
import { z } from 'zod';
import type { ActionDefinition, AnyActionDefinition } from '../registry/types';

const createInput = z.object({
  text: z.string().trim().min(1).max(500),
  /**
   * Required, and an instant rather than a description. A reminder without a
   * time is not a reminder, and the assistant asks rather than guessing —
   * see the capability table's `mustResolve`.
   */
  dueAt: z.string().datetime({ offset: true }),
  timezone: z.string().trim().min(1).max(64).default('Asia/Kolkata'),
  clientId: z.string().trim().min(1).max(64).nullish(),
});

const createResult = z.object({
  reminderId: z.string(),
  text: z.string(),
  dueAt: z.string(),
  timezone: z.string(),
  /**
   * Whether anything will actually fire. False today: the scheduler that
   * delivers reminders is not connected, so the reminder is stored and the
   * user is told it is stored — not that they will be reminded.
   */
  scheduled: z.boolean(),
});

/**
 * Save a reminder.
 *
 * Local and verifiable in the same way a note is, with one honest caveat
 * that the result schema carries rather than hides: storing a reminder and
 * *firing* one are different things, and nothing here fires. `scheduled` is
 * false and the wording says "saved", not "I'll remind you".
 */
const create: ActionDefinition<z.infer<typeof createInput>, z.infer<typeof createResult>> = {
  id: 'reminders.create',
  category: 'reminders',
  description: 'Save a reminder.',
  inputSchema: createInput,
  requiredParams: ['text', 'dueAt'],
  requiredPermissions: ['account.active', 'device.active', 'assistant.enabled', 'data.write'],
  requiresConnection: null,
  confirmationPolicy: 'never',
  idempotency: 'pending-action',
  kind: ActionKind.REMINDER_CREATE,
  executionMode: ExecutionMode.LOCAL,
  resultSchema: createResult,

  preview: (input) => [
    { key: 'text', label: 'Remind me to', value: input.text, editable: true },
    { key: 'dueAt', label: 'When', value: input.dueAt, editable: true },
  ],

  handler: async (input, context) => {
    const { prisma } = context.deps;
    const dueAt = new Date(input.dueAt);

    // A reminder for a moment already past would never fire even once the
    // scheduler exists, so it is refused rather than stored to look busy.
    if (dueAt.getTime() <= Date.now()) {
      return {
        status: 'FAILED',
        detail: 'That time has already passed.',
        verified: true,
        failureCode: 'due_in_past',
        result: {
          reminderId: '',
          text: input.text,
          dueAt: input.dueAt,
          timezone: input.timezone,
          scheduled: false,
        },
      };
    }

    const reminder = input.clientId
      ? await prisma.reminder.upsert({
          where: { userId_clientId: { userId: context.userId, clientId: input.clientId } },
          create: {
            userId: context.userId,
            text: input.text,
            dueAt,
            timezone: input.timezone,
            clientId: input.clientId,
          },
          update: {
            text: input.text,
            dueAt,
            timezone: input.timezone,
            version: { increment: 1 },
            deletedAt: null,
          },
          select: { id: true },
        })
      : await prisma.reminder.create({
          data: {
            userId: context.userId,
            text: input.text,
            dueAt,
            timezone: input.timezone,
          },
          select: { id: true },
        });

    const stored = await prisma.reminder.findFirst({
      where: { id: reminder.id, userId: context.userId, deletedAt: null },
      select: { id: true, text: true, dueAt: true, timezone: true, jobId: true },
    });

    if (!stored) {
      return {
        status: 'UNVERIFIED',
        detail: 'The reminder may not have been saved.',
        verified: false,
        failureCode: 'result_not_readable',
        result: {
          reminderId: reminder.id,
          text: input.text,
          dueAt: input.dueAt,
          timezone: input.timezone,
          scheduled: false,
        },
      };
    }

    // `jobId` is what a queued reminder would carry. It is null, and the
    // wording follows from that rather than from an assumption.
    const scheduled = stored.jobId !== null;

    return {
      status: 'COMPLETED',
      detail: scheduled
        ? 'Reminder set.'
        : 'Reminder saved. It will not alert you yet — reminder delivery is not connected.',
      verified: true,
      resultRef: stored.id,
      result: {
        reminderId: stored.id,
        text: stored.text,
        dueAt: stored.dueAt.toISOString(),
        timezone: stored.timezone,
        scheduled,
      },
    };
  },
};

export const REMINDER_ACTIONS: readonly AnyActionDefinition[] = Object.freeze([
  create,
] as unknown as AnyActionDefinition[]);
