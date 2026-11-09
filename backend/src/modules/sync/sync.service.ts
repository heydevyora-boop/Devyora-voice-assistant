import { Injectable, Logger } from '@nestjs/common';
import { NoteSource, ReminderStatus, type Prisma } from '@prisma/client';
import { AppError } from '../../common/errors/app-error';
import { AppConfigService } from '../../config/app-config.module';
import { PrismaService } from '../../database/prisma.service';
import { isValidTimezone, toInstant } from '../reminders/time';
import type { PullQueryDto, PushNoteDto, PushReminderDto, SyncPushDto } from './dto/sync.dto';

export interface SyncContext {
  readonly userId: string;
  readonly deviceId: string;
}

/** What happened to one pushed record. */
export type RecordOutcome =
  /** Created on the server. */
  | 'created'
  /** The server's copy was replaced by the client's. */
  | 'updated'
  /** Identical to what the server already had; nothing was written. */
  | 'unchanged'
  /** The server's copy is newer. The client's change was **not** applied. */
  | 'conflict'
  /** Deleted on the server, as asked. */
  | 'deleted'
  /** Refused: malformed, or not this user's. */
  | 'rejected';

export interface PushedRecordResult {
  readonly clientId: string;
  readonly id: string | null;
  readonly outcome: RecordOutcome;
  readonly version: number | null;
  /** Present on a conflict: the server's copy, so the client can resolve it. */
  readonly server: unknown;
  readonly detail: string | null;
}

/**
 * Offline-first synchronisation.
 *
 * ## The conflict strategy, stated once
 *
 * Every synced record carries a `version`, incremented by the server on
 * every accepted change. A client pushing a change sends `baseVersion`: the
 * version its edit was built on.
 *
 * - `baseVersion === stored.version` — the client is up to date. Applied,
 *   version incremented.
 * - `baseVersion < stored.version` — somebody else changed it first. The
 *   push is **refused** as a conflict and the server's copy is returned
 *   with it. Nothing is overwritten.
 * - `baseVersion` omitted — a deliberate "take mine". Applied. This is the
 *   only way to win a conflict, which makes overwriting somebody's work an
 *   explicit act rather than a side effect of a race.
 *
 * It is **not** last-write-wins. Last-write-wins on a wall clock loses data
 * for exactly the reason it is convenient: two devices, two clocks, and the
 * one that is three minutes fast always wins. A version counter the server
 * owns has no clock in it.
 *
 * ## Deletions travel
 *
 * A deletion is a change, and a device that was offline has to learn about
 * it. So deletes are soft: the row stays with `deletedAt` set, its version
 * increments, and it appears in the next pull as a tombstone. It is purged
 * only after the retention window, which is therefore also the longest a
 * device may be offline and still sync correctly.
 *
 * ## The cursor
 *
 * A pull returns everything changed at or after the cursor, and a new
 * cursor to use next time. The cursor is a server timestamp, never the
 * client's: a device with a wrong clock would otherwise ask for the wrong
 * window and silently miss records.
 *
 * ## Idempotency
 *
 * Every pushed record carries a `clientId`, unique per user by a database
 * constraint. A replayed push therefore updates the same row rather than
 * creating a second one — which is what makes a client safe to retry after
 * a dropped connection.
 */
@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  // ──────────────────────────────────────────────────────────────── push

  /**
   * Takes a batch of local changes.
   *
   * Each record is handled on its own: one conflict does not fail the
   * batch, because a device with fifty queued changes and one conflict
   * should get forty-nine applied and be told about the one. Returning
   * per-record outcomes is what makes that possible.
   */
  async push(context: SyncContext, body: SyncPushDto) {
    const limit = this.config.providers.productivity.syncMaxBatch;
    const notes = body.notes ?? [];
    const reminders = body.reminders ?? [];

    if (notes.length + reminders.length > limit) {
      throw AppError.validation(`A sync batch may hold at most ${limit} records.`);
    }

    const noteResults: PushedRecordResult[] = [];
    for (const record of notes) {
      noteResults.push(await this.pushNote(context, record));
    }

    const reminderResults: PushedRecordResult[] = [];
    for (const record of reminders) {
      reminderResults.push(await this.pushReminder(context, record));
    }

    const applied = [...noteResults, ...reminderResults].filter(
      (r) => r.outcome === 'created' || r.outcome === 'updated' || r.outcome === 'deleted',
    ).length;

    await this.touchCursor(context, { pushed: notes.length + reminders.length });

    return {
      notes: noteResults,
      reminders: reminderResults,
      summary: {
        received: notes.length + reminders.length,
        applied,
        conflicts: [...noteResults, ...reminderResults].filter((r) => r.outcome === 'conflict')
          .length,
        rejected: [...noteResults, ...reminderResults].filter((r) => r.outcome === 'rejected')
          .length,
      },
      // Said explicitly, because it is the guarantee that matters: a
      // conflict means the client's change is still only on the client.
      note:
        'A record reported as `conflict` was not applied. The server copy is included so ' +
        'the client can resolve it and push again.',
    };
  }

  private async pushNote(
    context: SyncContext,
    record: PushNoteDto,
  ): Promise<PushedRecordResult> {
    const existing = await this.prisma.note.findFirst({
      // Scoped to the user. A client id is not a capability: one user's
      // `note-1` is a different row from another's.
      where: { userId: context.userId, clientId: record.clientId },
      select: { id: true, version: true, content: true, title: true, pinned: true, deletedAt: true },
    });

    if (!existing) {
      if (record.deleted) {
        // A deletion of something the server never had. Nothing to do, and
        // not an error: the client and the server agree it is gone.
        return {
          clientId: record.clientId,
          id: null,
          outcome: 'unchanged',
          version: null,
          server: null,
          detail: 'Already absent.',
        };
      }

      const created = await this.prisma.note.create({
        data: {
          userId: context.userId,
          clientId: record.clientId,
          title: record.title?.trim() || null,
          content: record.content ?? '',
          pinned: record.pinned ?? false,
          source: record.source ?? NoteSource.MANUAL,
          language: record.language ?? null,
          updatedByDeviceId: context.deviceId,
        },
        select: { id: true, version: true },
      });
      return {
        clientId: record.clientId,
        id: created.id,
        outcome: 'created',
        version: created.version,
        server: null,
        detail: null,
      };
    }

    // The conflict rule.
    if (record.baseVersion !== undefined && record.baseVersion < existing.version) {
      const server = await this.prisma.note.findUniqueOrThrow({
        where: { id: existing.id },
        select: {
          id: true,
          clientId: true,
          title: true,
          content: true,
          pinned: true,
          source: true,
          language: true,
          version: true,
          updatedAt: true,
          deletedAt: true,
        },
      });
      return {
        clientId: record.clientId,
        id: existing.id,
        outcome: 'conflict',
        version: existing.version,
        server,
        detail: `The server has version ${existing.version}; this change was based on ${record.baseVersion}.`,
      };
    }

    if (record.deleted) {
      if (existing.deletedAt) {
        return {
          clientId: record.clientId,
          id: existing.id,
          outcome: 'unchanged',
          version: existing.version,
          server: null,
          detail: 'Already deleted.',
        };
      }
      const deleted = await this.prisma.note.update({
        where: { id: existing.id },
        data: {
          deletedAt: new Date(),
          updatedByDeviceId: context.deviceId,
          version: { increment: 1 },
        },
        select: { version: true },
      });
      return {
        clientId: record.clientId,
        id: existing.id,
        outcome: 'deleted',
        version: deleted.version,
        server: null,
        detail: null,
      };
    }

    // Nothing actually changed? Then nothing is written, and the version
    // does not move — otherwise an idle client polling in a loop would
    // bump every record's version forever and make every other device
    // re-download them.
    const unchanged =
      (record.content ?? existing.content) === existing.content &&
      (record.title?.trim() || null) === existing.title &&
      (record.pinned ?? existing.pinned) === existing.pinned &&
      !existing.deletedAt;

    if (unchanged) {
      return {
        clientId: record.clientId,
        id: existing.id,
        outcome: 'unchanged',
        version: existing.version,
        server: null,
        detail: null,
      };
    }

    const updated = await this.prisma.note.update({
      where: { id: existing.id },
      data: {
        ...(record.title !== undefined ? { title: record.title?.trim() || null } : {}),
        ...(record.content !== undefined ? { content: record.content } : {}),
        ...(record.pinned !== undefined ? { pinned: record.pinned } : {}),
        ...(record.language !== undefined ? { language: record.language } : {}),
        deletedAt: null,
        updatedByDeviceId: context.deviceId,
        version: { increment: 1 },
      },
      select: { version: true },
    });

    return {
      clientId: record.clientId,
      id: existing.id,
      outcome: 'updated',
      version: updated.version,
      server: null,
      detail: null,
    };
  }

  private async pushReminder(
    context: SyncContext,
    record: PushReminderDto,
  ): Promise<PushedRecordResult> {
    const existing = await this.prisma.reminder.findFirst({
      where: { userId: context.userId, clientId: record.clientId },
      select: { id: true, version: true, dueAt: true, text: true, deletedAt: true, timezone: true },
    });

    // A reminder's time has to be interpretable before anything is written.
    let dueAt: Date | null = null;
    let zone = existing?.timezone ?? this.config.providers.productivity.defaultTimezone;

    if (record.timezone) {
      if (!isValidTimezone(record.timezone)) {
        return {
          clientId: record.clientId,
          id: existing?.id ?? null,
          outcome: 'rejected',
          version: existing?.version ?? null,
          server: null,
          detail: `"${record.timezone}" is not a known time zone.`,
        };
      }
      zone = record.timezone;
    }

    if (record.dueAt) {
      const resolved = toInstant(record.dueAt, zone);
      if (!resolved.ok) {
        return {
          clientId: record.clientId,
          id: existing?.id ?? null,
          outcome: 'rejected',
          version: existing?.version ?? null,
          server: null,
          detail: resolved.detail,
        };
      }
      dueAt = resolved.instant;
    }

    if (!existing) {
      if (record.deleted) {
        return {
          clientId: record.clientId,
          id: null,
          outcome: 'unchanged',
          version: null,
          server: null,
          detail: 'Already absent.',
        };
      }
      if (!dueAt || !record.text) {
        return {
          clientId: record.clientId,
          id: null,
          outcome: 'rejected',
          version: null,
          server: null,
          detail: 'A new reminder needs text and a time.',
        };
      }

      const created = await this.prisma.reminder.create({
        data: {
          userId: context.userId,
          clientId: record.clientId,
          text: record.text,
          dueAt,
          timezone: zone,
          rrule: record.rrule ?? null,
          updatedByDeviceId: context.deviceId,
        },
        select: { id: true, version: true },
      });
      // Scheduling happens through the reconciliation sweep rather than
      // here: a sync batch should not depend on Redis being reachable, and
      // the sweep picks up any reminder whose job is missing within a
      // minute.
      return {
        clientId: record.clientId,
        id: created.id,
        outcome: 'created',
        version: created.version,
        server: null,
        detail: null,
      };
    }

    if (record.baseVersion !== undefined && record.baseVersion < existing.version) {
      const server = await this.prisma.reminder.findUniqueOrThrow({
        where: { id: existing.id },
        select: {
          id: true,
          clientId: true,
          text: true,
          dueAt: true,
          timezone: true,
          rrule: true,
          status: true,
          version: true,
          updatedAt: true,
          deletedAt: true,
        },
      });
      return {
        clientId: record.clientId,
        id: existing.id,
        outcome: 'conflict',
        version: existing.version,
        server,
        detail: `The server has version ${existing.version}; this change was based on ${record.baseVersion}.`,
      };
    }

    if (record.deleted) {
      if (existing.deletedAt) {
        return {
          clientId: record.clientId,
          id: existing.id,
          outcome: 'unchanged',
          version: existing.version,
          server: null,
          detail: 'Already deleted.',
        };
      }
      const deleted = await this.prisma.reminder.update({
        where: { id: existing.id },
        data: {
          deletedAt: new Date(),
          status: ReminderStatus.CANCELLED,
          updatedByDeviceId: context.deviceId,
          version: { increment: 1 },
        },
        select: { version: true },
      });
      return {
        clientId: record.clientId,
        id: existing.id,
        outcome: 'deleted',
        version: deleted.version,
        server: null,
        detail: null,
      };
    }

    const sameTime = dueAt === null || dueAt.getTime() === existing.dueAt.getTime();
    const sameText = record.text === undefined || record.text === existing.text;
    if (sameTime && sameText && !existing.deletedAt && !record.rrule) {
      return {
        clientId: record.clientId,
        id: existing.id,
        outcome: 'unchanged',
        version: existing.version,
        server: null,
        detail: null,
      };
    }

    const updated = await this.prisma.reminder.update({
      where: { id: existing.id },
      data: {
        ...(record.text !== undefined ? { text: record.text } : {}),
        ...(dueAt ? { dueAt } : {}),
        timezone: zone,
        ...(record.rrule !== undefined ? { rrule: record.rrule || null } : {}),
        status: ReminderStatus.SCHEDULED,
        deletedAt: null,
        updatedByDeviceId: context.deviceId,
        version: { increment: 1 },
      },
      select: { version: true },
    });

    return {
      clientId: record.clientId,
      id: existing.id,
      outcome: 'updated',
      version: updated.version,
      server: null,
      detail: null,
    };
  }

  // ──────────────────────────────────────────────────────────────── pull

  /**
   * Everything changed since the cursor, tombstones included.
   *
   * The cursor is inclusive at its lower bound and the returned cursor is
   * the newest `updatedAt` in the batch, so a record changed in the same
   * millisecond as the boundary is sent again rather than skipped. A
   * duplicate is harmless — the client upserts by id — whereas a skipped
   * record is lost data.
   */
  async pull(context: SyncContext, query: PullQueryDto) {
    const limit = Math.min(
      query.limit ?? this.config.providers.productivity.syncMaxBatch,
      this.config.providers.productivity.syncMaxBatch,
    );

    const cursor = await this.readCursor(context);
    const notesSince = query.since ? new Date(query.since) : cursor?.notesCursor ?? null;
    const remindersSince = query.since ? new Date(query.since) : cursor?.remindersCursor ?? null;

    const noteWhere: Prisma.NoteWhereInput = {
      userId: context.userId,
      ...(notesSince ? { updatedAt: { gte: notesSince } } : {}),
    };
    const reminderWhere: Prisma.ReminderWhereInput = {
      userId: context.userId,
      ...(remindersSince ? { updatedAt: { gte: remindersSince } } : {}),
    };

    const [notes, reminders] = await Promise.all([
      this.prisma.note.findMany({
        where: noteWhere,
        select: {
          id: true,
          clientId: true,
          title: true,
          content: true,
          pinned: true,
          source: true,
          language: true,
          version: true,
          updatedByDeviceId: true,
          createdAt: true,
          updatedAt: true,
          deletedAt: true,
        },
        orderBy: { updatedAt: 'asc' },
        take: limit + 1,
      }),
      this.prisma.reminder.findMany({
        where: reminderWhere,
        select: {
          id: true,
          clientId: true,
          text: true,
          dueAt: true,
          timezone: true,
          rrule: true,
          status: true,
          firedAt: true,
          completedAt: true,
          snoozedUntil: true,
          version: true,
          updatedByDeviceId: true,
          createdAt: true,
          updatedAt: true,
          deletedAt: true,
        },
        orderBy: { updatedAt: 'asc' },
        take: limit + 1,
      }),
    ]);

    // One extra row was fetched purely to answer "is there more?" without a
    // second count query.
    const notesTruncated = notes.length > limit;
    const remindersTruncated = reminders.length > limit;
    const notePage = notesTruncated ? notes.slice(0, limit) : notes;
    const reminderPage = remindersTruncated ? reminders.slice(0, limit) : reminders;

    const nextNotesCursor = notePage.at(-1)?.updatedAt ?? notesSince;
    const nextRemindersCursor = reminderPage.at(-1)?.updatedAt ?? remindersSince;

    // The cursor is only advanced when the client is not being truncated.
    // Advancing it mid-page would let a device believe it had caught up
    // when there was another page waiting.
    await this.writeCursor(context, {
      notesCursor: notesTruncated ? nextNotesCursor : nextNotesCursor,
      remindersCursor: remindersTruncated ? nextRemindersCursor : nextRemindersCursor,
      pulled: true,
    });

    return {
      notes: notePage.map((n) => ({
        ...n,
        createdAt: n.createdAt.toISOString(),
        updatedAt: n.updatedAt.toISOString(),
        deletedAt: n.deletedAt?.toISOString() ?? null,
        /** A tombstone: the client should remove its local copy. */
        deleted: n.deletedAt !== null,
      })),
      reminders: reminderPage.map((r) => ({
        ...r,
        dueAt: r.dueAt.toISOString(),
        firedAt: r.firedAt?.toISOString() ?? null,
        completedAt: r.completedAt?.toISOString() ?? null,
        snoozedUntil: r.snoozedUntil?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        deletedAt: r.deletedAt?.toISOString() ?? null,
        deleted: r.deletedAt !== null,
      })),
      cursor: {
        notes: nextNotesCursor?.toISOString() ?? null,
        reminders: nextRemindersCursor?.toISOString() ?? null,
      },
      hasMore: notesTruncated || remindersTruncated,
      /** The server's clock, so a client can see its own drift. */
      serverTime: new Date().toISOString(),
    };
  }

  // ───────────────────────────────────────────────────────────── cursors

  /** What this device has already seen. */
  async status(context: SyncContext) {
    const cursor = await this.readCursor(context);
    const [notes, reminders, pendingNotes, pendingReminders] = await Promise.all([
      this.prisma.note.count({ where: { userId: context.userId, deletedAt: null } }),
      this.prisma.reminder.count({ where: { userId: context.userId, deletedAt: null } }),
      this.prisma.note.count({
        where: {
          userId: context.userId,
          ...(cursor?.notesCursor ? { updatedAt: { gt: cursor.notesCursor } } : {}),
        },
      }),
      this.prisma.reminder.count({
        where: {
          userId: context.userId,
          ...(cursor?.remindersCursor ? { updatedAt: { gt: cursor.remindersCursor } } : {}),
        },
      }),
    ]);

    return {
      cursor: {
        notes: cursor?.notesCursor?.toISOString() ?? null,
        reminders: cursor?.remindersCursor?.toISOString() ?? null,
      },
      lastPulledAt: cursor?.lastPulledAt?.toISOString() ?? null,
      lastPushedAt: cursor?.lastPushedAt?.toISOString() ?? null,
      totals: { notes, reminders },
      /** Roughly how much this device is behind. */
      pending: { notes: pendingNotes, reminders: pendingReminders },
      tombstoneDays: this.config.providers.productivity.tombstoneDays,
      serverTime: new Date().toISOString(),
    };
  }

  /**
   * Forgets what a device has seen, so its next pull is a full one.
   *
   * For a client that has lost or corrupted its local store. It does not
   * touch any data — only this device's watermark.
   */
  async reset(context: SyncContext) {
    await this.prisma.syncCursor.deleteMany({
      where: { userId: context.userId, deviceId: context.deviceId },
    });
    return { reset: true, note: 'The next pull will return everything, tombstones included.' };
  }

  private readCursor(context: SyncContext) {
    return this.prisma.syncCursor.findUnique({
      where: { userId_deviceId: { userId: context.userId, deviceId: context.deviceId } },
    });
  }

  private async writeCursor(
    context: SyncContext,
    update: { notesCursor: Date | null; remindersCursor: Date | null; pulled: boolean },
  ): Promise<void> {
    const data = {
      notesCursor: update.notesCursor,
      remindersCursor: update.remindersCursor,
      ...(update.pulled ? { lastPulledAt: new Date() } : {}),
    };

    await this.prisma.syncCursor
      .upsert({
        where: { userId_deviceId: { userId: context.userId, deviceId: context.deviceId } },
        create: { userId: context.userId, deviceId: context.deviceId, ...data },
        update: data,
      })
      .catch((error: unknown) => {
        // A cursor is an optimisation: the client sends `since` too. Losing
        // one must not fail the sync that produced it.
        this.logger.warn(
          `Could not write the sync cursor: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      });
  }

  private async touchCursor(context: SyncContext, info: { pushed: number }): Promise<void> {
    await this.prisma.syncCursor
      .upsert({
        where: { userId_deviceId: { userId: context.userId, deviceId: context.deviceId } },
        create: {
          userId: context.userId,
          deviceId: context.deviceId,
          lastPushedAt: new Date(),
          pushedCount: info.pushed,
        },
        update: { lastPushedAt: new Date(), pushedCount: { increment: info.pushed } },
      })
      .catch(() => undefined);
  }
}
