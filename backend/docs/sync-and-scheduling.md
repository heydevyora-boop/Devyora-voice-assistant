# Notes, reminders, sync, scheduling and notifications

The user's own data, kept in step across their devices, and the durable
machinery that makes a reminder actually arrive.

One sentence version: **a version counter the server owns decides conflicts,
deletions travel as tombstones, reminders live in Redis as delayed jobs with
Postgres as the source of truth, and nothing calls scheduling "delivered".**

---

## 1. Notes

`GET|POST /notes` · `GET|PATCH|DELETE /notes/:id` · `POST /notes/:id/restore`

| Field | Note |
| --- | --- |
| `title` | Optional, and **not invented**. A dictated note has none, and guessing one from the first few words would put the assistant's words in the user's data. |
| `content` | The note itself. |
| `source` | `VOICE` · `MANUAL` · `IMPORT`. Advisory: a client saying `VOICE` does not make a note dictated. |
| `language` | BCP-47, as detected at the time. Null when nothing detected it — not defaulted to English. |
| `version` | Incremented by the server on every accepted change. |
| `updatedByDeviceId` | Which surface made the change, so a syncing client can tell its own echo from somebody else's edit. |
| `pinned` | Floated to the top of a listing by default. |

### Listing

`?q=` searches title and content case-insensitively, Devanagari included.
`?pinned=`, `?source=`, `?language=` filter. `?sortBy=updatedAt|createdAt|title`
with `?order=`. `?dateField=` plus `?from=`/`?to=` for a date range.
`?includeDeleted=true` to see tombstones; ordinary listings hide them.
`?page=` and `?limit=` (capped at 100).

Indexed for the three queries that matter: `(userId, deletedAt, updatedAt
desc)` for listing, `(userId, updatedAt asc)` for incremental sync, and
`(userId, pinned, deletedAt)` for the pinned-first ordering.

### Idempotent creation

Sending a `clientId` makes a create an upsert, scoped by a unique index on
`(userId, clientId)`. A replayed request therefore updates the same row
rather than making a second one — which is what lets an offline device retry
after a dropped connection. **A client id is not a capability:** one user's
`note-1` is a different row from another's, enforced by that index.

Without a `clientId`, a repeated create is a genuinely new note and is
treated as one.

---

## 2. The conflict strategy

Stated once, and the same for notes and reminders.

Every synced record carries a `version`. A client sends `baseVersion` (or
`expectedVersion` on the REST routes): the version its edit was built on.

| Case | What happens |
| --- | --- |
| `base === stored` | Applied. Version increments. |
| `base < stored` | **Refused as a conflict.** Nothing is overwritten, and the server's copy comes back with the refusal. |
| `base` omitted | A deliberate "take mine". Applied. |

Omitting the version is the **only** way to win a conflict, which makes
overwriting somebody's work an explicit act rather than the side effect of a
race.

### Why not last-write-wins

Because it loses data for exactly the reason it is convenient. Two devices,
two clocks, and the one that is three minutes fast always wins — silently,
and in favour of whichever device happens to be wrong. A version counter the
server owns has no clock in it. There is a test that pushes a *later* change
with an *older* base and watches it lose.

### Per-record outcomes

A sync push returns one outcome per record rather than succeeding or failing
as a batch:

`created` · `updated` · `unchanged` · `conflict` · `deleted` · `rejected`

A device with fifty queued changes and one conflict gets forty-nine applied
and is told about the one. This also drove a real fix: `dueAt` on a pushed
reminder is validated **per record**, not by the request schema, because a
strict `@IsISO8601()` there meant one corrupt date rejected the whole batch —
which would permanently wedge a device that could never get past it.

`unchanged` does not bump the version. An idle client polling in a loop would
otherwise bump every record forever and make every other device re-download
them.

---

## 3. Deletions travel

Deletes are **soft**, always. A deletion is a change, and a device that was
offline has to learn about it — which it cannot do if the row is gone. So the
row stays with `deletedAt` set, its version increments, and it appears in the
next pull as a tombstone with `deleted: true`.

It is purged permanently after `SYNC_TOMBSTONE_DAYS` (30). That window is
therefore two things at once:

- how long an accidental delete is recoverable, and
- **the longest a device may be offline and still sync correctly.**

Purge sooner and a device returning after a fortnight silently keeps a note
the user removed. That is why the purge job runs every six hours against a
window measured in days rather than aggressively.

---

## 4. Sync

`GET /sync/status` · `GET /sync/pull` · `POST /sync/push` · `POST /sync/reset`

### The cursor

A pull returns everything changed at or after the cursor, plus a new cursor.
The cursor is a **server** timestamp, never the client's: a device with a
wrong clock would otherwise ask for the wrong window and silently miss
records.

The lower bound is inclusive and the returned cursor is the newest
`updatedAt` in the batch, so a record changed in the same millisecond as the
boundary is sent **again** rather than skipped. A duplicate is harmless — the
client upserts by id — whereas a skipped record is lost data.

Cursors are per device, stored in `SyncCursor`. Kept server-side as well as
on the client because a reinstalled app has forgotten its own and needs
somewhere to ask. `POST /sync/reset` forgets it, so the next pull is a full
one; it touches no data.

### Batches

`SYNC_MAX_BATCH` (200) bounds a push and a pull. A pull fetches one extra row
to answer "is there more?" without a second count query, and reports
`hasMore`.

`serverTime` is in every pull response, so a client can see its own drift.

---

## 5. Reminders

`GET|POST /reminders` · `GET /reminders/upcoming` · `GET /reminders/history`
`GET|PATCH|DELETE /reminders/:id` · `POST /reminders/:id/complete`
`POST /reminders/:id/snooze`

### Time, and why both are stored

`dueAt` is an instant, always UTC in the database. `timezone` says what
wall-clock time the user meant. Both, not one:

- a one-off reminder needs the instant;
- a **recurring** reminder needs the zone, because "every Monday at 9am" is a
  statement about the clock on the wall, and that is a different instant
  either side of a daylight-saving change.

`dueAt` accepts either form. `2026-11-10T08:00` is read in the reminder's
zone — what a date picker produces. `2026-11-10T08:00:00+05:30` is already
absolute — what the AI layer produces. Mixing them up is how a reminder ends
up five and a half hours out.

The zone comes from the client if it states one, otherwise the account's own,
otherwise `DEFAULT_TIMEZONE`. An invalid zone is **refused**, not quietly
replaced: a reminder in the wrong zone is a reminder at the wrong time.

### Daylight saving

Two cases, both reported rather than silently absorbed.

**The time does not exist.** At 01:30 on the night the clocks go forward
there is no such moment. Resolved to the moment the clock jumps to (02:30
local) and reported as `adjusted: { reason: 'skipped' }`. Later rather than
earlier, so a 01:30 alarm fires after the hour it was meant for.

**The time happens twice.** 01:30 occurs once before the clocks go back and
once after. Resolved to the **earlier** instant and reported as `adjusted:
{ reason: 'ambiguous' }`. This is a deliberate departure from Luxon's
default, which is the later one — an alarm an hour early is a smaller wrong
than one an hour late. It was also worth checking rather than assuming: the
first version of the detection never fired, because it looked an hour the
wrong way.

**Recurrence keeps the wall-clock hour.** The rule is expanded in floating
local time and the result rebuilt in the zone, so a weekly 09:00 London
reminder stays at 09:00 and the *instant* moves. Without that it drifts to
08:00 or 10:00 for half the year. Tested against real transition dates in
Europe/London and America/New_York.

### Recurrence rules

RFC 5545, parsed and bounded before anything is written — so an unusable rule
is a rejected request rather than a stored reminder that never fires.

- No more often than every **15 minutes**.
- A rule that produces no occurrence is refused.
- A rule set (multiple `RRULE` lines) is refused; its expansion is unbounded
  in ways a single rule's is not.

One bug worth recording: `RRule.toString()` emits a two-line iCalendar
fragment with a `DTSTART:` line, and storing that made it unparseable when
read back — so **every recurring reminder stopped recurring after its first
firing**. `normaliseRuleText` now extracts just the rule, and tolerates the
old two-line form in case a row still holds it.

### Completing and snoozing

Completing a one-off reminder marks it `DONE` and clears its job. Completing
a **recurring** one advances to the next occurrence, measured from the
occurrence being completed rather than from now — a reminder due next month
that you tick off today should move to the month after.

Snoozing computes from **now**, not from the time that was missed: pressing
snooze means "not for another ten minutes", not "ten minutes after the time
I already missed". `snoozeCount` records how many times.

Completing, deleting or cancelling clears `jobId`. A row still naming a
removed job would report `scheduled: true` and tell the user an alarm is set
when it is not.

### History

`GET /reminders/history` returns **occurrences**, not reminders. A weekly
reminder is one row, and "did Monday's go out?" is a question about one
firing. Each occurrence carries the notification it produced, so the answer
chains through to what the transport actually said rather than stopping at
"it was scheduled".

---

## 6. Durable scheduling

BullMQ over Redis. `QUEUE.reminders`, `QUEUE.notifications` (separate, so a
slow transport cannot delay the next firing) and `QUEUE.maintenance`.

Nothing in this codebase schedules a reminder with a timer. A delayed job
lives in Redis, not in a `setTimeout` that a deploy throws away.

### Redis is optional, and its absence is reported

With no `REDIS_URL`:

- the reminder is still stored;
- `jobId` stays null, so the response's `scheduled` field reads **false**;
- the readiness probe reports `scheduler: not-configured`;
- the assistant says "Reminder saved. It will not alert you yet."

A queue that pretended to accept work it could not hold would be worse than
one that says it cannot. With `REDIS_URL` set but unreachable, readiness
reports `down` — and the scheduler is one of the two checks that can fail
readiness, because an instance that cannot deliver reminders is not serving
the product even though it answers requests.

### Postgres is the source of truth

A job is a *prompt to act*; the reminder row is the record of what is
scheduled. This matters because Redis and Postgres are two systems that
cannot be written to atomically: a crash between writing the row and
enqueueing the job, a Redis flush, or a restart after a period with no Redis
all leave a row whose job is missing.

`JOB.reconcileReminders` closes that gap every minute: it finds reminders due
within the hour whose job id is absent, stale or no longer in Redis, and
enqueues them again. There is a test that deletes the job from Redis and
watches the sweep put it back.

### Deduplication

Three layers, each a constraint rather than a check:

1. **The job id** is derived — `reminder:{id}:{dueAtMs}` — not random. BullMQ
   holds one job per id per queue, so a repeated enqueue (a sweep racing a
   create) produces one job.
2. **The occurrence row** is `@@unique([reminderId, scheduledFor])`, created
   *before* anything is notified. A retried job, a duplicated enqueue or a
   restart all collide on it, so one instant produces one notification
   however many times the handler runs.
3. **The notification's `dedupeKey`** is `@@unique([userId, dedupeKey])`.

That third constraint started out globally unique, which was a cross-user
leak: one account's key could collide with another's, and the collision
handler would hand back **a notification belonging to someone else**. Scoping
it to the account fixed it, and the lookup is scoped to match.

### Retries

Three attempts, exponential backoff from 5 s. Deliberately modest: a reminder
that cannot be delivered after three tries over a couple of minutes will not
succeed on the fourth, and a reminder delivered an hour late is worse than
one reported as failed. The occurrence row records which happened.

### Idempotent handlers

Every handler is idempotent, because a queue gives at-least-once delivery: a
worker that dies after doing the work but before acknowledging it is handed
the same job again.

Nothing trusts its payload. A job carries ids; the handler loads the current
state. A reminder may have been completed, snoozed, rescheduled or deleted in
between, and the payload cannot know that — so the handler skips a reminder
that is deleted, done, or whose `dueAt` has moved.

### Graceful shutdown

`JobsService.onModuleDestroy` closes each worker, which lets BullMQ finish
the job in flight and return anything unstarted to the queue. Without it a
deploy mid-job would leave an occurrence marked `SCHEDULED` with no job to
fire it — recoverable by the sweep, but a needless trip through a broken
state.

### The maintenance schedule

| Job | Every | What it does |
| --- | --- | --- |
| `reconcile-reminders` | 1 min | Re-enqueues reminders whose job is missing |
| `reconcile-actions` | 2 min | Marks abandoned action attempts unverified |
| `expire-stale` | 5 min | Expires overdue voice sessions and pending actions |
| `cleanup-audio` | 10 min | Deletes temporary audio past retention |
| `cleanup-sessions` | 1 hr | Closes sessions with no live refresh token |
| `purge-deleted` | 6 hr | Removes tombstones past the window |

Each has a stable repeat key, so a restart *replaces* its schedule rather
than adding a second one — otherwise every deploy would multiply the number
of cleanup runs.

`JOBS_MAINTENANCE_ENABLED=false` turns the schedule off for an instance that
should only serve requests. `JobsService.inspect()` reports queue depths and
worker state; `runNow(name)` triggers one handler, which is safe because they
are idempotent.

Expired refresh tokens are kept a week past expiry rather than deleted at
expiry: presenting a rotated token is how token theft is detected, and
deleting the evidence immediately would turn a detectable replay into an
ordinary failed login.

---

## 7. Notifications

`GET /notifications` · `GET /notifications/unread-count` ·
`GET /notifications/transports` · `POST /notifications/token` ·
`POST /notifications/:id/read` · `POST /notifications/read-all`

### Scheduled, accepted, seen — never collapsed

| Status | What it actually means |
| --- | --- |
| `QUEUED` | A row exists. Nothing has been attempted. |
| `SENDING` | A transport is being asked. |
| `SENT` | A transport **accepted** it. It has taken responsibility for trying. It has not reached a device, and nobody has seen it. |
| `UNDELIVERABLE` | No transport exists for this account's devices, so nothing was attempted. |
| `FAILED` | A transport refused or was unavailable. |
| `READ` | A client said the person saw it. |

There is deliberately **no `DELIVERED`**. We cannot observe it, so there is
nothing to name. The dispatch report's wording — "Accepted by a transport.
Not confirmed as seen." — is asserted in the tests, because that is the
sentence most easily softened into a lie.

`UNDELIVERABLE` is distinct from `FAILED` on purpose: "the user has no push
set up" and "a transport refused" are different facts, and the first is not a
delivery failure. Either way the row exists, so the in-app list shows what
was missed.

### In-app

The channel that always works, and the one that needs no credential: the row
*is* the notification, served from `GET /notifications`. A notification whose
push could not be delivered is still there.

### Push

`src/providers/push/` — same provider abstraction as the other modalities.

| Adapter | Reaches | Auth |
| --- | --- | --- |
| `fcm` | Android, iOS via Firebase | Service account → RS256 JWT → OAuth token, cached |
| `apns` | iOS, macOS | ES256 JWT signed with the .p8 key, cached ~50 min |
| `mock` | all | Records; sends nothing |

Both auth flows are implemented properly rather than stubbed, because there
is no shortcut: FCM v1 has no long-lived API key, and APNs token auth is the
only form Apple has not deprecated. The APNs signature uses
`dsaEncoding: 'ieee-p1363'` — Node's DER default produces a 403 that looks
exactly like a bad key.

Selection is **per platform**, unlike the single-provider registries: a
user's devices can span Android and iOS. A provider with no credential is
never selected; the fallback is the recording stand-in. A platform with no
transport yields `UNDELIVERABLE` rather than a silent loss.

A device with no push token is **not a target**. Including it would turn "the
user has no push set up" into a delivery failure. A token the transport
rejects as dead is cleared from the device row, so nothing keeps trying it.

`GET /notifications/transports` reports, per device, whether it is registered
and reachable — so a client can tell the user push is not set up rather than
leaving them to wonder why a reminder never arrived.

### Preferences, not duplicated

Notification settings live in `UserPreference.assistant` alongside the action
switches. The timezone lives on the **user** record; voice settings live in
`UserPreference.voice`. Nothing here restates either — a second copy of a
preference is a second answer waiting to disagree with the first.

A muted type is **not created at all**, rather than created and then not
sent: there is nothing to report on, and a row would imply we tried.

Quiet hours handle a window crossing midnight (22:00–07:00), which a naive
comparison gets backwards. A reminder due inside them is still delivered — a
silenced alarm is not an alarm.

---

## 8. Configuration

```
REDIS_URL=redis://…          # no URL means no durable scheduling, reported
JOBS_MAINTENANCE_ENABLED=true

DEFAULT_TIMEZONE=Asia/Kolkata
SYNC_TOMBSTONE_DAYS=30       # also the max offline window
SYNC_MAX_BATCH=200
REMINDER_UPCOMING_DAYS=30

PUSH_PREFERRED=fcm,apns
PUSH_TIMEOUT_MS=10000
FCM_SERVICE_ACCOUNT=         # the whole JSON document, one line
APNS_KEY_ID= / APNS_TEAM_ID= / APNS_BUNDLE_ID= / APNS_PRIVATE_KEY=
APNS_SANDBOX=false
```

Rate limits: `sync/pull` 120/min, `sync/push` 60/min — generous, because sync
is chatty by nature and the batch size is the real bound on work.

`.env.example` holds **placeholders only**. No push credential exists in this
repository; the stand-in records and `hasRealTransport` reports false.

---

## 9. Data

`Note` — title, content, source, language, version, `updatedByDeviceId`,
soft delete.

`Reminder` — text, instant, zone, rrule, status, `jobId`, `firedAt`,
`completedAt`, `snoozedUntil`, `snoozeCount`, version, soft delete.

`ReminderOccurrence` — one firing. `@@unique([reminderId, scheduledFor])`,
which is the deduplication guarantee. Carries its notification id and a
normalised failure code.

`Notification` — type, title, body, routing payload, status,
`attemptCount`, `providerId`, `providerRef`, `dedupeKey`
(`@@unique([userId, dedupeKey])`), `sentAt`, `readAt`, failure code.

`SyncCursor` — one row per device: `notesCursor`, `remindersCursor`,
`lastPulledAt`, `lastPushedAt`.

Two migrations, verified by applying all seven to an empty database and
diffing against the schema — no difference. The `notes.text` → `notes.content`
rename was **hand-edited** from Prisma's generated `DROP` + `ADD`, which
would have discarded every existing note; a `RENAME COLUMN` keeps the data
and is what the change actually is.

---

## 10. Tests

**137 new tests; 581 in the backend suite.** The reminders suite runs against
a live Redis with the real workers consuming, not a mocked queue.

**`test/time.spec.ts`** (35) — zone validation, including the tz database's
legacy fixed-offset entries (`EST` is not a synonym for America/New_York, and
the test shows why); wall-clock-to-instant in several zones; **a time that
does not exist** in London and New York; **a time that happens twice**,
resolved to the earlier instant and reported; no false positives in a zone
with no DST; recurrence parsing and its bounds; **recurrence keeping the
wall-clock hour across both DST directions**; the schedulable window; quiet
hours across midnight.

**`test/notes.spec.ts`** (32) — CRUD; no invented title; soft delete bumping
the version so the deletion can travel; restore; idempotent creation by
client id; a client id scoped to the account; a conflict refused with the
server's copy returned and **the other device's change intact**; a deliberate
overwrite; search across Latin and Devanagari; filters; date ranges;
pagination and its cap; deleted hidden unless asked; cross-account isolation
on every route; any of the account's own devices being allowed; retention
purging the old and keeping the recent.

**`test/sync.spec.ts`** (23) — upload creating records; **a replayed batch
changing nothing and not bumping versions**; one bad record rejected without
failing the batch; the batch size limit; a conflict returning the server copy
with nothing overwritten; **not last-write-wins**, proved by a later push
with an older base losing; a deliberate overwrite; deletions arriving as
tombstones at the other device; deleting something that never existed;
idempotent double-delete; recreation reviving a row; incremental pull and
per-device cursors; pagination; the server clock; reset; **a client id unable
to reach or delete another account's record**.

**`test/reminders.spec.ts`** (47) — creation genuinely enqueuing a job in
Redis; the wall-clock reading presented alongside the instant; the account's
zone used; an unknown zone refused; a DST adjustment reported; update
cancelling the old job and the superseded job being gone; stale-version
conflict; delete cancelling the job; idempotent create; complete clearing the
schedule; **a recurring reminder advancing instead of ending**; snooze
measured from now; snooze counting; rules that repeat too often or are
unreadable refused with nothing stored; upcoming ordering; **firing creating
an occurrence and a notification**; **one occurrence however many times the
job runs**; skipping a deleted, completed or rescheduled reminder; **a
recurring reminder keeping 09:00 across a DST change after firing**; history;
**reconciliation putting back a job Redis lost**; reconciliation not
resurrecting a deleted reminder; dispatch accepting without claiming it was
seen; `UNDELIVERABLE` when no device has a token; dedupe by key; idempotent
dispatch; a retryable failure re-thrown for backoff; a permanent failure
clearing the dead token; a muted type creating nothing; read tracking;
transports reported per device; cross-account isolation; worker inspection;
every maintenance handler run twice; an unknown job name refused.

```bash
npm test      # 581 tests
```

### Bugs these tests found

1. **Recurring reminders stopped recurring.** The stored rule carried a
   `DTSTART:` line that could not be re-parsed. Every recurring reminder
   would have fired once and then gone quiet.
2. **A notification `dedupeKey` was globally unique**, so one account's key
   could collide with another's and the handler would return *another user's*
   notification id.
3. **Completing or deleting a reminder left `jobId` set**, so it reported
   `scheduled: true` with no job behind it.
4. **Completing a recurring reminder did not advance it** when its due time
   was in the future, because the next occurrence was computed from now.
5. **One corrupt date rejected a whole sync batch**, which could permanently
   wedge a device holding queued changes.

---

## 11. What is not here

- **Realtime fan-out of in-app notifications.** They are served from the
  database; pushing them over the existing socket is a follow-up, and the
  gateway is voice-scoped today.
- **A push credential.** The stand-in records; `hasRealTransport` is false.
- **Reminder delivery to a desktop client.** The transports cover Android,
  iOS and macOS; a Windows or web client reads the in-app list.
- **Natural-language date parsing.** It happens in the AI layer (Chunk 4),
  which resolves "tomorrow at 8" against the user's zone and hands this
  module an instant. This module validates and schedules; it does not parse
  prose.
