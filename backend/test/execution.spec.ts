import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaService } from '../src/database/prisma.service';
import { LlmRegistry } from '../src/providers/llm/llm.module';
import { ActionRegistry } from '../src/modules/actions/registry/action.registry';
import { ActionExecutorService } from '../src/modules/actions/action-executor.service';
import type { AnyActionDefinition } from '../src/modules/actions/registry/types';
import {
  createTestApp,
  uniqueEmail,
  STRONG_PASSWORD,
  NATIVE_DEVICE,
  type AuthBody,
  type Envelope,
  type ErrorBody,
} from './helpers/app';

interface PlanView {
  pendingActionId: string;
  kind: string;
  requiresConfirmation: boolean;
  fields: { key: string; value: string }[];
}

interface ExecutionView {
  executionId: string;
  actionId: string;
  status: string;
  detail: string;
  verified: boolean;
  failureCode: string | null;
  resultRef: string | null;
  result: unknown;
  duplicate: boolean;
}

interface TurnView {
  commandId: string;
  status: string;
  reply: string;
  intent: string | null;
  plan: PlanView | null;
  problem: { code: string; detail: string } | null;
  execution: ExecutionView | null;
}

const noteOutput = (text = 'buy milk') => ({
  command: { intent: 'save_note', entities: { text } },
  confidence: 0.95,
  clarification: null,
  reply: 'Saved it.',
  detectedLanguage: 'en-IN',
});

const messageOutput = (recipient = '+919876543210', platform = 'whatsapp') => ({
  command: { intent: 'send_message', entities: { platform, recipient, message: 'Running late' } },
  confidence: 0.92,
  clarification: null,
  reply: 'Here is the message.',
  detectedLanguage: 'en-IN',
});

describe('secure action execution', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => Server;
  /** The language model's stand-in, typed for chaining. */
  interface ScriptableLlm {
    reset: () => ScriptableLlm;
    script: (match: RegExp, output: unknown) => ScriptableLlm;
  }
  let llm: ScriptableLlm;
  let registry: ActionRegistry;
  let executor: ActionExecutorService;

  beforeAll(async () => {
    ({ app, prisma, http } = await createTestApp());
    llm = app.get(LlmRegistry).byId('mock') as never;
    registry = app.get(ActionRegistry);
    executor = app.get(ActionExecutorService);
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => {
    llm.reset();
  });

  async function newAccount() {
    const res = await request(http())
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail('exec'), password: STRONG_PASSWORD, device: NATIVE_DEVICE })
      .expect(201);
    const body = res.body as AuthBody;
    return {
      email: body.data.user.email,
      userId: body.data.user.id,
      deviceId: body.data.device.id,
      access: body.data.tokens.accessToken!,
    };
  }

  /** A second device on the same account, with its own token. */
  async function secondDevice(email: string) {
    const res = await request(http())
      .post('/api/v1/auth/login')
      .send({
        email,
        password: STRONG_PASSWORD,
        device: { platform: 'WINDOWS', name: 'Desktop', deviceType: 'desktop' },
      })
      .expect(200);
    const body = res.body as AuthBody;
    return { deviceId: body.data.device.id, access: body.data.tokens.accessToken! };
  }

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function turn(token: string, text: string) {
    const res = await request(http())
      .post('/api/v1/assistant/turn')
      .set(auth(token))
      .send({ text })
      .expect(201);
    return (res.body as Envelope<TurnView>).data;
  }

  const decide = (token: string, id: string, approve: boolean) =>
    request(http())
      .post(`/api/v1/assistant/actions/${id}/decision`)
      .set(auth(token))
      .send({ approve });

  async function setAssistantPreferences(
    userId: string,
    patch: Record<string, boolean>,
  ): Promise<void> {
    await prisma.userPreference.upsert({
      where: { userId },
      create: { userId, assistant: patch },
      update: { assistant: patch },
    });
  }

  // ───────────────────────────────────────────────────────── valid action

  describe('a valid action', () => {
    it('runs, verifies its own effect and records everything', async () => {
      const account = await newAccount();
      llm.script(/milk/i, noteOutput('buy milk'));

      const result = await turn(account.access, 'note: buy milk');

      expect(result.status).toBe('executed');
      expect(result.execution!.actionId).toBe('notes.create');
      expect(result.execution!.status).toBe('COMPLETED');
      expect(result.execution!.verified).toBe(true);

      // The record carries everything the brief asks for.
      const record = await prisma.actionExecution.findUniqueOrThrow({
        where: { id: result.execution!.executionId },
      });
      expect(record.userId).toBe(account.userId);
      expect(record.deviceId).toBe(account.deviceId);
      expect(record.sessionId).not.toBeNull();
      expect(record.actionId).toBe('notes.create');
      expect(record.attempt).toBe(1);
      expect(record.status).toBe('COMPLETED');
      expect(record.verified).toBe(true);
      expect(record.failureCode).toBeNull();
      expect(record.resultRef).not.toBeNull();
      expect(record.startedAt).toBeInstanceOf(Date);
      expect(record.finishedAt).not.toBeNull();
      // A reference to the parameters, not a copy of them.
      expect(record.paramsDigest).toMatch(/^[0-9a-f]{64}$/);
    });

    it('does not store the parameters on the execution record', async () => {
      const account = await newAccount();
      llm.script(/.*/, noteOutput('my bank password is hunter2'));

      const result = await turn(account.access, 'note this down');

      const record = await prisma.actionExecution.findUniqueOrThrow({
        where: { id: result.execution!.executionId },
      });
      // The note itself lives on the pending action and in the notes table.
      // It is deliberately not duplicated into an execution log, which
      // would outlive the thing it describes.
      expect(JSON.stringify(record)).not.toContain('hunter2');
    });

    it('reports a read as completed and a hand-off as a hand-off', async () => {
      const account = await newAccount();

      llm.script(/notes/i, {
        command: { intent: 'retrieve_note', entities: { query: 'milk' } },
        confidence: 0.9,
        clarification: null,
        reply: 'Looking.',
        detectedLanguage: 'en-IN',
      });
      const read = await turn(account.access, 'what notes do I have about milk');
      expect(read.status).toBe('executed');
      expect(read.execution!.verified).toBe(true);

      llm.reset().script(/spotify/i, {
        command: { intent: 'open_application', entities: { application: 'spotify' } },
        confidence: 0.9,
        clarification: null,
        reply: 'Opening.',
        detectedLanguage: 'en-IN',
      });
      const handoff = await turn(account.access, 'open spotify');
      // The server cannot open an application. It produced a descriptor.
      expect(handoff.status).toBe('handed_off');
      expect(handoff.execution!.status).toBe('HANDOFF');
      expect(handoff.execution!.verified).toBe(false);
      expect(handoff.execution!.result).toMatchObject({ openedByServer: false });
    });
  });

  // ──────────────────────────────────────────────────────── invalid action

  describe('an invalid action', () => {
    it('refuses a pending action whose id is not in the registry', async () => {
      const account = await newAccount();
      llm.script(/milk/i, noteOutput());
      const first = await turn(account.access, 'note: buy milk');

      // A stored id the registry no longer knows — a row from an older
      // build, or one written by hand.
      const forged = await prisma.pendingAction.create({
        data: {
          userId: account.userId,
          deviceId: account.deviceId,
          commandId: (
            await prisma.assistantCommand.create({
              data: { userId: account.userId, rawText: 'x' },
              select: { id: true },
            })
          ).id,
          actionId: 'shell.exec',
          kind: 'NOTE_SAVE',
          executionMode: 'LOCAL',
          plan: {},
          params: { command: 'rm -rf /' },
          requiresConfirmation: false,
          expiresAt: new Date(Date.now() + 60_000),
        },
        select: { id: true },
      });
      void first;

      const res = await request(http())
        .post(`/api/v1/actions/${forged.id}/execute`)
        .set(auth(account.access))
        .send({})
        .expect(400);
      expect((res.body as ErrorBody).success).toBe(false);

      const row = await prisma.pendingAction.findUniqueOrThrow({ where: { id: forged.id } });
      expect(row.status).toBe('FAILED');
      // Nothing ran.
      expect(await prisma.actionExecution.count({ where: { pendingActionId: forged.id } })).toBe(0);
    });

    it('refuses a pending action whose parameters no longer validate', async () => {
      const account = await newAccount();
      llm.script(/milk/i, noteOutput());
      const result = await turn(account.access, 'note: buy milk');

      // A second proposal, then its parameters are corrupted before the
      // executor sees them.
      llm.reset().script(/late/i, messageOutput());
      const planned = await turn(account.access, 'tell +919876543210 I am late');
      await prisma.pendingAction.update({
        where: { id: planned.plan!.pendingActionId },
        data: { params: { platform: 'carrier-pigeon' }, status: 'APPROVED' },
      });
      void result;

      await request(http())
        .post(`/api/v1/actions/${planned.plan!.pendingActionId}/execute`)
        .set(auth(account.access))
        .send({})
        .expect(400);

      const row = await prisma.pendingAction.findUniqueOrThrow({
        where: { id: planned.plan!.pendingActionId },
      });
      expect(row.status).toBe('FAILED');
    });

    it('refuses an application that is not in the catalogue', async () => {
      const account = await newAccount();
      llm.script(/terminal/i, {
        command: { intent: 'open_application', entities: { application: 'terminal' } },
        confidence: 0.99,
        clarification: null,
        reply: 'Opening terminal.',
        detectedLanguage: 'en-IN',
      });

      const result = await turn(account.access, 'open the terminal');

      expect(result.status).toBe('action_failed');
      expect(result.execution!.failureCode).toBe('application_not_supported');
      expect(result.execution!.result).toMatchObject({ launch: null });
    });

    it('refuses a reminder for a time that has already passed', async () => {
      const account = await newAccount();
      llm.script(/gym/i, {
        command: {
          intent: 'create_reminder',
          entities: { text: 'gym', dueAt: '2020-01-01T08:00:00+05:30', spokenTime: 'yesterday' },
        },
        confidence: 0.9,
        clarification: null,
        reply: 'Setting it.',
        detectedLanguage: 'en-IN',
      });

      const result = await turn(account.access, 'remind me about gym yesterday');

      expect(result.status).toBe('action_failed');
      expect(result.execution!.failureCode).toBe('due_in_past');
      // Nothing was stored just to look busy.
      expect(await prisma.reminder.count({ where: { userId: account.userId } })).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────── permission denial

  describe('permission denial', () => {
    it('refuses every action when the user has turned the assistant off', async () => {
      const account = await newAccount();
      await setAssistantPreferences(account.userId, { actionsEnabled: false });
      llm.script(/milk/i, noteOutput());

      const result = await turn(account.access, 'note: buy milk');

      // A person who has turned the assistant off has withdrawn consent for
      // it to act, and that outranks the request.
      expect(result.status).toBe('action_failed');
      expect(await prisma.note.count({ where: { userId: account.userId } })).toBe(0);

      const audit = await prisma.auditLog.findFirst({
        where: { userId: account.userId, action: 'action.denied' },
      });
      expect(audit).not.toBeNull();
      expect(audit!.metadata as object).toMatchObject({ denial: 'assistant_disabled' });
    });

    it('refuses only the actions a specific preference covers', async () => {
      const account = await newAccount();
      await setAssistantPreferences(account.userId, { handoffEnabled: false });

      llm.script(/spotify/i, {
        command: { intent: 'open_application', entities: { application: 'spotify' } },
        confidence: 0.9,
        clarification: null,
        reply: 'Opening.',
        detectedLanguage: 'en-IN',
      });
      const blocked = await turn(account.access, 'open spotify');
      expect(blocked.status).toBe('action_failed');

      // Saving a note does not need the hand-off permission.
      llm.reset().script(/milk/i, noteOutput());
      const allowed = await turn(account.access, 'note: buy milk');
      expect(allowed.status).toBe('executed');
    });

    it('refuses an action needing an integration that is not connected', async () => {
      const account = await newAccount();
      llm.script(/calendar/i, {
        command: {
          intent: 'get_calendar_events',
          entities: { from: null, to: null, query: null },
        },
        confidence: 0.9,
        clarification: null,
        reply: 'Checking.',
        detectedLanguage: 'en-IN',
      });

      const result = await turn(account.access, 'what is on my calendar');

      // Reported as missing, never as "you have no events today".
      expect(result.status).not.toBe('executed');
      expect(result.reply.toLowerCase()).toContain('calendar');
    });

    it('re-checks authorization at execution time, not only when proposing', async () => {
      const account = await newAccount();
      llm.script(/late/i, messageOutput());
      const planned = await turn(account.access, 'tell +919876543210 I am late');
      expect(planned.status).toBe('awaiting_confirmation');

      // The permission is withdrawn in the gap between proposing and
      // confirming — which can be minutes.
      await setAssistantPreferences(account.userId, { messagingEnabled: false });

      const res = await decide(account.access, planned.plan!.pendingActionId, true).expect(403);
      expect((res.body as ErrorBody).success).toBe(false);

      expect(
        await prisma.actionExecution.count({
          where: { pendingActionId: planned.plan!.pendingActionId },
        }),
      ).toBe(0);
    });

    it('refuses once the device has been signed out', async () => {
      const account = await newAccount();
      llm.script(/late/i, messageOutput());
      const planned = await turn(account.access, 'tell +919876543210 I am late');

      await prisma.device.update({
        where: { id: account.deviceId },
        data: { revokedAt: new Date() },
      });

      // The token is rejected by the guard before the executor is reached,
      // which is the same answer by a shorter route.
      await decide(account.access, planned.plan!.pendingActionId, true).expect(401);
      expect(
        await prisma.actionExecution.count({
          where: { pendingActionId: planned.plan!.pendingActionId },
        }),
      ).toBe(0);
    });

    it('reports what this user and device may do', async () => {
      const account = await newAccount();
      const res = await request(http())
        .get('/api/v1/actions/permissions')
        .set(auth(account.access))
        .expect(200);

      const body = (res.body as Envelope<{ granted: string[]; denial: unknown }>).data;
      expect(body.denial).toBeNull();
      expect(body.granted).toContain('account.active');
      expect(body.granted).toContain('device.active');
      expect(body.granted).toContain('messaging.prepare');

      await setAssistantPreferences(account.userId, { actionsEnabled: false });
      const after = await request(http())
        .get('/api/v1/actions/permissions')
        .set(auth(account.access))
        .expect(200);
      expect(
        (after.body as Envelope<{ denial: { code: string } }>).data.denial.code,
      ).toBe('assistant_disabled');
    });
  });

  // ──────────────────────────────────────────────────────────── confirmation

  describe('confirmation', () => {
    it('requires it for a message, and attempts nothing while it waits', async () => {
      const account = await newAccount();
      llm.script(/late/i, messageOutput());

      const planned = await turn(account.access, 'tell +919876543210 I am late');

      expect(planned.status).toBe('awaiting_confirmation');
      expect(planned.plan!.requiresConfirmation).toBe(true);
      expect(planned.execution).toBeNull();

      // The confirmation contract: everything the brief lists.
      const row = await prisma.pendingAction.findUniqueOrThrow({
        where: { id: planned.plan!.pendingActionId },
      });
      expect(row.actionId).toBe('messaging.prepare');
      expect(row.userId).toBe(account.userId);
      expect(row.deviceId).toBe(account.deviceId);
      expect(row.sessionId).not.toBeNull();
      expect(row.requiresConfirmation).toBe(true);
      expect(row.status).toBe('PENDING');
      expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(row.params as object).toMatchObject({
        platform: 'whatsapp',
        recipient: '+919876543210',
        message: 'Running late',
      });

      // The preview a user sees is rendered from those same parameters.
      const fields = Object.fromEntries(planned.plan!.fields.map((f) => [f.key, f.value]));
      expect(fields).toMatchObject({
        platform: 'whatsapp',
        recipient: '+919876543210',
        message: 'Running late',
      });

      expect(await prisma.actionExecution.count({ where: { pendingActionId: row.id } })).toBe(0);
    });

    it('cannot be skipped by a client claiming the action is already approved', async () => {
      const account = await newAccount();
      llm.script(/late/i, messageOutput());
      const planned = await turn(account.access, 'tell +919876543210 I am late');

      // Straight to the execute route, with no decision.
      const res = await request(http())
        .post(`/api/v1/actions/${planned.plan!.pendingActionId}/execute`)
        .set(auth(account.access))
        .send({})
        .expect(409);
      expect((res.body as ErrorBody).message).toContain('confirmed');

      expect(
        await prisma.actionExecution.count({
          where: { pendingActionId: planned.plan!.pendingActionId },
        }),
      ).toBe(0);
    });

    it('cannot be skipped by a row that says confirmation is unnecessary', async () => {
      const account = await newAccount();
      llm.script(/late/i, messageOutput());
      const planned = await turn(account.access, 'tell +919876543210 I am late');

      // The column is flipped directly — as a migration or a compromised
      // write might. The registry is still what decides.
      await prisma.pendingAction.update({
        where: { id: planned.plan!.pendingActionId },
        data: { requiresConfirmation: false },
      });

      await request(http())
        .post(`/api/v1/actions/${planned.plan!.pendingActionId}/execute`)
        .set(auth(account.access))
        .send({})
        .expect(409);
    });

    it('carries the action out when the user approves', async () => {
      const account = await newAccount();
      llm.script(/late/i, messageOutput());
      const planned = await turn(account.access, 'tell +919876543210 I am late');

      const res = await decide(account.access, planned.plan!.pendingActionId, true).expect(201);
      const body = (res.body as Envelope<{ status: string; execution: ExecutionView }>).data;

      expect(body.status).toBe('handed_off');
      expect(body.execution.status).toBe('HANDOFF');
      // A draft, not a send. Stated in the result, not left to be assumed.
      expect(body.execution.result).toMatchObject({
        sentByServer: false,
        remainingStep: 'Open WhatsApp and press send.',
      });

      const row = await prisma.pendingAction.findUniqueOrThrow({
        where: { id: planned.plan!.pendingActionId },
      });
      expect(row.status).toBe('EXECUTED');
      expect(row.decidedAt).not.toBeNull();
      expect(row.startedAt).not.toBeNull();
      expect(row.finishedAt).not.toBeNull();
    });

    it('permanently bars execution when the user rejects', async () => {
      const account = await newAccount();
      llm.script(/late/i, messageOutput());
      const planned = await turn(account.access, 'tell +919876543210 I am late');
      const id = planned.plan!.pendingActionId;

      const res = await decide(account.access, id, false).expect(201);
      expect((res.body as Envelope<{ status: string; note: string }>).data.status).toBe('rejected');
      expect((res.body as Envelope<{ note: string }>).data.note).toContain('cannot be carried out later');

      expect((await prisma.pendingAction.findUniqueOrThrow({ where: { id } })).status).toBe('REJECTED');

      // Nothing can route around it: not a second decision, not the
      // execute route, not a retry.
      await decide(account.access, id, true).expect(409);
      await request(http())
        .post(`/api/v1/actions/${id}/execute`)
        .set(auth(account.access))
        .send({})
        .expect(409);
      expect(await prisma.actionExecution.count({ where: { pendingActionId: id } })).toBe(0);
    });

    it('refuses an expired confirmation', async () => {
      const account = await newAccount();
      llm.script(/late/i, messageOutput());
      const planned = await turn(account.access, 'tell +919876543210 I am late');
      const id = planned.plan!.pendingActionId;

      await prisma.pendingAction.update({
        where: { id },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });

      const res = await decide(account.access, id, true).expect(409);
      expect((res.body as ErrorBody).message).toContain('expired');

      expect((await prisma.pendingAction.findUniqueOrThrow({ where: { id } })).status).toBe('EXPIRED');
      // And expiry is as permanent as rejection.
      await request(http())
        .post(`/api/v1/actions/${id}/execute`)
        .set(auth(account.access))
        .send({})
        .expect(409);
      expect(await prisma.actionExecution.count({ where: { pendingActionId: id } })).toBe(0);
    });

    it('expires overdue proposals in bulk and leaves live ones alone', async () => {
      const account = await newAccount();
      llm.script(/late/i, messageOutput());
      const overdue = await turn(account.access, 'tell +919876543210 I am late');
      llm.reset().script(/soon/i, messageOutput('+919999999999'));
      const live = await turn(account.access, 'tell +919999999999 soon');

      await prisma.pendingAction.update({
        where: { id: overdue.plan!.pendingActionId },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });

      expect(await executor.expireOverdue()).toBeGreaterThanOrEqual(1);

      expect(
        (await prisma.pendingAction.findUniqueOrThrow({ where: { id: overdue.plan!.pendingActionId } })).status,
      ).toBe('EXPIRED');
      expect(
        (await prisma.pendingAction.findUniqueOrThrow({ where: { id: live.plan!.pendingActionId } })).status,
      ).toBe('PENDING');
    });

    it('cancels a proposal, distinctly from rejecting it', async () => {
      const account = await newAccount();
      llm.script(/late/i, messageOutput());
      const planned = await turn(account.access, 'tell +919876543210 I am late');
      const id = planned.plan!.pendingActionId;

      const res = await request(http())
        .post(`/api/v1/assistant/actions/${id}/cancel`)
        .set(auth(account.access))
        .expect(201);
      const body = (res.body as Envelope<{ status: string; alreadyEnded: boolean }>).data;
      expect(body.status).toBe('cancelled');
      expect(body.alreadyEnded).toBe(false);

      expect((await prisma.pendingAction.findUniqueOrThrow({ where: { id } })).status).toBe('CANCELLED');

      // Terminal, and recorded as cancellation rather than rejection so the
      // audit log can tell them apart.
      await decide(account.access, id, true).expect(409);
      expect(
        await prisma.auditLog.count({ where: { userId: account.userId, action: 'action.cancelled' } }),
      ).toBe(1);

      // Idempotent.
      const again = await request(http())
        .post(`/api/v1/assistant/actions/${id}/cancel`)
        .set(auth(account.access))
        .expect(201);
      expect((again.body as Envelope<{ alreadyEnded: boolean }>).data.alreadyEnded).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────── duplicates

  describe('duplicate prevention', () => {
    it('hands a replayed approval the original outcome rather than repeating it', async () => {
      const account = await newAccount();
      llm.script(/late/i, messageOutput());
      const planned = await turn(account.access, 'tell +919876543210 I am late');
      const id = planned.plan!.pendingActionId;

      const first = await decide(account.access, id, true).expect(201);
      const firstExecution = (first.body as Envelope<{ execution: ExecutionView }>).data.execution;

      // A second decision is refused outright, because the row has moved on.
      await decide(account.access, id, true).expect(409);

      // And the execute route — the reconnect case, where the client never
      // saw the first response — is handed what happened.
      const replay = await request(http())
        .post(`/api/v1/actions/${id}/execute`)
        .set(auth(account.access))
        .send({})
        .expect(200);
      const replayed = (replay.body as Envelope<ExecutionView>).data;

      expect(replayed.executionId).toBe(firstExecution.executionId);
      expect(replayed.duplicate).toBe(true);

      // Exactly one attempt exists.
      expect(await prisma.actionExecution.count({ where: { pendingActionId: id } })).toBe(1);
    });

    it('does not create a second note when the same proposal is executed twice', async () => {
      const account = await newAccount();
      llm.script(/milk/i, noteOutput('buy milk'));
      const result = await turn(account.access, 'note: buy milk');
      const id = result.plan!.pendingActionId;

      await request(http())
        .post(`/api/v1/actions/${id}/execute`)
        .set(auth(account.access))
        .send({})
        .expect(200);

      // One note, not two.
      expect(await prisma.note.count({ where: { userId: account.userId } })).toBe(1);
      expect(await prisma.actionExecution.count({ where: { pendingActionId: id } })).toBe(1);
    });

    it('ignores a client key for an action whose idempotency is the confirmation', async () => {
      const account = await newAccount();
      llm.script(/late/i, messageOutput());
      const planned = await turn(account.access, 'tell +919876543210 I am late');
      const id = planned.plan!.pendingActionId;

      await decide(account.access, id, true).expect(201);

      // "The client asked twice" is not a reason to send a message twice.
      for (const key of ['retry-1', 'retry-2']) {
        const res = await request(http())
          .post(`/api/v1/actions/${id}/execute`)
          .set(auth(account.access))
          .send({ idempotencyKey: key })
          .expect(200);
        expect((res.body as Envelope<ExecutionView>).data.duplicate).toBe(true);
      }
      expect(await prisma.actionExecution.count({ where: { pendingActionId: id } })).toBe(1);
    });

    it('lets only one of two concurrent executions through', async () => {
      const account = await newAccount();
      llm.script(/late/i, messageOutput());
      const planned = await turn(account.access, 'tell +919876543210 I am late');
      const id = planned.plan!.pendingActionId;
      await prisma.pendingAction.update({
        where: { id },
        data: { status: 'APPROVED', decidedAt: new Date() },
      });

      // The race the idempotency key exists for.
      const results = await Promise.allSettled([
        executor.execute({ userId: account.userId, deviceId: account.deviceId, pendingActionId: id }),
        executor.execute({ userId: account.userId, deviceId: account.deviceId, pendingActionId: id }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      // Either one wins and one conflicts, or one wins and the other is
      // handed the same record — never two attempts.
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      expect(await prisma.actionExecution.count({ where: { pendingActionId: id } })).toBe(1);
    });

    it('keeps the idempotency key unique across the table', async () => {
      const account = await newAccount();
      llm.script(/milk/i, noteOutput());
      const result = await turn(account.access, 'note: buy milk');

      const record = await prisma.actionExecution.findUniqueOrThrow({
        where: { id: result.execution!.executionId },
      });
      expect(record.idempotencyKey).toBe(`notes.create:${result.plan!.pendingActionId}`);

      // The constraint, not application logic, is what makes a duplicate
      // impossible.
      await expect(
        prisma.actionExecution.create({
          data: {
            pendingActionId: result.plan!.pendingActionId,
            attempt: 99,
            userId: account.userId,
            actionId: 'notes.create',
            idempotencyKey: record.idempotencyKey,
            paramsDigest: record.paramsDigest,
            status: 'COMPLETED',
            detail: 'forged',
          },
        }),
      ).rejects.toThrow();
    });
  });

  // ──────────────────────────────────────────────── timeouts and recovery

  describe('timeouts and interrupted attempts', () => {
    /** Substitutes one definition for the duration of a test. */
    function withAction(definition: AnyActionDefinition, run: () => Promise<void>) {
      const original = registry.find.bind(registry);
      (registry as unknown as { find: unknown }).find = (id: string) =>
        id === definition.id ? definition : original(id);
      return run().finally(() => {
        (registry as unknown as { find: unknown }).find = original;
      });
    }

    it('reports a handler that overruns its deadline as unverified, not failed', async () => {
      const account = await newAccount();
      llm.script(/milk/i, noteOutput());
      const result = await turn(account.access, 'note: buy milk');
      const real = registry.require('notes.create');

      // A handler that never settles until it is aborted.
      const slow = {
        ...real,
        handler: (_input: never, context: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            context.signal.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          }),
      } as unknown as AnyActionDefinition;

      // A fresh proposal to run it against.
      llm.reset().script(/bread/i, noteOutput('buy bread'));
      const second = await turn(account.access, 'note: buy bread');
      void result;
      void second;

      const planned = await prisma.pendingAction.create({
        data: {
          userId: account.userId,
          deviceId: account.deviceId,
          commandId: (
            await prisma.assistantCommand.create({
              data: { userId: account.userId, rawText: 'slow' },
              select: { id: true },
            })
          ).id,
          actionId: 'notes.create',
          kind: 'NOTE_SAVE',
          executionMode: 'LOCAL',
          plan: {},
          params: { text: 'slow note' },
          requiresConfirmation: false,
          expiresAt: new Date(Date.now() + 60_000),
        },
        select: { id: true },
      });

      await withAction(slow, async () => {
        const report = await executor.execute({
          userId: account.userId,
          deviceId: account.deviceId,
          pendingActionId: planned.id,
        });

        // A timeout does not tell us whether the work had an effect first,
        // so "failed" would be the comfortable lie.
        expect(report.status).toBe('UNVERIFIED');
        expect(report.verified).toBe(false);
        expect(report.failureCode).toBe('attempt_timeout');
        expect(report.detail).toContain('cannot confirm');
      });
    }, 30_000);

    it('reports a handler that throws as failed', async () => {
      const account = await newAccount();
      const real = registry.require('notes.create');
      const broken = {
        ...real,
        handler: () => Promise.reject(new Error('something broke')),
      } as unknown as AnyActionDefinition;

      const planned = await prisma.pendingAction.create({
        data: {
          userId: account.userId,
          deviceId: account.deviceId,
          commandId: (
            await prisma.assistantCommand.create({
              data: { userId: account.userId, rawText: 'broken' },
              select: { id: true },
            })
          ).id,
          actionId: 'notes.create',
          kind: 'NOTE_SAVE',
          executionMode: 'LOCAL',
          plan: {},
          params: { text: 'note' },
          requiresConfirmation: false,
          expiresAt: new Date(Date.now() + 60_000),
        },
        select: { id: true },
      });

      await withAction(broken, async () => {
        const report = await executor.execute({
          userId: account.userId,
          deviceId: account.deviceId,
          pendingActionId: planned.id,
        });
        expect(report.status).toBe('FAILED');
        expect(report.failureCode).toBe('handler_error');
        // The provider's own message is not relayed to the user.
        expect(report.detail).not.toContain('something broke');
      });
    });

    it('reports a result that does not match its schema as unverified', async () => {
      const account = await newAccount();
      const real = registry.require('notes.create');
      const wrong = {
        ...real,
        handler: () =>
          Promise.resolve({
            status: 'COMPLETED',
            detail: 'Saved.',
            verified: true,
            result: { unexpected: true },
          }),
      } as unknown as AnyActionDefinition;

      const planned = await prisma.pendingAction.create({
        data: {
          userId: account.userId,
          deviceId: account.deviceId,
          commandId: (
            await prisma.assistantCommand.create({
              data: { userId: account.userId, rawText: 'wrong' },
              select: { id: true },
            })
          ).id,
          actionId: 'notes.create',
          kind: 'NOTE_SAVE',
          executionMode: 'LOCAL',
          plan: {},
          params: { text: 'note' },
          requiresConfirmation: false,
          expiresAt: new Date(Date.now() + 60_000),
        },
        select: { id: true },
      });

      await withAction(wrong, async () => {
        const report = await executor.execute({
          userId: account.userId,
          deviceId: account.deviceId,
          pendingActionId: planned.id,
        });
        // A handler claiming success with a malformed body does not get to
        // report success.
        expect(report.status).toBe('UNVERIFIED');
        expect(report.verified).toBe(false);
        expect(report.failureCode).toBe('result_schema_mismatch');
      });
    });

    it('reconciles an abandoned attempt as unverified rather than retrying it', async () => {
      const account = await newAccount();
      llm.script(/milk/i, noteOutput());
      const result = await turn(account.access, 'note: buy milk');

      // A process that died between claiming and settling.
      const stranded = await prisma.actionExecution.create({
        data: {
          pendingActionId: result.plan!.pendingActionId,
          attempt: 7,
          userId: account.userId,
          deviceId: account.deviceId,
          actionId: 'notes.create',
          idempotencyKey: `stranded:${result.plan!.pendingActionId}`,
          paramsDigest: 'a'.repeat(64),
          status: 'RUNNING',
          detail: 'Started.',
          startedAt: new Date(Date.now() - 60_000),
        },
        select: { id: true },
      });
      await prisma.pendingAction.update({
        where: { id: result.plan!.pendingActionId },
        data: { status: 'EXECUTING' },
      });

      expect(await executor.reconcileStale()).toBeGreaterThanOrEqual(1);

      const settled = await prisma.actionExecution.findUniqueOrThrow({ where: { id: stranded.id } });
      // The handler may have had its effect before the process went away,
      // so retrying could duplicate a real side effect. Unknown is the
      // truth, and it is what gets recorded.
      expect(settled.status).toBe('UNVERIFIED');
      expect(settled.failureCode).toBe('attempt_abandoned');
      expect(settled.finishedAt).not.toBeNull();

      expect(
        (await prisma.pendingAction.findUniqueOrThrow({ where: { id: result.plan!.pendingActionId } }))
          .status,
      ).toBe('FAILED');
    });
  });

  // ─────────────────────────────────────────────────────────── isolation

  describe('cross-user and cross-device access', () => {
    it('hides another account’s pending action entirely', async () => {
      const owner = await newAccount();
      const stranger = await newAccount();
      llm.script(/late/i, messageOutput());
      const planned = await turn(owner.access, 'tell +919876543210 I am late');
      const id = planned.plan!.pendingActionId;

      // 404, not 403: confirming an id exists is itself a disclosure.
      await decide(stranger.access, id, true).expect(404);
      await request(http())
        .post(`/api/v1/assistant/actions/${id}/cancel`)
        .set(auth(stranger.access))
        .expect(404);
      await request(http())
        .post(`/api/v1/actions/${id}/execute`)
        .set(auth(stranger.access))
        .send({})
        .expect(404);

      expect((await prisma.pendingAction.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING');
      expect(await prisma.actionExecution.count({ where: { pendingActionId: id } })).toBe(0);
    });

    it('stops one device acting on another device’s pending action', async () => {
      const account = await newAccount();
      const other = await secondDevice(account.email);
      llm.script(/late/i, messageOutput());
      const planned = await turn(account.access, 'tell +919876543210 I am late');
      const id = planned.plan!.pendingActionId;

      // Same account, different device. A confirmation belongs to the
      // screen it appeared on.
      await decide(other.access, id, true).expect(404);
      await request(http())
        .post(`/api/v1/actions/${id}/execute`)
        .set(auth(other.access))
        .send({})
        .expect(404);
      await request(http())
        .post(`/api/v1/assistant/actions/${id}/cancel`)
        .set(auth(other.access))
        .expect(404);

      expect((await prisma.pendingAction.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING');

      // The owning device can.
      await decide(account.access, id, true).expect(201);
    });

    it('shows only this account’s execution history', async () => {
      const owner = await newAccount();
      const stranger = await newAccount();
      llm.script(/milk/i, noteOutput('a private note'));
      await turn(owner.access, 'note: buy milk');

      const mine = await request(http())
        .get('/api/v1/actions/history')
        .set(auth(owner.access))
        .expect(200);
      expect((mine.body as Envelope<unknown[]>).data.length).toBeGreaterThanOrEqual(1);

      const theirs = await request(http())
        .get('/api/v1/actions/history')
        .set(auth(stranger.access))
        .expect(200);
      expect((theirs.body as Envelope<unknown[]>).data).toHaveLength(0);
    });

    it('requires authentication on every action route', async () => {
      const id = '4f1e2d3c-0000-4000-8000-000000000000';
      await request(http()).get('/api/v1/actions').expect(401);
      await request(http()).get('/api/v1/actions/permissions').expect(401);
      await request(http()).get('/api/v1/actions/history').expect(401);
      await request(http()).post(`/api/v1/actions/${id}/execute`).send({}).expect(401);
    });
  });

  // ──────────────────────────────────────────────────────── audit logging

  describe('audit logging', () => {
    it('records the proposal, the approval and the execution separately', async () => {
      const account = await newAccount();
      llm.script(/late/i, messageOutput());
      const planned = await turn(account.access, 'tell +919876543210 I am late');
      await decide(account.access, planned.plan!.pendingActionId, true).expect(201);

      const entries = await prisma.auditLog.findMany({
        where: { userId: account.userId },
        orderBy: { createdAt: 'asc' },
        select: { action: true, actorType: true, resource: true, metadata: true },
      });
      const actions = entries.map((e) => e.action);

      // Three distinct facts: the AI suggested it, the person agreed, the
      // server carried it out. A reader can tell which is which.
      expect(actions).toContain('assistant.action.proposed');
      expect(actions).toContain('assistant.action.approved');
      expect(actions).toContain('action.executed');

      const proposed = entries.find((e) => e.action === 'assistant.action.proposed')!;
      expect(proposed.actorType).toBe('AI');
      const approved = entries.find((e) => e.action === 'assistant.action.approved')!;
      expect(approved.actorType).toBe('USER');
    });

    it('records a refusal distinctly from a failure', async () => {
      const account = await newAccount();
      await setAssistantPreferences(account.userId, { actionsEnabled: false });
      llm.script(/milk/i, noteOutput());
      await turn(account.access, 'note: buy milk');

      const denied = await prisma.auditLog.findFirstOrThrow({
        where: { userId: account.userId, action: 'action.denied' },
      });
      expect(denied.actorType).toBe('SYSTEM');
      expect(denied.metadata as object).toMatchObject({ actionId: 'notes.create' });
    });

    it('never records the content of what was done', async () => {
      const account = await newAccount();
      llm.script(/.*/, noteOutput('my bank password is hunter2'));
      await turn(account.access, 'note this');

      const entries = await prisma.auditLog.findMany({ where: { userId: account.userId } });
      expect(JSON.stringify(entries)).not.toContain('hunter2');
    });

    it('keeps an execution record that cannot be mistaken for an approval', async () => {
      const account = await newAccount();
      llm.script(/milk/i, noteOutput());
      const result = await turn(account.access, 'note: buy milk');

      const executed = await prisma.auditLog.findFirstOrThrow({
        where: { userId: account.userId, action: 'action.executed' },
      });
      expect(executed.resource).toBe('action_execution');
      expect(executed.resourceId).toBe(result.execution!.executionId);
      expect(executed.metadata as object).toMatchObject({ actionId: 'notes.create', verified: true });
    });
  });

  // ─────────────────────────────────────────────────────── the catalogue

  describe('the published catalogue', () => {
    it('advertises exactly what the executor enforces', async () => {
      const account = await newAccount();
      const res = await request(http()).get('/api/v1/actions').set(auth(account.access)).expect(200);

      const body = (res.body as Envelope<{
        actions: { id: string; requiresConfirmation: boolean }[];
        applications: { id: string }[];
        messaging: { id: string }[];
      }>).data;

      expect(body.actions.map((a) => a.id).sort()).toEqual([...registry.ids()]);
      expect(body.actions.find((a) => a.id === 'messaging.prepare')!.requiresConfirmation).toBe(true);
      expect(body.actions.find((a) => a.id === 'notes.create')!.requiresConfirmation).toBe(false);
      expect(body.applications.map((a) => a.id)).toContain('spotify');
      expect(body.messaging.map((m) => m.id)).toEqual(['whatsapp', 'telegram', 'email']);
    });

    it('exposes no handler, schema or credential', async () => {
      const account = await newAccount();
      const res = await request(http()).get('/api/v1/actions').set(auth(account.access)).expect(200);

      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain('handler');
      expect(raw).not.toContain('inputSchema');
      expect(raw).not.toMatch(/sk-/);
      expect(raw).not.toContain('apiKey');
    });
  });
});
