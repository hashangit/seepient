/**
 * Ink internals reset — the Command Code pattern, adapted for stock Ink 6.6.0
 * without a bundler.
 *
 * Why: `<Static>` renders each item once and freezes it, so resize-reflow and
 * tool-block expand/collapse (which need to re-render history) don't work.
 * Remounting `<Static>` via a `key` bump re-paints everything — BUT Ink
 * accumulates the re-emitted items in its internal `fullStaticOutput`, causing
 * duplicate "phantom" lines. Resetting `fullStaticOutput` + `lastOutput` before
 * the remount fixes that.
 *
 * Stock Ink doesn't expose the instance. Its `package.json` `exports` field
 * blocks `ink/build/instances.js` as a subpath, BUT importing the file by its
 * resolved absolute path (derived from the exported main entry) bypasses
 * package-exports enforcement — no bundler required.
 *
 * INK INTERNALS DEPENDENCY (T0-4 audit):
 *   Version: ink@6.6.0 (tested)
 *   File:   {ink-package}/build/instances.js
 *   Symbol: `default` export — a `WeakMap<object, { fullStaticOutput: string; lastOutput: string }>`
 *   Fields: `fullStaticOutput` (string), `lastOutput` (string)
 *   If Ink changes the export shape or field names, the version-drift guard logs
 *   a warning and `resetInkStatic` returns false (no crash — degrades to
 *   artifacts on resize).
 */

import { createRequire } from 'node:module';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';

const REQUIRED_INK_VERSION = '6.6.0';

const nodeRequire = createRequire(import.meta.url);
const inkBuildDir = path.dirname(nodeRequire.resolve('ink'));

type InkInternal = { fullStaticOutput: string; lastOutput: string };
let inkInstances: WeakMap<object, InkInternal> | null | undefined;

/** Pre-load the internal instances store (async; call once at TUI start). */
export async function warmInkReset(): Promise<void> {
  if (inkInstances !== undefined) return;
  try {
    // Absolute-path import sidesteps Ink's `exports` restriction.
    const mod = await import(path.join(inkBuildDir, 'instances.js'));
    inkInstances = mod.default instanceof WeakMap ? mod.default : null;
  } catch {
    inkInstances = null;
  }
}

/**
 * Reset Ink's accumulated Static output + last-frame tracking so a `<Static>`
 * remount repaints cleanly. Returns false (no-op) if the internals are
 * unavailable or shaped differently than expected.
 */
export function resetInkStatic(stdout: object): boolean {
  if (!inkInstances) return false;
  const ink = inkInstances.get(stdout) as InkInternal | undefined;
  if (!ink) return false;
  if (typeof ink.fullStaticOutput !== 'string' || typeof ink.lastOutput !== 'string') {
    return false;
  }
  try {
    ink.fullStaticOutput = '';
    ink.lastOutput = '';
    return true;
  } catch {
    return false;
  }
}

/**
 * T0-4 — Version-drift guard.
 *
 * Checks the installed Ink version against the tested version. If they differ,
 * logs a warning so the operator knows the internals may have changed shape.
 * Does NOT throw — the fail-safe is `resetInkStatic` returning false.
 */
export function guardInkVersion(): void {
  try {
    const pkgPath = path.join(path.dirname(inkBuildDir), 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const actual = pkg.version as string;
    if (actual !== REQUIRED_INK_VERSION) {
      const msg = `[seepient] Ink version drift: expected ${REQUIRED_INK_VERSION}, found ${actual}. ` +
        'Ink internals may have changed — ink-reset.ts may need an update. ' +
        'If you see phantom lines on resize, report this.';
      process.stderr.write(`${msg}\n`);
    }
  } catch {
    // Can't read package.json — skip the guard silently.
  }
}

