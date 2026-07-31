import { describe, it, expect } from 'vitest';
import { rainbowCellColor } from '../gradient.js';

// Tokyo Night Moon accent stops (matching theme.ts).
const STOPS = ['#ff757f', '#ff966c', '#ffc777', '#c3e88d', '#86e1fc', '#82aaff', '#c099ff'];

describe('rainbowCellColor', () => {
  it('hits the red stop at the bottom-left corner (t=0)', () => {
    expect(rainbowCellColor(0, 0, 2, 10, STOPS)).toBe('#ff757f');
  });
  it('hits the purple stop at the top-right corner (t=1)', () => {
    expect(rainbowCellColor(1, 9, 2, 10, STOPS)).toBe('#c099ff');
  });
  it('is deterministic (same input → same output)', () => {
    const a = rainbowCellColor(0, 3, 2, 10, STOPS);
    const b = rainbowCellColor(0, 3, 2, 10, STOPS);
    expect(a).toBe(b);
  });
  it('reduces to a horizontal sweep for a single row', () => {
    // 1 row, 4 cols: t = col/3 → 0, 1/3, 2/3, 1 → red, ~interior, ~interior, purple
    expect(rainbowCellColor(0, 0, 1, 4, STOPS)).toBe('#ff757f');
    expect(rainbowCellColor(0, 3, 1, 4, STOPS)).toBe('#c099ff');
  });
  it('clamps t outside [0,1]', () => {
    expect(rainbowCellColor(5, 50, 2, 10, STOPS)).toBe('#c099ff');
  });
});
