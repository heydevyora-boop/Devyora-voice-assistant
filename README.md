# Devyora

A personal AI voice assistant built around **one orb**. The orb is the product:
the same component renders on the main screen and in the compact floating
presentation, so the assistant looks and behaves like a single entity wherever
it appears.

## Status

Chunk 4 — the secondary surfaces: connected apps, the orb customiser and
settings.

What is real: microphone capture and live level metering, browser speech
recognition, browser speech synthesis, and local actions (notes, reminders)
that are written to storage and read back before being reported as done.

What is not, and says so in the interface: there is no AI service, so commands
are matched against a short list of fixed phrasings and anything else is
reported as unsupported rather than guessed at. No message is ever sent on the
user's behalf, and no application account can be linked, because account
linking needs an OAuth backend and a browser must never hold the tokens.

## Running it

```bash
npm install
```

```bash
npm run dev
```

```bash
npm run build
```

## Architecture

```
src/
├── app/            App shell and routing
├── design/         tokens.css, orb.css, base.css, self-hosted fonts
├── components/
│   ├── primitives/ Icon (inline SVG set), cn
│   └── shell/      AmbientBackground, AppHeader, SecondaryNav
├── features/
│   ├── orb/        Orb, Waveform, orbStates, orbMachine, types
│   ├── voice/      useVoiceSession, VoicePanel, ActionConfirmation,
│   │               ClarificationPrompt, TranscriptCard, notices, text fallback
│   └── apps/       AppCard
├── services/
│   ├── stt/        SttProvider contract, Web Speech adapter, scripted stand-in
│   ├── tts/        TtsProvider contract, Web Speech Synthesis adapter
│   ├── nlu/        CommandInterpreter contract, on-device phrase rules
│   ├── audio/      live microphone metering (AnalyserNode)
│   ├── actions/    plan model, execution modes, local executor
│   ├── connections/ integration contract, app registry, hand-off launcher
│   └── wakeWord.ts readiness contract — deliberately not implemented
├── hooks/          useReducedMotion, useBreakpoint
├── platform/       capability detection (host, OS, overlay, wake word)
├── routes/         Home, Voice, Apps, Style, Settings, Compact, dev gallery
└── stores/         orbStore (phase), voiceStore (turn content),
                    settingsStore, appearanceStore
```

### The orb's seven states

`idle → listening → processing → confirmation → executing → success → error`

`src/features/orb/orbStates.ts` is the single source of truth for how each
state looks and reads. `src/features/orb/orbMachine.ts` is the single source of
truth for which transitions are legal.

Events are split in two:

- **User events** (`ACTIVATE`, `CANCEL`, `APPROVE`, `REJECT`, `REVISE`,
  `RETRY`, `DISMISS`) come from the interface.
- **Pipeline events** (`SPEECH_CAPTURED`, `NEEDS_APPROVAL`, `RUN`, `COMPLETED`,
  `FAILED`) come from the voice/AI layer.

Nothing in this chunk emits a pipeline event, which is why the orb cannot show
a fabricated success.

### The voice turn

`useVoiceSession` owns the side effects and translates their real results into
events on the orb machine. It adds no second state machine: `orbStore` holds
the phase, `voiceStore` holds the content of the turn, and nothing else writes
to both.

```
idle --tap--> listening --engine delivers--> processing
      |                                         |
      |                        +----------------+----------------+
      |                        v                                 v
      |                  confirmation  --approve-->  executing --> success
      |                (sensitive or                     |
      |                 externally visible)              +------> handoff -> idle
      +<-- cancel / Escape / timeout / error <-----------+
```

Confirmation is required for anything that leaves the device or is visible to
someone else. A note or a reminder is private, local and reversible, so it
runs straight away.

### What the assistant will not claim

- **Nothing is sent.** WhatsApp does not let another app send on a user's
  behalf. The executor opens a prefilled draft and reports a `handoff`, a
  result distinct from success, and the orb returns to rest rather than
  showing a tick.
- **A launch is not a success.** Opening an application cannot be verified
  from a web page, so `app.open` also reports a handoff.
- **An unresolved name is a question, not a guess.** With no contact directory
  connected, "send a message to Rahul" raises a clarification instead of
  picking someone.
- **The waveform only moves to real audio.** Bars are driven by an
  `AnalyserNode` over the live stream; with no capture they hold a still
  resting silhouette.
- **Mock providers are labelled wherever their output appears**, so a scripted
  transcript or a pattern-matched plan cannot read as something heard or
  understood.

### Styling rules worth keeping

**Dynamic orb values are CSS custom properties, never JavaScript-built class
names.** The Stitch export assembled Tailwind class strings at runtime
(`el.className = '...' + config.sphereClass`); Tailwind's compiler cannot see
those strings and purges the utilities, so the orb renders unstyled in a
production build.

**No `filter: blur()` and no `mix-blend-mode` on orb or background layers.**
Both force Chromium to composite through a rectangular layer: a blur is clipped
to the layer bounds and a blend reads the backdrop from them, and either one
stamps a visible square edge across the soft glow as soon as an ancestor is
promoted by `will-change`, a `transform` or the native shell. Every bloom is a
multi-stop radial gradient instead — same look, no bounds, cheaper to paint.
`backdrop-filter` on glass surfaces is fine; it blurs what is behind an element
rather than the element itself.

**Only `transform` and `opacity` are animated**, and the orb's sanctuary
reserves space for its largest state, so no state change can shift the layout.

### Orb appearance

`features/orb/appearance.ts` holds the model, the palettes, the presets and
one pure `appearanceToVars()` translation to CSS custom properties.
`appearanceStore` persists the saved choice, and every `Orb` reads it — so the
customiser's preview is the real component with an unsaved draft passed as a
prop, not a second implementation that could drift from it.

Two things the palette deliberately does not touch: the colours of `success`
and `error`, and the animations tied to listening, thinking and results.
Those carry meaning, and a style choice should never make the orb harder to
read. Size sets the floating widget in pixels; the main screen scales with it
rather than matching it.

### Connected apps

Each capability is labelled by what can actually happen today:

- **on device** — runs here and the result is verified (notes, reminders).
- **hand-off** — the app opens with your content filled in through a
  documented public URL, and you finish it.
- **needs account** — waiting on an authorised backend that does not exist.

No application is ever shown as connected unless the connections provider
says so, and the provider in this build cannot connect anything; attempting it
reports why. Each card also discloses the authorisation a real link would
request.

### Wake word

Not implemented, on purpose. A browser `getUserMedia` loop held open to listen
for a phrase would keep the microphone live and drain the battery, and it still
would not work with the app closed — which is the only time a wake word is
useful. `services/wakeWord.ts` defines the contract and reports that nothing is
listening; real detection belongs to an on-device model in the native shell.

### Platform support

`src/platform/capabilities.ts` reports what the current host can actually do.
A web page cannot place a window above other applications on any OS, and iOS
does not permit an always-on-top overlay at all. The frontend provides the
compact layout at `/#/compact`; creating the always-on-top window is the native
shell's job (Tauri or Capacitor) and is deliberately outside this codebase.

### Accessibility

- The orb is a real `<button>`: Enter and Space activate it, `Escape` cancels
  from anywhere, and the current state is announced via `aria-live`.
- `prefers-reduced-motion` stops every animation, and the `data-motion="reduced"`
  attribute gives the same result for a future in-app toggle.
- Pinch zoom is not disabled.

### Development

`/#/dev/states` renders all seven states side by side. It is mounted only when
`import.meta.env.DEV` is true and is absent from production bundles, so the
states stay reviewable without shipping a way to force one.
