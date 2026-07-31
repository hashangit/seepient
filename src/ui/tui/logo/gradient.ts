/**
 * Tokyo Night rainbow gradient for the Seepient Agent logo. Pure, deterministic, no
 * dependency. Each cell at (row, col) within a (rows × cols) grid is projected
 * onto the 45° axis: `t = (col + row) / ((cols-1) + (rows-1))` — sweeps
 * bottom-left → top-right; for a single row it reduces to a horizontal sweep.
 *
 * Interpolation is RGB between ADJACENT palette stops (red→orange→yellow→green
 * →cyan→blue→purple). Adjacent rainbow hues lerp cleanly (no muddy mid-tones),
 * and since the stops ARE the Tokyo Night accents, the result stays on-palette.
 */
export function rainbowCellColor(
  row: number,
  col: number,
  rows: number,
  cols: number,
  stops: readonly string[],
): string {
  const maxCol = Math.max(0, cols - 1);
  const maxRow = Math.max(0, rows - 1);
  const span = maxCol + maxRow;
  const t = span <= 0 ? 0 : Math.max(0, Math.min(1, (col + row) / span));
  const n = Math.max(1, stops.length - 1);
  const seg = t * n;
  const i = Math.min(Math.floor(seg), stops.length - 2);
  const frac = seg - i;
  const a = hexToRgb(stops[i]!);
  const b = hexToRgb(stops[i + 1]!);
  return rgbToHex(a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac, a[2] + (b[2] - a[2]) * frac);
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number): string => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}
