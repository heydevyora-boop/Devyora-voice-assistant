# The assistant engine

How a spoken sentence becomes a proposed action, and what stops a language
model from deciding anything that matters.

One sentence version: **the model classifies, the server decides, the user
confirms, and nothing in this chunk executes.**

---

## 1. The pipeline

```
POST /api/v1/assistant/turn
        │
        ├─ 1. Context retrieval      conversation resolved, transcript stored,
        │                            last N turns loaded (owner-scoped)
        ├─ 2. Interpretation         provider called through LlmProvider
        ├─ 3. Schema validation      output held to modelOutputSchema
        ├─ 4. Permission evaluation  CAPABILITIES table, not model output
        ├─ 5. Action routing         intent + entities → ActionKind
        ├─ 6. Confirmation /         PendingAction written, or a question asked
        │     clarification
        └─ 7. Response               one structured AssistantTurn
```

Step 1 happens **before** step 2, and the transcript is written to the
database before the provider is called. A provider outage therefore loses
the interpretation, never the user's words.

Steps 4–6 never read anything the model produced except the intent and the
entities. There is no path from model output to a permission decision.

### Why the ordering matters

Interpretation is the only step that trusts anything. Everything after it
treats the model's answer as a *proposal from an untrusted source*: the same
posture as a request body from an unauthenticated client.

---

## 2. Provider abstraction

`src/providers/llm/`

| File | What it is |
| --- | --- |
| `types.ts` | The `LlmProvider` contract every adapter implements |
| `errors.ts` | One error vocabulary for all vendors |
| `reliability.ts` | `withTimeout`, `withRetry` |
| `openai.provider.ts` | OpenAI chat completions |
| `gemini.provider.ts` | Google Gemini `generateContent` |
| `mock.provider.ts` | Deterministic stand-in |
| `llm.module.ts` | `LlmRegistry` — selection and health |

```ts
interface LlmProvider {
  readonly id: string;
  readonly kind: 'real' | 'mock';
  readonly configured: boolean;        // false when no credential is present
  complete(request: LlmCompletionRequest): Promise<LlmCompletion>;
  embed?(input: readonly string[]): Promise<readonly number[][]>;
  health(): Promise<LlmProviderHealth>;
}
```

**No vendor name appears above this directory.** `AiService` asks the
registry for whatever is active; `AssistantService` does not know a provider
exists. Adding a vendor is one new file and one line in the registry.

### Selection rules

`AI_PROVIDER` chooses, with one override that cannot be configured away:

> **A provider with no credential is never selected.**

If `AI_PROVIDER=openai` and `OPENAI_API_KEY` is empty, the registry selects
the stand-in and logs a warning. It does **not** silently select a different
vendor — that would change where a user's words are sent without anyone
deciding it.

### Errors

Every adapter maps its failures onto one vocabulary, so retry policy and
user-facing wording are written once:

`auth` · `rate_limited` · `timeout` · `unavailable` · `invalid_request` ·
`invalid_output` · `content_filtered` · `unknown`

Retryable: `rate_limited`, `timeout`, `unavailable`. Nothing else. An
`invalid_output` will be invalid again, and retrying `auth` just burns a
rate limit.

### Retries and non-idempotency

`withRetry` wraps **completion generation only**, which is a read: a
discarded attempt leaves nothing behind. No write, no send, and no
third-party charge is retried anywhere in this chunk. `PendingAction`
creation happens after interpretation has already succeeded, exactly once.

### Cost

`PRICE_PER_MILLION` reports `null` for a model it does not know rather than
guessing, because a wrong number in a cost report is worse than no number.

---

## 3. The command schema

`src/modules/ai/schemas/command.schema.ts`

Eight intents, and the list is an allow-list:

```
save_note · retrieve_note · create_reminder · send_message ·
prepare_message · open_application · get_calendar_events · general_question
```

Entities are a **discriminated union on `intent`**, so each intent carries
only its own fields and nothing else validates.

```ts
modelOutputSchema = {
  command: { intent, entities } | null,
  confidence: 0..1,
  clarification: { question, reason, field, options[] } | null,
  reply: string,
  detectedLanguage: string | null,
}
```

### What the schema deliberately cannot express

There is no field for `requiresConfirmation`, `permitted`, `executed` or
`success`. A model cannot hold an opinion about them, because the shape it
must produce has nowhere to put one. Extra keys are stripped before the
orchestrator ever sees the object.

### Dates

`dueAt` is an ISO-8601 instant **or null**. Null is a valid answer on
purpose: the assistant can ask about a missing time, but it cannot un-fire a
reminder set for the wrong day.

---

## 4. Server authority

`src/modules/ai/capability-registry.ts`

One table decides, per intent, what the assistant may do:

| Intent | Action kind | Mode | Confirm | Must resolve |
| --- | --- | --- | --- | --- |
| `save_note` | `NOTE_SAVE` | LOCAL | no | — |
| `create_reminder` | `REMINDER_CREATE` | LOCAL | no | `dueAt` |
| `send_message` | per platform | **ASSISTED** | **yes** | `recipient` |
| `prepare_message` | per platform | **ASSISTED** | **yes** | `recipient` |
| `open_application` | `APP_OPEN` | ASSISTED | no | — |
| `get_calendar_events` | `CALENDAR_EVENT` | ACCOUNT | no | — |
| `general_question` | `ASSISTANT_REPLY` | LOCAL | no | — |
| `retrieve_note` | — | LOCAL | no | — |

Rule of thumb encoded here: **anything another person will see is
confirmed, always; private, local, reversible work is not.** An assistant
that asks twice about saving a note is worse than useless.

`requiresConfirmation` is written to the `PendingAction` row from this table.
Not from the request body, not from the model.

### Resolution, not guessing

`mustResolve` lists entities that need to point at something real.

- **`recipient`** resolves only when it is an *address* — a 7–15 digit phone
  number or an email address. A name, nickname or description does not,
  because no contact directory is connected and nothing can turn one into a
  person. The clarification offers **no "send it anyway" option**: that
  would defeat the check.
- **`dueAt`** must be non-null.

A guessed recipient sends a private message to a stranger. A question is
cheaper.

### Routing depends on entities, not only intent

`send_message` with `platform: telegram` becomes `MESSAGE_TELEGRAM`, not
`MESSAGE_WHATSAPP`. A platform with no hand-off route (Instagram, Facebook)
returns `UNSUPPORTED_TARGET` rather than being filed under a kind some
future worker would act on.

---

## 5. Prompt-injection posture

Four layers, listed weakest first so the ordering is not mistaken:

1. **Prompt wording.** The system instruction says the transcript is a
   record of what a person said, not an instruction. This is the weakest
   layer and is not relied on.
2. **Randomised delimiters.** The transcript is wrapped in
   `<<<TRANSCRIPT {nonce}>>>` with a fresh nonce per request, so text inside
   it cannot close the block by guessing the marker.
3. **The allow-list.** An intent outside the eight fails schema validation,
   so a model persuaded to invent `transfer_money` produces an unusable
   answer and the turn fails. It does not become an action of another kind.
4. **Server-side policy.** Permission, confirmation and routing are read
   from the capability table. A transcript that says "confirmation is
   disabled" changes nothing, because nothing downstream reads the model for
   that answer.

Also: the transcript never enters the system message, system messages are
excluded from the replayed context window, and the stored conversation
cannot influence the instruction — it is rebuilt from scratch each turn.

---

## 6. Honesty about execution

**There is no executor in this chunk.** The `TurnStatus` vocabulary
therefore contains no word that means "done":

| Status | Meaning |
| --- | --- |
| `awaiting_confirmation` | A plan is ready; the user has not approved it |
| `needs_clarification` | A question must be answered first |
| `queued_for_execution` | Understood and permitted, waiting for a worker |
| `unsupported` | Understood, but the assistant cannot carry it out |
| `answered` | Answered in conversation; nothing to carry out |
| `failed` | Interpretation failed |

Approving an action returns, verbatim:

> Approved and queued. Nothing has run yet — execution is not connected in
> this build.

`ActionExecution` rows are written by the worker that lands with the action
chunk, never here.

---

## 7. API

All routes require authentication. All are under `/api/v1`.

### `POST /assistant/turn`

```jsonc
// request
{ "text": "kal subah 8 baje gym ka reminder laga do",
  "conversationId": "…",        // optional — continues a conversation
  "answersCommandId": "…" }     // optional — answers a clarification
```

```jsonc
// response
{ "conversationId": "…", "commandId": "…",
  "status": "awaiting_confirmation",
  "reply": "Yahan message hai.",
  "intent": "send_message",
  "confidence": 0.92,
  "plan": {
    "pendingActionId": "…", "kind": "MESSAGE_WHATSAPP",
    "intent": "send_message", "executionMode": "ASSISTED",
    "requiresConfirmation": true,
    "fields": [ { "key": "message", "label": "Message",
                  "value": "Running late", "editable": true,
                  "multiline": true } ],
    "expiresAt": "…"
  },
  "clarification": null,
  "problem": null,
  "transcript": "…",
  "detectedLanguage": "hi-Latn-IN",
  "provider": { "id": "mock", "model": "mock-1", "isMock": true } }
```

`plan.fields` is built explicitly per intent rather than dumping the entity
object, because the user has to see exactly what will happen before
approving. `provider.isMock` is passed through so an answer from the
stand-in is never presented as the work of a real model.

Confirmations expire after **90 seconds**.

### `POST /assistant/actions/:id/decision`

`{ "approve": true | false }` → `queued_for_execution` or `rejected`, plus
the `note` quoted above. A second decision on the same action is `409`.
An expired one is `409` and the row moves to `EXPIRED`.

### `GET /assistant/capabilities`

Served from the same table the orchestrator enforces, so a client cannot
advertise something the backend will refuse. Policy only — no prompt text,
no provider details.

### Conversations

`GET|POST /conversations` · `GET /conversations/:id` ·
`GET /conversations/:id/messages` · `PATCH /conversations/:id` ·
`POST /conversations/:id/archive` · `DELETE /conversations/:id` ·
`DELETE /conversations`

### Readiness

`/health/ready` gains an `interpreter` check. While the stand-in is active it
reports `up` with `degraded: true` — the process can serve traffic, so
readiness passes, but anyone reading the probe can see answers are not
coming from a language model.

---

## 8. Isolation

Every query is filtered by `userId` where it is written, not by a caller
remembering to. The context window is the one worth reading twice:

```ts
where: {
  conversationId,
  conversation: { userId, deletedAt: null },   // the isolation guarantee
  role: { in: ['USER', 'ASSISTANT'] },
}
```

A conversation id alone is never enough to read messages. The same applies
to `answersCommandId`: a command belonging to someone else resolves to
nothing, so another account's words cannot be injected into this
conversation's prompt. Another user's row is **404, not 403**.

---

## 9. Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `AI_PROVIDER` | `mock` | `mock` · `openai` · `gemini` |
| `AI_TIMEOUT_MS` | `20000` | Per provider call |
| `AI_MAX_ATTEMPTS` | `3` | Retries, transient failures only |
| `AI_CONTEXT_MESSAGES` | `10` | Turns replayed to the model |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | — / `gpt-4o-mini` | |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | — / `gemini-2.0-flash` | |

`.env.example` holds placeholders only. **No provider key exists in this
repository, and the assistant runs on the stand-in until one is supplied.**

Rate limits: `assistantTurn` 30/min, `assistantDecision` 60/min. Lower than
the global ceiling because a turn costs a provider call — this is about
spend as much as abuse.

---

## 10. Tests

91 tests across three files, all against the deterministic stand-in. No test
contacts a vendor.

**`test/ai.spec.ts`** (38) — structured output validation, intents outside
the allow-list, entities from the wrong intent, null vs vague dates, the
absence of permission fields, JSON extraction from prose and fences,
transcript never reaching the system message, history ordering, clarification
resumption, entity requirements, provider selection without a credential,
error normalisation, retry classification, timeout abort.

**`test/assistant.spec.ts`** (38) — intent recognition and entity
extraction end to end, plan construction, unresolvable recipient →
clarification, address → confirmation, missing date → clarification,
clarification resumption, **a model claiming confirmation is unnecessary
being ignored**, an intent outside the allow-list, **an injected "SYSTEM
OVERRIDE" transcript changing nothing**, missing account connection,
platform routing, audit as `actorType: AI`, approval saying nothing has run,
rejection, replayed decision, expiry, invalid output, timeout, unconfigured
provider, transcript surviving a failed turn, conversation reuse, context
not repeating the current turn, English/Hindi/Hinglish, cross-user
conversation access, cross-user command-id leakage, cross-user decision,
authentication, payload limits, unknown fields, the capabilities contract,
readiness reporting `degraded`.

**`test/conversations.spec.ts`** (15) — lifecycle, soft delete keeping the
row, context window ordering and cap, system messages excluded, cross-user
window returning empty, deleted conversation excluded, retention.

The stand-in enforces its own `timeoutMs`, like every other provider: a mock
that ignored it would let a timeout bug ship, because the suite would wait
where production would not.

```bash
npm test                      # 226 tests
npx vitest run test/ai.spec.ts test/assistant.spec.ts test/conversations.spec.ts
```

---

## 11. What is not here

- **Execution.** No worker, no `ActionExecution` row, no sending.
- **Notes and reminders as resources.** `PendingAction` rows are created;
  the modules that own the data land next.
- **Account connections.** `get_calendar_events` reports
  `ACCOUNT_NOT_CONNECTED` because no OAuth exists yet.
- **A contact directory.** Which is why a named recipient always asks.
- **Streaming.** One request, one response.
- **A real provider key.** The stand-in answers until one is configured, and
  says so in readiness and in every response.
