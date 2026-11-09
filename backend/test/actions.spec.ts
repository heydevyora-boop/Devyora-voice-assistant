import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ACTIONS,
  actionIds,
  findAction,
  hasAction,
  requireAction,
} from '../src/modules/actions/registry/action.registry';
import {
  CLAIMABLE_STATES,
  canPendingTransition,
  describeBlockedStatus,
  EXECUTION_BARRED_STATES,
  isExecutionBarred,
  isPendingTerminal,
  TERMINAL_PENDING_STATES,
} from '../src/modules/actions/pending-action.state';
import { digestOf } from '../src/modules/actions/action-executor.service';
import { parseAssistantPreferences } from '../src/modules/actions/permissions.service';
import {
  APPLICATIONS,
  describeLaunch,
  findApplication,
  findMessagingSurface,
  isUsableAddress,
  MESSAGING_SURFACES,
} from '../src/modules/actions/handlers/launch-catalog';
import { CAPABILITIES, policyFor } from '../src/modules/ai/capability-registry';
import { toActionParams } from '../src/modules/ai/action-mapping';
import { INTENTS } from '../src/modules/ai/schemas/command.schema';
import { statusForExecution } from '../src/modules/assistant/assistant.service';
import type { ExecutionReport } from '../src/modules/actions/action-executor.service';

const report = (status: ExecutionReport['status']): ExecutionReport => ({
  executionId: 'e',
  pendingActionId: 'p',
  actionId: 'a',
  status,
  detail: '',
  verified: false,
  failureCode: null,
  resultRef: null,
  result: null,
  duplicate: false,
  startedAt: new Date().toISOString(),
  finishedAt: null,
});

describe('action registry and policy', () => {
  // ──────────────────────────────────────────────────────── the allow-list

  describe('the allow-list', () => {
    it('contains exactly the actions this backend can perform', () => {
      expect(actionIds()).toEqual([
        'apps.launch',
        'calendar.list',
        'messaging.prepare',
        'notes.create',
        'notes.search',
        'reminders.create',
      ]);
    });

    it('covers the categories the brief asks for', () => {
      const categories = new Set(ACTIONS.map((a) => a.category));
      for (const category of ['notes', 'reminders', 'apps', 'messaging', 'calendar']) {
        expect(categories).toContain(category);
      }
    });

    it('gives every action everything the engine needs', () => {
      for (const action of ACTIONS) {
        expect(action.id).toMatch(/^[a-z]+\.[a-z]+$/);
        expect(action.description.length).toBeGreaterThan(5);
        expect(typeof action.inputSchema.safeParse).toBe('function');
        expect(typeof action.resultSchema.safeParse).toBe('function');
        // A direct function reference, not a name to be resolved later.
        expect(typeof action.handler).toBe('function');
        expect(typeof action.preview).toBe('function');
        expect(action.requiredPermissions.length).toBeGreaterThan(0);
        expect(['never', 'always']).toContain(action.confirmationPolicy);
        expect(['pending-action', 'pending-action-and-params']).toContain(action.idempotency);
      }
    });

    it('requires an active account and device for every action, without exception', () => {
      for (const action of ACTIONS) {
        expect(action.requiredPermissions).toContain('account.active');
        expect(action.requiredPermissions).toContain('device.active');
        // A user who has turned the assistant off has withdrawn consent for
        // it to act, and that outranks any request.
        expect(action.requiredPermissions).toContain('assistant.enabled');
      }
    });

    it('returns nothing for an id that is not an action', () => {
      expect(findAction('notes.delete')).toBeUndefined();
      expect(findAction('')).toBeUndefined();
      expect(hasAction('shell.exec')).toBe(false);
      expect(() => requireAction('eval')).toThrow(/Unknown action/);
    });

    it('cannot be reached through an object property', () => {
      // A Map, not a plain object, so a crafted key is a missing entry
      // rather than a reachable property of Object.prototype.
      for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
        expect(findAction(key)).toBeUndefined();
        expect(hasAction(key)).toBe(false);
      }
    });

    it('is frozen, so nothing can add or replace an action at runtime', () => {
      expect(Object.isFrozen(ACTIONS)).toBe(true);
      for (const action of ACTIONS) expect(Object.isFrozen(action)).toBe(true);

      // The array cannot be extended...
      expect(() => {
        (ACTIONS as unknown as unknown[]).push({ id: 'evil' });
      }).toThrow();

      // ...and an existing entry's handler cannot be swapped.
      const notes = requireAction('notes.create');
      expect(() => {
        (notes as unknown as { handler: unknown }).handler = () => undefined;
      }).toThrow();
    });

    it('exposes no implementation detail to a client', () => {
      // `describe()` is what a client sees. Nothing about how an action
      // works, and nothing executable.
      const described = ACTIONS.map((action) => ({
        id: action.id,
        requiresConfirmation: action.confirmationPolicy === 'always',
      }));
      const raw = JSON.stringify(described);
      expect(raw).not.toContain('function');
      expect(raw).not.toContain('handler');
    });
  });

  // ─────────────────────────────────────────────── confirmation policy

  describe('confirmation policy', () => {
    it('always confirms anything another person will see', () => {
      expect(requireAction('messaging.prepare').confirmationPolicy).toBe('always');
    });

    it('does not confirm private, local, reversible work', () => {
      expect(requireAction('notes.create').confirmationPolicy).toBe('never');
      expect(requireAction('notes.search').confirmationPolicy).toBe('never');
      expect(requireAction('reminders.create').confirmationPolicy).toBe('never');
    });

    it('is written in exactly one place', () => {
      // The capability table derives it rather than restating it. A second
      // copy of this answer is how such a rule gets skipped.
      for (const intent of INTENTS) {
        const policy = policyFor(intent);
        if (!policy.actionId) continue;
        const action = requireAction(policy.actionId);
        expect(policy.requiresConfirmation).toBe(action.confirmationPolicy === 'always');
      }
    });

    it('has no intent naming an action outside the registry', () => {
      // Enforced at module load; asserted here so the guarantee is visible.
      for (const intent of INTENTS) {
        const { actionId } = policyFor(intent);
        if (actionId) expect(hasAction(actionId)).toBe(true);
      }
      expect(Object.keys(CAPABILITIES).sort()).toEqual([...INTENTS].sort());
    });

    it('never marks a messaging action as something the server completes', () => {
      expect(requireAction('messaging.prepare').executionMode).toBe('ASSISTED');
      expect(requireAction('apps.launch').executionMode).toBe('ASSISTED');
    });
  });

  // ──────────────────────────────────────────────── parameter mapping

  describe('parameter mapping', () => {
    const context = { timezone: 'Asia/Kolkata' };

    it('maps each intent onto its action’s parameters', () => {
      expect(
        toActionParams({ intent: 'save_note', entities: { text: 'buy milk' } }, context),
      ).toEqual({ text: 'buy milk' });

      expect(
        toActionParams(
          {
            intent: 'send_message',
            entities: { platform: 'whatsapp', recipient: '+919876543210', message: 'late' },
          },
          context,
        ),
      ).toEqual({ platform: 'whatsapp', recipient: '+919876543210', message: 'late' });
    });

    it('takes the timezone from the account, not from the model', () => {
      const params = toActionParams(
        {
          intent: 'create_reminder',
          entities: { text: 'gym', dueAt: '2026-11-10T08:00:00+05:30', spokenTime: 'kal' },
        },
        { timezone: 'Europe/London' },
      );
      expect(params).toMatchObject({ timezone: 'Europe/London' });
      // `spokenTime` was in the entities and is not a handler parameter, so
      // it does not travel.
      expect(params).not.toHaveProperty('spokenTime');
    });

    it('drops anything the handler did not ask for', () => {
      // Each parameter is named in source, so a key a model invented has
      // nowhere to go.
      const params = toActionParams(
        {
          intent: 'save_note',
          entities: { text: 'hello', __proto__: { polluted: true }, extra: 'ignored' },
        } as never,
        context,
      );
      expect(Object.keys(params!)).toEqual(['text']);
    });

    it('returns nothing for an intent with no action', () => {
      expect(
        toActionParams({ intent: 'general_question', entities: { question: 'why' } }, context),
      ).toBeNull();
    });

    it('produces parameters every action’s own schema accepts', () => {
      // The mapping and the schemas are written separately; this is what
      // keeps them in step.
      const samples: Record<string, unknown> = {
        save_note: { intent: 'save_note', entities: { text: 'x' } },
        retrieve_note: { intent: 'retrieve_note', entities: { query: 'x' } },
        create_reminder: {
          intent: 'create_reminder',
          entities: { text: 'x', dueAt: '2030-01-01T09:00:00+05:30', spokenTime: null },
        },
        send_message: {
          intent: 'send_message',
          entities: { platform: 'whatsapp', recipient: '+919876543210', message: 'x' },
        },
        prepare_message: {
          intent: 'prepare_message',
          entities: { platform: 'email', recipient: 'a@b.com', message: 'x' },
        },
        open_application: { intent: 'open_application', entities: { application: 'spotify' } },
        get_calendar_events: {
          intent: 'get_calendar_events',
          entities: { from: '2030-01-01T09:00:00+05:30', to: null, query: null },
        },
      };

      for (const [intent, command] of Object.entries(samples)) {
        const policy = policyFor(intent as never);
        const params = toActionParams(command as never, context);
        const action = requireAction(policy.actionId!);
        const parsed = action.inputSchema.safeParse(params);
        expect(parsed.success, `${intent} -> ${policy.actionId}`).toBe(true);
      }
    });
  });

  // ──────────────────────────────────────────────── the state machine

  describe('pending action state machine', () => {
    it('lets nothing out of a state that bars execution', () => {
      // This is the mechanism by which a user's "no" is permanent: there is
      // no edge, so no retry or sweep can route around it.
      for (const state of EXECUTION_BARRED_STATES) {
        expect(isExecutionBarred(state)).toBe(true);
        for (const to of ['APPROVED', 'EXECUTING', 'EXECUTED']) {
          expect(canPendingTransition(state, to as never)).toBe(false);
        }
      }
    });

    it('lets nothing out of any terminal state', () => {
      for (const state of TERMINAL_PENDING_STATES) {
        expect(isPendingTerminal(state)).toBe(true);
        for (const to of ['PENDING', 'APPROVED', 'EXECUTING', 'EXECUTED', 'FAILED']) {
          expect(canPendingTransition(state, to as never)).toBe(false);
        }
      }
    });

    it('allows the lifecycle the brief specifies', () => {
      expect(canPendingTransition('PENDING', 'APPROVED')).toBe(true);
      expect(canPendingTransition('PENDING', 'REJECTED')).toBe(true);
      expect(canPendingTransition('PENDING', 'EXPIRED')).toBe(true);
      expect(canPendingTransition('PENDING', 'CANCELLED')).toBe(true);
      // An action needing no confirmation goes straight to execution.
      expect(canPendingTransition('PENDING', 'EXECUTING')).toBe(true);
      expect(canPendingTransition('APPROVED', 'EXECUTING')).toBe(true);
      expect(canPendingTransition('EXECUTING', 'EXECUTED')).toBe(true);
      expect(canPendingTransition('EXECUTING', 'FAILED')).toBe(true);
    });

    it('refuses a jump that skips execution', () => {
      expect(canPendingTransition('PENDING', 'EXECUTED')).toBe(false);
      expect(canPendingTransition('APPROVED', 'EXECUTED')).toBe(false);
      // An approved action cannot be rejected after the fact.
      expect(canPendingTransition('APPROVED', 'REJECTED')).toBe(false);
    });

    it('only lets the executor claim from a claimable state', () => {
      expect([...CLAIMABLE_STATES]).toEqual(['PENDING', 'APPROVED']);
      for (const state of EXECUTION_BARRED_STATES) {
        expect(CLAIMABLE_STATES).not.toContain(state);
      }
    });

    it('explains every blocked status in plain language', () => {
      for (const state of TERMINAL_PENDING_STATES) {
        expect(describeBlockedStatus(state).length).toBeGreaterThan(10);
      }
      expect(describeBlockedStatus('REJECTED')).toContain('rejected');
      expect(describeBlockedStatus('EXPIRED')).toContain('expired');
      expect(describeBlockedStatus('CANCELLED')).toContain('cancelled');
    });
  });

  // ────────────────────────────────────────────── outcome vocabulary

  describe('outcome vocabulary', () => {
    it('maps every execution status onto a turn status', () => {
      expect(statusForExecution(report('COMPLETED'))).toBe('executed');
      expect(statusForExecution(report('HANDOFF'))).toBe('handed_off');
      // Neither success nor failure, reported as its own thing.
      expect(statusForExecution(report('UNVERIFIED'))).toBe('unverified');
      expect(statusForExecution(report('PARTIAL'))).toBe('unverified');
      expect(statusForExecution(report('FAILED'))).toBe('action_failed');
      expect(statusForExecution(report('RUNNING'))).toBe('queued_for_execution');
    });

    it('does not map a hand-off or a timeout onto success', () => {
      expect(statusForExecution(report('HANDOFF'))).not.toBe('executed');
      expect(statusForExecution(report('UNVERIFIED'))).not.toBe('executed');
      expect(statusForExecution(report('PARTIAL'))).not.toBe('executed');
    });
  });

  // ──────────────────────────────────────────────────── permissions

  describe('assistant preferences', () => {
    it('permits ordinary work by default', () => {
      const prefs = parseAssistantPreferences(null);
      expect(prefs.actionsEnabled).toBe(true);
      expect(prefs.handoffEnabled).toBe(true);
      expect(prefs.messagingEnabled).toBe(true);
    });

    it('honours a user who turned something off', () => {
      expect(parseAssistantPreferences({ actionsEnabled: false }).actionsEnabled).toBe(false);
      expect(parseAssistantPreferences({ messagingEnabled: false }).messagingEnabled).toBe(false);
    });

    it('falls back field by field on a malformed document', () => {
      const prefs = parseAssistantPreferences({ actionsEnabled: 'yes', handoffEnabled: false });
      expect(prefs.actionsEnabled).toBe(true);
      expect(prefs.handoffEnabled).toBe(false);
      expect(parseAssistantPreferences('nonsense').actionsEnabled).toBe(true);
    });
  });

  // ─────────────────────────────────────────── the launch allow-list

  describe('launch and messaging allow-list', () => {
    it('resolves only exact names and aliases', () => {
      expect(findApplication('spotify')?.id).toBe('spotify');
      expect(findApplication('whats app')?.id).toBe('whatsapp');
      // Case and surrounding space do not matter — a person saying
      // "WhatsApp" means WhatsApp.
      expect(findApplication('  Whats App ')?.id).toBe('whatsapp');
      // No fuzzy fallback: a near-miss that opened the wrong application
      // would be worse than being told it is not supported.
      expect(findApplication('spotfy')).toBeNull();
      expect(findApplication('terminal')).toBeNull();
      expect(findApplication('')).toBeNull();
    });

    it('builds a descriptor only from the catalogue', () => {
      const entry = findApplication('spotify')!;
      const descriptor = describeLaunch(entry, 'ANDROID')!;
      expect(descriptor.androidPackage).toBe('com.spotify.music');
      expect(descriptor.scheme).toBe('spotify://');
    });

    it('has no entry carrying a shell command or an executable path', () => {
      for (const app of APPLICATIONS) {
        for (const target of Object.values(app.targets)) {
          const parts = [target.scheme, target.androidPackage, target.web].filter(Boolean);
          for (const part of parts as string[]) {
            expect(part).not.toMatch(/[;&|`$><]/);
            expect(part).not.toMatch(/^(\/|\.\/|~\/)/);
            expect(part).not.toMatch(/\b(sh|bash|cmd|powershell|node|python)\b/);
          }
        }
      }
    });

    it('escapes both parameters into a messaging deep link', () => {
      const whatsapp = findMessagingSurface('whatsapp')!;
      const url = whatsapp.compose('+91 98765 43210', 'hello & goodbye?x=1');

      expect(url.startsWith('https://wa.me/919876543210?text=')).toBe(true);
      // Nothing from the message can escape the query parameter.
      expect(url).not.toContain(' ');
      expect(url).not.toContain('&goodbye');
      expect(url).toContain(encodeURIComponent('hello & goodbye?x=1'));
    });

    it('cannot be made to point anywhere but the allow-listed host', () => {
      const whatsapp = findMessagingSurface('whatsapp')!;

      // The host and path come from the template; only the two parameters
      // vary, and both are encoded. Hostile text inside the message is
      // harmless precisely because it stays inside a query value — so the
      // assertion is about where the link goes, not about what it quotes.
      for (const hostile of ['../../evil', 'https://evil.test', 'javascript:alert(1)', '#x']) {
        const parsed = new URL(whatsapp.compose('+919876543210', hostile));
        expect(parsed.protocol).toBe('https:');
        expect(parsed.host).toBe('wa.me');
        expect(parsed.pathname).toBe('/919876543210');
        expect(parsed.searchParams.get('text')).toBe(hostile);
        // One parameter, so nothing was smuggled in as a second.
        expect([...parsed.searchParams.keys()]).toEqual(['text']);
      }

      // A recipient cannot alter the path either: non-digits are stripped.
      const sneaky = new URL(whatsapp.compose('+91 98765 43210/../evil', 'hi'));
      expect(sneaky.pathname).toBe('/919876543210');
    });

    it('builds a mailto whose recipient cannot carry extra headers', () => {
      const email = findMessagingSurface('email')!;
      const url = email.compose('a@b.com', 'hello');
      expect(url.startsWith('mailto:a%40b.com?body=')).toBe(true);
      // An attempt to append a header is encoded rather than honoured.
      const injected = email.compose('a@b.com?bcc=evil@test.com', 'hello');
      expect(injected).not.toContain('bcc=evil@test.com');
    });

    it('refuses a messaging surface that is not allow-listed', () => {
      expect(findMessagingSurface('instagram')).toBeNull();
      expect(findMessagingSurface('sms')).toBeNull();
      expect(MESSAGING_SURFACES.map((s) => s.id)).toEqual(['whatsapp', 'telegram', 'email']);
    });

    it('accepts an address and refuses a name', () => {
      expect(isUsableAddress('+919876543210', 'phone')).toBe(true);
      expect(isUsableAddress('98765 43210', 'phone')).toBe(true);
      expect(isUsableAddress('Rahul', 'phone')).toBe(false);
      expect(isUsableAddress('', 'phone')).toBe(false);
      expect(isUsableAddress('123', 'phone')).toBe(false);

      expect(isUsableAddress('a@b.com', 'email')).toBe(true);
      expect(isUsableAddress('Rahul', 'email')).toBe(false);
      expect(isUsableAddress('a@b', 'email')).toBe(false);
    });
  });

  // ───────────────────────────────────────── the idempotency digest

  describe('parameter digest', () => {
    it('is stable regardless of key order', () => {
      expect(digestOf({ a: 1, b: 2 })).toBe(digestOf({ b: 2, a: 1 }));
      expect(digestOf({ a: { x: 1, y: 2 } })).toBe(digestOf({ a: { y: 2, x: 1 } }));
    });

    it('changes when the content changes', () => {
      expect(digestOf({ text: 'hello' })).not.toBe(digestOf({ text: 'hellp' }));
      expect(digestOf({ text: 'hello' })).not.toBe(digestOf({ text: 'hello', extra: 1 }));
    });

    it('does not reveal what it summarises', () => {
      const digest = digestOf({ message: 'my bank password is hunter2' });
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
      expect(digest).not.toContain('hunter2');
    });

    it('treats undefined and absent alike', () => {
      expect(digestOf({ a: 1, b: undefined })).toBe(digestOf({ a: 1 }));
    });
  });

  // ──────────────────────────────────────────────────── security rules

  describe('security rules', () => {
    it('has no handler that evaluates code or runs a command', async () => {
      // Read as text rather than reasoned about: the point is that no
      // handler file contains one of these at all.
      const dir = join(process.cwd(), 'src/modules/actions/handlers');
      const files = await readdir(dir);
      expect(files.length).toBeGreaterThan(4);

      for (const file of files) {
        const source = await readFile(join(dir, file), 'utf8');
        for (const forbidden of [
          'child_process',
          'execSync',
          'spawn(',
          'eval(',
          'new Function',
          'vm.runIn',
          'require(',
          'import(',
        ]) {
          expect(source, `${file} contains ${forbidden}`).not.toContain(forbidden);
        }
      }
    });

    it('has no handler reading or writing the filesystem', async () => {
      const dir = join(process.cwd(), 'src/modules/actions/handlers');

      for (const file of await readdir(dir)) {
        const source = await readFile(join(dir, file), 'utf8');
        for (const forbidden of ['node:fs', "from 'fs'", 'writeFile', 'readFileSync']) {
          expect(source, `${file} contains ${forbidden}`).not.toContain(forbidden);
        }
      }
    });

    it('has no handler making an outbound request', async () => {
      // Every network call in this backend goes through a provider adapter
      // with a timeout, an error vocabulary and a configured host. A handler
      // reaching for `fetch` directly would bypass all of it.
      const dir = join(process.cwd(), 'src/modules/actions/handlers');

      for (const file of await readdir(dir)) {
        const source = await readFile(join(dir, file), 'utf8');
        expect(source, `${file} calls fetch`).not.toMatch(/\bfetch\s*\(/);
        expect(source, `${file} uses axios`).not.toContain('axios');
      }
    });
  });
});
