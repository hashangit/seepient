# Feature Specification: TUI Persistent Input Box + Seepient Agent Logo

**Feature Branch**: `003-tui-input-and-logo`

**Created**: 2026-06-15 (revised post-scrutinize)

**Status**: ✅ IMPLEMENTED — on the `<Static>` model (see deviations below).

> Implementation notes (the spec was written for a full-screen model that was
> later reverted — 005). Actual build: the input border lives inside `PromptArea`
> (not a separate `InputBox`); the input is always visible with the spinner above
> it (queue / `/steer`-active, not dimmed); the logo is a figlet wordmark
> (`ANSI Compact`) with a Tokyo Night 45° rainbow gradient + `by hashangit · v…`
> descriptor, rendered as a `kind: 'logo'` feed entry that scrolls away. Branding is
> split by design: the logo shows the full wordmark ("Seepient Agent"), while the binary
> and package use the short name (`seepient`).

**Predecessor**: `specs/001-tui-upgrade` (the Ink/React TUI this builds on, US1-US4 shipped)

**Depends on**: `specs/005-fullscreen-tui` — **build 005 first**. 005 delivers the
full-screen model (alternate buffer + windowed feed + bottom-pinned input region).
003 layers on top: its `InputBox` drops into 005's pinned bottom region, and the
logo is the first windowed feed entry — **no layout changes in 003**. (003 also
runs standalone on the current content-flow model, just without viewport-bottom
pinning.)

**Source**: User request — the shipped TUI is missing two pieces every peer
agent CLI (Claude Code, Codex/Command, Pi, Codebuff) has: a visually separated
input box, and a brand logo.

## Scope decisions (confirmed with the user)

| Decision | Choice |
|---|---|
| Input box separator | **Rounded box** (`╭╮ │ ╰╯`) — full border, Claude Code style |
| Input while agent runs | **Stays visible, dimmed, input disabled**; spinner renders *just above* the box |
| Input while an overlay/permission prompt is open | **Also disabled** (overlays own stdin; the box stays visible but inert) |
| Input positioning | **Last live element, directly above the Footer, in content flow.** NOT viewport-bottom-pinned — see *Constraints* |
| Future: queue / steer mid-run | **Out of scope** — only noted as a follow-up |
| Logo placement | **Large welcome banner on launch**, rendered as the first feed entry so it scrolls away as the feed grows |
| Logo text | **"Seepient Agent"** (the full wordmark; the binary and package use the short name `seepient`) |
| Logo color | **Tokyo Night rainbow** across all letters, sampled along a **45° axis**, interpolated in **HSL** (hue rotation) so mid-tones stay vivid |
| Persistent compact wordmark | **Deferred** to a later task |
| Branding scope | **Logo only shows the full wordmark.** Placeholder, spinner, footer, binary name, and package use the short name `seepient` — split branding is **intentional** |

## Constraints (read before judging "pinned to the bottom")

The TUI renders with **plain Ink** (`render(<TuiApp/>, { exitOnCtrlC: false })`,
no fullscreen/alternate-buffer). `<Static>` writes history into the terminal's
native scrollback; the live region (input box, footer, spinner, overlays) is
re-rendered each frame and positioned **immediately after** the static content.

**Consequence — be explicit:** the input box is the **last live element**, but
it sits at the bottom of the *written content*, **not** pinned to the bottom of
the terminal viewport. On a short/empty session it appears high on the screen.
This is the existing rendering model; this feature does **not** change it. True
viewport-bottom pinning (Claude Code / Codex full-screen style) is the separate
rewrite tracked in **`specs/005-fullscreen-tui`** (alternate-screen + windowed
feed) — **build 005 first**; this feature's `InputBox` then drops into its pinned
bottom region.

What this feature *does* guarantee: the box is always **present** (never
replaced by the spinner), **visually separated** by its border, and **first in
z-order at the bottom of the content** (directly above the footer). The large
logo banner (US2) fills vertical space on launch, so on a fresh session the box
sits lower — a partial, incidental mitigation only.

## User Scenarios & Testing

### User Story 1 - Persistent, bordered input box (Priority: P1)

The prompt renders inside a rounded-border box, directly above the status footer
as the last live element, and is present on **every** frame. While the agent
runs, the box stays visible but dimmed and stops accepting keystrokes; the
"Seepient is working" spinner sits immediately above the box instead of replacing
it. While an overlay (palette/help/model/settings) or a permission prompt is
open, the box also stays visible but inert (the overlay owns stdin).

**Why this priority**: The shipped `PromptArea` is rendered as one of several
mutually-exclusive options in the live region (see `app.tsx`) — while running it
is replaced by the spinner, so it vanishes, and it has no border so it reads as
just another line of the feed.

**Independent Test**: Run `seepient`, submit a prompt that triggers a long shell
command — the rounded input box stays (dimmed) with the spinner above it; when
the run finishes the box is live again. Open Ctrl+P — the box stays visible but
keystrokes go to the palette, not the box.

**Acceptance Scenarios**:

1. **Given** the TUI is idle, **When** it renders, **Then** the prompt sits
   inside a rounded box (`╭…╮` / `╰…╯`) directly above the footer status bar.
2. **Given** the box, **When** the terminal resizes, **Then** the box reflows to
   the new width without breaking the border (stays `< columns`).
3. **Given** a run in progress, **When** the user looks at the bottom of the
   content, **Then** the input box is still rendered (dimmed) and the working
   spinner is rendered immediately above the box — the box never disappears.
4. **Given** a run in progress, **When** the user types, **Then** keystrokes are
   ignored (input disabled).
5. **Given** an overlay (palette/help/model/settings) or a permission prompt is
   open, **When** the user types, **Then** keystrokes go to the overlay/prompt,
   not the input box (the box is inert but still visible).
6. **Given** autocomplete (`/` or `@`) or history (↑/↓), **When** used while
   idle, **Then** behavior is byte-identical to today.
7. **Given** non-interactive launch (`-n`, piped, `--docker`, SDK/Server),
   **When** started, **Then** React/Ink are never imported.

---

### User Story 2 - Seepient Agent logo (Priority: P1)

On launch, a large "Seepient Agent" banner renders with a Tokyo Night rainbow
gradient running across all the letters along a 45° axis. It renders as the
**first feed entry**, so it scrolls up into native scrollback as the user chats.

**Why this priority**: Brand presence + visual identity parity with peer agent
CLIs. Pure presentation; touches only the TUI presentation layer.

**Independent Test**: Run `seepient` on a fresh session — see the large gradient
"Seepient Agent". Send a message — the banner scrolls up out of view. Confirm the
sweep is a vivid rainbow (red → orange → yellow → green → cyan → blue → purple).

**Acceptance Scenarios**:

1. **Given** a fresh session, **When** the TUI launches, **Then** the large
   multi-line gradient "Seepient Agent" renders as the first feed entry.
2. **Given** the feed is growing, **When** entries scroll, **Then** the banner
   scrolls away via the normal `<Static>` mechanism (it is a real feed entry,
   not a special-case element).
3. **Given** the logo, **When** inspected, **Then** every letter cell is colored
   from the Tokyo Night palette (`theme.ts`) interpolated in **HSL** along a 45°
   axis — no muddy RGB mid-tones, no new dependency.
4. **Given** the branding split, **When** scanning the rest of the UI,
   **Then** the placeholder, spinner, footer, binary, and package say
   `seepient` — only the logo says "Seepient Agent" (intentional split branding).

---

### Edge Cases

- Terminal too narrow for the box border + content? (Wrap/truncate; verify at
  80 cols — the box border is 2 chars of overhead.)
- Multi-line input (Shift+Enter) growing taller than one row? (Box grows
  vertically; border closes around N rows.)
- Gradient on a 1-line element vs an N-line banner? (Same projection; on a
  single row the 45° axis reduces to a horizontal sweep.)
- Color fidelity in terminals without truecolor? (Ink/Chalk downgrades to the
  nearest 256-color; the sweep still reads. Validate the HSL result in a real
  render before closing the task.)

## Requirements

### Functional Requirements

- **FR-001**: The prompt MUST render inside a rounded-border box (`╭─╮` top,
  `│` sides, `╰─╯` bottom), full width minus the gutter, immediately above the
  `Footer`, on every frame. It is the **last live element in content flow**
  (not viewport-bottom-pinned — see *Constraints*).
- **FR-002**: The input box MUST be present in **all** states. It MUST be
  **disabled** (dimmed, ignores keystrokes) whenever the agent is running **or**
  an overlay is open **or** a permission prompt is pending. The working
  indicator MUST render immediately above the box while running.
- **FR-003**: The box MUST reuse the existing input machinery (`TextInput`,
  `Autocomplete`, history ↑/↓, `/`+`@` completion). A single `enabled` flag on
  `TextInput` powers disable (its `useInput` early-returns); `InputBox.disabled`
  composes it from `isRunning || overlay !== null || !!pendingPermission`.
- **FR-004**: The logo MUST render "Seepient Agent" with per-cell colors sampled from
  the Tokyo Night palette in `theme.ts` along a 45° axis, interpolated in **HSL**
  (hue rotation) for vivid mid-tones. Pure function, unit-tested, no new
  dependency.
- **FR-005**: The banner MUST be a real feed entry — add `kind: 'logo'` to the
  `FeedEntry` union (`tui/types.ts`) and a case in `FeedItem`
  (`message-area.tsx`) rendering `<LogoBanner/>`; seed one logo entry at session
  start so it scrolls away with the feed via `<Static>`. No special-case element,
  no `as any`.
- **FR-006**: Branding is split by design. Every user-visible string other than the
  logo, plus the binary name and package name, use the short name `seepient`; only the
  logo shows the full "Seepient Agent" wordmark. Split branding is intentional.
- **FR-007**: Non-interactive launch paths MUST never import the new components;
  the lazy-load invariant MUST hold.
- **FR-008**: `pnpm test` MUST pass. The gradient function MUST have unit tests.

### Key Entities

- **`InputBox`** (presentation component): wraps `PromptArea`'s input in a
  rounded border; `disabled` dims + disables (composed from run/overlay/permission
  state by `app.tsx`).
- **`LogoBanner`** (presentation component): large multi-line ASCII "Seepient Agent";
  rendered through a `kind: 'logo'` feed entry.
- **`FeedEntry` (`tui/types.ts`)**: gains a `kind: 'logo'` variant (one seeded at
  session start).
- **`rainbow45`** (pure function): per-cell hex color via 45° projection + HSL
  hue interpolation across the Tokyo Night rainbow stops.

### Success Criteria

### Measurable Outcomes

- **SC-001**: Input is a clearly bordered box, present (dimmed) during runs and
  overlays — vs the current borderless prompt that vanishes while running.
- **SC-002**: Spinner appears above the input box during runs — vs replacing it.
- **SC-003**: "Seepient Agent" logo with a vivid 45° Tokyo Night rainbow shows on
  launch and scrolls away as the feed grows.
- **SC-004**: Only the logo text changed to "Seepient Agent"; binary/package/Seepient
  strings elsewhere unchanged.
- **SC-005**: `seepient -n`, SDK, Server, and `pnpm test` unaffected.

## Assumptions

- Positioning is content-flow (last live element above the footer), **not**
  viewport-bottom-pinned. This matches the existing Ink rendering model; true
  bottom-pinning is a separate task (see *Constraints*).
- The banner rides the existing single `<Static>` as a `kind: 'logo'` feed entry
  — no second `<Static>` (which would interact badly with `ink-reset`/`staticKey`).
- A persistent compact wordmark was considered and **deferred**.
- React 19 + Ink 6.6.0 already drive the TUI; no version changes.
- The Vitest suite (~262 tests) is the regression baseline.
