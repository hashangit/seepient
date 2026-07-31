/**
 * Shared layout constants for the TUI.
 *
 * `HORIZONTAL_PADDING` insets every rendered line from the terminal edges.
 * It is applied both to the root `<Box>` (live area: prompt, status,
 * permission) and to each `<Static>` item (message history) — Ink's `<Static>`
 * renders at full terminal width and ignores parent padding, so history items
 * must pad themselves.
 *
 * Why pad at all: a line that fills the terminal's final column triggers an
 * auto-wrap (a phantom blank row below). Keeping every line ≤ `columns - 2`
 * avoids that and gives the TUI a gutter on both sides; Ink reflows within the
 * reduced width on resize.
 */
export const HORIZONTAL_PADDING = 1;
