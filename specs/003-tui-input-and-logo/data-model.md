# Data Model: TUI Persistent Input Box + Seepient Agent Logo

**Feature**: `003-tui-input-and-logo` | **Date**: 2026-06-15

**Persistence**: **None.** This feature is pure TUI presentation. No schema, no
migration, no repository, no new state owner beyond React component state that
already exists in `app.tsx`. This document records the **in-memory shapes** the
new pieces introduce or extend, so contracts and tasks have precise types.

---

## 1. New pure domain function: `rainbow45`

Lives in the TUI presentation layer but is a pure, deterministic, side-effect-free
mapping (testable without React/Ink). It is the "domain logic" of the logo.

```ts
// src/adapters/cli/tui/logo/gradient.ts
import type { Theme } from '../theme.js';

/**
 * The rainbow order across Tokyo Night accent hues (see research.md R1).
 * Source of truth: the palette in theme.ts. Order is fixed (red→violet).
 */
export const RAINBOW_STOPS: ReadonlyArray<keyof Theme> = [
  'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple',
];

/**
 * Project a cell onto the 45° axis and interpolate across the rainbow stops
 * in HSL (hue rotation) so mid-tones stay vivid (RGB was rejected — muddy mids
 * between non-adjacent stops like red↔green).
 * Returns the hex color for the cell at (row, col) within a grid of size
 * (rows × cols). Pure: same inputs → same output. No Math.random / Date.
 *
 * t = (col + row) / (maxCol + maxRow)  ∈ [0,1]
 */
export function rainbowCellColor(
  row: number,
  col: number,
  rows: number,
  cols: number,
  palette: Theme,
): string;

/**
 * Map every non-space cell of a fixed ASCII grid to its gradient color.
 * Returns a grid of { char, color } cells, computed once (logo is static).
 */
export interface ColoredCell { char: string; color: string; }
export function gradientGrid(
  grid: ReadonlyArray<ReadonlyArray<string>>,
  palette: Theme,
): ColoredCell[][];
```

**Invariants**:
- `rows ≥ 1`, `cols ≥ 1` (caller guarantees via the logo constants).
- Space cells keep their char; color is still assigned by position so alignment
  is uniform (a space with a color is invisible — fine).
- Output length matches input grid dimensions exactly.

**State transitions**: none (stateless function).

---

## 2. Presentation component props

These are React prop contracts (full detail in `contracts/`). Summarized here as
the "data" each new piece consumes/produces.

```ts
// InputBox — wraps PromptArea's input in a border; adds disabled.
interface InputBoxProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  disabled: boolean;            // dim + ignore keystrokes; app.tsx composes
                                // from isRunning||overlay!==null||!!pendingPermission
  onHistoryUp?: () => void;
  onHistoryDown?: () => void;
  commands: Suggestion[];
  skills: Suggestion[];
}

// LogoBanner — large gradient banner; rendered via a kind:'logo' FeedEntry
// (seeded once at session start, scrolls away with the feed). No props.
// (Persistent TopBar wordmark deferred to a later task.)
```

No new persistent entity. No new state owner. `app.tsx` already owns `input`,
`isRunning`, etc.; the only change is `isRunning` now feeds `InputBox.disabled`
instead of gating `PromptArea`'s existence.

---

## 3. Validation rules

- `disabled` is the **only** new behavioral flag on `InputBox`/`TextInput`. When
  `true`, `TextInput` ignores all keystrokes (its `useInput` early-returns) and
  renders dimmed. `app.tsx` composes it: `isRunning || overlay !== null ||
  !!pendingPermission` (so overlays keep exclusive stdin).
- `FeedEntry` (`tui/types.ts`) gains `kind: 'logo'`; `message-area.tsx` `FeedItem`
  adds the case. Exactly one logo entry is seeded at session start.
- Logo grid constants are compile-time string literals (no runtime parsing of
  external input) — "parse at the boundary" does not apply; there is no external
  input.
- Width math reuses the existing `columns - HORIZONTAL_PADDING` discipline from
  `message-area.tsx`; the box adds 2 chars of border overhead, so content width
  is `boxWidth - 2`.
