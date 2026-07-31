---

description: "Task list for 005-fullscreen-tui (full-screen TUI: alt buffer + windowed feed + bottom-pinned input + in-app scroll)"
---

# Tasks: Full-Screen TUI (Alternate Buffer + In-App Scroll)

**Input**: Design documents from `/specs/005-fullscreen-tui/` (plan.md, spec.md,
research.md, data-model.md, contracts/, quickstart.md).

**Tests**: the pure modules — `measure` (wrapping) and `useScroll` (clamp/sticky)
— get unit tests (FR-010), TDD-style. `AltScreen`, `FeedWindow`, `app.tsx`, and
`index.tsx` are validated via the manual `quickstart.md` scenarios S1–S8.

**Organization**: two P1 stories — US1 (full-screen + bottom-pinned input/footer,
🎯 MVP) and US2 (in-app scroll). US1 ships **without** scroll (the feed shows the
latest slice, offset 0); US2 makes the offset controllable. Shared pure primitives
(AltScreen, measure, layout) are Foundational.

**Prerequisite**: run the two **Phase 0 smoke tests** in `quickstart.md` (minimal
alt-buffer render; confirm `string-width`/`wrap-ansi` resolve) **before** T004 —
they gate the rewrite.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on incomplete tasks)
- **[Story]**: US1 / US2 (user-story phases only)
- Exact file paths in every description

---

## Phase 1: Setup

**Purpose**: regression baseline.

- [ ] T001 Run `pnpm test`; confirm the full pre-existing suite is green and record the count (≈262) as the baseline. Confirm `pnpm build` (tsc) compiles cleanly. Then run the two Phase 0 smoke tests in `specs/005-fullscreen-tui/quickstart.md` (minimal alt-buffer Ink render; confirm `string-width` + `wrap-ansi` resolve transitively) — these gate the rewrite.

**Checkpoint**: baseline green; alt-buffer + measure deps confirmed; safe to start.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the shared pure/edge primitives both stories depend on. **⚠️ No story
work until these land.**

### Tests (TDD — write first, confirm fail)

- [ ] T002 [P] Write unit tests in `src/adapters/cli/tui/fullscreen/measure.test.ts` per `contracts/rendering.md` C4: known text + width → expected wrapped-line count (incl. a wide-char line and an ANSI-colored line); pure/deterministic.
- [ ] T003 [P] Write unit tests in `src/adapters/cli/tui/fullscreen/layout.test.ts` per `data-model.md` §1: `computeGeometry` enforces `feedHeight >= MIN_FEED_HEIGHT`, `feedHeight = rows - bottomHeight`, and clamps on tiny terminals.

### Implementation

- [ ] T004 Implement `measureEntry(entry, width)` in `src/adapters/cli/tui/fullscreen/measure.ts`: wrap with `wrap-ansi` + display width via `string-width` (verified in T001); if either is unavailable, write a ~30-line wrap helper (no new dependency). Pure/deterministic. (TDD: make T002 pass)
- [ ] T005 Implement `computeGeometry(rows, cols, bottomHeight)` + `ViewportGeometry` in `src/adapters/cli/tui/fullscreen/layout.ts` (`feedHeight >= MIN_FEED_HEIGHT`). (TDD: make T003 pass)
- [ ] T006 [P] Implement the `AltScreen` edge module in `src/adapters/cli/tui/fullscreen/alt-screen.ts`: `enterAltScreen()` (`\x1b[?1049h` + clear) and idempotent `leaveAltScreen()` (`\x1b[?1049l`). Single owner of these escape codes — none elsewhere.

**Checkpoint**: primitives ready; US1 can begin.

---

## Phase 3: User Story 1 - Full-screen layout, bottom-pinned input & footer (Priority: P1) 🎯 MVP

**Goal**: the TUI runs in the alternate buffer as a fixed-height column; the feed
is a windowed region showing the latest slice; the input area + footer are pinned
to the viewport bottom on every frame; resize reflows; exit/crash restores the
terminal. (No scrolling yet — offset is fixed at 0.)

**Independent Test** (quickstart S1, S2, S4, S6, S7): `seepient` → fills terminal,
input+footer on the bottom rows even on a fresh session; long feed scrolls inside
its region while the pinned region never moves; resize reflows + re-pins; exit
restores the prior screen; `seepient -n` unchanged.

### Implementation for User Story 1

- [ ] T007 [US1] Create `FeedWindow` in `src/adapters/cli/tui/fullscreen/feed-window.tsx`: renders the **visible slice** of the feed by measuring each entry via `measureEntry` (memoize by `(id, width)`), concatenating wrapped lines, and painting the last `feedHeight` lines (offset 0 for now). Reuse the existing per-kind components (`UserMessage`, `AssistantMessage`, `ToolCallBlock`, `ErrorMessage`, `InfoMessage`) — do not reimplement them. (depends on T004, T005)
- [ ] T008 [US1] Rewrite the root in `src/adapters/cli/tui/app.tsx` into a fixed-height column (`height={geometry.rows}`, `overflow="hidden"`): `<FeedWindow height={geometry.feedHeight}>` at top, then `{latestTodos}`, the mutually-exclusive live slot (overlays/permission/spinner), the input area (`PromptArea` for now — 003 swaps in `InputBox`), and `<Footer/>` as the last children so they pin to the bottom. Compute `geometry` from `useStdout().stdout.rows/columns`; recompute + repaint on resize. (depends on T005, T007)
- [ ] T009 [US1] In `src/adapters/cli/tui/index.tsx`: call `enterAltScreen()` immediately before `render(...)`; replace `resetView`/`resetInkStatic` usage with a plain "recompute geometry" (no screen clear, no static reset); wire `leaveAltScreen()` to unmount cleanup, `SIGTERM`, `process.on('exit')`, and an `uncaughtException`/`unhandledRejection` guard. (depends on T006)
- [ ] T010 [US1] Remove the now-orphaned `<Static>` machinery: delete `src/adapters/cli/tui/ink-reset.ts` (`warmInkReset`/`resetInkStatic`) and delete or replace `src/adapters/cli/tui/components/message-area.tsx` (its job is now `FeedWindow`'s); drop the `staticKey` remount and `warmInkReset()` call. (depends on T008, T009)

**Checkpoint**: User Story 1 fully functional and independently testable (no scroll yet).

---

## Phase 4: User Story 2 - In-app feed scroll (Priority: P1)

**Goal**: Page Up/Down + `j`/`k` scroll the feed; new output auto-sticks to the
bottom unless scrolled up; a "↓ N new" indicator shows when newer content is below;
sticky re-engages on return to bottom; scroll clamps on resize.

**Independent Test** (quickstart S3): fill the feed → Page Up shows older content,
Page Down returns; `j`/`k` line-scroll; new output while scrolled up holds position
+ shows the indicator; scrolling back to bottom re-engages sticky.

### Tests for User Story 2 (TDD)

- [ ] T011 [P] [US2] Write unit tests in `src/adapters/cli/tui/fullscreen/use-scroll.test.ts` per `contracts/scroll.md`: `pageUp/Down` and `lineUp/Down(j/k)` move + clamp `offsetFromBottom` to `[0, maxOffset]`; reaching 0 sets `sticky=true`; new content follows when sticky, holds when not; resize re-clamps.

### Implementation for User Story 2

- [ ] T012 [US2] Implement `useScroll({ totalLines, feedHeight, contentVersion })` in `src/adapters/cli/tui/fullscreen/use-scroll.ts` returning `{ state, pageUp, pageDown, lineUp, lineDown, useScrollKeys }` per `contracts/scroll.md`. One owner of `ScrollState`. (TDD: make T011 pass)
- [ ] T013 [US2] Wire scroll into `src/adapters/cli/tui/app.tsx` + `FeedWindow`: pass `scroll.state` to `FeedWindow` so the visible window is the last `(feedHeight + offsetFromBottom)` lines; bump `contentVersion` on new feed/streaming output (sticky follows; non-sticky holds); render a "↓ N new" indicator at the top of the feed when `!sticky`; register `useScrollKeys(enabled)` gated on `overlay === null && !isRunning` (no double-handling with overlays/input). (depends on T008, T012)

**Checkpoint**: User Story 2 fully functional; full quickstart S1–S8 passable.

---

## Phase 5: Polish & Cross-Cutting

- [ ] T014 [P] Verify the lazy-load invariant: `echo hi | seepient`, `seepient -n "hi"`, `seepient --docker …` never enter the alt buffer and never statically import `src/adapters/cli/tui/fullscreen/*`. Run any existing CI guard.
- [ ] T015 Run `specs/005-fullscreen-tui/quickstart.md` S1–S8 in a real TTY: full-screen + bottom-pinned (S1); feed scrolls inside, pinned region still (S2); PageUp/Down + j/k + sticky + indicator (S3); resize reflow + clamp (S4); streaming + tool blocks under windowing (S5); exit/SIGTERM restore (S6); non-interactive parity (S7). Fix flicker/clip/edge cases (tiny terminals).
- [ ] T016 Run `pnpm test` (baseline count still passes **plus** T002/T003/T011) and `pnpm build`.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: none — **must** pass the Phase 0 smokes (they gate T004).
- **Foundational (Phase 2)**: after Setup — **blocks both stories**.
- **US1 (Phase 3)**: after Foundational.
- **US2 (Phase 4)**: after US1 (scroll wires into `FeedWindow`/`app.tsx` from US1).
- **Polish (Phase 5)**: after both stories.

### Task Dependencies

- **Foundational**: T002→T004 (measure), T003→T005 (layout); T006 (alt-screen) independent.
- **US1**: T004,T005 → T007 (FeedWindow) → T008 (app.tsx); T006 → T009 (index.tsx); T008,T009 → T010 (removals).
- **US2**: T011→T012 (useScroll); T008,T012 → T013 (wiring).
- **Shared files**: `app.tsx` is edited in T008 (US1) and T013 (US2) — sequence them. `index.tsx` only in T009.

### Parallel Opportunities

- T002 (`measure.test.ts`), T003 (`layout.test.ts`), T006 (`alt-screen.ts`) — different files, no deps → run together.
- After Foundational: T007 (FeedWindow) and T009 (index.tsx) can proceed in parallel (different files).
- T011 (`use-scroll.test.ts`) can start in parallel with US1 finalization (independent file).

---

## Parallel Example: Foundational kickoff

```bash
# Disjoint files, no inter-dependency — run together:
Task: "T002 measure unit tests in src/adapters/cli/tui/fullscreen/measure.test.ts"
Task: "T003 layout unit tests in src/adapters/cli/tui/fullscreen/layout.test.ts"
Task: "T006 AltScreen module in src/adapters/cli/tui/fullscreen/alt-screen.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 only — no scroll)

1. Phase 1: baseline green + Phase 0 smokes pass (T001).
2. Phase 2: Foundational primitives (T002–T006).
3. Phase 3: US1 — full-screen layout + bottom-pinned input/footer + exit safety (T007–T010).
4. **STOP and VALIDATE**: quickstart S1, S2, S4, S6, S7 — the input is pinned to the viewport bottom; exit restores the terminal.
5. This alone delivers the core requirement (Claude Code/Codex look).

### Incremental Delivery

1. Setup + Foundational → primitives ready.
2. US1 → full-screen + pinning (MVP) → validate.
3. US2 → in-app scroll → validate.
4. Polish → lazy-load + full quickstart + full `pnpm test`.

### Single-developer sequence (recommended)

T001 → (T002→T004, T003→T005, T006) → T007 → T008 → T009 → T010 → (US1 done) →
T011 → T012 → T013 → T014 → T015 → T016.

---

## Notes

- `[P]` = different files, no dependencies on incomplete tasks.
- `[Story]` maps a task to its user story.
- **Highest-risk TUI change to date** — rewrites the rendering model. The Phase 0
  smokes (alt-buffer render; measure deps) gate the rewrite; re-validate streaming
  + resize against the windowed feed (S4/S5).
- Mouse-wheel scroll is **best-effort/deferrable** (Ink 6 mouse is unreliable);
  keyboard scroll (PageUp/Down + j/k) is the v1 guarantee.
- `<Static>`, `ink-reset.ts`, `staticKey`, and `resetInkStatic` are removed
  (orphaned by this change) — clean up your own mess.
- After 005 lands, run `/speckit-tasks` checks for 003 and implement 003 on top
  (its `InputBox` drops into 005's pinned bottom region; logo = first feed entry).
- Commit after each task or logical group; stop at any checkpoint to validate.
