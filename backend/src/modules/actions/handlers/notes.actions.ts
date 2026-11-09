import { ActionKind, ExecutionMode, NoteSource } from '@prisma/client';
import { z } from 'zod';
import type { ActionDefinition, AnyActionDefinition } from '../registry/types';

const createInput = z.object({
  text: z.string().trim().min(1).max(5_000),
  /**
   * Client-generated id, so a device that created the note offline and then
   * synced does not create it twice. Optional: a spoken note has no client
   * id, and the pending action's own id covers that case.
   */
  clientId: z.string().trim().min(1).max(64).nullish(),
});

const createResult = z.object({
  noteId: z.string(),
  text: z.string(),
  createdAt: z.string(),
});

const searchInput = z.object({
  query: z.string().trim().min(1).max(200).nullish(),
  limit: z.number().int().min(1).max(50).default(10),
});

const searchResult = z.object({
  notes: z.array(z.object({ noteId: z.string(), text: z.string(), createdAt: z.string() })),
  total: z.number().int(),
});

/**
 * Save a note.
 *
 * The simplest action, and the one worth reading first: the work is local
 * and reversible, so no confirmation is required, and the effect is a row
 * this server owns, so the result can be read back and genuinely verified.
 * `verified: true` here means something.
 */
const create: ActionDefinition<z.infer<typeof createInput>, z.infer<typeof createResult>> = {
  id: 'notes.create',
  category: 'notes',
  description: 'Save a note to this account.',
  inputSchema: createInput,
  requiredParams: ['text'],
  requiredPermissions: ['account.active', 'device.active', 'assistant.enabled', 'data.write'],
  requiresConnection: null,
  // Private, local and reversible. Asking twice about saving a note is
  // worse than useless.
  confirmationPolicy: 'never',
  idempotency: 'pending-action',
  kind: ActionKind.NOTE_SAVE,
  executionMode: ExecutionMode.LOCAL,
  resultSchema: createResult,

  preview: (input) => [
    { key: 'text', label: 'Note', value: input.text, editable: true, multiline: true },
  ],

  handler: async (input, context) => {
    const { prisma } = context.deps;

    // A client id is scoped to the user by a unique index, so an offline
    // device replaying its queue updates rather than duplicates.
    const note = input.clientId
      ? await prisma.note.upsert({
          where: { userId_clientId: { userId: context.userId, clientId: input.clientId } },
          create: {
            userId: context.userId,
            content: input.text,
            clientId: input.clientId,
            source: NoteSource.VOICE,
          },
          update: { content: input.text, version: { increment: 1 }, deletedAt: null },
          select: { id: true, content: true, createdAt: true },
        })
      : await prisma.note.create({
          data: { userId: context.userId, content: input.text, source: NoteSource.VOICE },
          select: { id: true, content: true, createdAt: true },
        });

    // Read back, rather than trusting the write. This is what earns
    // `verified: true`, and it is only possible because the effect is a row
    // in a database this server controls.
    const stored = await prisma.note.findFirst({
      where: { id: note.id, userId: context.userId, deletedAt: null },
      select: { id: true, content: true, createdAt: true },
    });

    if (!stored) {
      return {
        status: 'UNVERIFIED',
        detail: 'The note may not have been saved.',
        verified: false,
        failureCode: 'result_not_readable',
        result: { noteId: note.id, text: input.text, createdAt: note.createdAt.toISOString() },
      };
    }

    return {
      status: 'COMPLETED',
      detail: 'Note saved.',
      verified: true,
      resultRef: stored.id,
      result: {
        noteId: stored.id,
        text: stored.content,
        createdAt: stored.createdAt.toISOString(),
      },
    };
  },
};

/** Read notes back. A pure read, so nothing to confirm and nothing to undo. */
const search: ActionDefinition<z.infer<typeof searchInput>, z.infer<typeof searchResult>> = {
  id: 'notes.search',
  category: 'notes',
  description: 'Read back saved notes.',
  inputSchema: searchInput,
  requiredParams: [],
  requiredPermissions: ['account.active', 'device.active', 'assistant.enabled', 'data.read'],
  requiresConnection: null,
  confirmationPolicy: 'never',
  // A read may legitimately be repeated with a different query.
  idempotency: 'pending-action-and-params',
  kind: ActionKind.ASSISTANT_REPLY,
  executionMode: ExecutionMode.LOCAL,
  resultSchema: searchResult,

  preview: (input) => [
    { key: 'query', label: 'Search', value: input.query ?? 'everything', editable: true },
  ],

  handler: async (input, context) => {
    const { prisma } = context.deps;

    const where = {
      userId: context.userId,
      deletedAt: null,
      // Case-insensitive contains. Not a user-supplied expression: Prisma
      // parameterises it, so there is no pattern injection to worry about.
      ...(input.query ? { content: { contains: input.query, mode: 'insensitive' as const } } : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.note.findMany({
        where,
        select: { id: true, content: true, createdAt: true },
        orderBy: { updatedAt: 'desc' },
        take: input.limit,
      }),
      prisma.note.count({ where }),
    ]);

    return {
      status: 'COMPLETED',
      detail: total === 0 ? 'No notes matched.' : `Found ${total} note${total === 1 ? '' : 's'}.`,
      verified: true,
      result: {
        notes: rows.map((r) => ({
          noteId: r.id,
          text: r.content,
          createdAt: r.createdAt.toISOString(),
        })),
        total,
      },
    };
  },
};

export const NOTE_ACTIONS: readonly AnyActionDefinition[] = Object.freeze([
  create,
  search,
] as unknown as AnyActionDefinition[]);
