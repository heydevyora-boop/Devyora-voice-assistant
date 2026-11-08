# Devyora

A personal AI voice assistant built around **one orb**. The orb is the product:
the same component renders on the main screen, in the customiser's preview and
in the compact floating presentation, so the assistant looks and behaves like a
single entity wherever it appears.

**One dot → one tap → speak → the assistant works it out → an action → a result.**

## Status

The frontend is complete and audited. What is real, what is a labelled
stand-in, and what is still waiting on a backend or a native shell are all
stated plainly in the interface itself — see **What the assistant will not
claim** below.

| Layer | State |
|---|---|
| Microphone capture and live level metering | real |
| Speech to text | real (Web Speech API) |
| Speech output | real (Web Speech Synthesis) |
| Notes and reminders | real — written to storage and read back before being reported |
| App hand-offs (WhatsApp, Gmail, Telegram, Calendar, Instagram, Facebook) | real — opens the app with your content filled in |
| Command understanding | **stand-in** — fixed phrase rules, badged `TEST` in the UI |
| Scripted transcript source | **stand-in** — opt-in only, badged `TEST`, opens no microphone |
| Account linking (OAuth) | **not available** — needs a backend that holds the tokens |
| Wake word | **not implemented** — needs an on-device model in the native shell |

## Commands

```bash
npm install
```

```bash
npm run dev
```

```bash
npm run build
```

```bash
npm run preview
```

```bash
npm run typecheck
```

```bash
npm run lint
```

The end-to-end suites drive a real browser, so start a server first
(`npm run dev` in another terminal), then:

```bash
npm test
```

Individual suites: `npm run test:orb`, `npm run test:voice`,
`npm run test:surfaces`, `npm run test:responsive`. Point them at another
server with `DEVYORA_TEST_URL=http://localhost:4173 npm test`.

Playwright is not a project dependency — it is only needed to run the suites:

```bash
npm i -D playwright && npx playwright install chromium
```

## Architecture

```
src/
├── app/            App shell and routing
├── design/         tokens.css, orb.css, base.css, self-hosted fonts
├── components/
│   ├── primitives/ Icon (inline SVG set), GlassCard, cn
│   └── shell/      AmbientBackground, AppHeader, SecondaryNav
├── features/
│   ├── orb/        Orb, Waveform, orbStates, orbMachine, appearance
│   ├── voice/      useVoiceSession, VoicePanel, ActionConfirmation,
│   │               ClarificationPrompt, TranscriptCard, notices, text fallback
│   └── apps/       AppCard
├── services/
│   ├── stt/        SttProvider contract, Web Speech adapter, scripted stand-in
│   ├── tts/        TtsProvider contract, Web Speech Synthesis adapter
│   ├── nlu/        CommandInterpreter contract, on-device phrase rules
│   ├── audio/      microphone metering + the level bus
│   ├── actions/    plan model, execution modes, local executor
│   ├── connections/ integration contract, app registry, hand-off launcher
│   └── wakeWord.ts readiness contract — deliberately not implemented
├── platform/       capability detection (host, OS, overlay, wake word)
├── routes/         Home, Voice, Apps, Style, Settings, Compact, dev gallery
└── stores/         orbStore (phase), voiceStore (turn content),
                    settingsStore, appearanceStore
```

### The voice turn

`useVoiceSession` owns the side effects and translates their real results into
events on the orb machine. There is no second state machine: `orbStore` holds
the phase, `voiceStore` holds the turn's content.

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
someone else. A note or a reminder is private, local and reversible, so it runs
straight away.

### What the assistant will not claim

- **Nothing is sent.** WhatsApp does not let another app send on your behalf.
  The executor opens a prefilled draft and reports a `handoff` — a result
  distinct from success — and the orb returns to rest rather than showing a tick.
- **A launch is not a success.** Opening an application cannot be verified from
  a web page, so that is a handoff too.
- **An unresolved name is a question, not a guess.** With no contact directory
  connected, "send a message to Rahul" raises a clarification.
- **No app is connected.** There is no integration service, so every account
  reads as unlinked and a connect attempt explains the missing OAuth backend
  instead of flipping a switch.
- **The waveform only moves to real audio.** With no capture it holds a still
  resting silhouette.
- **Mock providers are labelled wherever their output appears.**

### Orb appearance

`features/orb/appearance.ts` holds the model, palettes and presets, and one
pure `appearanceToVars()` translation to CSS custom properties.
`appearanceStore` persists the choice and every `Orb` reads it, so the
customiser's preview is the real component with an unsaved draft passed as a
prop.

Two deliberate limits: a palette never repaints `success` or `error`, and a
motion style only changes what the orb does **at rest**. Both carry meaning.
Size sets the floating widget in pixels; the main screen scales with it.

### Styling and performance rules worth keeping

**Dynamic orb values are CSS custom properties, never JavaScript-built class
names.** The Stitch export assembled Tailwind class strings at runtime;
Tailwind's compiler cannot see those, so the orb renders unstyled in a
production build.

**No `filter: blur()` and no `mix-blend-mode` on orb or background layers.**
Both composite through a rectangular layer — a blur is clipped to it and a
blend reads the backdrop from it — and either stamps a visible square edge
across the soft glow once an ancestor is promoted. Every bloom is a multi-stop
radial gradient instead. `backdrop-filter` on glass surfaces is fine.

**Microphone levels never enter React state.** They travel on
`services/audio/levelBus` straight to the visualiser, which writes `transform`
on nine spans. Routing sixty frames a second through a store re-rendered the
whole screen for a purely visual change.

**Only `transform` and `opacity` are animated**, and the orb's sanctuary
reserves space for its largest state, so no state change shifts the layout.

### Accessibility

- The orb is a real `<button>`: Enter and Space activate it, `Escape` cancels
  from anywhere, and the current state is announced via `aria-live`.
- `prefers-reduced-motion` stops every animation; `data-motion="reduced"` gives
  the same result for a future in-app toggle.
- Interactive controls are at least 44×44 px. Pinch zoom is not disabled.
- A decision the user has to make is scrolled into view when it appears.

### Platform support

`platform/capabilities.ts` reports what the current host can actually do. A web
page cannot place a window above other applications on any OS, and iOS does not
permit an always-on-top overlay at all. The frontend provides the compact
layout at `/#/compact`; creating the always-on-top window is the native shell's
job (Tauri or Capacitor) and is deliberately outside this codebase.

### Wake word

Not implemented, on purpose. A browser `getUserMedia` loop held open to listen
for a phrase would keep the microphone live and drain the battery, and it still
would not work with the app closed — the only time a wake word is useful.
`services/wakeWord.ts` defines the contract and reports that nothing is
listening.

### Development

`/#/dev/states` renders all seven orb states side by side. It is mounted only
when `import.meta.env.DEV` is true and is absent from production bundles, along
with the `__orb`, `__voice`, `__settings` and `__levels` handles the suites use.
