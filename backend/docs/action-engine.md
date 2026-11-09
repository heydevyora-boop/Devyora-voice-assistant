# The action execution engine

How a validated command becomes a real effect, and the specific mechanisms
that stop a language model turning into a remote shell.

One sentence version: **a model proposes an intent, the intent names an id in
a frozen table, the id is a direct function reference, and nothing else
runs.**

---

## 1. The action registry

`src/modules/actions/registry/` and `src/modules/actions/handlers/`

| Action | Category | Confirm | Mode | Verifiable |
| --- | --- | --- | --- | --- |
| `notes.create` | notes | no | LOCAL | **yes** |
| `notes.search` | notes | no | LOCAL | **yes** |
| `reminders.create` | reminders | no | LOCAL | **yes** |
| `apps.launch` | apps | no | ASSISTED | no — hand-off |
| `messaging.prepare` | messaging | **yes** | ASSISTED | no — hand-off |
| `calendar.list` | calendar | no | ACCOUNT | needs a connection |

Every action declares all of this in one object:

```ts
interface ActionDefinition<Input, Result> {
  id: string;                                  // 'notes.create'
  category: 'notes' | 'reminders' | 'apps' | 'messaging' | 'calendar';
  description: string;
  inputSchema: z.ZodType<Input>;               // the only accepted input
  requiredParams: readonly string[];           // named, not derived
  requiredPermissions: readonly Permission[];
  requiresConnection: string | null;
  confirmationPolicy: 'never' | 'always';
  idempotency: 'pending-action' | 'pending-action-and-params';
  kind: ActionKind;
  executionMode: ExecutionMode;
  resultSchema: z.ZodType<Result>;             // the only accepted output
  handler: (input, context) => Promise<ActionOutcome<Result>>;
  preview: (input) => readonly PreviewField[];
}
```

### Why this is an allow-list and not a convention

Four properties, each of them a mechanism rather than an intention:

**The set is fixed at module load.** `ACTIONS` is a frozen array of frozen
constants. There is no `register()`, nothing reads a directory, nothing adds
an entry in response to a request. What this server can do is decided by what
`action.registry.ts` imports, and `Object.isFrozen` is asserted in the tests
along with the fact that pushing to the array throws.

**Lookup is by exact id against a `Map`.** No name-to-function resolution, no
dynamic `import`, no `eval`. A `Map` rather than an object literal, so
`__proto__`, `constructor` and `toString` are missing entries rather than
reachable properties — also asserted.

**The handler is a direct reference.** A function written in this repository,
on the definition, reachable only through that map. At no point does a string
become a call.

**Dependencies are injected, not captured.** The handler receives
`context.deps`, which is why every definition can be a module-level constant
— and that in turn is why the capability table can read confirmation policy
straight from the registry without constructing anything (§3).

### What a handler may not do

Asserted by reading the handler sources as text, because the point is that
these do not appear at all:

- no `child_process`, `execSync`, `spawn`
- no `eval`, `new Function`, `vm.runIn*`
- no `require()` or dynamic `import()`
- no `node:fs`, `writeFile`, `readFileSync`
- no `fetch` or `axios`

The last one deserves a word. Every outbound call in this backend goes
through a provider adapter with a timeout, a normalised error vocabulary and
a configured host. A handler reaching for `fetch` directly would bypass all
three, so handlers do not make network calls — and the test asserts it rather
than trusting review.

### The URL and application allow-list

`handlers/launch-catalog.ts` is the whole of the answer to "no unrestricted
URLs". Six applications, three messaging surfaces, each with a template in
source. Only two values ever vary — an address and a message — and both are
`encodeURIComponent`-escaped.

What the tests check:

- an application resolves by exact name or alias, with **no fuzzy fallback**:
  a near-miss that opened the wrong application would be worse than a refusal;
- no catalogue entry contains shell metacharacters, a filesystem path, or an
  interpreter name;
- a composed link's **protocol, host and path** are fixed, whatever the
  message says — hostile text inside a query value is harmless precisely
  because it is encoded, so the assertion is about where the link goes;
- a recipient cannot alter the path: non-digits are stripped;
- a `mailto:` recipient cannot smuggle in a `bcc` header.

---

## 2. The lifecycle

```
REQUEST
  └─ pending action found, scoped to user AND device
VALIDATION
  ├─ action id resolved in the registry        → or FAILED, nothing runs
  ├─ params parsed against the input schema    → or FAILED, nothing runs
  └─ required params present                   → or FAILED, nothing runs
CONFIRMATION CHECK
  ├─ a settled attempt exists?                 → hand back what happened
  ├─ status is claimable?                      → or 409
  ├─ rejected / expired / cancelled?           → 409, permanently
  └─ policy says 'always' and status PENDING?  → 409, needs confirming
AUTHORIZATION
  └─ re-checked here, at execution time        → or denied + audited
CLAIM
  ├─ conditional update PENDING|APPROVED → EXECUTING
  └─ insert execution row, status RUNNING, unique idempotency key
EXECUTION
  └─ handler runs outside the transaction, under an AbortSignal
RESULT VERIFICATION
  └─ outcome held to the action's result schema
RESPONSE
  └─ execution row settled, pending action → EXECUTED | FAILED, audited
```

Two orderings in there were chosen deliberately, and one of them was a bug
the tests caught.

**The settled-attempt lookup comes before the confirmation rule.** An action
that has already run was confirmed on its way there — its status is
`EXECUTED`, not `APPROVED`. Asking "has this been confirmed?" of a finished
action answers no and refuses a caller who is only asking what happened. That
is exactly the reconnect case, and getting it wrong turned a replay into a
409. Narrowing the rule to `status === PENDING` is safe because the state
table has no edge into `PENDING` from anywhere else.

**Authorization is re-checked at execution time, not at proposal time.**
Minutes can pass between a plan being shown and a user approving it. A device
revoked, or a preference turned off, in that window must stop the action — and
the test for it withdraws the permission in exactly that gap.

---

## 3. Permissions

`src/modules/actions/permissions.service.ts`

| Permission | The fact it corresponds to |
| --- | --- |
| `account.active` | the user row exists, is `ACTIVE`, not soft-deleted |
| `device.active` | the device belongs to this user and is not revoked |
| `assistant.enabled` | the user has not turned assistant actions off |
| `data.read` / `data.write` | private data this account owns |
| `handoff.launch` | the user permits application hand-offs |
| `messaging.prepare` | the user permits message drafts |
| `integration.read` | the user permits reading connected accounts |

Permissions are **derived from state the server owns**, not stored as grants.
That is a choice worth stating plainly: a grants table with nothing to
populate it would be a fiction, and a fiction in an authorization layer is
worse than an absence. Each permission above is a fact that can be checked.

What this never consults: model output, request bodies, headers, or any
client assertion. The assistant's output schema has no field in which a model
could claim a permission, and this service would not read one if it did.

Every action requires `account.active`, `device.active` and
`assistant.enabled` — asserted for all six, with no exceptions permitted. A
person who has turned the assistant off has withdrawn consent for it to act,
and that outranks any request.

### Denials

`account_inactive` · `device_unknown` · `device_revoked` ·
`assistant_disabled` · `permission_missing` · `integration_not_connected` ·
`resource_not_owned`

`device_unknown` maps to a 404, not a 403 — a device that is not this user's
should not be confirmed to exist, consistent with the rest of the codebase.

---

## 4. The confirmation contract

A proposal carries everything the brief specifies:

```jsonc
{
  "actionId":       "messaging.prepare",
  "userId":         "…",
  "deviceId":       "…",   // not optional
  "sessionId":      "…",
  "voiceSessionId": "…",   // when the request came by speech
  "kind":           "MESSAGE_WHATSAPP",
  "executionMode":  "ASSISTED",
  "params":         { "platform": "whatsapp", "recipient": "+91…", "message": "…" },
  "plan":           { "fields": [ … ] },
  "requiresConfirmation": true,
  "status":         "PENDING",
  "expiresAt":      "…"
}
```

### The preview cannot drift from what runs

`plan.fields` is produced by the action's own `preview()`, called with the
same validated `params` object that is later passed to its `handler`. Not a
copy, not a parallel formatter — the same values. A user approving a message
is approving the text that will be prepared.

### The approval sequence

1. authenticated (the global guard, before `decide` runs);
2. ownership validated — user **and** device;
3. expiry checked;
4. a settled attempt short-circuits rather than repeating;
5. authorization re-checked, inside the executor;
6. the action runs;
7. the result stored and returned.

### Rejection, expiry and cancellation are permanent

`REJECTED`, `EXPIRED` and `CANCELLED` have **no outgoing edge** in the state
table. That is the mechanism, not a check that could be forgotten: there is
no route by which a retry, a reconnect, a replayed approval or a background
sweep carries out an action the user refused.

Cancellation is recorded distinctly from rejection — rejection is the user
answering the question, cancellation is the user taking it back — so an audit
reader can tell them apart. Both bar execution. Cancellation is idempotent.

### The state machine

```
PENDING ──► APPROVED ──► EXECUTING ──► EXECUTED
   │            │            └───────► FAILED
   │            └──► CANCELLED · EXPIRED
   ├──► EXECUTING          (no confirmation required)
   └──► REJECTED · EXPIRED · CANCELLED
```

Terminal: `EXECUTED`, `FAILED`, `REJECTED`, `EXPIRED`, `CANCELLED`. Claimable:
`PENDING`, `APPROVED`, and nothing else.

---

## 5. Idempotency

Two mechanisms, both database constraints rather than application logic.

**The claim is a conditional update.** `updateMany where { id, status in
(PENDING, APPROVED) } → EXECUTING`. A second caller matches zero rows and
loses.

**The execution record carries a unique key, inserted in the same
transaction.** A second insert fails outright with `P2002`, and the loser is
handed the existing record.

| Strategy | Key | Used by |
| --- | --- | --- |
| `pending-action` | `{actionId}:{pendingActionId}` | notes.create, reminders.create, apps.launch, messaging.prepare |
| `pending-action-and-params` | `…:{clientKey or paramsDigest}` | notes.search, calendar.list |

`pending-action` **deliberately ignores a client-supplied key**. For a message
or a note created from one confirmation, "the client asked twice" is not a
reason to do it twice — and there is a test that sends two different client
keys and gets the same single execution back.

Natural keys exist too: `Note` and `Reminder` are unique on
`(userId, clientId)`, so an offline device replaying its queue updates rather
than duplicates.

### Where exactly-once cannot be guaranteed

Stated because it matters and because the brief asks.

**Within this backend, execution is exactly-once** for the actions in the
registry. They write to one PostgreSQL database, the claim and the execution
record are in one transaction with the write, and the unique key is enforced
by the database.

**Across a process death, it is at-most-once with an unknown outcome.** A
process that dies between claiming and settling leaves a `RUNNING` execution.
The handler may have had its effect first. So `reconcileStale()` marks it
`UNVERIFIED` — not `FAILED` — and moves the pending action to `FAILED` so
nothing claims it again. **It is not retried**, because retrying could
duplicate a real effect. The user is told the outcome is unknown and can
decide, which is the only honest option available.

**For a hand-off, there is no such thing.** `apps.launch` and
`messaging.prepare` produce a descriptor and a deep link. Whether the device
opened it, and whether the person pressed send, is unknowable here and is
never claimed. That is why both report `HANDOFF` with `verified: false`,
`openedByServer: false` and `sentByServer: false` as literal `false` in their
result schemas.

**For a future external provider, it will not be.** When a real send exists,
a timeout will mean "may have been delivered". The vocabulary for that already
exists — `UNVERIFIED` — and the engine already reports a timeout that way
rather than guessing.

---

## 6. Execution records

`ActionExecution` holds everything the brief lists:

| Field | Note |
| --- | --- |
| `actionId` | the registry id |
| `userId`, `deviceId`, `sessionId` | denormalised, so an audit needs no join |
| `attempt` | unique per pending action |
| `idempotencyKey` | **unique across the table** |
| `paramsDigest` | SHA-256 of the parameters |
| `status` | `RUNNING` → `COMPLETED` / `HANDOFF` / `PARTIAL` / `UNVERIFIED` / `FAILED` |
| `verified` | true only when the effect was read back |
| `detail` | plain language, for the user |
| `failureCode` | normalised; never a provider message |
| `resultRef`, `providerRef` | what was created |
| `startedAt`, `finishedAt` | written before and after |

### Parameters are not stored here

`paramsDigest` identifies them without keeping a second copy of a message
somebody wrote. The values live on the pending action; when that is purged the
message is gone, rather than living on in an execution log that outlives the
thing it describes. There is a test that writes a note containing a password
and asserts it does not appear in the execution record — or in the audit log.

### The status vocabulary

`RUNNING` is written **before** the handler runs. That ordering is the
duplicate guard, and it also means a crash leaves a visible record of an
attempt that may have had an effect, instead of no trace at all.

`COMPLETED` requires the handler to have read its own effect back.
`notes.create` re-reads the row it wrote; that is what earns `verified: true`
and why it means something. A handler cannot promote itself: the executor
sets `verified` to `outcome.verified && status === 'COMPLETED'`.

`UNVERIFIED` is used for a timeout, an abandoned attempt, and a result that
did not match its schema. In each case something may have happened and we
cannot say what — and "failed" would be the comfortable lie rather than the
true answer.

---

## 7. Error handling

| Condition | Result |
| --- | --- |
| Unauthorized action | 403, audited as `action.denied` |
| Missing permission | 403 naming what is off |
| Invalid parameters | 400, pending action → `FAILED`, nothing runs |
| Unregistered action id | 400, pending action → `FAILED`, nothing runs |
| Needs confirmation | 409 |
| Expired confirmation | 409, pending action → `EXPIRED` |
| Rejected / cancelled | 409, permanently |
| Duplicate execution | 200 with the original outcome, `duplicate: true` |
| Provider unavailable | `FAILED` with a normalised code |
| Timeout | `UNVERIFIED`, `attempt_timeout` |
| Partial execution | `PARTIAL` |
| Unverified result | `UNVERIFIED`, `result_schema_mismatch` |
| Handler threw | `FAILED`, `handler_error` — the message is logged, not relayed |

An inline execution that is refused outright is caught by the assistant and
reported as a failed turn: a turn that got as far as proposing an action
should tell the user what happened to it, not disappear into a 500.

---

## 8. Audit logging

Three distinct facts, recorded distinctly, so a reader can tell which
happened:

| Event | `actorType` | Meaning |
| --- | --- | --- |
| `assistant.action.proposed` | **`AI`** | the model suggested it |
| `assistant.action.approved` | `USER` | the person agreed |
| `assistant.action.rejected` | `USER` | the person refused |
| `action.cancelled` | `USER` | the person withdrew it |
| `action.denied` | `SYSTEM` | policy refused it |
| `action.executed` | `USER` | the server carried it out |
| `action.failed` | `USER` / `SYSTEM` | it was attempted and did not work |

`actorType: AI` on a proposal is the important one: a model-suggested action
is never indistinguishable from a human-initiated one.

Metadata carries identifiers and outcomes — action id, status, failure code,
attempt number, which permission was missing — and **never content**. The
audit service scrubs, and a test writes a password into a note and asserts it
does not appear.

`AuditLog` is append-only: nothing in the codebase updates or deletes a row,
and it survives account deletion with its user reference nulled, so the record
of what happened is pseudonymised rather than destroyed.

---

## 9. API

| Route | What it does |
| --- | --- |
| `GET /actions` | the allow-list, applications, messaging surfaces |
| `GET /actions/permissions` | what this user and device may currently do |
| `POST /actions/:id/execute` | run an approved action; idempotent |
| `GET /actions/history` | outcomes for this account, no parameters |
| `POST /assistant/actions/:id/decision` | approve (and run) or reject |
| `POST /assistant/actions/:id/cancel` | withdraw a proposal |

`GET /actions/permissions` is a convenience for hiding a control rather than
letting the user discover a refusal. It is only a view — the check that
matters runs again at execution time.

An assistant turn now carries an `execution` field: the report when an action
ran without needing confirmation, and `null` while a plan awaits approval,
because nothing has been attempted.

### Turn statuses

| Status | Meaning |
| --- | --- |
| `awaiting_confirmation` | a plan is ready; nothing attempted |
| `needs_clarification` | a question must be answered first |
| `executed` | carried out, and the effect was read back |
| `handed_off` | prepared; the person still has a step to take |
| `unverified` | may have taken effect; cannot confirm |
| `action_failed` | attempted, did not take effect |
| `answered` | answered in conversation |
| `unsupported` | understood, cannot be carried out |
| `failed` | interpretation failed; nothing attempted |
| `queued_for_execution` | reserved for deferred execution (job queue) |

The reply text for an executed turn is the **executor's** words, not the
model's. The model wrote its suggestion before anything ran and cannot know
the outcome, so it is not allowed to describe one. `notes.create` says "Note
saved."; the model's "Saved it." is a fallback for when nothing ran.

---

## 10. Honesty, specifically

Three places where the engine says less than it could:

**`reminders.create` stores a reminder and says so.** Nothing fires it — the
scheduler is not connected. `scheduled` is `false` in the result schema and
the wording is "Reminder saved. It will not alert you yet", not "I'll remind
you".

**`apps.launch` cannot open anything.** `openedByServer: false` is a literal
in the result schema so a client cannot read it another way.

**`calendar.list` is registered and refuses.** It needs an OAuth connection
that does not exist yet, so it reports `integration_not_connected` with an
empty list and a null source — never an invented event. An empty list and "no
events today" are different answers, and the status is what distinguishes
them. It is registered rather than omitted because omitting it would make the
assistant claim not to understand a request it understands perfectly well.

---

## 11. Configuration

| Variable | Default | Note |
| --- | --- | --- |
| `ACTION_TIMEOUT_MS` | 20000 | one attempt; overrun → `UNVERIFIED` |
| `ACTION_STALE_CLAIM_MS` | 120000 | longer than the attempt timeout |
| `ACTION_CONFIRMATION_TTL_MS` | 90000 | how long a proposal waits |

Rate limit: `POST /actions/:id/execute` at 30/min. Not the duplicate guard —
that is the idempotency key — but it bounds how fast a compromised client
could work through a list of proposals.

---

## 12. Tests

**84 new tests across two files; 443 in the backend suite.** All against the
deterministic language-model stand-in — no test contacts a vendor.

**`test/actions.spec.ts`** (44) — the allow-list contains exactly six actions;
every one carries a complete definition; every one requires an active
account, device and enabled assistant; an unknown id returns nothing;
`__proto__` and friends are missing entries; the registry and every
definition are frozen and pushing throws; confirmation policy is written in
exactly one place and the capability table derives it; no intent names an
action outside the registry; parameter mapping drops anything a handler did
not ask for and takes the timezone from the account; every intent's mapped
parameters satisfy its action's own schema; nothing leaves a barred or
terminal state; only `PENDING` and `APPROVED` are claimable; every execution
status maps to a turn status and none of hand-off, partial or unverified maps
to success; preference parsing salvages a malformed document; the launch
catalogue resolves exactly and has no shell metacharacter or interpreter
name; a composed link's protocol, host and path are fixed whatever the
message says; a recipient cannot alter the path; `mailto:` cannot carry an
injected header; the digest is order-stable and reveals nothing; and no
handler source contains `child_process`, `eval`, `fetch` or a filesystem
call.

**`test/execution.spec.ts`** (40) — a valid action runs, verifies its effect
and writes a complete record; parameters are **not** stored on the execution
record; a read completes and a hand-off stays a hand-off; an unregistered
action id, invalid parameters, an application outside the catalogue and a
reminder in the past are each refused with nothing run; the assistant being
turned off refuses everything and is audited; a specific preference refuses
only what it covers; a missing integration is reported rather than invented;
**authorization is re-checked in the gap between proposing and confirming**;
a revoked device cannot act; confirmation is required for a message and
nothing is attempted while it waits; the confirmation contract carries every
field; **confirmation cannot be skipped by going straight to execute, nor by
flipping `requiresConfirmation` in the row**; approval carries it out without
claiming to have sent it; **rejection permanently bars execution by three
different routes**; expiry likewise; overdue proposals expire in bulk;
cancellation is distinct, terminal and idempotent; a replayed approval is
handed the original outcome; executing twice creates one note; a client key
is ignored where idempotency is the confirmation; two concurrent executions
produce one attempt; the unique key is enforced by the database; a timeout is
`UNVERIFIED` and not `FAILED`; a throwing handler is `FAILED` and its message
is not relayed; a result that breaks its schema is `UNVERIFIED`; an abandoned
attempt is reconciled as unverified **and not retried**; cross-user and
**cross-device** access is refused on every route; history is scoped;
proposal, approval and execution are audited separately with the proposal as
`actorType: AI`; content never reaches the audit log; and the published
catalogue matches what the executor enforces while exposing no handler or
schema.

```bash
npm test      # 443 tests
```

### Tests this chunk deliberately changed

Chunk 4 asserted that approval "says plainly that nothing has run", and
chunk 5 that a voice session reaches `QUEUED`. Both described a build with no
executor. They were rewritten rather than removed, keeping their intent:
"never fake success" is now "`executed` appears only when the effect was read
back", and "approval queues it" is now "approval runs it and still does not
claim the message was sent".

---

## 13. What is not here

- **A job queue.** Every registered action runs inline; `queued_for_execution`
  is reserved for when deferred execution arrives with Redis.
- **Reminder delivery.** Reminders are stored, not scheduled, and say so.
- **Real sending.** Messaging prepares a draft. By design, not by omission:
  a message in someone's name should be seen by them first.
- **Calendar reading.** Registered, refusing, waiting for OAuth.
- **A grants table.** Permissions are derived from facts the server owns.
