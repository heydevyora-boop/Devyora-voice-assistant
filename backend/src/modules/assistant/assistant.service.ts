import { Injectable, Logger } from '@nestjs/common';
import { ActionKind as ActionKindEnum, PendingActionStatus, type ActionKind, type ExecutionMode } from '@prisma/client';
import { AppError } from '../../common/errors/app-error';
import { PrismaService } from '../../database/prisma.service';
import { AuditAction, AuditService } from '../../security/services/audit.service';
import { LlmError } from '../../providers/llm/errors';
import { AiService } from '../ai/ai.service';
import { CAPABILITIES, policyFor, type CapabilityPolicy } from '../ai/capability-registry';
import { toActionParams } from '../ai/action-mapping';
import { ActionRegistry } from '../actions/registry/action.registry';
import { ActionExecutorService, type ExecutionReport } from '../actions/action-executor.service';
import {
  CLAIMABLE_STATES,
  describeBlockedStatus,
  isPendingTerminal,
} from '../actions/pending-action.state';
import type { AnyActionDefinition } from '../actions/registry/types';
import type { Command, Intent } from '../ai/schemas/command.schema';
import { ConversationsService } from '../conversations/conversations.service';
import { AppConfigService } from '../../config/app-config.module';

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
  /**
   * Carried out, and the effect was read back. The only status that means
   * something actually happened — a handler earns it by verifying its own
   * result, not by returning without throwing.
   */
  | 'executed'
  /**
   * Prepared for the user to finish elsewhere: a message draft, an
   * application to open. Deliberately not `executed`, because the task is
   * not done and the person still has a step to take.
   */
  | 'handed_off'
  /**
   * It may have taken effect and we cannot confirm it. Reported as its own
   * status rather than collapsed into success or failure, because guessing
   * either way would be a lie in one direction or the other.
   */
  | 'unverified'
  /** Attempted and did not take effect. */
  | 'action_failed'
  /**
   * Approved and waiting for a worker. Reserved: every action in the
   * registry today runs inline, and deferred execution arrives with the job
   * queue.
   */
  | 'queued_for_execution'
  /** Understood, but the assistant cannot carry it out. */
  | 'unsupported'
  /** Answered in conversation; nothing to carry out. */
  | 'answered'
  /** Interpretation failed. Nothing was attempted. */
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
  /**
   * What the executor did, when an action ran without needing confirmation.
   * Null while a plan is awaiting approval — nothing has been attempted.
   */
  readonly execution: ExecutionReport | null;
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
  /** The authenticated session, recorded on anything it proposes. */
  readonly sessionId?: string | null;
  /** The voice session, when the request came by speech. */
  readonly voiceSessionId?: string | null;
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
    private readonly registry: ActionRegistry,
    private readonly executor: ActionExecutorService,
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
        execution: null,
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
        execution: null,
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
        execution: null,
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
        execution: null,
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
        execution: null,
      };
    }

    // The registry entry, resolved from the capability table's action id.
    // An intent that named something outside the registry would have failed
    // at module load, so reaching here with no action is a bug, not input.
    const action = policy.actionId ? this.registry.find(policy.actionId) : undefined;
    if (!action) {
      const detail = 'I understood that, but I cannot carry it out yet.';
      await this.conversations.appendMessage(conversation.id, 'ASSISTANT', detail);
      return {
        ...base,
        status: 'unsupported',
        reply: detail,
        intent: output.command.intent,
        plan: null,
        clarification: null,
        problem: { code: 'ACTION_NOT_REGISTERED', detail },
        execution: null,
      };
    }

    // Parameters are built by a named mapping, then held to the action's own
    // input schema *before* a plan is shown. A proposal the executor would
    // reject is not a proposal worth confirming.
    const params = toActionParams(output.command, { timezone: user.timezone });
    const validated = action.inputSchema.safeParse(params);
    if (!validated.success) {
      const detail = 'I could not work out the details for that.';
      await this.conversations.appendMessage(conversation.id, 'ASSISTANT', detail);
      return {
        ...base,
        status: 'unsupported',
        reply: detail,
        intent: output.command.intent,
        plan: null,
        clarification: null,
        problem: { code: 'ACTION_PARAMS_INVALID', detail },
        execution: null,
      };
    }

    const plan = await this.createPendingAction(request, command.id, action, validated.data, kind);

    if (plan.requiresConfirmation) {
      await this.conversations.appendMessage(conversation.id, 'ASSISTANT', output.reply);
    }

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

    // ── confirmation or execution ─────────────────────────────────────
    if (plan.requiresConfirmation) {
      // Nothing has been attempted. The plan waits for the user, and the
      // executor will refuse it until they answer.
      return {
        ...base,
        status: 'awaiting_confirmation',
        reply: output.reply,
        intent: output.command.intent,
        plan,
        clarification: null,
        problem: null,
        execution: null,
      };
    }

    // Private, local, reversible work. Run it now and report what actually
    // happened — the executor re-checks authorization, claims the action
    // atomically and holds the handler's result to its schema.
    const execution = await this.runNow(request, plan.pendingActionId);

    const reply = execution.detail || output.reply;
    await this.conversations.appendMessage(conversation.id, 'ASSISTANT', reply);

    return {
      ...base,
      status: statusForExecution(execution),
      // The executor's own words. The model's suggested reply is a fallback
      // only: it was written before anything ran and cannot know the
      // outcome, so it must not be allowed to describe one.
      reply,
      intent: output.command.intent,
      plan,
      clarification: null,
      problem:
        execution.status === 'FAILED'
          ? { code: execution.failureCode?.toUpperCase() ?? 'ACTION_FAILED', detail: execution.detail }
          : null,
      execution,
    };
  }

  /**
   * Runs an action that needs no confirmation.
   *
   * Errors are caught and turned into a failed report rather than thrown: a
   * turn that got as far as proposing an action should tell the user what
   * happened to it, not disappear into a 500.
   */
  private async runNow(request: TurnRequest, pendingActionId: string): Promise<ExecutionReport> {
    try {
      return await this.executor.execute({
        userId: request.userId,
        deviceId: request.deviceId,
        sessionId: request.sessionId ?? null,
        pendingActionId,
        meta: request.meta,
      });
    } catch (error) {
      const detail =
        error instanceof AppError ? error.message : 'That could not be carried out.';
      this.logger.warn(`Inline execution of ${pendingActionId} failed: ${detail}`);

      return {
        executionId: '',
        pendingActionId,
        actionId: '',
        status: 'FAILED',
        detail,
        verified: false,
        failureCode: 'execution_refused',
        resultRef: null,
        result: null,
        duplicate: false,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      };
    }
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

  /**
   * Writes the proposal.
   *
   * The preview is rendered by the action's own `preview()` from the same
   * validated parameters that will be passed to its handler. That is the
   * guarantee the confirmation system rests on: what the user approves and
   * what runs cannot drift apart, because they are the same object.
   */
  private async createPendingAction(
    request: TurnRequest,
    commandId: string,
    action: AnyActionDefinition,
    params: unknown,
    kind: ActionKind,
  ): Promise<AssistantPlan> {
    const fields = action.preview(params as never);
    const requiresConfirmation = action.confirmationPolicy === 'always';
    const expiresAt = new Date(Date.now() + this.config.providers.actions.confirmationTtlMs);

    const pending = await this.prisma.pendingAction.create({
      data: {
        userId: request.userId,
        // Not optional. A confirmation belongs to the device that raised it,
        // and the executor refuses another device even on the same account.
        deviceId: request.deviceId,
        sessionId: request.sessionId ?? null,
        voiceSessionId: request.voiceSessionId ?? null,
        commandId,
        actionId: action.id,
        kind,
        executionMode: action.executionMode,
        plan: { intent: action.id, fields } as object,
        params: params as object,
        // Server policy, read from the registry. Not the model's opinion and
        // not the client's.
        requiresConfirmation,
        status: PendingActionStatus.PENDING,
        expiresAt,
      },
      select: { id: true, plan: true },
    });

    return {
      pendingActionId: pending.id,
      kind,
      intent: (await this.prisma.assistantCommand.findUniqueOrThrow({
        where: { id: commandId },
        select: { intent: true },
      })).intent as Intent,
      executionMode: action.executionMode,
      requiresConfirmation,
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
      execution: null,
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
  /**
   * Records the user's decision, and on approval carries the action out.
   *
   * The sequence the confirmation contract specifies, in order:
   *
   * 1. the caller is authenticated (the global guard, before this runs);
   * 2. ownership is validated — user **and** device;
   * 3. expiry is checked;
   * 4. an already-settled attempt short-circuits rather than repeating;
   * 5. authorization is re-checked, inside the executor, at execution time;
   * 6. the action runs;
   * 7. the result is stored and returned.
   *
   * Steps 4–7 are the executor's, not duplicated here. Rejection is
   * terminal: `REJECTED` has no outgoing edge in the state table, so
   * nothing — a retry, a reconnect, a sweep — can carry it out later.
   */
  async decide(
    userId: string,
    pendingActionId: string,
    approve: boolean,
    meta: { ipAddress?: string; userAgent?: string; deviceId?: string },
  ) {
    const pending = await this.prisma.pendingAction.findFirst({
      where: {
        id: pendingActionId,
        userId,
        // One device may not decide another device's action, even on the
        // same account. Omitting the device would make the confirmation
        // belong to the account rather than to the screen it appeared on.
        ...(meta.deviceId ? { deviceId: meta.deviceId } : {}),
      },
      select: {
        id: true,
        status: true,
        expiresAt: true,
        kind: true,
        actionId: true,
        deviceId: true,
        sessionId: true,
      },
    });
    // Another user's — or another device's — id reads as missing.
    if (!pending) throw AppError.notFound('Action');

    if (pending.status !== PendingActionStatus.PENDING) {
      throw AppError.conflict(describeBlockedStatus(pending.status));
    }
    if (pending.expiresAt <= new Date()) {
      await this.prisma.pendingAction.update({
        where: { id: pending.id },
        data: { status: PendingActionStatus.EXPIRED, decidedAt: new Date() },
      });
      throw AppError.conflict('That request expired. Nothing was carried out.');
    }

    if (!approve) {
      await this.prisma.pendingAction.update({
        where: { id: pending.id },
        data: { status: PendingActionStatus.REJECTED, decidedAt: new Date() },
      });
      await this.audit.record({
        action: AuditAction.ASSISTANT_ACTION_REJECTED,
        userId,
        deviceId: pending.deviceId,
        resource: 'pending_action',
        resourceId: pending.id,
        metadata: { kind: pending.kind, actionId: pending.actionId },
        ...meta,
      });

      return {
        pendingActionId: pending.id,
        status: 'rejected' as const,
        execution: null,
        note: 'Rejected. Nothing was carried out, and it cannot be carried out later.',
      };
    }

    // The approval is recorded before the attempt, so a crash between the
    // two leaves a record that the user said yes — rather than losing their
    // decision and asking again.
    await this.prisma.pendingAction.update({
      where: { id: pending.id },
      data: { status: PendingActionStatus.APPROVED, decidedAt: new Date() },
    });
    await this.audit.record({
      action: AuditAction.ASSISTANT_ACTION_APPROVED,
      userId,
      deviceId: pending.deviceId,
      resource: 'pending_action',
      resourceId: pending.id,
      metadata: { kind: pending.kind, actionId: pending.actionId },
      ...meta,
    });

    const execution = await this.executor.execute({
      userId,
      deviceId: pending.deviceId,
      sessionId: pending.sessionId,
      pendingActionId: pending.id,
      meta,
    });

    return {
      pendingActionId: pending.id,
      status: statusForExecution(execution),
      execution,
      // The executor's own words, which describe what happened rather than
      // what was intended.
      note: execution.detail,
    };
  }

  /**
   * Cancels a proposal without running it.
   *
   * Separate from rejecting: rejection is the user answering the question,
   * cancellation is the user withdrawing it. Both are terminal and both
   * permanently bar execution, but a reader of the audit log should be able
   * to tell them apart.
   */
  async cancel(
    userId: string,
    pendingActionId: string,
    meta: { ipAddress?: string; userAgent?: string; deviceId?: string },
  ) {
    const pending = await this.prisma.pendingAction.findFirst({
      where: {
        id: pendingActionId,
        userId,
        ...(meta.deviceId ? { deviceId: meta.deviceId } : {}),
      },
      select: { id: true, status: true, kind: true, actionId: true, deviceId: true },
    });
    if (!pending) throw AppError.notFound('Action');

    if (isPendingTerminal(pending.status)) {
      // Idempotent: cancelling something already finished is a no-op that
      // says so, not a conflict.
      return {
        pendingActionId: pending.id,
        status: 'cancelled' as const,
        alreadyEnded: true,
        note: describeBlockedStatus(pending.status),
      };
    }

    await this.prisma.pendingAction.updateMany({
      where: { id: pending.id, status: { in: [...CLAIMABLE_STATES] } },
      data: { status: PendingActionStatus.CANCELLED, decidedAt: new Date() },
    });

    await this.audit.record({
      action: AuditAction.ACTION_CANCELLED,
      userId,
      deviceId: pending.deviceId,
      resource: 'pending_action',
      resourceId: pending.id,
      metadata: { kind: pending.kind, actionId: pending.actionId },
      ...meta,
    });

    return {
      pendingActionId: pending.id,
      status: 'cancelled' as const,
      alreadyEnded: false,
      note: 'Cancelled. It will not be carried out.',
    };
  }

}

/**
 * An execution report, as a turn status.
 *
 * Exhaustive over `ExecutionStatus`, so a status added to the database enum
 * will not compile until it has been given a meaning here. There is no
 * default branch for the same reason.
 */
export function statusForExecution(report: ExecutionReport): TurnStatus {
  switch (report.status) {
    case 'COMPLETED':
      return 'executed';
    case 'HANDOFF':
      return 'handed_off';
    case 'PARTIAL':
    case 'UNVERIFIED':
      return 'unverified';
    case 'FAILED':
      return 'action_failed';
    case 'RUNNING':
      // Still in flight. Only reachable if a report is read mid-attempt.
      return 'queued_for_execution';
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

