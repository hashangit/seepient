# Quickstart / Validation: TUI Input Box + Seepient Agent Logo

**Feature**: `003-tui-input-and-logo` | **Date**: 2026-06-15

Runnable scenarios that prove the feature works end-to-end. This is a validation
guide — implementation bodies and full tests live in `tasks.md` (next step).

## Prerequisites

- Node + `pnpm` (never npm).
- A TTY (run in a real terminal, not piped). The non-interactive path must stay
  byte-identical to before — that is itself a validation scenario (S5).

## Build & baseline

```bash
pnpm install
pnpm test            # all pre-existing tests pass (regression baseline)
pnpm build           # tsc compiles the new .tsx cleanly (no bundler)
```

## Unit validation (deterministic, no TTY needed)

Covers `contracts/gradient.md` — the only pure logic in this feature.

```bash
pnpm test -- src/adapters/cli/tui/logo/gradient.test.ts
```

- Single-line grid (`rows=1`) endpoints are exactly `red` (#ff757f) and `purple`
  (#c099ff); interior cells match the worked `t` values in
  `contracts/gradient.md`.
- Multi-line grid diagonal corners are `red` (top-left) and `purple`
  (bottom-right); output dimensions equal input.
- Same inputs return the same output (pure/deterministic).

## Manual TTY scenarios

Launch the interactive TUI:

```bash
pnpm dev            # tsx — resolves the lazy './tui/*.tsx' import
# or the built binary in a real terminal:
seepient
```

### S1 — Bordered input box, last live element above the footer (idle)

1. Run `seepient` in a TTY.
2. **Expect**: the prompt sits inside a **rounded box** (`╭…╮` / `╰…╯`) directly
   above the footer status bar. It is clearly separated from the feed and the
   footer by its border.
3. Type `/hel` → autocomplete dropdown appears inside/above the box as today.
4. Press ↑/↓ with an empty box → input history recalls as today.
5. Press Ctrl+P → the palette opens; **the box stays visible but keystrokes go to
   the palette, not the box** (input disabled while an overlay is open).

### S2 — Box persists (dimmed) while running; spinner above it

1. Submit a prompt that runs a slow shell command, e.g.:
   `run a shell command: sleep 4 && echo done`.
2. **Expect**: the rounded input box **stays in place, dimmed** for the whole run;
   the "Seepient is working" spinner renders **immediately above** the box.
3. Type while running → **keystrokes are ignored** (input disabled).
4. When the run finishes → the box is live (full color) again.

> Positioning is content-flow (last live element above the footer), **not** pinned
> to the viewport bottom on short sessions — see `spec.md` *Constraints*.

### S3 — Seepient Agent logo on launch (scrolls away)

1. Start `seepient` on a fresh session.
2. **Expect**: a large "Seepient Agent" banner with a **vivid 45° Tokyo Night rainbow**
   (red → orange → yellow → green → cyan → blue → purple across the letters) —
   mid-tones must be saturated, **not** muddy gray/brown (HSL, not RGB lerp).
3. Send a message → the large banner **scrolls up and away** as the feed grows
   (it is a real feed entry, `kind: 'logo'`, not a special-case element).
4. Resize the terminal → the logo/box reflow without breaking.

> The persistent compact wordmark is **deferred** (not built this round).

### S4 — Rename is logo-only

1. While in the TUI, inspect: placeholder text, spinner text, footer.
2. **Expect**: they still say **Seepient** (`Ask Seepient …`, `Seepient is working`).
   Only the logo says "Seepient Agent".
3. `seepient --version` / package name → still `seepient`.

### S5 — Non-interactive paths unchanged (regression)

```bash
echo "hi" | seepient            # piped stdin → readline path, no React import
seepient -n "hi"                # --no-interactive → readline path
seepient --docker ...           # docker non-interactive → unchanged
```

- **Expect**: byte-identical behavior to before; React/Ink never load. (If a CI
  guard asserts "no `.tsx` in the headless import graph", it must still pass.)

### S6 — Tests still green

```bash
pnpm test                    # full suite passes (≈ pre-existing count)
```

## Out of scope (do not validate here)

- Queuing / steering the agent with new messages mid-run (future feature).
- A header pinned to the absolute top of the terminal viewport (requires a feed
  rewrite — separate task; see `research.md` R3).
