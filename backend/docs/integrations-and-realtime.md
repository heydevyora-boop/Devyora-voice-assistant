# External integrations, OAuth and real-time communication

What this backend can actually do with WhatsApp, Instagram, Messenger,
Telegram, Gmail and Google Calendar — and the socket layer that carries the
assistant's events live.

One sentence version: **an official API connector is used only when a real,
scoped connection exists; otherwise the user-assisted connector prepares a
draft; nothing is ever reported as sent, delivered or completed beyond what
was actually verified.**

---

## 1. Three connector kinds, not one

`src/providers/integrations/types.ts`

| Kind | What it can honestly claim |
| --- | --- |
| `official-api` | Acts with an authorised credential. Can read back what happened for some operations (`verified`); for others the provider only confirms it accepted the request (`accepted`). |
| `user-assisted` | Prepares something — a draft, a deep link — and hands it to the device. Needs no account. Fidelity is always `prepared`. |
| `native-launch` | A descriptor for the device to open. No credential, no observable outcome. (Shared with the Chunk 6 action registry's `apps.launch`.) |

Every provider declares `fidelity` **per operation**, not once for the whole
connector, because it genuinely differs: Gmail can read back a draft it just
created (`verified`) but cannot read back whether a human opened it.

This is the whole answer to "do not implement unsupported actions as fake
success": a capability that does not exist returns `unsupported`, not a
best-effort guess, and a capability that exists but cannot be verified
returns `accepted` or `prepared`, never `verified`.

### Provider-agnostic. Capability-specific.

`IntegrationRegistry` holds one instance per `(provider, kind)` pair. A
request always goes through `IntegrationRegistry.forUse(provider,
hasConnection)`:

- a live official connection → the official connector, if it is configured;
- otherwise → the user-assisted connector, if one exists for that provider;
- otherwise → whichever is left.

That is the mechanism behind "a user with a personal WhatsApp account gets a
working draft, not an error about business verification": there is no
official connection, so the assisted route is chosen automatically.

---

## 2. What each provider actually is

### WhatsApp — `src/providers/integrations/meta.provider.ts`

**There is no official API for a personal WhatsApp account, and no
supported way to automate the WhatsApp app on somebody's phone.** What
exists is the WhatsApp Business Platform: a business phone number, Business
Verification, and an app that has passed Review. This backend does not
pretend otherwise.

| | |
| --- | --- |
| Operations | `messages.send` (confirmed) |
| Fidelity | `accepted` — Meta took the message; delivery is confirmed by webhook, which this build does not receive |
| Scopes | `whatsapp_business_messaging`, `whatsapp_business_management` (Advanced Access, App Review required) |
| Limitations | Free-form replies only within 24 hours of the user's last message; outside it, only an approved template works, and this adapter does not send templates — such an attempt fails with the provider's own error |
| Configured when | `META_APP_ID`, `META_APP_SECRET`, **and** `WHATSAPP_PHONE_NUMBER_ID` |

Without a business connection, `messaging.prepare` from the Chunk 6 action
registry routes to the **assisted** connector: a `wa.me` deep link with the
recipient and message encoded, opened by the device. The user presses send.
That hand-off is reported as `HANDOFF`, never as a send.

### Instagram and Facebook Messenger — same file

| | WhatsApp | Instagram | Messenger |
| --- | --- | --- | --- |
| Needs | Business phone number | Professional account + linked Page | A Page the user administers |
| Personal account | **Cannot connect** | **Cannot connect** | **Cannot connect** |
| Window | 24h | 24h | 24h |

All three are Advanced Access and require App Review; this is stated in
`limitations` on every operation, not just in this document, so a client
reading the capability metadata sees it without having to ask a person.

`threads.list` is `verified` — reading conversations the Page participates
in is something the response confirms, unlike a send.

### Telegram — `src/providers/integrations/telegram.provider.ts`

The deliberately different one, and the differences are the point:

- **No OAuth.** A bot token from BotFather is pasted in and verified against
  `getMe` before anything is stored. `authorizationUrl`, `exchange`,
  `refresh` are **absent** from this provider — not implemented as no-ops,
  genuinely not there, so a caller asking the capability table gets
  `supportsOAuth: false` rather than a flow that silently does nothing.
- **A bot cannot message an arbitrary phone number.** It can reply to a chat
  someone started with it, or post to a channel it administers. Sending to a
  phone number is caught and refused with an explanation (`unsupported`)
  rather than relayed as a confusing Telegram error.
- **No revoke endpoint.** `supportsRevoke: false`; disconnecting removes our
  copy of the token, and the connection view says to revoke the bot itself
  in BotFather.
- **Always "configured".** There is nothing for this backend to hold — the
  credential is the user's own bot — which is what makes Telegram usable
  with zero app registration on our side.

### Gmail and Google Calendar — `src/providers/integrations/google.provider.ts`

One adapter, two `ConnectionProvider` values (`GMAIL`, `GOOGLE_CALENDAR`),
because both share one OAuth client and one refresh mechanism — splitting
them would mean a user authorising twice for one grant.

| | Gmail | Calendar |
| --- | --- | --- |
| Scopes requested | `gmail.compose` — **not** `gmail.send** | `calendar.events.*` — not full calendar control |
| Write operation | `email.draft` → `verified` (the draft is read back) | `calendar.events.create` → `verified` (the event is read back) |
| What it cannot do | Send mail. The scope requested makes this true at the API level, not just in wording. | Invite guests — that would email other people, a separate consent. |

Both scopes are Google-classified as sensitive/restricted: until the OAuth
client passes Google verification, users see an "unverified app" warning and
the app is capped at 100 users. Stated in `limitations`, not discovered
later.

A refresh token is only issued on first consent, or when `access_type=offline`
**and** `prompt=consent` are both sent — this adapter sends both on every
authorization, because omitting either silently returns no refresh token and
the connection dies in an hour with no way back.

---

## 3. The OAuth framework

`src/modules/integrations/oauth.service.ts`

### The state parameter is a server-side row, not a signed blob

A signed state can be replayed until it expires. A **row consumed by one
conditional `UPDATE`** cannot be used twice — a callback either matches
exactly one in-flight authorization or it matches none, and there is a test
that races two callbacks against one state and gets exactly one connection.

The row also records **who started the flow**: the user and the device. The
callback is checked against both, which is the CSRF defence — a code
delivered to a different browser, or presented by a different session, is
refused. There is a test for each half of that (wrong user, wrong device).

Every refusal path — unknown state, expired, already consumed, wrong user,
wrong device — returns the identical message. Distinguishing them would tell
somebody probing the flow which guess was closer.

### PKCE

Used wherever the provider's flow supports it (Google; not Meta's
server-side dialog, which has no PKCE parameter at all — `usesPkce: false`
is reported rather than a challenge being sent and silently ignored).

The verifier is **sealed at rest**: it must be presented to the token
endpoint later, so it cannot be hashed, and it must never reach the browser,
so it cannot travel in the state parameter the way the challenge does.

### Scopes: requested vs. granted

`start()` validates requested scopes against what the provider declares —
asking for a scope that does not exist is a bug worth surfacing, not a
request to forward and let the provider reject.

What actually comes back from `exchange()` is **what the provider says it
granted**, which can be narrower: a user can untick a permission on Google's
consent screen and still be issued a token. `scopesNarrowed` in the callback
response says this happened. Every later operation check compares against
*granted* scopes, never *requested* ones — this is what turns "you unchecked
something" into a clear refusal instead of a confusing provider error three
steps later.

---

## 4. Credential encryption

`src/security/services/crypto.service.ts`

AES-256-GCM. Layout `IV ‖ tag ‖ ciphertext` in one column, because the three
pieces are useless apart and a row missing its tag would be a silent
integrity hole.

**Versioned keys**, so rotation is additive: `TOKEN_ENCRYPTION_KEY` holds
`version:base64` pairs — new material seals with the highest version; every
version configured is kept available for reads, so old rows stay readable
without a rewrite pass. `needsRotation(version)` flags a row sealed under a
retired key, for a future rotation sweep to act on.

**No key, no connection.** `CryptoService.available` is false with nothing
configured, and `OAuthService.start` refuses before a user is ever sent to a
consent screen — never storing a token unencrypted as a fallback.

`open()` never throws: a wrong key, a truncated buffer, a tampered tag all
return `null`. The caller's correct response is identical in every case
(treat the connection as broken, ask the user to reconnect), and
distinguishing them would only tell an attacker which part of a guess was
wrong.

---

## 5. Connections: the one place a credential exists in plaintext

`src/modules/integrations/connections.service.ts`

`ConnectionView` — what every route returns — **has no token field.** The
only place a plaintext access token exists anywhere in this codebase is a
local variable inside `ConnectionsService.withAccessToken`, for the duration
of one provider call, never returned, logged, or stored anywhere but the
sealed column.

### Refresh

Idempotent: a token still comfortably valid is left alone, so a retried job
does not churn credentials. A rejected refresh increments
`refreshFailures`; an `auth` rejection (the grant is simply gone) or five
consecutive failures marks the connection `EXPIRED` — a connection the
provider keeps refusing stops being retried every couple of minutes and
starts telling the user to reconnect, rather than silently never working
again.

A refresh response that omits a new refresh token (the common case) keeps
the one already stored rather than overwriting it with nothing — getting
this backwards is how a connection dies at its very first refresh.

### Disconnect

Revokes **at the provider**, not just locally — deleting our row alone
would leave the grant live in the user's Google or Meta account, the kind of
thing discovered years later. If the provider cannot be reached, the local
row is marked revoked anyway: a provider outage must not leave a user unable
to disconnect, and the response says plainly that the remote grant may still
be live.

### Execute

Four gates, cheapest first: the connection is the caller's and `CONNECTED`;
the provider declares the operation; the connection was **granted** the
scopes it needs (not merely asked for them); the access token is current,
refreshed first if it is not. A missing scope is reported as "reconnect to
allow this," which is the actual fix, rather than relayed as whatever error
the provider happens to produce for a scope it never had.

---

## 6. Real-time: the `assistant.*` gateway

`src/modules/voice/voice.gateway.ts`, event contract in
`voice-events.ts`

### The rename

Chunk 5's events were bare names (`session.created`, `response.ready`).
Chunk 8 renamed every one to the `assistant.*` form the brief specifies and
added three more:

```
assistant.session.created        assistant.action.started
assistant.listening               assistant.action.completed
assistant.transcript.partial      assistant.action.failed
assistant.transcript.final        assistant.response.ready
assistant.processing              assistant.session.cancelled
assistant.clarification.required  assistant.session.expired
assistant.confirmation.required   assistant.session.failed
```

The three `assistant.action.*` events did not exist before this chunk,
because nothing executed yet — an event name is a promise to a client, and
one meaning nothing would have had clients drawing a tick for work that
never happened. Now the action executor exists (Chunk 6) and publishes them.

### The envelope

Every event, voice or action, carries:

```ts
{ id, type, at, userId, deviceId, sessionId, seq, correlationId }
```

- **`id`** — a fresh UUID per event. This is the mechanism for duplicate
  handling: a reconnecting client compares ids, which is cheaper and surer
  than comparing contents.
- **`userId` / `deviceId` / `sessionId`** — who owns it and which session it
  belongs to. Delivered only into that user's or that device's room; never
  broadcast wider.
- **`seq`** — monotonic per session (zero for the ephemeral
  `transcript.partial`, which is never stored).
- **`correlationId`** — the request that caused it, read from
  `requestContext`, for tracing an event back to the call that produced it.

### Duplicate handling, on both ends

**Server-side:** each socket remembers the last 200 event ids it has been
sent. `deliver()` now emits **per socket** rather than to the whole room, so
it can skip a socket that already holds an id — the case a reconnect
produces when a replay and a live push overlap on the same event. A
replayed event is remembered too, so a live push of the same thing a moment
later is recognised.

**Client-side:** the event carries its own `id`, so a client doing the same
check independently is not relying on the server alone — belt and braces,
because either side can be wrong after a reconnect in isolation.

### Heartbeat

Socket.io has transport-level ping/pong; this adds an **application-level**
check on top, because a socket can be TCP-alive while the client is wedged —
and a wedged client holding a room membership is an event delivered
nowhere. `assistant.ping` from the client, a sweep every 30 seconds drops
anything silent for 90. The `connected` event tells a client both numbers up
front, plus the full `assistant.*` vocabulary, so it can validate event
names rather than discover them by observation.

### Action events, specifically

`ActionExecutorService` publishes `assistant.action.started` before a
handler runs (so a client shows work in progress, not a frozen orb) and
`assistant.action.completed` or `assistant.action.failed` once it settles —
**only when the pending action came from a voice session**: a REST-only
confirmation has no session for a client to be watching, and there is a test
confirming no event is sent for that path.

`assistant.action.completed` carries the executor's own status unchanged —
`COMPLETED`, `HANDOFF`, `PARTIAL` or `UNVERIFIED` — and `verified`. A client
listening on the word "completed" still sees `verified: false` and
`status: 'HANDOFF'` for an application launch; the event *name* is not the
thing that tells it whether to celebrate.

Published through the global `VoiceEventBus` (promoted to its own
`AssistantEventsModule` this chunk, exactly what `events/README.md`
described: a publisher never imports a consumer's module to reach it), never
awaited by the executor and never allowed to throw into it — a broken
listener or a slow socket write must not cost an execution.

### A bug this chunk's own tests found

`VoiceGateway`'s `@WebSocketServer()` field was typed `Server`, but with a
namespace configured on the gateway, what Nest actually injects at runtime
is the **Namespace** instance. The two types share enough members to compile
either way, but `Server.adapter` is a different thing from
`Namespace.adapter` — the former is a method for setting an adapter
*constructor*, the latter is the live Adapter instance holding room
membership. The mistyped version resolved to the wrong overload, threw
inside the bus listener (which `VoiceEventBus.publish` catches and logs),
and the result was **silent event loss**, not a crash — every delivery test
timed out. Retyping the field as `Namespace` fixed both the types and the
behaviour.

---

## 7. Background processing

`src/jobs/`

| Job | Every | What |
| --- | --- | --- |
| `refresh-integrations` | 2 min | Renews tokens inside the refresh lead time, ordered most-urgent-first, bounded to 200 per sweep |
| `purge-oauth-states` | 1 hr | Removes state rows a day past expiry or consumption |

Both idempotent for the same reason every job in this codebase is: a queue
gives at-least-once delivery, and `ConnectionsService.refresh` re-reads the
connection rather than trusting anything in the job payload — a token
refreshed by a race, or a connection disconnected since the job was
enqueued, is handled correctly either way.

`refreshExpiring` skips connections that have already hit
`MAX_REFRESH_FAILURES`, so a connection the provider keeps rejecting is left
for the user to reconnect rather than retried every two minutes forever.

---

## 8. API

All routes require authentication. All are under `/api/v1/integrations`.

| Route | What |
| --- | --- |
| `GET /integrations` | Every provider's real capabilities, including unconfigured ones |
| `GET /integrations/connections` | This account's live connections — no credentials |
| `POST /integrations/authorize` | Start OAuth; returns a URL, nothing connects yet |
| `POST /integrations/callback` | Finish OAuth; single-use, CSRF-checked |
| `POST /integrations/connect` | Connect with a supplied secret (Telegram) |
| `DELETE /integrations/connections/:id` | Disconnect, revoking at the provider where possible |
| `POST /integrations/connections/:id/refresh` | Renew now, rather than waiting for the sweep |
| `POST /integrations/operations` | Run a declared operation; response carries `fidelity` |

`GET /integrations` lists every provider this server knows, **including
ones with no credential configured**, marked `configured: false` — a user
should be able to see that Instagram exists and this deployment cannot offer
it, rather than wondering why it is missing.

---

## 9. Tests

**137 new tests; 681 in the backend suite.** All against stand-ins — no test
contacts a vendor, and no test sends a real message, per the brief.

**`test/crypto.spec.ts`** (16) — key parsing including versioned, bare,
malformed and duplicate entries; seal/open round-trip; a fresh IV every
call; refusal with no key; tamper detection; a buffer too short to be real;
an unknown key version; **reading old material after rotation while sealing
new material under the new key**; rotation flagging; constant-time
comparison.

**`test/integration-providers.spec.ts`** (35) — Google: unconfigured without
a client, `gmail.compose` never `gmail.send`, Gmail and Calendar as
genuinely distinct providers, confirmation required only for writes, a
PKCE+state authorization URL, refusal with no client, the unverified-app and
refresh-token limitations stated. Meta: unconfigured without an app,
WhatsApp specifically needing a phone number, **a personal WhatsApp account
stated as unconnectable**, `accepted` never `verified` for a send, the
24-hour window declared for every surface, App Review stated, per-surface
scopes, no PKCE claimed. Telegram: always configured, no OAuth methods at
all, a malformed token rejected before any request, a phone number refused
as a chat target, no revoke endpoint. The assisted connector: no OAuth
needed, `prepared` fidelity, address validation, no route for an
unsupported provider. The mock: records and performs nothing, narrower
grants, no-expiry tokens, scope enforcement.

**`test/integrations.spec.ts`** (41) — a single-use server-side state;
**replay refused**; unknown and expired states refused; **the CSRF
defence**, proved by an attacker's own session being unable to complete a
victim's state, and the state staying usable by its rightful owner;
**cross-device callback refused**; narrower-than-requested scopes recorded
and flagged; two racing callbacks settling on one connection; the three
distinct audit actions; Telegram token verification before storage;
disconnect revoking at the provider and marking (not deleting) the row;
**disconnect succeeding locally when the provider is unreachable**; refresh
renewing, leaving a valid token alone, **keeping the existing refresh token
when the provider omits a new one**, backing off through repeated failures
before marking `EXPIRED`; an unsupported operation refused distinctly from a
failure; a missing scope refused with "reconnect" as the fix; provider
outages reported honestly; a credential-rejection marking the connection for
reconnection; **an official-API send reported `verified`, never
`completed`-as-success**; **the assisted hand-off for an unconnected
WhatsApp account**; no token anywhere in any response; cross-user isolation
on every route; OAuth state cleanup respecting the audit retention window.

**`test/voice-gateway.spec.ts`** (+8, 24 total) — every event's envelope
(id, type, timestamp, ownership); the published `assistant.*` names;
heartbeat ping/pong and the numbers given at connect; **a replayed event not
delivered twice when a live push overlaps it**; `assistant.action.started`
→ `assistant.action.completed` for a voice-originated action, with the
right action id; a hand-off reported as `HANDOFF`/`verified: false` even on
the "completed" event name; **no action event for a turn with no voice
session**.

```bash
npm test      # 681 tests
```

### A bug found while writing these tests, not by them directly

`AssistedIntegrationProvider.execute` was declared to return
`Promise<OperationResult>` but was not an `async` function, so a validation
failure threw **synchronously** rather than rejecting the returned promise.
Any caller relying on the documented contract — `provider.execute(...).catch(...)`,
or `expect(...).rejects` in a test — would have the exception escape before
promise machinery ever got involved. Every other adapter was already
`async`; this one was made consistent.

---

## 10. What is not here

- **Delivery confirmation via webhook.** Meta and Telegram both offer one;
  receiving it is future work. Until then, a send is `accepted`, never
  `verified`, and the distinction is load-bearing rather than decorative.
- **Google verification / Meta App Review.** Both OAuth clients work today
  in their unverified/development state, which caps who can use them and
  shows a warning screen. Stated in capability metadata, not hidden.
- **Instagram/Messenger message *drafting*** (as opposed to sending through
  a live connection) — there is no assisted route for them, because there is
  no personal-account equivalent the way there is for WhatsApp and email.
- **A grants table for integrations.** Scope checks compare against what
  each provider's token actually carries; nothing is cached separately.
- **Cross-instance socket delivery.** Still in-process, as in Chunk 5; the
  Redis adapter for multi-instance delivery is unchanged future work.
