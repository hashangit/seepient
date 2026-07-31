# Feature Specification: Full-Screen TUI (Alternate Buffer + In-App Scroll)

**Feature Branch**: `005-fullscreen-tui`

**Created**: 2026-06-15

**Status**: ⚠️ SUPERSEDED — reverted. The full-screen / alt-buffer approach caused
mouse-capture gibberish (Ink has no native mouse) and lost native scrollback;
investigating Command Code showed it uses `<Static>` + Ink-internals-poke, so we
reverted to that model. 003 (input border + logo) was implemented on the
`<Static>` foundation instead. Kept for the decision record; do NOT implement.

**Predecessor / unblocks**: `specs/001-tui-upgrade` (shipped Ink TUI). Unblocks
`specs/003-tui-input-and-logo` (its "pinned to the bottom" requirement is only
achievable once this full-screen model lands).

**Source**: User decision — the input must be pinned to the **viewport bottom**
(Claude Code / Codex look), which the current `<Static>`-into-native-scrollback
model cannot do.

## Scope decisions (confirmed with the user)

| Decision | Choice |
|---|---|
| Rendering model | **Alternate screen buffer** (`\x1b[?1049h`/`l`); the app owns the whole viewport |
| Feed history | **Windowed, in-app scroll** — NOT in the terminal's native scrollback (accepted tradeoff) |
| Bottom pinning | Input region + footer **pinned to the viewport bottom** on every frame, short or long sessions |
| Scroll controls | **Page Up / Page Down** + **vim j/k** (solid baseline); mouse wheel best-effort (research) |
| New output while scrolled up | **Sticky-bottom** by default; auto-stick resumes when the user scrolls back to the bottom |
| Packaging | **Separate spec (005)**; 003 (input box + logo) layers on top |

## What this spec does NOT do

- Does **not** add the rounded input border or dim-during-run (that's 003 US1).
- Does **not** add the logo (that's 003 US2; it will render as the first windowed
  feed entry once 005 lands).
- Does **not** change the agent engine, providers, tools, or non-interactive
  paths. Headless / SDK / Server are byte-identical.

## User Scenarios & Testing

### User Story 1 - Full-screen layout with bottom-pinned input & footer (Priority: P1) 🎯 MVP

The TUI takes over the full terminal (alternate buffer). The feed occupies the
top region and scrolls inside the app; the input area and the footer status bar
are **pinned to the bottom of the viewport** and stay there whether the session
is empty or long. Resizing the terminal reflows the regions. Exiting (Ctrl+C when
idle, `/exit`, crash) restores the previous terminal state.

**Why this priority**: this is the entire point of the spec — the current model
floats the input near the top on short sessions. Full-screen + bottom-pinning is
the foundation; everything else (003, scroll polish) builds on it.

**Independent Test**: run `seepient` on a fresh session → the input + footer sit at
the **bottom row(s)** of the terminal, not floating mid-screen. Resize the window
→ regions reflow, input stays at the bottom. Exit → you're back in your shell
with the prior screen intact (not scrolled junk).

**Acceptance Scenarios**:

1. **Given** a TTY, **When** the TUI launches, **Then** it enters the alternate
   buffer and occupies the full viewport; the input area + footer are on the
   bottom rows.
2. **Given** an empty/short session, **When** rendered, **Then** the input +
   footer remain at the viewport bottom (empty space is in the feed region above,
   not below).
3. **Given** the feed grows beyond the viewport, **When** more output arrives,
   **Then** the feed scrolls inside its region; the input + footer never move.
4. **Given** a resize, **When** the terminal changes size, **Then** region heights
   recompute and the scroll offset clamps; the input + footer re-pin to the new
   bottom.
5. **Given** exit (idle Ctrl+C, `/exit`), SIGTERM, or an uncaught error, **When**
   the process ends, **Then** the alternate buffer is left and raw mode disabled
   (the user's prior terminal screen is restored).
6. **Given** non-interactive launch (`-n`, piped, `--docker`, SDK/Server),
   **When** started, **Then** React/Ink are never imported and no alternate
   buffer is entered.

---

### User Story 2 - In-app feed scroll (Priority: P1)

The user can scroll the feed history within the app: Page Up / Page Down page
through it; `j`/`k` scroll line-by-line. New output auto-sticks to the bottom
unless the user has scrolled up; scrolling back to the bottom re-enables
stickiness.

**Why this priority**: dropping native scrollback (the tradeoff of US1) is only
acceptable if in-app scroll is good. Ships with US1 because they're inseparable.

**Independent Test**: fill the feed (long conversation), press Page Up → older
messages appear; press Page Down → returns to the latest; trigger new output while
scrolled up → the view holds (sticky-off) until you scroll back to the bottom.

**Acceptance Scenarios**:

1. **Given** a feed taller than its region, **When** the user presses Page Up,
   **Then** the feed scrolls up by one region height; Page Down scrolls back down.
2. **Given** the user presses `k`/`j`, **When** these fire (and no overlay/input
   owns them), **Then** the feed scrolls one line up/down.
3. **Given** the view is at the bottom, **When** new output arrives, **Then** the
   view follows it (sticky-bottom).
4. **Given** the user has scrolled up, **When** new output arrives, **Then** the
   view holds its position (sticky-off) and a clear indicator is shown that new
   output exists below.
5. **Given** the user scrolls back to the bottom, **When** that happens, **Then**
   sticky-bottom re-engages.
6. **Given** a resize while scrolled, **When** heights change, **Then** the scroll
   offset clamps to valid range without jumping.

---

### Edge Cases

- Terminal too small (e.g. < 20 rows)? (Reserve the bottom rows for input+footer;
  give the feed at least a 1-line minimum; refuse/scroll if impossible.)
- Very long feeds (thousands of entries)? (Window: render only the visible slice;
  memoize per-entry wrapped-line counts keyed by `(id, width)`.)
- Streaming assistant text whose height changes every token? (Re-measure only the
  streaming entry each tick; others are cached.)
- Tool blocks with live, growing stdout? (Same — dynamic height; re-measure on
  change.)
- Mouse wheel without Ink mouse support? (Keyboard scroll is the guaranteed path;
  mouse wheel is best-effort and may defer — see research.)
- Wide/CJK characters and ANSI codes in content? (Measure display width with the
  same `string-width` model the rest of the TUI uses; wrap with `wrap-ansi` if
  available — verify in research.)
- Crash mid-run? (Signal/error handlers must still leave the alt buffer.)

## Requirements

### Functional Requirements

- **FR-001**: On interactive launch the TUI MUST enter the alternate screen
  buffer and render a single fixed-height column = viewport rows: a feed region
  (top, `flexGrow`), the pinned bottom region (input area + footer), and optional
  fixed rows between (todos, spinner).
- **FR-002**: The input area + footer MUST occupy the bottom rows of the viewport
  on every frame, for both empty and full sessions. Empty space MUST appear in the
  feed region, never below the footer.
- **FR-003**: The feed MUST render as a **windowed live region** (only the visible
  slice), NOT via Ink's `<Static>`. `<Static>`, `ink-reset.ts`, and the
  `staticKey`/`resetView` remount machinery are removed/replaced.
- **FR-004**: The TUI MUST provide in-app scroll: Page Up / Page Down (region
  height) and `j`/`k` (one line). A scroll offset (lines from bottom) is the
  single source of truth, owned by one hook.
- **FR-005**: New output MUST auto-stick to the bottom unless the user scrolled
  up; an indicator MUST show when newer content exists below the viewport; sticky
  re-engages when the user returns to the bottom.
- **FR-006**: Resize MUST recompute region heights and clamp the scroll offset;
  the bottom region MUST re-pin.
- **FR-007**: Exit (idle Ctrl+C, `/exit`), SIGTERM, and uncaught errors MUST
  leave the alternate buffer and disable raw mode. The restore is best-effort but
  MUST be wired for all exit paths.
- **FR-008**: Per-entry wrapped-line counts MUST be memoized by `(id, width)` so a
  long feed re-renders in O(visible), not O(total).
- **FR-009**: Non-interactive launch MUST never enter the alternate buffer or
  import the new modules; the lazy-load invariant holds.
- **FR-010**: `pnpm test` MUST pass; the measurement + scroll math get unit tests.

### Key Entities

- **`ViewportGeometry`**: `{ rows, cols, feedHeight, bottomHeight }` — computed
  from `stdout` + the fixed bottom region size.
- **`ScrollState`**: `{ offsetFromBottom: number, sticky: boolean }` — owned by
  `useScroll`.
- **`MeasuredEntry`**: `{ id, lines: string[] }` — the wrapped display lines for
  one feed entry at the current width; cached and invalidated on width/content
  change.
- **`AltScreen`** (edge module): enter/leave the alternate buffer; one owner of
  the escape codes (no scattered `\x1b[?1049…`).

### Success Criteria

### Measurable Outcomes

- **SC-001**: Input + footer sit on the bottom rows on a fresh session — vs the
  current float-near-top.
- **SC-002**: Scrolling the feed never moves the input/footer.
- **SC-003**: Page Up/Down + j/k navigate history in-app; sticky-bottom follows
  new output.
- **SC-004**: Exit/crash restores the terminal cleanly.
- **SC-005**: `seepient -n`, SDK, Server, and `pnpm test` unaffected.

## Assumptions

- Ink renders correctly inside the alternate buffer (it manages the cursor
  directly; the alt buffer is transparent to cursor ops) — verified in research.
- `string-width` (display width) and `wrap-ansi` are available transitively via
  Ink/Chalk for measurement; if not, a small helper is written (no new dep
  without justification).
- Ink 6 does **not** ship a first-party fullscreen/alt-buffer helper and has
  limited mouse support — so alt-buffer is hand-managed and mouse-wheel scroll is
  best-effort/deferrable.
- The Vitest suite (~262 tests) is the regression baseline; this is the highest-
  risk change to the TUI to date.
