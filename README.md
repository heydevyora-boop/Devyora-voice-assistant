# Devyora

A personal AI voice assistant built around **one orb**. The orb is the product:
the same component renders on the main screen and in the compact floating
presentation, so the assistant looks and behaves like a single entity wherever
it appears.

## Status

Chunk 2 — the orb, its state machine and the minimal primary interface.
There is no voice pipeline yet: the orb enters `listening` when you activate it
and waits for a real speech/AI layer to report what happened. It never invents
progress or a result.

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
├── features/orb/   Orb, Waveform, orbStates, orbMachine, types
├── hooks/          useReducedMotion, useBreakpoint
├── platform/       capability detection (host, OS, overlay, wake word)
├── routes/         Home, Compact, Settings, placeholders, dev state gallery
└── stores/         orbStore (Zustand)
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
