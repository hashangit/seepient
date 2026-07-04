# Research: TUI Persistent Input Box + Seepient Agent Logo

**Feature**: `003-tui-input-and-logo` | **Date**: 2026-06-15 (revised post-scrutinize)

Resolves every NEEDS CLARIFICATION raised during planning. Decision / Rationale
/ Alternatives for each. Revised findings are flagged **[fixed]**.

---

## R1. The exact Tokyo Night palette (logo color source)

**Decision**: Sample colors from the **existing** `theme.ts` (Tokyo Night Moon),
in rainbow order: `red #ff757f` → `orange #ff966c` → `yellow #ffc777` →
`green #c3e88d` → `cyan #86e1fc` → `blue #82aaff` → `purple #c099ff`.

**Rationale**: `theme.ts` is already the single color source ("no inline hex
elsewhere"). Reusing it keeps the logo consistent and re-themeable.

**Alternatives**: hard-coding the canonical non-Moon palette (rejected: second
color source); adding `gradient-string`/`tinygradient` (rejected: one helper,
don't add a dep — CLAUDE.md §6).

---

## R2. The 45° rainbow gradient — HSL hue rotation, no dependency  **[fixed]**

**Decision**: A pure function `rainbow45` that, for each cell `(row, col)` in the
logo's bounding box:

1. Project onto the 45° axis: `t = (col + row) / (maxCol + maxRow)` ∈ [0, 1].
2. Map `t` across the 7 rainbow stops and interpolate in **HSL** — rotate hue
   between the two surrounding stops, keep saturation/lightness near the palette
   values. HSL (not RGB) so mid-tones stay vivid rather than going muddy.
3. For a single-line element (`maxRow == 0`), `t = col / maxCol` → horizontal
   sweep; for the multi-line banner the diagonal term shifts each row's start.

Pure → unit-testable, deterministic (no `Math.random`). The logo grid is static,
so the result is computed **once** at module load and reused; the banner is a
`<Static>` entry rendered once → no per-frame cost.

**Alternatives**:
- **RGB lerp (originally chosen) — rejected:** interpolating non-adjacent stops
  (red↔green, green↔blue) in RGB passes through desaturated gray/brown mid-tones.
  For a brand logo that reads as washed-out. **Switched to HSL.**
- Discrete palette assignment (one stop per letter, no interpolation) — kept as a
  fallback for any future single-line wordmark; the large banner needs
  interpolation, so HSL stays the primary path.
- Per-frame recomputation — rejected: wasteful; logo is static.
- Truecolor-only assert — rejected: Ink/Chalk downgrade is fine.

---

## R3. Where the logo lives — and the real positioning model  **[fixed]**

**Finding**: The feed (`message-area.tsx`) uses Ink's `<Static>`, which writes
completed entries once into the terminal's **native scrollback**. The live region
(input box, footer, spinner, overlays) is re-rendered each frame and positioned
**immediately after** the static content — it is **not** pinned to the viewport
bottom. (The earlier draft's "bottom-anchored" wording was inaccurate; corrected.)

**Decision**: The large banner renders as a real feed entry — add `kind: 'logo'`
to `FeedEntry` (`tui/types.ts`) + a `FeedItem` case — seeded once at session
start. It scrolls up and out of view naturally as the user chats. **No transition
state machine; no second `<Static>** (a second Static would interact badly with
`ink-reset`/`staticKey` remounting).

**Deferred**: a persistent compact wordmark. Because the live region follows
content (not viewport-bottom), a header pinned to the **viewport top** would
require a full-screen rewrite — separate task, out of scope.

**Positioning caveat (load-bearing)**: making the input box "the last live
element" does **not** put it at the bottom of the terminal on short sessions — it
sits at the bottom of the *written content*. True viewport-bottom pinning needs
alternate-screen mode and is out of scope (see `spec.md` *Constraints*).

**Alternatives**: full-screen raw-mode rewrite (rejected: disproportionate,
high risk to streaming/resize/`ink-reset`); wordmark in `<Static>` (rejected:
scrolls away, not persistent); a second `<Static>` for the banner (rejected:
remount/reset interactions).

---

## R4. The input box — rounded border, always-on, disabled correctly  **[fixed]**

**Finding**: In `app.tsx`, `PromptArea` is one branch of a mutually-exclusive
live region; while running it is **replaced** by the spinner (the "vanishes"
bug), and it has no border. Separately, the overlays assume they *exclusively*
own stdin — `command-palette.tsx` documents *"the prompt is hidden while the
palette is open"* and registers its own `useInput`. Today that holds because
`PromptArea` is unmounted while an overlay is up.

**Decision**:
- `InputBox` wraps the existing input in a rounded border and is rendered
  **unconditionally** as the last live element (above the footer). The spinner /
  overlays / permission prompt render in the live slot **above** it.
- `InputBox.disabled` is composed as `isRunning || overlay !== null ||
  !!pendingPermission`. When disabled, `TextInput`'s `useInput` early-returns, so
  an open overlay/palette keeps exclusive stdin ownership — no double-handling of
  keystrokes. (The earlier draft gated disable on `isRunning` only; **fixed** to
  include overlays/permission.)

**Rationale**: minimal, surgical; reuses all input logic (one `enabled` flag).
Always-on + dim-while-busy gives presence; the border gives separation; the
composite disable preserves the overlays' stdin contract.

**Alternatives**: keep the spinner replacing the input (rejected: the core
complaint); rebuild input inside the box (rejected: violates Surgical Changes);
`ink-box` dependency for the border (rejected: box-drawing chars, no dep).

---

## R5. Border drawing characters

**Decision**: Rounded corners via Unicode box-drawing: `╭─…─╮` / `│` / `╰─…─╯`.
Width = `min(stdout.columns, MAX) - 2*HORIZONTAL_PADDING`, capped so each line
stays `< columns` (same discipline as `message-area.tsx`). Recompute from live
`stdout.columns` on resize.

---

## R6. Branding split — logo wordmark vs short name (intentional)

**Decision**: `"Seepient Agent"` appears **only** in `LogoBanner`. Placeholder
("Ask Seepient …"), spinner ("Seepient is working"), footer, help, binary name
(`seepient`), and package name use the short name. Both forms appear on screen at
once — this is **intentional**: the logo is the full product wordmark, while the CLI
command and package keep the short, typeable name.

---

## Open items after research

None. The inaccurate "bottom-anchored" premise and the `isRunning`-only disable
condition are corrected; the logo mechanism is pinned to a typed feed entry; the
gradient switched to HSL.
