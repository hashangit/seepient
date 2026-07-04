---

description: "Task list for 003-tui-input-and-logo (TUI persistent input box + Seepient Agent logo) — post-scrutinize"
---

# Tasks: TUI Persistent Input Box + Seepient Agent Logo

**Input**: Design documents from `/specs/003-tui-input-and-logo/` (plan.md,
spec.md, research.md, data-model.md, contracts/, quickstart.md) — revised after
the `/scrutinize` pass.

**Scrutinize fixes baked in**: (1) positioning is content-flow, not
viewport-bottom-pinned; (2) input is disabled during runs **and** overlays
**and** permission prompts; (3) the logo is a typed `kind: 'logo'` feed entry
(no `<Static>` hack, no `as any`); (4) gradient uses HSL hue rotation; (5)
mixed branding is intentional.

**Tests**: the pure `rainbow45` gradient gets unit tests (FR-008), including a
saturation guard against muddy RGB mid-tones. Component behavior is validated via
the manual `quickstart.md` scenarios.

**Organization**: two P1 stories — US1 (input box, 🎯 MVP) and US2 (logo). They
touch disjoint files **except `app.tsx`**, whose two edits are sequenced.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on incomplete tasks)
- **[Story]**: US1 / US2 (user-story phases only)
- Exact file paths in every description

---

## Phase 1: Setup

**Purpose**: regression baseline.

- [ ] T001 Run `pnpm test`; confirm the full pre-existing suite is green and record the count (≈262) as the baseline. Confirm `pnpm build` (tsc) compiles cleanly.

**Checkpoint**: baseline green; safe to start.

---

## Phase 2: Foundational (Blocking Prerequisites)

**None required.** US1 and US2 touch disjoint files (`components/input-box.tsx`
vs `logo/*` + `components/logo-banner.tsx`) and share no prerequisite. The only
shared file is `app.tsx`; its two edits are sequenced (T005 → T011). Proceed to
either story after Setup.

---

## Phase 3: User Story 1 - Persistent, bordered input box (Priority: P1) 🎯 MVP

**Goal**: the prompt renders inside a rounded box as the last live element above
the footer on every frame; disabled (dimmed, inert) while running or while an
overlay/permission prompt is open; spinner above the box while running.

**Independent Test** (quickstart S1–S2): `seepient` → rounded box above the footer;
trigger a long shell command → box stays dimmed with spinner above it, keystrokes
ignored; Ctrl+P → box stays visible but keys go to the palette, not the box.

### Implementation for User Story 1

- [ ] T002 [P] [US1] Add an optional `enabled` prop (default `true`) to `TextInput` in `src/adapters/cli/tui/components/text-input.tsx`: when `false`, the `useInput` callback early-returns (no keystrokes) and rendered text/placeholder uses `theme.fgDim`. No other input logic changes.
- [ ] T003 [US1] Forward an optional `enabled` prop through `PromptArea` in `src/adapters/cli/tui/components/prompt-area.tsx` to the inner `TextInput`. Default `true`. (depends on T002)
- [ ] T004 [US1] Create `InputBox` in `src/adapters/cli/tui/components/input-box.tsx`: rounded box (`╭─╮`/`│`/`╰─╯`) at `min(stdout.columns, MAX) - 2*HORIZONTAL_PADDING` (recompute on resize via `useStdout`), wrapping the existing `PromptArea` row. `disabled` dims border+text (`theme.fgDim`) and passes `enabled={!disabled}` to `PromptArea`. Multi-line input grows the box; bottom border closes around N rows. (depends on T003)
- [ ] T005 [US1] Restructure the live region in `src/adapters/cli/tui/app.tsx`: render `<InputBox disabled={isRunning || overlay !== null || !!pendingPermission} …/>` **unconditionally** directly above `<Footer/>`; move the `"Seepient is working"` spinner into the mutually-exclusive live slot **above** the box (it must no longer replace the input). The composite `disabled` keeps an open overlay/palette as the sole live stdin owner. Verify the box is present in idle, running, overlay, and permission frames.

**Checkpoint**: User Story 1 fully functional and independently testable.

---

## Phase 4: User Story 2 - Seepient Agent logo (Priority: P1)

**Goal**: on launch, a large "Seepient Agent" banner with a vivid Tokyo Night rainbow
gradient (45° axis, HSL) renders as the first feed entry and scrolls away as the
user chats.

**Independent Test** (quickstart S3): `seepient` on a fresh session → large gradient
"Seepient Agent", vivid red→…→purple sweep; send a message → banner scrolls up out of
view; resize → reflows without breaking.

### Tests for User Story 2 (gradient pure function — FR-008)

> **NOTE**: write the gradient test FIRST; confirm it FAILS before T007.

- [ ] T006 [P] [US2] Write unit tests in `src/adapters/cli/tui/logo/gradient.test.ts` per `contracts/gradient.md`: single-line (`rows=1, cols=4`) endpoints are exactly `red` (#ff757f) and `purple` (#c099ff); multi-line (`3×3`) corners are `red` (top-left) and `purple` (bottom-right); **interior cells are saturated** (S ≥ floor) — guards against the muddy-RGB-mid regression; output dims equal input; deterministic.

### Implementation for User Story 2

- [ ] T007 [US2] Implement the pure gradient module in `src/adapters/cli/tui/logo/gradient.ts`: `RAINBOW_STOPS` (red→orange→yellow→green→cyan→blue→purple), `rainbowCellColor(row,col,rows,cols,palette)` (45° projection `t=(col+row)/(maxCol+maxRow)`, **HSL hue rotation** between stops, S/L near palette), and `gradientGrid(grid,palette)` → `ColoredCell[][]`. Pure/deterministic; no React/Ink/Math.random. (TDD: make T006 pass)
- [ ] T008 [P] [US2] Create the ASCII "Seepient Agent" banner grid as a constant in `src/adapters/cli/tui/logo/grids.ts`: a multi-line `string[][]` (lines split to cells), every line width-capped `< columns`.
- [ ] T009 [P] [US2] Add `kind: 'logo'` to the `FeedEntry` union in `src/adapters/cli/tui/types.ts` and a `case 'logo': return <LogoBanner/>;` to `FeedItem` in `src/adapters/cli/tui/components/message-area.tsx`. No `as any`. (different files from T007/T008)
- [ ] T010 [US2] Create `LogoBanner` in `src/adapters/cli/tui/components/logo-banner.tsx`: renders the banner grid with per-cell colors from `gradientGrid(grid, theme)`. No props. (depends on T007, T008; exported for the T009 case)
- [ ] T011 [US2] In `src/adapters/cli/tui/app.tsx` (or `useFeed` init), seed exactly one `{ id: '__logo__', kind: 'logo' }` entry at session start, before any messages, so it scrolls away via the existing `<Static>` as the feed grows. On `/clear`, re-seed it. (depends on T005 — same file; and T009, T010)

**Checkpoint**: User Story 2 fully functional and independently testable.

---

## Phase 5: Polish & Cross-Cutting

- [ ] T012 [P] Verify the lazy-load invariant: `echo hi | seepient`, `seepient -n "hi"`, `seepient --docker …` never statically import any new `.tsx`. Run any existing CI guard.
- [ ] T013 Run `quickstart.md` S1–S6 in a real TTY: fix box-border reflow at 80 cols / on resize; **visually confirm the gradient is a vivid rainbow (not muddy)**; confirm the box is disabled (inert) while running/overlay/permission; confirm positioning is content-flow (last live element above footer) and **flag to the user** if viewport-bottom pinning was actually expected (separate task).
- [ ] T014 Run `pnpm test` (baseline count still passes **plus** T006) and `pnpm build`.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: none.
- **Foundational (Phase 2)**: none required.
- **US1 (Phase 3)**: after Setup.
- **US2 (Phase 4)**: after Setup. **Shares `app.tsx` with US1** — T005 before T011.
- **Polish (Phase 5)**: after both stories.

### User Story Dependencies

- **US1 (P1) 🎯 MVP**: T002 → T003 → T004 → T005 (input chain).
- **US2 (P1)**: T006 (test, fail first) → T007 (impl) and T008 (grid) and T009 (feed kind+case) → T010 (component) → T011 (seed). T011 also depends on T005 (same file).
- **US1 ↔ US2**: otherwise independent; only `app.tsx` is shared.

### Parallel Opportunities

- T002 (`text-input.tsx`), T006 (`gradient.test.ts`), T008 (`grids.ts`), T009 (`types.ts`+`message-area.tsx`) — different files, no deps → run together.
- Within US2: T008 and T009 in parallel after T006.
- US1 and US2 in parallel **except** their `app.tsx` edits (T005 → T011).

---

## Parallel Example: Kickoff of both stories

```bash
# Disjoint files, no inter-dependency — run together:
Task: "T002 add `enabled` prop to TextInput in src/adapters/cli/tui/components/text-input.tsx"
Task: "T006 gradient unit tests in src/adapters/cli/tui/logo/gradient.test.ts"
Task: "T008 ASCII banner grid in src/adapters/cli/tui/logo/grids.ts"
Task: "T009 add kind:'logo' FeedEntry in src/adapters/cli/tui/types.ts + FeedItem case in message-area.tsx"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1: baseline green (T001).
2. Phase 3: US1 — persistent bordered input box (T002–T005).
3. **STOP and VALIDATE**: quickstart S1–S2; box is bordered, present, and inert while running/overlay/permission.

### Incremental Delivery

1. Setup → baseline green.
2. US1 → input box (MVP) → validate.
3. US2 → logo banner → validate.
4. Polish → lazy-load + full quickstart + full `pnpm test`.

### Single-developer sequence (recommended)

T001 → T002 → T003 → T004 → T005 → (US1 done) → T006 → T007 → T008 → T009 →
T010 → T011 → T012 → T013 → T014.

---

## Notes

- `[P]` = different files, no dependencies on incomplete tasks.
- `[Story]` maps a task to its user story.
- No new dependency; no schema/migration; no engine/core/infra change.
- Only `app.tsx` is shared across stories — sequence its edits (T005 → T011).
- Deferred: persistent compact wordmark; mid-run message queue/steering; **true viewport-bottom input pinning** (needs fullscreen — separate task).
- Commit after each task or logical group; stop at any checkpoint to validate.
