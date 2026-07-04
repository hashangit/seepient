# Quickstart / Validation: Full-Screen TUI

**Feature**: `005-fullscreen-tui` | **Date**: 2026-06-15

Runnable scenarios that prove the full-screen model works end-to-end. Validation
guide — implementation bodies and full tests live in `tasks.md`.

## Prerequisites

- `pnpm` (never npm). A real TTY.
- The non-interactive path must stay byte-identical — that is itself a scenario (S7).

## Build & baseline

```bash
pnpm install
pnpm test            # pre-existing suite passes (regression baseline)
pnpm build           # tsc compiles the new .tsx cleanly
```

## Unit validation (deterministic, no TTY)

Covers `contracts/scroll.md` + `measure.ts`:

```bash
pnpm test -- src/adapters/cli/tui/fullscreen/
```

- `measureEntry`: known text + width → expected wrapped-line count (incl. wide
  chars / ANSI); pure/deterministic.
- `useScroll`: pageUp/Down + j/k move `offsetFromBottom` and clamp to
  `[0, maxOffset]`; reaching 0 sets `sticky=true`; new content follows when sticky,
  holds when not; resize re-clamps.

## Phase 0 smoke tests (do these FIRST)

1. Minimal Ink render inside the alt buffer (enter → render a `<Text>` → leave)
   repaints correctly with no flicker. Confirms R1.
2. Confirm `string-width` and `wrap-ansi` resolve (transitive via Ink/Chalk); if
   not, the small wrap helper is written here. Confirms R2.

## Manual TTY scenarios

```bash
pnpm dev            # tsx
# or in a real terminal:
seepient
```

### S1 — Full-screen, bottom-pinned input + footer

1. Run `seepient` on a fresh session.
2. **Expect**: the app fills the terminal; the input + footer sit on the **bottom
   rows** (not floating mid-screen). Empty space is above them, in the feed region.
3. Send a short message → the exchange appears above; input/footer stay pinned.

### S2 — Feed scrolls inside the app; pinned region never moves

1. Trigger a long conversation (enough to exceed the viewport).
2. **Expect**: older messages scroll out the top of the feed region; the input +
   footer never move. (History is NOT in the terminal's native scrollback —
   scrolling the terminal itself does nothing inside the session.)

### S3 — In-app scroll

1. With a feed taller than the viewport, press **Page Up** → older content shows.
2. Press **Page Down** → returns to newest.
3. Press **k** / **j** → line-by-line up/down.
4. While scrolled up, trigger new output → the view **holds** and a "↓ N new"
   indicator appears; scroll back to the bottom → sticky re-engages and follows.

### S4 — Resize

1. Resize the terminal (bigger and smaller).
2. **Expect**: regions reflow; input/footer re-pin to the new bottom; scroll offset
   clamps (no jump/crash). At very small heights the feed keeps a ≥1-line minimum.

### S5 — Streaming + tool blocks under windowing

1. Submit a prompt that streams a long answer and runs a shell tool with live
   stdout.
2. **Expect**: the streaming text + tool block render in the feed window; sticky-
   bottom follows the stream; the pinned region is unaffected.

### S6 — Exit restores the terminal

1. From idle, press Ctrl+C twice (or `/exit`).
2. **Expect**: you return to your shell with the **prior screen intact** (alt
   buffer left, raw mode off) — no leftover junk, no stuck raw input.
3. Kill the process (`kill`/SIGTERM) from another terminal → same clean restore.

### S7 — Non-interactive paths unchanged (regression)

```bash
echo "hi" | seepient
seepient -n "hi"
seepient --docker …
```
- **Expect**: byte-identical to before; no alt buffer, no React import.

### S8 — Tests green

```bash
pnpm test           # full suite passes (≈ baseline + new fullscreen unit tests)
```

## Out of scope (do not validate here)

- Rounded input border + dim-during-run → 003 US1.
- Seepient Agent logo → 003 US2.
- Persistent header/wordmark → deferred.
- Mouse-wheel scroll (best-effort; may defer to keyboard-only v1).
