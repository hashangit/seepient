/**
 * Build prerequisite (review C6): remove stale compiled output so deleted
 * modules cannot linger in the published tarball — while PRESERVING
 * `dist/native-fs-commit`, which the release pipeline stages before
 * `pnpm publish` (prepublishOnly → build → tsc must not wipe it; the
 * pack:verify gate enforces that the staged helpers survive).
 */
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const dist = "dist";
const PRESERVE = new Set(["native-fs-commit"]);

let entries = [];
try {
  entries = readdirSync(dist);
} catch {
  process.exit(0); // nothing to clean
}

for (const entry of entries) {
  if (PRESERVE.has(entry)) continue;
  rmSync(join(dist, entry), { recursive: true, force: true });
}
