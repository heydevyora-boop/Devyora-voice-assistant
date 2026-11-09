import { Injectable } from '@nestjs/common';
import { NoteSource, type Note, type Prisma } from '@prisma/client';
import { AppError } from '../../common/errors/app-error';
import { PageDto, PageMetaDto } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../database/prisma.service';
import type { ListNotesQueryDto } from './dto/notes.dto';

/** What a client sees. Built explicitly, so a new column is not exposed by accident. */
const NOTE_SELECT = {
  id: true,
  title: true,
  content: true,
  pinned: true,
  source: true,
  language: true,
  clientId: true,
  version: true,
  updatedByDeviceId: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
} as const;

export type NoteView = Prisma.NoteGetPayload<{ select: typeof NOTE_SELECT }>;

export interface WriteNoteInput {
  readonly title?: string | null;
  readonly content: string;
  readonly pinned?: boolean;
  readonly source?: NoteSource;
  readonly language?: string | null;
  readonly clientId?: string | null;
}

export interface NoteContext {
  readonly userId: string;
  readonly deviceId: string | null;
}

/**
 * Notes.
 *
 * Every query is filtered by `userId` where it is written, not by a caller
 * remembering to. There is no method here that can reach a note without an
 * owner, which is what keeps one account's notes out of another's.
 *
 * Deletion is soft, always. A deletion is a change like any other and has to
 * travel to the user's other devices — which it cannot do if the row is
 * gone. The purge that eventually removes it is a retention decision, not
 * part of deleting.
 */
@Injectable()
export class NotesService {
  constructor(private readonly prisma: PrismaService) {}

  // ───────────────────────────────────────────────────────────────── read

  /**
   * Lists notes, with search, filtering, sorting and pagination.
   *
   * The ordering puts pinned notes first by default, because that is what
   * pinning is for, and then applies the requested sort. Both are indexed.
   */
  async list(userId: string, query: ListNotesQueryDto) {
    const where = this.buildWhere(userId, query);

    const orderBy: Prisma.NoteOrderByWithRelationInput[] = [];
    if (query.pinnedFirst !== false) orderBy.push({ pinned: 'desc' });
    orderBy.push({ [query.sortBy ?? 'updatedAt']: query.order ?? 'desc' });

    const [items, total] = await Promise.all([
      this.prisma.note.findMany({
        where,
        select: NOTE_SELECT,
        orderBy,
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.note.count({ where }),
    ]);

    return new PageDto(items, new PageMetaDto(query.page, query.limit, total));
  }

  /**
   * Finds a note the caller owns, or reports it missing.
   *
   * Another user's id and a nonexistent id give the same answer: confirming
   * that something exists is itself a disclosure.
   */
  async requireOwned(userId: string, noteId: string, options: { includeDeleted?: boolean } = {}) {
    const note = await this.prisma.note.findFirst({
      where: {
        id: noteId,
        userId,
        ...(options.includeDeleted ? {} : { deletedAt: null }),
      },
      select: NOTE_SELECT,
    });
    if (!note) throw AppError.notFound('Note');
    return note;
  }

  // ──────────────────────────────────────────────────────────────── write

  /**
   * Creates a note, or updates the one a client id already names.
   *
   * The upsert is what makes an offline device's queue safe to replay: the
   * unique index on `(userId, clientId)` means a second attempt with the
   * same client id updates rather than duplicating. Without a client id a
   * repeat genuinely is a new note, and is treated as one.
   */
  async create(context: NoteContext, input: WriteNoteInput): Promise<NoteView> {
    const data = {
      userId: context.userId,
      title: input.title?.trim() || null,
      content: input.content,
      pinned: input.pinned ?? false,
      source: input.source ?? NoteSource.MANUAL,
      language: input.language ?? null,
      updatedByDeviceId: context.deviceId,
    };

    if (!input.clientId) {
      return this.prisma.note.create({ data, select: NOTE_SELECT });
    }

    return this.prisma.note.upsert({
      where: { userId_clientId: { userId: context.userId, clientId: input.clientId } },
      create: { ...data, clientId: input.clientId },
      update: {
        title: data.title,
        content: data.content,
        pinned: data.pinned,
        language: data.language,
        updatedByDeviceId: context.deviceId,
        version: { increment: 1 },
        // An offline device recreating a note it had deleted locally is
        // asking for it back, not asking for a second copy.
        deletedAt: null,
      },
      select: NOTE_SELECT,
    });
  }

  /**
   * Updates a note, refusing a change built on a stale version.
   *
   * `expectedVersion` is the whole conflict story in one parameter. A client
   * sends the version its edit was based on; if the stored version has moved
   * on, somebody else got there first and this is a conflict rather than an
   * overwrite. Omitting it is allowed — a deliberate "take mine" — and is
   * the only way to win a conflict, which makes overwriting someone's work
   * an explicit act.
   */
  async update(
    context: NoteContext,
    noteId: string,
    input: Partial<WriteNoteInput>,
    expectedVersion?: number,
  ): Promise<NoteView> {
    const existing = await this.requireOwned(context.userId, noteId);

    if (expectedVersion !== undefined && existing.version !== expectedVersion) {
      throw conflictError(existing, expectedVersion);
    }

    // Conditional on the version we just read, so two concurrent updates
    // cannot both believe they won.
    const { count } = await this.prisma.note.updateMany({
      where: { id: noteId, userId: context.userId, version: existing.version },
      data: {
        ...(input.title !== undefined ? { title: input.title?.trim() || null } : {}),
        ...(input.content !== undefined ? { content: input.content } : {}),
        ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
        ...(input.language !== undefined ? { language: input.language } : {}),
        updatedByDeviceId: context.deviceId,
        version: { increment: 1 },
      },
    });

    if (count === 0) {
      // It moved between the read and the write.
      const current = await this.requireOwned(context.userId, noteId);
      throw conflictError(current, expectedVersion ?? existing.version);
    }

    return this.requireOwned(context.userId, noteId);
  }

  /**
   * Soft-deletes.
   *
   * The version still increments, because a deletion is a change the other
   * devices have to learn about and the cursor they sync against is ordered
   * by `updatedAt`.
   */
  async remove(context: NoteContext, noteId: string, expectedVersion?: number) {
    const existing = await this.requireOwned(context.userId, noteId);

    if (expectedVersion !== undefined && existing.version !== expectedVersion) {
      throw conflictError(existing, expectedVersion);
    }

    const now = new Date();
    await this.prisma.note.updateMany({
      where: { id: noteId, userId: context.userId, version: existing.version },
      data: { deletedAt: now, updatedByDeviceId: context.deviceId, version: { increment: 1 } },
    });

    return { deleted: true, deletedAt: now.toISOString() };
  }

  /** Restores a soft-deleted note. */
  async restore(context: NoteContext, noteId: string): Promise<NoteView> {
    const existing = await this.requireOwned(context.userId, noteId, { includeDeleted: true });
    if (!existing.deletedAt) return existing;

    await this.prisma.note.update({
      where: { id: noteId },
      data: { deletedAt: null, updatedByDeviceId: context.deviceId, version: { increment: 1 } },
    });
    return this.requireOwned(context.userId, noteId);
  }

  // ───────────────────────────────────────────────────────────── retention

  /**
   * Permanently removes notes deleted long enough ago.
   *
   * The grace period is what makes an accidental delete recoverable, and it
   * is also how long a device may be offline and still learn that something
   * was deleted. Purging sooner would mean a device coming back after a
   * fortnight silently keeping a note the user removed.
   */
  async purgeDeleted(retainDays: number, now = new Date()): Promise<number> {
    if (retainDays <= 0) return 0;
    const cutoff = new Date(now.getTime() - retainDays * 86_400_000);

    const { count } = await this.prisma.note.deleteMany({
      where: { deletedAt: { not: null, lt: cutoff } },
    });
    return count;
  }

  // ─────────────────────────────────────────────────────────────── private

  private buildWhere(userId: string, query: ListNotesQueryDto): Prisma.NoteWhereInput {
    const where: Prisma.NoteWhereInput = {
      userId,
      // Deleted notes are hidden from ordinary listings. Sync asks for them
      // explicitly, because a device needs to know about a deletion.
      ...(query.includeDeleted ? {} : { deletedAt: null }),
    };

    if (query.q) {
      // Parameterised by Prisma, so there is no pattern injection here. It
      // is a `contains` rather than a full-text search: the data set is one
      // person's notes, and a trigram index would be a cost without a
      // benefit until somebody has tens of thousands.
      where.OR = [
        { content: { contains: query.q, mode: 'insensitive' } },
        { title: { contains: query.q, mode: 'insensitive' } },
      ];
    }

    if (query.pinned !== undefined) where.pinned = query.pinned;
    if (query.source) where.source = query.source;
    if (query.language) where.language = query.language;

    if (query.from || query.to) {
      const field = query.dateField === 'createdAt' ? 'createdAt' : 'updatedAt';
      where[field] = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }

    return where;
  }
}

/**
 * A conflict, carrying what the server has.
 *
 * The point of including the current state is that a client can resolve the
 * conflict without another round trip — and that nothing has to guess. A
 * bare 409 would leave the client to re-fetch and hope.
 */
export function conflictError(current: NoteView | Note, expectedVersion: number): AppError {
  return new AppError(
    'CONFLICT',
    'That note changed on another device. Nothing was overwritten.',
    409,
    [
      { field: 'version', message: `expected ${expectedVersion}, stored ${current.version}` },
    ],
  );
}
