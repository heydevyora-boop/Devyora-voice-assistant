import { Injectable } from '@nestjs/common';
import type { MessageRole, MessageSource, Prisma } from '@prisma/client';
import { AppError } from '../../common/errors/app-error';
import { PageDto, PageMetaDto, type PaginationQueryDto } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../database/prisma.service';

/** What a conversation looks like to a client. */
const CONVERSATION_SELECT = {
  id: true,
  title: true,
  lastMessageAt: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const MESSAGE_SELECT = {
  id: true,
  role: true,
  source: true,
  content: true,
  createdAt: true,
} as const;

export interface ContextMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/**
 * Conversations and their messages.
 *
 * Every query is filtered by `userId` at the point it is written, not by a
 * caller remembering to. There is no method here that can read a row
 * without an owner, which is what keeps one user's context out of another's
 * prompt.
 */
@Injectable()
export class ConversationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, query: PaginationQueryDto) {
    const where: Prisma.ConversationWhereInput = { userId, deletedAt: null };

    const [items, total] = await Promise.all([
      this.prisma.conversation.findMany({
        where,
        select: { ...CONVERSATION_SELECT, _count: { select: { messages: true } } },
        orderBy: { lastMessageAt: { sort: query.order, nulls: 'last' } },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.conversation.count({ where }),
    ]);

    return new PageDto(
      items.map(({ _count, ...c }) => ({ ...c, messageCount: _count.messages })),
      new PageMetaDto(query.page, query.limit, total),
    );
  }

  async create(userId: string, title?: string) {
    return this.prisma.conversation.create({
      data: { userId, title: title?.slice(0, 200) },
      select: CONVERSATION_SELECT,
    });
  }

  /**
   * Finds a conversation the caller owns, or reports it missing.
   *
   * Another user's id and a nonexistent id give the same answer: confirming
   * that something exists is itself a disclosure.
   */
  async requireOwned(userId: string, conversationId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, userId, deletedAt: null },
      select: CONVERSATION_SELECT,
    });
    if (!conversation) throw AppError.notFound('Conversation');
    return conversation;
  }

  async messages(userId: string, conversationId: string, query: PaginationQueryDto) {
    await this.requireOwned(userId, conversationId);

    const where: Prisma.MessageWhereInput = { conversationId };
    const [items, total] = await Promise.all([
      this.prisma.message.findMany({
        where,
        select: MESSAGE_SELECT,
        orderBy: { createdAt: query.order },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.message.count({ where }),
    ]);

    return new PageDto(items, new PageMetaDto(query.page, query.limit, total));
  }

  /**
   * Appends a message and moves the conversation's cursor, atomically, so a
   * crash cannot leave a conversation whose `lastMessageAt` disagrees with
   * its contents.
   */
  async appendMessage(
    conversationId: string,
    role: MessageRole,
    content: string,
    options: { source?: MessageSource; tokensIn?: number; tokensOut?: number } = {},
  ) {
    return this.prisma.transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          conversationId,
          role,
          content,
          source: options.source,
          tokensIn: options.tokensIn,
          tokensOut: options.tokensOut,
        },
        select: MESSAGE_SELECT,
      });
      await tx.conversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: message.createdAt },
      });
      return message;
    });
  }

  /**
   * The recent turns replayed to the model.
   *
   * Scoped to one conversation belonging to one user, capped, and oldest
   * first. System messages are excluded: the system instruction is built
   * fresh each turn and must not be something a stored row can influence.
   */
  async contextWindow(
    userId: string,
    conversationId: string,
    limit: number,
  ): Promise<ContextMessage[]> {
    if (limit <= 0) return [];

    const rows = await this.prisma.message.findMany({
      where: {
        conversationId,
        // The join back to the owner is the isolation guarantee: a
        // conversation id alone is never enough to read messages.
        conversation: { userId, deletedAt: null },
        role: { in: ['USER', 'ASSISTANT'] },
      },
      select: { role: true, content: true },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return rows
      .reverse()
      .map((r) => ({ role: r.role === 'USER' ? ('user' as const) : ('assistant' as const), content: r.content }));
  }

  async rename(userId: string, conversationId: string, title: string) {
    await this.requireOwned(userId, conversationId);
    return this.prisma.conversation.update({
      where: { id: conversationId },
      data: { title: title.slice(0, 200) },
      select: CONVERSATION_SELECT,
    });
  }

  async archive(userId: string, conversationId: string) {
    await this.requireOwned(userId, conversationId);
    return this.prisma.conversation.update({
      where: { id: conversationId },
      data: { archivedAt: new Date() },
      select: CONVERSATION_SELECT,
    });
  }

  /**
   * Soft-deletes. The rows stay for the grace period so a mistake can be
   * undone; the purge job that removes them lands with the background
   * workers, and nothing here claims the data is already gone.
   */
  async remove(userId: string, conversationId: string) {
    await this.requireOwned(userId, conversationId);
    const now = new Date();
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { deletedAt: now, archivedAt: now },
    });
    return { deleted: true, deletedAt: now };
  }

  /** Deletes every conversation for a user, for the privacy screen. */
  async removeAll(userId: string) {
    const now = new Date();
    const { count } = await this.prisma.conversation.updateMany({
      where: { userId, deletedAt: null },
      data: { deletedAt: now, archivedAt: now },
    });
    return { deleted: count, deletedAt: now };
  }

  /**
   * Applies the retention window.
   *
   * Called by the retention job once background workers exist. It is
   * written here because retention is a property of this data, not of the
   * scheduler that happens to trigger it.
   */
  async applyRetention(userId: string, retainDays: number): Promise<number> {
    if (retainDays <= 0) return 0;
    const cutoff = new Date(Date.now() - retainDays * 86_400_000);

    const { count } = await this.prisma.conversation.updateMany({
      where: { userId, deletedAt: null, lastMessageAt: { lt: cutoff } },
      data: { deletedAt: new Date() },
    });
    return count;
  }
}
