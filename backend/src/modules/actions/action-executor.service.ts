import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  ExecutionStatus,
  PendingActionStatus as S,
  Prisma,
  type PendingAction,
} from '@prisma/client';
import { AppError } from '../../common/errors/app-error';
import { AppConfigService } from '../../config/app-config.module';
import { PrismaService } from '../../database/prisma.service';
import { AuditAction, AuditService } from '../../security/services/audit.service';
import { ActionRegistry } from './registry/action.registry';
import { PermissionsService, type Denial } from './permissions.service';
import {
  CLAIMABLE_STATES,
  describeBlockedStatus,
  isExecutionBarred,
} from './pending-action.state';
import type { ActionOutcome, AnyActionDefinition } from './registry/types';

export interface ExecuteRequest {
  readonly userId: string;
  readonly deviceId: string;
  readonly sessionId?: string | null;
  readonly pendingActionId: string;
  /** Supplied by the client so a replayed request is recognised as one. */
  readonly clientIdempotencyKey?: string | null;
  readonly meta?: { ipAddress?: string; userAgent?: string };
}

export interface ExecutionReport {
  readonly executionId: string;
  readonly pendingActionId: string;
  readonly actionId: string;
  readonly status: ExecutionStatus;
  readonly detail: string;
  /** True only when the effect was read back after the fact. */
  readonly verified: boolean;
  readonly failureCode: string | null;
  readonly resultRef: string | null;
  /** Validated against the action's result schema. Null when nothing ran. */
  readonly result: unknown;
  /** True when this report describes an attempt that had already happened. */
  readonly duplicate: boolean;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

/**
 * The execution engine.
 *
 * ```
 * REQUEST → VALIDATION → AUTHORIZATION → CONFIRMATION CHECK
 *         → CLAIM (or refuse) → EXECUTION → RESULT VERIFICATION → RESPONSE
 * ```
 *
 * Four properties this service exists to guarantee.
 *
 * **Only registered actions run.** The pending action names an id; the id is
 * looked up in the registry; the registry hands back a definition with a
 * direct function reference. There is no other path to a handler, and an
 * unrecognised id fails rather than falling through.
 *
 * **Authorization is re-checked at execution time, not at proposal time.**
 * Minutes can pass between a plan being shown and a user approving it, and a
 * device revoked in that window must not still be able to act.
 *
 * **A duplicate cannot execute.** The claim is a conditional update and the
 * execution record carries a unique key, both inside one transaction. The
 * second caller loses the race at the database, not in application logic.
 *
 * **Success is never assumed.** The handler's own status is recorded
 * unchanged. A handler that could not read back its effect reports
 * `UNVERIFIED`, and that is what the user is told.
 */
@Injectable()
export class ActionExecutorService {
  private readonly logger = new Logger(ActionExecutorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ActionRegistry,
    private readonly permissions: PermissionsService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
  ) {}

  // ─────────────────────────────────────────────────────────── the lifecycle

  async execute(request: ExecuteRequest): Promise<ExecutionReport> {
    // ── 1. REQUEST ─────────────────────────────────────────────────────
    // Scoped to the user *and* the device. One device may not act on
    // another device's pending action, even on the same account.
    const pending = await this.prisma.pendingAction.findFirst({
      where: {
        id: request.pendingActionId,
        userId: request.userId,
        deviceId: request.deviceId,
      },
    });
    // Another user's — or another device's — reads as missing.
    if (!pending) throw AppError.notFound('Action');

    // ── 2. VALIDATION ──────────────────────────────────────────────────
    const action = this.registry.find(pending.actionId);
    if (!action) {
      // A stored id that is no longer in the registry. Refused rather than
      // guessed at: whatever used to run under that name is not running now.
      await this.failPending(pending, 'action_not_registered');
      throw AppError.validation('That action is no longer available.');
    }

    const parsed = action.inputSchema.safeParse(pending.params);
    if (!parsed.success) {
      // Parameters that no longer satisfy the schema. The row is stale or
      // the schema has tightened; either way nothing runs on bad input.
      await this.failPending(pending, 'params_invalid');
      throw AppError.validation('The saved details for that action are no longer valid.');
    }
    const input = parsed.data;

    const missing = action.requiredParams.filter((key) => {
      const value = (pending.params as Record<string, unknown> | null)?.[key];
      return value === undefined || value === null || value === '';
    });
    if (missing.length > 0) {
      await this.failPending(pending, 'params_missing');
      throw AppError.validation(`That action still needs: ${missing.join(', ')}.`);
    }

    // ── 3. CONFIRMATION CHECK ──────────────────────────────────────────
    // Before authorization, because it is the cheaper check and because a
    // rejected or expired action must be refused even if the account has
    // since lost permission — the user's answer is the more important fact.
    if (isExecutionBarred(pending.status)) {
      throw AppError.conflict(describeBlockedStatus(pending.status));
    }

    if (pending.expiresAt <= new Date() && !isPendingClaimed(pending.status)) {
      await this.expire(pending);
      throw AppError.conflict('That request expired. Nothing was carried out.');
    }

    // An attempt already settled? Hand back what happened rather than
    // repeating it. This is the reconnect case: the client never saw the
    // first response, and asking again must not mean doing it again.
    //
    // Checked before the confirmation rule, because an action that has
    // already run was confirmed on its way there. Asking "has this been
    // confirmed?" of a finished action would answer no — its status is
    // EXECUTED, not APPROVED — and refuse a caller who is only asking what
    // happened.
    const existing = await this.findSettledAttempt(pending.id);
    if (existing) return { ...existing, duplicate: true };

    if (!CLAIMABLE_STATES.includes(pending.status)) {
      throw AppError.conflict(describeBlockedStatus(pending.status));
    }

    // Server policy, read from the registry. Not from the row, which a
    // migration could have written, and certainly not from the client.
    //
    // Only `PENDING` can be unconfirmed: the state table has no edge from
    // anywhere else into it, so a claimable action that is not PENDING is
    // APPROVED and has been through confirmation.
    if (action.confirmationPolicy === 'always' && pending.status === S.PENDING) {
      throw AppError.conflict('That action needs to be confirmed first.');
    }

    // ── 4. AUTHORIZATION ───────────────────────────────────────────────
    // Re-checked here, at execution time. The plan may have been shown
    // minutes ago.
    const denial = await this.permissions.authorise(
      { userId: request.userId, deviceId: request.deviceId },
      action,
    );
    if (denial) {
      await this.failPending(pending, denial.code);
      await this.recordDenial(request, pending, action, denial);
      throw denialToError(denial);
    }

    // ── 5. CLAIM ───────────────────────────────────────────────────────
    const claim = await this.claim(pending, action, request);
    if (claim.kind === 'duplicate') {
      return { ...claim.report, duplicate: true };
    }
    if (claim.kind === 'lost') {
      // Another attempt got there first. Not an error for the caller: the
      // action is being, or has been, carried out.
      throw AppError.conflict('That action is already being carried out.');
    }

    const { executionId } = claim;

    // ── 6. EXECUTION ───────────────────────────────────────────────────
    // Outside the transaction: a handler may be slow or talk to a provider,
    // and holding a row lock while it does would block everything else.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.providers.actions.timeoutMs);

    let outcome: ActionOutcome;
    try {
      outcome = await action.handler(input, {
        userId: request.userId,
        deviceId: request.deviceId,
        sessionId: request.sessionId ?? null,
        pendingActionId: pending.id,
        signal: controller.signal,
        // Dependencies are handed to the handler rather than captured in a
        // closure, which is what lets every definition be static data the
        // capability table can read without constructing anything.
        deps: { prisma: this.prisma },
      });
    } catch (error) {
      clearTimeout(timer);
      return this.settleFailure(pending, action, executionId, error, controller.signal.aborted);
    }
    clearTimeout(timer);

    // ── 7. RESULT VERIFICATION ─────────────────────────────────────────
    // The handler's own shape is held to the action's result schema. A
    // handler that returns something else is a bug in this repository, and
    // the honest report is that the outcome could not be verified — not a
    // success with a malformed body.
    const validated = action.resultSchema.safeParse(outcome.result);
    if (!validated.success) {
      this.logger.error(
        `Action ${action.id} returned a result that does not match its schema; ` +
          'reporting the outcome as unverified.',
      );
      return this.settle(pending, action, executionId, {
        ...outcome,
        status: ExecutionStatus.UNVERIFIED,
        verified: false,
        failureCode: 'result_schema_mismatch',
        detail: 'The action ran but its result could not be checked.',
        result: null,
      });
    }

    // ── 8. RESPONSE ────────────────────────────────────────────────────
    return this.settle(pending, action, executionId, {
      ...outcome,
      result: validated.data,
      // A handler cannot promote itself: `verified` is only true when the
      // handler both says so and reports a terminal success.
      verified: outcome.verified && outcome.status === ExecutionStatus.COMPLETED,
    });
  }

  // ───────────────────────────────────────────────────────────── claiming

  /**
   * Takes ownership of an attempt, atomically.
   *
   * Two guards in one transaction, and both are database constraints rather
   * than application checks:
   *
   * 1. The pending action moves to `EXECUTING` only *from* a claimable
   *    state. A second caller's conditional update matches zero rows.
   * 2. The execution row carries a unique idempotency key. A second insert
   *    with the same key fails outright.
   *
   * Either loser is handed the existing attempt rather than running.
   */
  private async claim(
    pending: PendingAction,
    action: AnyActionDefinition,
    request: ExecuteRequest,
  ): Promise<
    | { kind: 'claimed'; executionId: string; attempt: number }
    | { kind: 'duplicate'; report: ExecutionReport }
    | { kind: 'lost' }
  > {
    const digest = digestOf(pending.params);
    const key = this.idempotencyKeyFor(action, pending, digest, request.clientIdempotencyKey);

    try {
      return await this.prisma.transaction(async (tx) => {
        const moved = await tx.pendingAction.updateMany({
          where: { id: pending.id, status: { in: [...CLAIMABLE_STATES] } },
          data: { status: S.EXECUTING, startedAt: new Date() },
        });
        if (moved.count === 0) return { kind: 'lost' as const };

        const attempt =
          (await tx.actionExecution.count({ where: { pendingActionId: pending.id } })) + 1;

        const execution = await tx.actionExecution.create({
          data: {
            pendingActionId: pending.id,
            attempt,
            userId: pending.userId,
            deviceId: pending.deviceId,
            sessionId: request.sessionId ?? pending.sessionId,
            actionId: action.id,
            idempotencyKey: key,
            paramsDigest: digest,
            // RUNNING, written before the handler runs. A crash leaves this
            // visible rather than leaving no trace of an attempt that may
            // have had an effect.
            status: ExecutionStatus.RUNNING,
            detail: 'Started.',
          },
          select: { id: true },
        });

        return { kind: 'claimed' as const, executionId: execution.id, attempt };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // The key already exists: this exact action has been attempted.
        const report = await this.reportForKey(key);
        if (report) return { kind: 'duplicate', report };
        return { kind: 'lost' };
      }
      throw error;
    }
  }

  /**
   * The key that makes a duplicate impossible.
   *
   * `pending-action` is the default and the strict one: one confirmation
   * means one execution, whatever happens to the connection in between. A
   * client key is incorporated where the action permits legitimate repeats,
   * so a client can retry deliberately and distinguishably.
   */
  private idempotencyKeyFor(
    action: AnyActionDefinition,
    pending: PendingAction,
    digest: string,
    clientKey: string | null | undefined,
  ): string {
    if (action.idempotency === 'pending-action') {
      // Deliberately ignores the client key. For a message or a note
      // created from one confirmation, "the client asked twice" is not a
      // reason to do it twice.
      return `${action.id}:${pending.id}`;
    }

    const suffix = clientKey?.trim() ? `c:${clientKey.trim().slice(0, 80)}` : `p:${digest.slice(0, 32)}`;
    return `${action.id}:${pending.id}:${suffix}`;
  }

  // ───────────────────────────────────────────────────────────── settling

  private async settle(
    pending: PendingAction,
    action: AnyActionDefinition,
    executionId: string,
    outcome: ActionOutcome,
  ): Promise<ExecutionReport> {
    const finishedAt = new Date();
    const succeeded = outcome.status !== ExecutionStatus.FAILED;

    const execution = await this.prisma.transaction(async (tx) => {
      const row = await tx.actionExecution.update({
        where: { id: executionId },
        data: {
          status: outcome.status,
          detail: outcome.detail,
          verified: outcome.verified,
          failureCode: outcome.failureCode ?? null,
          resultRef: outcome.resultRef ?? null,
          providerRef: outcome.providerRef ?? null,
          finishedAt,
        },
        select: { id: true, startedAt: true, finishedAt: true, attempt: true },
      });

      await tx.pendingAction.updateMany({
        where: { id: pending.id, status: S.EXECUTING },
        data: { status: succeeded ? S.EXECUTED : S.FAILED, finishedAt },
      });

      return row;
    });

    await this.audit.record({
      action: succeeded ? AuditAction.ACTION_EXECUTED : AuditAction.ACTION_FAILED,
      userId: pending.userId,
      deviceId: pending.deviceId,
      actorType: 'USER',
      resource: 'action_execution',
      resourceId: execution.id,
      metadata: {
        actionId: action.id,
        status: outcome.status,
        verified: outcome.verified,
        failureCode: outcome.failureCode ?? null,
        attempt: execution.attempt,
      },
    });

    return {
      executionId: execution.id,
      pendingActionId: pending.id,
      actionId: action.id,
      status: outcome.status,
      detail: outcome.detail,
      verified: outcome.verified,
      failureCode: outcome.failureCode ?? null,
      resultRef: outcome.resultRef ?? null,
      result: outcome.result,
      duplicate: false,
      startedAt: execution.startedAt.toISOString(),
      finishedAt: execution.finishedAt?.toISOString() ?? null,
    };
  }

  /**
   * Records a handler that threw.
   *
   * A thrown error tells us the handler did not complete. It does **not**
   * tell us whether it had an effect first — a provider call that timed out
   * may well have been received. So a timeout is reported as `UNVERIFIED`,
   * not `FAILED`, and the user is told we cannot confirm it either way.
   * Calling that a failure would be the more comfortable lie.
   */
  private async settleFailure(
    pending: PendingAction,
    action: AnyActionDefinition,
    executionId: string,
    error: unknown,
    aborted: boolean,
  ): Promise<ExecutionReport> {
    const timedOut = aborted || isAbortError(error);

    this.logger.warn(
      `Action ${action.id} ${timedOut ? 'timed out' : 'threw'} for pending action ${pending.id}`,
    );

    return this.settle(pending, action, executionId, {
      status: timedOut ? ExecutionStatus.UNVERIFIED : ExecutionStatus.FAILED,
      detail: timedOut
        ? 'That took too long and I cannot confirm whether it went through.'
        : 'That could not be carried out.',
      verified: false,
      failureCode: timedOut ? 'attempt_timeout' : 'handler_error',
      result: null,
    });
  }

  // ───────────────────────────────────────────────────── duplicate lookup

  /** A settled attempt for this pending action, if one exists. */
  private async findSettledAttempt(pendingActionId: string): Promise<ExecutionReport | null> {
    const row = await this.prisma.actionExecution.findFirst({
      where: { pendingActionId, status: { not: ExecutionStatus.RUNNING } },
      orderBy: { attempt: 'desc' },
    });
    return row ? this.toReport(row) : null;
  }

  private async reportForKey(idempotencyKey: string): Promise<ExecutionReport | null> {
    const row = await this.prisma.actionExecution.findUnique({ where: { idempotencyKey } });
    return row ? this.toReport(row) : null;
  }

  private toReport(row: {
    id: string;
    pendingActionId: string;
    actionId: string;
    status: ExecutionStatus;
    detail: string;
    verified: boolean;
    failureCode: string | null;
    resultRef: string | null;
    startedAt: Date;
    finishedAt: Date | null;
  }): ExecutionReport {
    return {
      executionId: row.id,
      pendingActionId: row.pendingActionId,
      actionId: row.actionId,
      status: row.status,
      detail: row.detail,
      verified: row.verified,
      failureCode: row.failureCode,
      resultRef: row.resultRef,
      // Not replayed. The result of the original attempt is not stored —
      // deliberately, since it can contain the user's own content — so a
      // duplicate reports the outcome and the caller re-reads the resource
      // by `resultRef` if it needs the data.
      result: null,
      duplicate: false,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
    };
  }

  // ──────────────────────────────────────────────────────── state changes

  private async failPending(pending: PendingAction, failureCode: string): Promise<void> {
    await this.prisma.pendingAction.updateMany({
      where: { id: pending.id, status: { in: [...CLAIMABLE_STATES] } },
      data: { status: S.FAILED, finishedAt: new Date() },
    });
    this.logger.warn(`Pending action ${pending.id} failed before execution: ${failureCode}`);
  }

  private async expire(pending: PendingAction): Promise<void> {
    await this.prisma.pendingAction.updateMany({
      where: { id: pending.id, status: { in: [...CLAIMABLE_STATES] } },
      data: { status: S.EXPIRED, decidedAt: new Date() },
    });
  }

  private async recordDenial(
    request: ExecuteRequest,
    pending: PendingAction,
    action: AnyActionDefinition,
    denial: Denial,
  ): Promise<void> {
    await this.audit.record({
      action: AuditAction.ACTION_DENIED,
      userId: request.userId,
      deviceId: request.deviceId,
      actorType: 'SYSTEM',
      resource: 'pending_action',
      resourceId: pending.id,
      metadata: {
        actionId: action.id,
        denial: denial.code,
        permission: denial.permission ?? null,
      },
      ...request.meta,
    });
  }

  // ──────────────────────────────────────────────────────── reconciliation

  /**
   * Cleans up attempts that were claimed and never settled.
   *
   * A process that dies between claiming and settling leaves a `RUNNING`
   * execution and an `EXECUTING` pending action. Neither may simply be
   * retried: the handler may have had its effect before the process went
   * away, and running it again could duplicate a real-world side effect.
   *
   * So a stale attempt becomes `UNVERIFIED`, which is the truth, and the
   * pending action becomes `FAILED` so nothing claims it again. The user is
   * told the outcome is unknown and can decide, which is the only honest
   * option available to us.
   */
  async reconcileStale(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - this.config.providers.actions.staleClaimMs);

    const stale = await this.prisma.actionExecution.findMany({
      where: { status: ExecutionStatus.RUNNING, startedAt: { lt: cutoff } },
      select: { id: true, pendingActionId: true, actionId: true, userId: true },
    });

    for (const row of stale) {
      await this.prisma.transaction(async (tx) => {
        await tx.actionExecution.update({
          where: { id: row.id },
          data: {
            status: ExecutionStatus.UNVERIFIED,
            detail: 'Interrupted before it finished; the outcome is unknown.',
            verified: false,
            failureCode: 'attempt_abandoned',
            finishedAt: now,
          },
        });
        await tx.pendingAction.updateMany({
          where: { id: row.pendingActionId, status: S.EXECUTING },
          data: { status: S.FAILED, finishedAt: now },
        });
      });

      await this.audit.record({
        action: AuditAction.ACTION_FAILED,
        userId: row.userId,
        actorType: 'SYSTEM',
        resource: 'action_execution',
        resourceId: row.id,
        metadata: { actionId: row.actionId, failureCode: 'attempt_abandoned' },
      });
    }

    if (stale.length > 0) {
      this.logger.warn(`Reconciled ${stale.length} abandoned action attempt(s) as unverified.`);
    }
    return stale.length;
  }

  /** Expires every proposal past its deadline. For the scheduler. */
  async expireOverdue(now = new Date()): Promise<number> {
    const { count } = await this.prisma.pendingAction.updateMany({
      where: { expiresAt: { lte: now }, status: { in: [S.PENDING, S.APPROVED] } },
      data: { status: S.EXPIRED, decidedAt: now },
    });
    return count;
  }

  // ────────────────────────────────────────────────────────────── reading

  /** Execution history for one account. Scoped, and without parameters. */
  async history(userId: string, limit = 20) {
    const rows = await this.prisma.actionExecution.findMany({
      where: { userId },
      orderBy: { startedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
      select: {
        id: true,
        actionId: true,
        status: true,
        detail: true,
        verified: true,
        failureCode: true,
        resultRef: true,
        attempt: true,
        startedAt: true,
        finishedAt: true,
      },
    });

    return rows.map((row) => ({
      executionId: row.id,
      actionId: row.actionId,
      status: row.status,
      detail: row.detail,
      verified: row.verified,
      failureCode: row.failureCode,
      resultRef: row.resultRef,
      attempt: row.attempt,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
    }));
  }
}

/** A privacy-safe reference to a set of parameters. */
export function digestOf(params: unknown): string {
  // Keys sorted, so two logically identical parameter sets produce the same
  // digest regardless of how they were serialised.
  return createHash('sha256').update(stableStringify(params)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

function isPendingClaimed(status: S): boolean {
  return status === S.EXECUTING || status === S.EXECUTED || status === S.FAILED;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || /abort/i.test(error.message));
}

function denialToError(denial: Denial): AppError {
  switch (denial.code) {
    case 'account_inactive':
    case 'device_revoked':
      return AppError.unauthenticated(denial.detail);
    case 'device_unknown':
      return AppError.notFound('Action');
    case 'integration_not_connected':
      return AppError.validation(denial.detail);
    default:
      return AppError.forbidden(denial.detail);
  }
}
