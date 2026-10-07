/**
 * Build prerequisite (review C6): remove stale compiled output so deleted
 * modules cannot linger in the published tarball — while PRESERVING
 * `dist/native-fs-commit`, which the release pipeline stages before
 * `pnpm publish` (prepublishOnly → build → tsc must not wipe it; the
 * pack:verify gate enforces that the staged helpers survive).
 *
 * Spec 027: also (re)writes the path-preserving `seepient/types` forwarding
 * shim — `dist/foundations/types.{js,d.ts}` re-exporting from seepient-core.
 * The root emit no longer contains the engine; this shim keeps the
 * `exports["./types"]` target byte-compatible for existing consumers (D16,
 * B-3-whitelisted as a forwarding shim).
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dist = "dist";
const PRESERVE = new Set(["native-fs-commit"]);

let entries = [];
try {
  entries = readdirSync(dist);
} catch {
  entries = [];
}

for (const entry of entries) {
  if (PRESERVE.has(entry)) continue;
  rmSync(join(dist, entry), { recursive: true, force: true });
}

const shimDir = join(dist, "foundations");
mkdirSync(shimDir, { recursive: true });
const SHIM_SOURCE = "seepient-core/dist/foundations/types.js";
writeFileSync(
  join(shimDir, "types.js"),
  `// Path-preserving forwarding shim (spec 027 D16): the engine moved to seepient-core.\nexport * from ${JSON.stringify(SHIM_SOURCE)};\n`,
);
writeFileSync(
  join(shimDir, "types.d.ts"),
  `// Path-preserving forwarding shim (spec 027 D16): the engine moved to seepient-core.\nexport * from ${JSON.stringify(SHIM_SOURCE)};\n`,
);

