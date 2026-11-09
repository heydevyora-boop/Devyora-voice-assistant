# Voice: recognition, synthesis and sessions

How speech becomes a transcript, a transcript becomes a proposed action, and
a reply becomes a voice — and what the backend refuses to do along the way.

One sentence version: **the device listens, the server transcribes only what
it is given, audio is deleted as soon as it has been used, and nothing a
stand-in produced is ever presented as something that was heard.**

---

## 1. Two input modes, both first-class

| Mode | Who recognises speech | Audio reaches the server |
| --- | --- | --- |
| `TEXT` | the device | **never** |
| `UPLOAD` | the server | one bounded recording |
| `STREAM` | the device, incrementally | no — partial text only |

`TEXT` is what the web client uses: the browser's own recogniser produces
text and no audio leaves the machine. That is the better arrangement
wherever the platform supports it, so it is a first-class mode rather than a
fallback — and it is the reason the contract is *text in*, not *audio in*.

`UPLOAD` exists for platforms with no usable local recogniser. It is the
only path on which the user's voice reaches this backend at all.

`STREAM` carries interim **text** over the socket while someone is still
speaking. It does not carry audio. See §7.

---

## 2. The pipeline

```
POST /voice/sessions                        → session, state CREATED/LISTENING
   │
   ├── POST /voice/sessions/:id/audio       (UPLOAD)
   │      1. validate bytes      → magic number, size, duration
   │      2. write to temp store → 0600, server-generated name
   │      3. transcribe          → provider, retried on transient failure
   │      4. delete recording    → in `finally`, always
   │
   ├── POST /voice/sessions/:id/transcript  (TEXT)
   │
   └── both continue:
          5. record transcript   → state TRANSCRIBING → INTERPRETING
          6. assistant turn      → Chunk 4's engine, unchanged
          7. map status → state  → clarification / confirmation / queued
          8. optional speech     → never allowed to cost the text reply
          9. response.ready
```

Steps 1–4 are the only place audio exists. Step 6 is the Chunk 4 assistant
engine called as-is: this module does not interpret anything, does not
decide permissions, and does not execute.

---

## 3. Audio formats

Decided from the **bytes**, never from `Content-Type` or the filename. A
client can claim anything; a container's magic number is what it actually
is. This is not pedantry: the recogniser picks a decoder from what we tell
it, and handing a decoder something other than what it expects is how a
media library gets to misbehave.

| Container | Magic | Canonical MIME | Duration known? |
| --- | --- | --- | --- |
| WAV (PCM) | `RIFF`…`WAVE` | `audio/wav` | **yes, exactly** |
| WebM (Opus) | `1A 45 DF A3` | `audio/webm` | no |
| Ogg (Opus/Vorbis) | `OggS` | `audio/ogg` | no |
| MP3 | `ID3` or `FF Ex/Fx` | `audio/mpeg` | no |
| MP4 / M4A (AAC) | `….ftyp` | `audio/mp4` | no |
| FLAC | `fLaC` | `audio/flac` | no |

Declared types that map onto these are accepted as equivalents, including
`audio/x-wav`, `audio/x-m4a`, `audio/webm;codecs=opus` and `video/webm` —
which is what a browser's `MediaRecorder` labels an audio-only WebM.

### Duration

WAV duration is measured exactly, by walking the header (chunks are not in
a fixed order, and real encoders insert `LIST`). For every other container
`durationMs` stays **null**: this service does not decode audio, so it does
not know. A plausible number estimated from the file size would be believed
by something later.

The length limit is therefore enforced **twice**:

1. on bytes, before any provider call;
2. on the real duration, once the provider reports one.

Both are needed — a byte ceiling cannot catch four minutes of silence in a
200 KB Opus file.

### Rejections

Each is a distinct code, so a client can say what to do differently instead
of "upload failed":

`audio_missing` · `audio_too_small` · `audio_too_large` ·
`audio_unsupported_format` · `audio_format_mismatch` · `audio_too_long`

`audio_format_mismatch` is deliberately separate from
`audio_unsupported_format`: one is a client sending something we do not
handle, the other is a client lying about what it sent.

---

## 4. Temporary storage and cleanup

`src/modules/voice/audio/audio-store.service.ts`

Three properties, in the order they matter.

**Nothing is kept that does not have to be.** The pipeline writes a file,
transcribes it, and deletes it in a `finally` block — on success, on
provider failure, on cancellation. A failure is not an excuse to leave bytes
behind.

**No client input reaches the filesystem.** Keys are 32 hex characters of
`randomBytes`, validated against `/^[0-9a-f]{32}$/` on *every* read and
delete, joined to one directory whose resolved path is re-checked. An
upload's filename is discarded on arrival: it is attacker-controlled text
whose only possible contribution is a path.

**The directory is the service's alone.** Created `0700`, files `0600`, and
emptied at startup so files left by a crashed process do not accumulate
someone's speech on disk. Files the service did not create are left alone
rather than deleted on a guess.

### Retention

| Setting | Meaning |
| --- | --- |
| `DISCARD` | **the default** — deleted as soon as it has been transcribed |
| `SESSION` | kept until the session ends, so a retry needs no second recording |
| `RETAIN` | kept for the number of days the user chose |

Retention is opt-in, per user, and `DISCARD` is what happens unless somebody
changed it. When audio is deleted, `storageKey` goes **null** and
`deletedAt` is set, so the row says "this existed and is gone" rather than
pointing at a file that is not there. Metadata — size, duration, checksum —
survives; the bytes do not.

**Cancellation ignores retention.** A user who cancels expects the recording
gone, not kept because a setting about *completed* turns said so.

The sweep (`applyAudioRetention`) makes two passes: rows whose window has
closed, then any file on disk that no live row claims. The second pass is
the backstop for a lost row or a failed delete, age-gated by 60 seconds so a
sweep running mid-upload does not delete audio being transcribed.

---

## 5. Providers

### Speech recognition — `src/providers/stt/`

| Adapter | Streaming | Language detection | Confidence | Mixed Hindi–English |
| --- | --- | --- | --- | --- |
| `whisper` | no | yes | **no** | `detected-as-one` |
| `google` | no | yes | yes | `alternatives` |
| `mock` | n/a | yes | yes | n/a |

`whisper` covers OpenAI's hosted endpoint **and every self-hosted server
that speaks the same shape** — faster-whisper-server, whisper.cpp's HTTP
mode, vLLM's audio endpoint — because `STT_BASE_URL` is configuration, not a
constant. A local endpoint needs no credential, and `configured` reflects
that: pointing this at a machine you run yourself is a deployment decision
and needs no code change. For voice that matters more than for text, because
the payload is the user's own speech.

Capabilities are **advertised, not assumed**, and the service respects them:

- Whisper returns segment log-probabilities, not an utterance confidence, so
  it reports `confidence: false` and none is derived. A number that looks
  authoritative and is not would be worse than its absence.
- When a provider does not report a detected language, the result stays
  null — the hint the client sent is **not** echoed back as a detection. An
  echoed guess is not a detection, and something downstream would believe it.
- Neither real adapter claims streaming, because both use a
  request/response method.

**Mixed Hindi–English** is stated per provider rather than promised
generically. Whisper returns one transcript with one detected language,
usually `hi` — the words are kept, the mix is not labelled
(`detected-as-one`). Google takes a primary `languageCode` plus
`alternativeLanguageCodes` and picks per utterance, so listing `hi-IN` and
`en-IN` is how code-switching is handled (`alternatives`). That difference
is the reason both adapters exist.

### Speech synthesis — `src/providers/tts/`

| Adapter | Voices | Language |
| --- | --- | --- |
| `openai` | 6 multilingual (`alloy`…`shimmer`) | read from the text itself |
| `google` | 4 named (`hi-IN`, `en-IN` neural) | voice is language-bound |
| `mock` | 1 | silent WAV |

Two different models of what a "voice" is, which is why both are here: with
Google the detected language picks the voice when the user has not chosen
one, so a Hindi reply is not read out in an English voice. The preference
layer above expresses the same user choice against either.

The stand-in produces a **real, playable, silent WAV** — built header and
all, so anything downstream that parses audio behaves as it would with a
genuine file. Silent on purpose: a tone could be mistaken for working
synthesis.

### Selection

Same rule as the language-model registry, and it matters more here:

> **A provider with no credential is never selected.** The fallback is the
> local stand-in, never a different vendor.

Sending someone's voice to a service nobody chose is not a fallback, it is a
disclosure. The fallback is logged, and readiness reports it (§9).

### Shared infrastructure

`src/providers/shared/` holds one error vocabulary and one timeout/retry
implementation for all three modalities:

`auth` · `rate_limited` · `timeout` · `unavailable` · `invalid_request` ·
`invalid_output` · `invalid_audio` · `content_filtered` · `unknown`

Retryable: `rate_limited`, `timeout`, `unavailable`. Nothing else.
`LlmError`, `SttError` and `TtsError` are subclasses, so a caller tells them
apart by type while the retry helper only needs the base shape.

Transcription is retried because it is a **read**: a discarded attempt
leaves nothing behind. Nothing that writes, sends or charges a third party
is retried anywhere here.

A provider failure becomes an honest HTTP error, not a 500 — a dependency
problem is `503`, a problem with the recording itself is `400`. Nothing in
this service went wrong, and the status should say so.

---

## 6. Session lifecycle

```
                    ┌──────────────────────────────┐
 CREATED ──► LISTENING ──► TRANSCRIBING ──► INTERPRETING
    │                                           │
    │                        ┌──────────────────┼──────────────────┐
    │                        ▼                  ▼                  ▼
    │            AWAITING_CLARIFICATION  AWAITING_CONFIRMATION  COMPLETED
    │                        │                  │
    │                        └──► TRANSCRIBING  └──► QUEUED ──► COMPLETED
    │
    └─ every live state ──► CANCELLED · EXPIRED · FAILED
```

The transition table is **data**, in `voice-session.service.ts`, so the whole
machine can be read and tested in one place. A transition that is not listed
cannot happen: `transitionTo` refuses it and the session stays where it was.

Two properties the table guarantees:

- **Every live state reaches `CANCELLED`, `FAILED` and `EXPIRED`.** A user
  must always be able to stop a voice interaction, and a session must never
  get wedged with no way out.
- **Nothing leaves a terminal state.** Cancelled stays cancelled; the record
  of what happened matters more than tidiness.

`QUEUED` is where this build stops. The executor that moves it onward
arrives with the action workers.

### Concurrency

Updates are conditional on the state we believe the session is in
(`updateMany where: { id, state: from }`), so two concurrent requests cannot
both think they made the transition — the loser gets a conflict rather than
silently overwriting.

### Expiry

Applied **on read**, not left to a sweep: a session past its deadline is
expired the moment anybody looks at it, so a slow client cannot resume
something that should be gone. `expireOverdue()` exists for the scheduler
and is a backstop, not the mechanism.

Default TTL 5 minutes (`VOICE_SESSION_TTL_MS`); a finished session stays
readable for 15 minutes (`VOICE_SESSION_GRACE_MS`) so a reconnecting client
can learn the outcome.

### Ownership

A voice session belongs to the **device** that started it, and `deviceId` is
not optional. `requireOwned(userId, sessionId, { requireDevice })` is the one
method everything goes through, so there is no route that reaches a session
by id alone. Another user's session — or another *device's*, on the same
account — reads as **404, not 403**.

That is the rule the brief asks for: one device cannot act on another
device's pending voice action. It is enforced in the service rather than a
controller so a new route cannot forget it.

Cancellation is **idempotent**: a double tap or a retry after a dropped
connection gets the same answer, and `alreadyEnded` says which it was.

---

## 7. Real-time events

Namespace `/assistant`, one room per user and one per device — the
arrangement approved in the architecture review. The pipeline publishes to
an in-process bus (`VoiceEventBus`) rather than to sockets directly, so it
does not import the gateway (that would be a cycle) and can be tested
without a WebSocket server.

| Event | Audience | Stored |
| --- | --- | --- |
| `session.created` | device | yes |
| `listening.started` | device | yes |
| `transcript.partial` | device | **no** |
| `transcript.final` | device | yes |
| `processing.started` | device | yes |
| `clarification.required` | device | yes |
| `confirmation.required` | **account** | yes |
| `response.ready` | account | yes |
| `session.cancelled` | device | yes |
| `session.expired` | device | yes |
| `session.failed` | account | yes |

`transcript.partial` is **never stored**. An interim guess is not a record of
what someone said, and a sequence of half-heard sentences is a worse thing
to keep than the settled one.

`confirmation.required` goes to the whole account because a confirmation is a
decision the *person* makes and they may be looking at another screen.
Acting on it still requires the owning device.

**There is no `action.executed` event.** An event name is a promise to a
client; adding one before there is an executor would have clients drawing a
tick that means nothing.

### Sequencing and reconnection

Each stored event gets a sequence number allocated by incrementing a counter
on the session row **in the same transaction as the insert**, so two events
cannot share a number. That is what makes "give me everything after 4" a safe
question.

A client that dropped mid-turn sends `voice.resume { sessionId, afterSeq }`
and is given the session's current state plus every event after that point.
Nothing is re-run — the events were recorded as they happened, so a replay is
a replay. The same is available over HTTP at
`GET /voice/sessions/:id/events?afterSeq=N` for clients with no socket.

A dropped socket does **not** cancel a session. The user may be
reconnecting, and the turn they started should still be there.

### Authentication

The same check as HTTP, at connection time: `PrincipalService`, shared with
`JwtAuthGuard`. A credential is judged identically however it arrived — an
authorization check that exists twice will eventually differ in one of them.
A socket with no valid credential is disconnected before it joins anything,
so room membership always implies an authorised identity. The token travels
in the handshake, never a query string, which ends up in logs.

Because the gateway authenticates its own connections, the global HTTP
guards, interceptors and exception filter now skip non-HTTP contexts. They
would otherwise reach for a request that does not exist and fail every
socket frame.

---

## 8. Wake word

**Detection runs on the device.** The backend's entire role is to accept an
authenticated activation:

```
local wake word detected
   └─► POST /voice/sessions { inputMode, wakeWordTriggered: true }
         └─► ordinary bearer-token request
```

Four things follow, and all four are enforced:

1. `wakeWordTriggered` is a **label**, recorded for the user's own activity
   view. The access token is what authorises the call, exactly as for a tap.
   A client-asserted flag is never treated as proof of anything.
2. The account must have enabled it (`wakeWordEnabled`), or the activation is
   refused with 403.
3. **No continuous audio.** The socket's `voice.audio.chunk` handler exists
   only to refuse, by name, and say where audio goes instead — a stated
   refusal rather than silence. `maxHttpBufferSize` is 64 KB, so a client
   that tries anyway is disconnected rather than quietly accommodated.
4. `GET /voice/capabilities` reports `realtime.acceptsAudioFrames: false`,
   so a client does not have to discover this by trying.

This backend does not implement always-listening, and nothing here should be
read as claiming to. Continuous local listening is a device capability
constrained by each platform's own rules; on iOS in particular, unrestricted
background wake-word listening is not available to an ordinary app.

---

## 9. API

All routes require authentication. All are under `/api/v1`.

| Route | What it does |
| --- | --- |
| `GET /voice/capabilities` | formats, limits, provider capabilities, event names |
| `POST /voice/sessions` | open a session (the wake-word activation point) |
| `GET /voice/sessions/:id` | where a session stands |
| `GET /voice/sessions/:id/events?afterSeq=N` | replay, for reconnection |
| `POST /voice/sessions/:id/transcript` | device-recognised text → full turn |
| `POST /voice/sessions/:id/audio` | `multipart/form-data`, field `audio` |
| `GET /voice/sessions/:id/speech` | the synthesised reply |
| `POST /voice/sessions/:id/cancel` | cancel and delete the recording |

Socket messages: `voice.resume`, `voice.transcript.partial`, `voice.cancel`,
and `voice.audio.chunk` (which refuses).

A turn returns the session, the transcript with its provider and whether that
provider is a stand-in, the assistant's own structured turn (Chunk 4's shape,
unchanged), and either `speech` or `speechUnavailable`.

### Spoken replies

Off by default: speech is something a user turns on, not something that starts
talking unprompted. Four distinct reasons it declines, each reported so a user
who expected a voice is told which it was — the preference is off, the text
was empty, no provider is configured, or the provider failed.

**A synthesis failure never costs the text reply.** `TtsService.speak` returns
an outcome object rather than throwing, because every caller's correct
response to a failure is identical and making it an exception would invite
someone to let it propagate.

Synthesised audio is `AudioKind.SPEECH`, kept for the session's grace window
and no longer; an earlier reply's audio is removed when a new one replaces it.
`Cache-Control: private, no-store` — it is one account's reply.

### Readiness

`/health/ready` gains two checks:

- `recogniser` — `up` with `degraded: true` while the stand-in is active. The
  process serves traffic, so readiness passes, but a deployment that meant to
  recognise speech can see that it does not.
- `synthesiser` — `not-configured` rather than `down`, because a reply without
  a voice is still a reply and this must never hold readiness down.

---

## 10. Reliability and limits

| Control | Default | Where |
| --- | --- | --- |
| Upload ceiling | 10 MB | `AUDIO_MAX_BYTES`, re-checked after receipt |
| Duration ceiling | 120 s | `AUDIO_MAX_DURATION_MS`, enforced twice |
| Minimum size | 512 B | `AUDIO_MIN_BYTES` |
| STT timeout | 30 s | `STT_TIMEOUT_MS`, abort signal reaches the socket |
| STT attempts | 2 | `STT_MAX_ATTEMPTS`, transient failures only |
| TTS timeout | 20 s | `TTS_TIMEOUT_MS` |
| Session TTL | 5 min | `VOICE_SESSION_TTL_MS` |
| `POST /voice/sessions` | 60/min | cheap; the work happens later |
| `POST …/transcript` | 30/min | costs an interpretation |
| `POST …/audio` | 20/min | costs a transcription and moves real bytes |

Cancellation propagates: an `AbortSignal` reaches the provider, so a
cancelled turn closes the upstream socket rather than leaving it running
while nobody is waiting.

### Configuration

```
STT_PROVIDER=mock          # mock | whisper | google
STT_BASE_URL=…/v1          # any Whisper-compatible endpoint
STT_MODEL / STT_TIMEOUT_MS / STT_MAX_ATTEMPTS
GOOGLE_SPEECH_API_KEY / GOOGLE_SPEECH_MODEL

TTS_PROVIDER=mock          # mock | openai | google
TTS_MODEL / TTS_DEFAULT_VOICE / TTS_TIMEOUT_MS
GOOGLE_TTS_API_KEY

AUDIO_MAX_BYTES / AUDIO_MAX_DURATION_MS / AUDIO_MIN_BYTES
AUDIO_TEMP_DIR / AUDIO_RETENTION_DEFAULT / AUDIO_RETENTION_DAYS
VOICE_SESSION_TTL_MS / VOICE_SESSION_GRACE_MS
```

`.env.example` holds **placeholders only**. No speech credential exists in
this repository: recognition and synthesis run on the stand-ins until one is
supplied, and both readiness and every response say so.

---

## 11. Data

`VoiceSession` — state, input mode, transcript, detected language, recogniser
and its latency, links to the conversation, command and pending action, the
reply text, a normalised failure code, and `lastEventSeq`.

`VoiceSessionEvent` — append-only, `@@unique([voiceSessionId, seq])`. What
makes reconnection a replay rather than a re-run.

`AudioAsset` — **metadata, not bytes**: MIME type, size, duration, sample
rate, SHA-256, retention, `deleteAfter`, `deletedAt`, and a `storageKey` that
goes null once the file is gone. `kind` separates the user's speech (`INPUT`)
from a synthesised reply (`SPEECH`), so the two are never confused by a
retention rule or a lookup.

One migration: `20261109044842_voice_sessions_and_audio`. Verified by
applying all four migrations to an empty database and diffing the result
against the schema — no difference.

---

## 12. Tests

**132 tests across four files, all against the stand-ins. No test contacts a
vendor.** The whole backend suite is 358.

**`test/audio.spec.ts`** (30) — every container identified from its bytes; a
RIFF that is not WAVE rejected; the MIME spellings clients actually send;
exact WAV duration including stereo, other sample rates, a `LIST` chunk and a
data chunk with no declared size; null duration for compressed containers;
each rejection code; a client lying about the format; the double duration
check; `0600` files and a `0700` directory; path traversal refused on every
operation; a delete that never throws; startup purge; files the service did
not create left alone; orphan sweeping that spares recent files.

**`test/speech.spec.ts`** (39) — the recogniser contract; no streaming or
confidence claimed where there is none; a self-hosted endpoint usable without
a key; language-hint normalisation; a health check that does not probe or echo
an endpoint; transcription with the stand-in reported as a stand-in; the hint
*not* echoed as a detection; audio the recogniser does not accept; a duration
only the provider could measure; transient retried and permanent not; a stall
aborted; no provider selected without a credential; synthesis producing a real
playable WAV; silence unless asked; **every synthesis failure returning a
reason instead of throwing**; rate clamping; Hindi and Indian-English voices;
one error vocabulary across modalities; preference parsing that salvages a
document with one bad field.

**`test/voice.spec.ts`** (47) — every live state reaching cancellation,
failure and expiry; nothing leaving a terminal state; illegal jumps refused at
the service; two concurrent transitions with exactly one winner; the assistant
status map; activation and wake-word gating; the transcript path keeping **no
audio row at all**; Hindi and Hinglish carried through unmangled; upload
transcribed and the recording deleted; **the recording deleted even when
recognition fails**; non-audio and mislabelled uploads failing the session
with nothing stored; nothing-heard as its own outcome with the assistant never
asked to interpret silence; retention honoured and then swept; spoken replies
off by default, served to the owning device only, and **the text reply
surviving a synthesis failure**; the event sequence monotonic from 1; replay
from a given sequence; partial transcripts never stored; event audience
(device-private vs account-wide); a throwing listener not costing the answer;
only documented event names published and no `action.executed`; cancellation
deleting retained audio and saying nothing was carried out; idempotent
cancellation; expiry on read and in bulk; cross-user and **cross-device**
isolation on every route; capabilities exposing no credentials; readiness
reporting `degraded`.

**`test/voice-gateway.spec.ts`** (16) — a real socket.io client over a real
port, because the question is whether a client that connects, authenticates,
joins rooms and drops actually receives what it should. Covers: a valid token
accepted and the identity reported; no credential and a bad credential both
disconnected, uniformly; **a revoked device unable to connect, proving the
socket applies the same checks as HTTP**; device-private delivery;
account-wide delivery to a device that is not the speaker; no cross-account
leakage; replay of a turn that ran while no socket was attached; partial
replay from a sequence; replay refused for another user *and* another device;
malformed resume requests rejected; partial transcript relayed and not stored;
cancellation over the socket; **audio frames refused by name**; a dropped
socket not cancelling the session.

```bash
npm test      # 358 tests
```

---

## 13. What is not here

- **Execution.** Still nothing. `QUEUED` is the end of the line, and the
  status vocabulary contains no word meaning "done".
- **True streaming recognition.** Both real adapters use request/response
  methods, and neither advertises streaming. The architecture is ready — the
  provider contract has a `streaming` capability and the transport exists —
  but no adapter implements it, so nothing claims to.
- **Multi-instance sockets.** Event delivery is in-process. A second instance
  needs the Redis adapter; this is logged at startup rather than left to be
  discovered.
- **A speech credential.** The stand-ins answer until one is configured.
- **Audio in the database.** Only metadata. By design.
