import { Injectable, Logger } from '@nestjs/common';
import { ActionKind as ActionKindEnum, PendingActionStatus, type ActionKind, type ExecutionMode } from '@prisma/client';
import { AppError } from '../../common/errors/app-error';
import { PrismaService } from '../../database/prisma.service';
import { AuditAction, AuditService } from '../../security/services/audit.service';
import { LlmError } from '../../providers/llm/errors';
import { AiService } from '../ai/ai.service';
import { CAPABILITIES, policyFor, type CapabilityPolicy } from '../ai/capability-registry';
import type { Command, Intent } from '../ai/schemas/command.schema';
import { ConversationsService } from '../conversations/conversations.service';
import { AppConfigService } from '../../config/app-config.module';

/** How long an unanswered confirmation stays open. */
const CONFIRMATION_TTL_MS = 90_000;

/**
 * What the assistant did with a turn.
 *
 * `executed` is deliberately absent. Execution arrives with the action
 * workers; until then nothing in this service may report that something
 * happened, so the vocabulary does not contain a word for it.
 */
export type TurnStatus =
  /** A plan is ready and waiting for the user to approve it. */
  | 'awaiting_confirmation'
  /** The assistant needs an answer before it can build a plan. */
  | 'needs_clarification'
  /** Understood and permitted, queued for the executor. */
  | 'queued_for_execution'
  /** Understood, but the assistant cannot carry it out. */
  | 'unsupported'
  /** Answered in conversation; nothing to carry out. */
  | 'answered'
  | 'failed';

export interface PlanField {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly editable: boolean;
  readonly multiline?: boolean;
}

export interface AssistantPlan {
  readonly pendingActionId: string;
  readonly kind: ActionKind;
  readonly intent: Intent;
  readonly executionMode: ExecutionMode;
  readonly requiresConfirmation: boolean;
  readonly fields: readonly PlanField[];
  readonly expiresAt: string;
}

export interface AssistantClarification {
  readonly question: string;
  readonly reason: string;
  readonly field: string;
  readonly options: readonly { label: string; value: string | null }[];
  /** Echo this on the follow-up so the turn can be resumed. */
  readonly commandId: string;
}

export interface AssistantTurn {
  readonly conversationId: string;
  readonly commandId: string;
  readonly status: TurnStatus;
  readonly reply: string;
  readonly intent: Intent | null;
  readonly confidence: number;
  readonly plan: AssistantPlan | null;
  readonly clarification: AssistantClarification | null;
  /** Present when the turn failed or is unsupported. */
  readonly problem: { readonly code: string; readonly detail: string } | null;
  readonly transcript: string;
  readonly detectedLanguage: string | null;
  readonly provider: { readonly id: string; readonly model: string; readonly isMock: boolean };
}

export interface TurnRequest {
  readonly userId: string;
  readonly deviceId: string;
  readonly text: string;
  readonly conversationId?: string;
  /** Set when answering a clarification, so the turn resumes in context. */
  readonly answersCommandId?: string;
  readonly meta: { ipAddress?: string; userAgent?: string };
}

/**
 * The assistant pipeline.
 *
 *   context → interpretation → schema validation → permission evaluation
 *   → action routing → confirmation or clarification → response
 *
 * The ordering matters: interpretation happens before any authority is
 * consulted, and the model's answer is treated as a proposal from an
 * untrusted source throughout. Permission, confirmation policy and routing
 * are read from the capability table, never from the model's output, so a
 * compromised or manipulated model cannot widen what the assistant will do.
 */
@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly conversations: ConversationsService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
  ) {}

  async handleTurn(request: TurnRequest): Promise<AssistantTurn> {
    const transcript = request.text.trim();
    if (!transcript) throw AppError.validation('The transcript is empty.');

    const conversation = await this.resolveConversation(request.userId, request.conversationId);

    // Stored before interpretation, so a provider failure still leaves a
    // record of what the user actually said.
    const message = await this.conversations.appendMessage(
      conversation.id,
      'USER',
      transcript,
      { source: 'SPEECH' },
    );

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: request.userId },
      select: { timezone: true, locale: true },
    });

    const history = await this.conversations.contextWindow(
      request.userId,
      conversation.id,
      this.config.providers.ai.contextMessages,
    );

    const resuming = await this.resolveResumption(request.userId, request.answersCommandId);

    // ── interpretation ────────────────────────────────────────────────
    let interpretation;
    try {
      interpretation = await this.ai.interpret(transcript, {
        nowIso: new Date().toISOString(),
        timezone: user.timezone,
        locale: user.locale,
        // No contact directory exists, so a named recipient can never be
        // resolved and the model is told to ask instead of guessing.
        hasContactDirectory: false,
        // The history excludes the turn just stored, so the transcript is
        // not presented to the model twice.
        history: history.slice(0, -1),
        resuming,
      });
    } catch (error) {
      return this.failTurn(conversation.id, message.id, request, transcript, error);
    }

    const { output } = interpretation;

    const command = await this.prisma.assistantCommand.create({
      data: {
        userId: request.userId,
        conversationId: conversation.id,
        messageId: message.id,
        rawText: transcript,
        intent: output.command?.intent ?? null,
        entities: (output.command?.entities ?? {}) as object,
        confidence: output.confidence,
        providerId: interpretation.providerId,
        latencyMs: interpretation.latencyMs,
      },
      select: { id: true },
    });

    const base = {
      conversationId: conversation.id,
      commandId: command.id,
      transcript,
      detectedLanguage: output.detectedLanguage,
      confidence: output.confidence,
      provider: {
        id: interpretation.providerId,
        model: interpretation.model,
        isMock: interpretation.isMock,
      },
    };

    // ── clarification ─────────────────────────────────────────────────
    if (output.clarification) {
      await this.conversations.appendMessage(conversation.id, 'ASSISTANT', output.reply);
      return {
        ...base,
        status: 'needs_clarification',
        reply: output.reply,
        intent: output.command?.intent ?? null,
        plan: null,
        clarification: { ...output.clarification, commandId: command.id },
        problem: null,
      };
    }

    // ── nothing recognised ────────────────────────────────────────────
    if (!output.command) {
      await this.conversations.appendMessage(conversation.id, 'ASSISTANT', output.reply);
      return {
        ...base,
        status: 'unsupported',
        reply: output.reply,
        intent: null,
        plan: null,
        clarification: null,
        problem: {
          code: 'NO_MATCHING_INTENT',
          detail: 'The request does not map to anything the assistant can do.',
        },
      };
    }

    // ── permission evaluation ─────────────────────────────────────────
    // Read from the policy table. The model has no say here.
    const policy = policyFor(output.command.intent);
    const denial = await this.evaluate(request.userId, output.command, policy);

    if (denial) {
      await this.conversations.appendMessage(conversation.id, 'ASSISTANT', denial.detail);
      return {
        ...base,
        status: denial.clarify ? 'needs_clarification' : 'unsupported',
        reply: denial.detail,
        intent: output.command.intent,
        plan: null,
        clarification: denial.clarify ? { ...denial.clarify, commandId: command.id } : null,
        problem: denial.clarify ? null : { code: denial.code, detail: denial.detail },
      };
    }

    // ── a conversational answer needs no action ───────────────────────
    if (output.command.intent === 'general_question' || !policy.actionKind) {
      await this.conversations.appendMessage(
        conversation.id,
        'ASSISTANT',
        output.reply,
        { tokensIn: interpretation.usage.inputTokens, tokensOut: interpretation.usage.outputTokens },
      );
      return {
        ...base,
        status: 'answered',
        reply: output.reply,
        intent: output.command.intent,
        plan: null,
        clarification: null,
        problem: null,
      };
    }

    // ── action routing ────────────────────────────────────────────────
    // The intent fixes the policy; the entities fix which executor the work
    // belongs to. A message to Telegram is not a WhatsApp action, and
    // recording it as one would send it to the wrong place later.
    const kind = resolveActionKind(output.command, policy);
    if (!kind) {
      const detail = unsupportedTargetMessage(output.command);
      await this.conversations.appendMessage(conversation.id, 'ASSISTANT', detail);
      return {
        ...base,
        status: 'unsupported',
        reply: detail,
        intent: output.command.intent,
        plan: null,
        clarification: null,
        problem: { code: 'UNSUPPORTED_TARGET', detail },
      };
    }

    const plan = await this.createPendingAction(request.userId, command.id, output.command, policy, kind);

    await this.conversations.appendMessage(conversation.id, 'ASSISTANT', output.reply);

    await this.audit.record({
      action: AuditAction.ASSISTANT_ACTION_PROPOSED,
      userId: request.userId,
      deviceId: request.deviceId,
      actorType: 'AI',
      resource: 'pending_action',
      resourceId: plan.pendingActionId,
      metadata: {
        intent: output.command.intent,
        requiresConfirmation: policy.requiresConfirmation,
        provider: interpretation.providerId,
      },
      ...request.meta,
    });

    return {
      ...base,
      // Either waiting on the user or waiting on the executor. Never "done":
      // nothing in this service has carried anything out.
      status: policy.requiresConfirmation ? 'awaiting_confirmation' : 'queued_for_execution',
      reply: output.reply,
      intent: output.command.intent,
      plan,
      clarification: null,
      problem: null,
    };
  }

  // ───────────────────────────────────────────────── permission evaluation

  /**
   * Decides whether a proposed command may proceed.
   *
   * Returns a denial, or a clarification when the right response is to ask
   * rather than refuse. Nothing here consults the model.
   */
  private async evaluate(
    userId: string,
    command: Command,
    policy: CapabilityPolicy,
  ): Promise<
    | null
    | {
        code: string;
        detail: string;
        clarify?: Omit<AssistantClarification, 'commandId'>;
      }
  > {
    // Required entities present?
    const missing = AiService.missingEntities(command, policy.requiredEntities);
    if (missing.length > 0) {
      return {
        code: 'MISSING_ENTITIES',
        detail: `I need a bit more to go on: ${missing.join(', ')}.`,
        clarify: {
          question: `What should I use for ${missing[0]}?`,
          reason: 'A required detail was not stated.',
          field: missing[0],
          options: [],
        },
      };
    }

    // Entities that must be resolved against something real.
    for (const field of policy.mustResolve) {
      const value = (command.entities as Record<string, unknown>)[field];

      if (field === 'recipient') {
        const recipient = typeof value === 'string' ? value.trim() : '';

        // An address needs no lookup: a phone number or an email address
        // already identifies exactly one destination. A bare name does not,
        // and no contact directory is connected, so it cannot be turned
        // into one — a guessed recipient sends a private message to a
        // stranger, which is worse than a question.
        if (addressesSomeoneExactly(recipient)) continue;

        return {
          code: 'UNRESOLVED_RECIPIENT',
          detail: 'I cannot tell who that is yet.',
          clarify: {
            question: recipient ? `Who is “${recipient}”?` : 'Who should this go to?',
            reason: 'No contact list is connected, so names cannot be looked up.',
            field: 'recipient',
            // Deliberately no "use it anyway" option: the point is to get an
            // address, and offering to proceed on a name defeats the check.
            options: [],
          },
        };
      }

      if (value === null || value === undefined) {
        return {
          code: 'UNRESOLVED_FIELD',
          detail: `I could not work out the ${field}.`,
          clarify: {
            question: `What ${field} should I use?`,
            reason: 'The value could not be determined confidently.',
            field,
            options: [],
          },
        };
      }
    }

    // A connected account that does not exist.
    if (policy.requiresConnection) {
      const connection = await this.prisma.connectedAccount.findFirst({
        where: {
          userId,
          provider: policy.requiresConnection,
          status: 'CONNECTED',
          revokedAt: null,
        },
        select: { id: true },
      });
      if (!connection) {
        return {
          code: 'ACCOUNT_NOT_CONNECTED',
          detail:
            `That needs a connected ${policy.requiresConnection.toLowerCase().replaceAll('_', ' ')} ` +
            'account, and none is linked yet.',
        };
      }
    }

    return null;
  }

  // ──────────────────────────────────────────────────────── action routing

  private async createPendingAction(
    userId: string,
    commandId: string,
    command: Command,
    policy: CapabilityPolicy,
    kind: ActionKind,
  ): Promise<AssistantPlan> {
    const fields = describeFields(command);
    const expiresAt = new Date(Date.now() + CONFIRMATION_TTL_MS);

    const pending = await this.prisma.pendingAction.create({
      data: {
        userId,
        commandId,
        kind,
        executionMode: policy.executionMode,
        plan: { intent: command.intent, entities: command.entities, fields } as object,
        // Server policy, not the model's opinion and not the client's.
        requiresConfirmation: policy.requiresConfirmation,
        status: PendingActionStatus.PENDING,
        expiresAt,
      },
      select: { id: true },
    });

    return {
      pendingActionId: pending.id,
      kind,
      intent: command.intent,
      executionMode: policy.executionMode,
      requiresConfirmation: policy.requiresConfirmation,
      fields,
      expiresAt: expiresAt.toISOString(),
    };
  }

  // ──────────────────────────────────────────────────────────── failures

  private async failTurn(
    conversationId: string,
    _messageId: string,
    request: TurnRequest,
    transcript: string,
    error: unknown,
  ): Promise<AssistantTurn> {
    const llm = error instanceof LlmError ? error : null;
    const code = llm?.code ?? 'unknown';

    // Logged without the transcript: it is the user's words.
    this.logger.warn(`Interpretation failed (${code}) for user ${request.userId}`);

    const detail =
      code === 'timeout'
        ? 'The assistant took too long to respond. Try again.'
        : code === 'invalid_output'
          ? 'The assistant could not produce a usable answer. Try rephrasing.'
          : code === 'rate_limited'
            ? 'The assistant is busy right now. Try again shortly.'
            : code === 'auth'
              ? 'The assistant is not configured correctly. Nothing was sent.'
              : 'The assistant could not process that. Try again.';

    await this.audit.record({
      action: AuditAction.ASSISTANT_TURN_FAILED,
      userId: request.userId,
      deviceId: request.deviceId,
      actorType: 'SYSTEM',
      metadata: { code },
      ...request.meta,
    });

    return {
      conversationId,
      commandId: '',
      status: 'failed',
      reply: detail,
      intent: null,
      confidence: 0,
      plan: null,
      clarification: null,
      problem: { code: code.toUpperCase(), detail },
      transcript,
      detectedLanguage: null,
      provider: { id: 'none', model: 'none', isMock: false },
    };
  }

  /**
   * Loads the request a clarification answer belongs to.
   *
   * Scoped to the user, so a command id belonging to someone else resolves
   * to nothing rather than leaking another account's words into this
   * conversation's prompt. An unknown id is treated the same way: the turn
   * proceeds without the extra context instead of failing.
   */
  private async resolveResumption(userId: string, commandId?: string) {
    if (!commandId) return null;

    const prior = await this.prisma.assistantCommand.findFirst({
      where: { userId, id: commandId },
      select: { rawText: true, intent: true },
    });
    if (!prior) return null;

    const policy = prior.intent ? CAPABILITIES[prior.intent as Intent] : undefined;
    return {
      request: prior.rawText,
      field: policy?.mustResolve[0] ?? policy?.requiredEntities[0] ?? null,
    };
  }

  private async resolveConversation(userId: string, conversationId?: string) {
    if (conversationId) return this.conversations.requireOwned(userId, conversationId);
    return this.conversations.create(userId);
  }

  // ─────────────────────────────────────────────────────── confirmation

  /**
   * Records the user's decision on a proposed action.
   *
   * Approval marks it ready for the executor; it does not run anything,
   * and the response says so. Chunk 6 attaches the worker that acts on
   * `APPROVED` rows.
   */
  async decide(
    userId: string,
    pendingActionId: string,
    approve: boolean,
    meta: { ipAddress?: string; userAgent?: string },
  ) {
    const pending = await this.prisma.pendingAction.findFirst({
      where: { id: pendingActionId, userId },
      select: { id: true, status: true, expiresAt: true, kind: true, executionMode: true },
    });
    // Another user's id reads as missing, like everywhere else.
    if (!pending) throw AppError.notFound('Action');

    if (pending.status !== PendingActionStatus.PENDING) {
      throw AppError.conflict('That action has already been decided.');
    }
    if (pending.expiresAt <= new Date()) {
      await this.prisma.pendingAction.update({
        where: { id: pending.id },
        data: { status: PendingActionStatus.EXPIRED, decidedAt: new Date() },
      });
      throw AppError.conflict('That request expired. Nothing was carried out.');
    }

    const status = approve ? PendingActionStatus.APPROVED : PendingActionStatus.REJECTED;
    await this.prisma.pendingAction.update({
      where: { id: pending.id },
      data: { status, decidedAt: new Date() },
    });

    await this.audit.record({
      action: approve ? AuditAction.ASSISTANT_ACTION_APPROVED : AuditAction.ASSISTANT_ACTION_REJECTED,
      userId,
      resource: 'pending_action',
      resourceId: pending.id,
      metadata: { kind: pending.kind },
      ...meta,
    });

    return {
      pendingActionId: pending.id,
      status: approve ? ('queued_for_execution' as const) : ('rejected' as const),
      // Said plainly rather than implied: approval is not completion.
      note: approve
        ? 'Approved and queued. Nothing has run yet — execution is not connected in this build.'
        : 'Rejected. Nothing was carried out.',
    };
  }
}

/**
 * Whether a recipient value names exactly one destination.
 *
 * Only an address counts: a phone number in international or local form, or
 * an email address. A name, a nickname or a description does not, however
 * confident the model was about it.
 */
function addressesSomeoneExactly(recipient: string): boolean {
  if (!recipient) return false;

  const digits = recipient.replace(/[\s()-]/g, '');
  // 7 to 15 digits covers national and E.164 forms; shorter is not a number
  // anyone can be reached on.
  if (/^\+?\d{7,15}$/.test(digits)) return true;

  // Deliberately strict: one @, no whitespace, a dotted domain.
  return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(recipient);
}

/**
 * Which executor a command belongs to.
 *
 * For most intents this is the policy's own answer. For messaging it depends
 * on the platform the user named, and a platform with no executor returns
 * null rather than being quietly filed under a different one — nothing here
 * may create an action a worker would carry out somewhere unintended.
 */
function resolveActionKind(command: Command, policy: CapabilityPolicy): ActionKind | null {
  if (command.intent !== 'send_message' && command.intent !== 'prepare_message') {
    return policy.actionKind;
  }

  switch (command.entities.platform) {
    case 'whatsapp':
      return ActionKindEnum.MESSAGE_WHATSAPP;
    case 'telegram':
      return ActionKindEnum.MESSAGE_TELEGRAM;
    case 'email':
      return ActionKindEnum.EMAIL_COMPOSE;
    // Instagram and Facebook have no hand-off route, so there is nothing
    // honest to prepare. Chunk 8 adds them with real connections.
    default:
      return null;
  }
}

function unsupportedTargetMessage(command: Command): string {
  if (command.intent === 'send_message' || command.intent === 'prepare_message') {
    return `I cannot prepare messages for ${command.entities.platform} yet.`;
  }
  return 'I understood that, but I cannot carry it out yet.';
}

/**
 * Turns entities into the labelled fields a confirmation card shows.
 *
 * The user has to be able to see exactly what will happen before approving,
 * so this is explicit per intent rather than a generic dump of the object.
 */
function describeFields(command: Command): PlanField[] {
  switch (command.intent) {
    case 'save_note':
      return [{ key: 'text', label: 'Note', value: command.entities.text, editable: true, multiline: true }];
    case 'create_reminder':
      return [
        { key: 'text', label: 'Remind me to', value: command.entities.text, editable: true },
        { key: 'dueAt', label: 'When', value: command.entities.dueAt ?? '', editable: true },
      ];
    case 'send_message':
    case 'prepare_message':
      return [
        { key: 'platform', label: 'App', value: command.entities.platform, editable: false },
        { key: 'recipient', label: 'To', value: command.entities.recipient ?? '', editable: true },
        { key: 'message', label: 'Message', value: command.entities.message, editable: true, multiline: true },
      ];
    case 'open_application':
      return [{ key: 'application', label: 'Application', value: command.entities.application, editable: false }];
    case 'get_calendar_events':
      return [
        { key: 'from', label: 'From', value: command.entities.from ?? '', editable: false },
        { key: 'to', label: 'To', value: command.entities.to ?? '', editable: false },
      ];
    default:
      return [];
  }
}
