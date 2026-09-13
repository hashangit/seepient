/**
 * FR-017 Process-state invariant gate (Spec 022, T002 / T033).
 *
 * Scans src/domain, src/capabilities, src/transport, and src/foundations for
 * module-level mutable state and registries.
 *
 * Flags any module-level `let` or mutable collection (Map/Set/Array registry)
 * unless explicitly accepted in the pinned list (Spec 022 data-model §6).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SCANNED_LAYERS = ["domain", "capabilities", "transport", "foundations"];

interface Violation {
  file: string;
  line: number;
  identifier: string;
  kind: "let" | "mutable-collection";
  snippet: string;
}

/**
 * Pinned accepted module-level state per Spec 022 data-model §6.
 * Format: "relative/path.ts:identifier"
 */
export const PINNED_ACCEPTED_STATE: readonly string[] = Object.freeze([
  "foundations/models-catalog.ts:globalCatalogAccessor",
  "domain/sessions/session-store.ts:registry",
  "domain/providers/config-store/provider-config-store.ts:baseConfigCache",
  "domain/tenancy/tenancy-mode.ts:noticePrinted",
  "transport/auth/auth.ts:cachedKeys",
  "transport/auth/auth.ts:cacheMtimeMs",
  "transport/sdk/settings.ts:manager",
  "capabilities/skills/skill-sources-helper.ts:multiZeroSourcesNoticed",
  "transport/http/provider-management/oauth.ts:pendingOAuthAttempts",
]);

function listSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      listSourceFiles(full, acc);
    } else if ((entry.endsWith(".ts") || entry.endsWith(".tsx")) && !entry.endsWith(".test.ts") && !entry.endsWith(".spec.ts") && !entry.endsWith(".d.ts")) {
      acc.push(full);
    }
  }
  return acc;
}

function isConstantCase(name: string): boolean {
  return /^[A-Z0-9_]+$/.test(name);
}

export function scanForModuleState(files: string[]): {
  violations: Violation[];
  matchedPinned: string[];
} {
  const violations: Violation[] = [];
  const matchedPinned = new Set<string>();

  for (const file of files) {
    const rel = relative(join(ROOT, "src"), file).replace(/\\/g, "/");
    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Skip comments
      if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
        continue;
      }

      // Check top-level `let` (not indented)
      const letMatch = line.match(/^(?:export\s+)?let\s+([a-zA-Z0-9_]+)/);
      if (letMatch) {
        const id = letMatch[1];
        const key = `${rel}:${id}`;
        if (!PINNED_ACCEPTED_STATE.includes(key)) {
          violations.push({
            file: rel,
            line: i + 1,
            identifier: id,
            kind: "let",
            snippet: trimmed,
          });
        } else {
          matchedPinned.add(key);
        }
        continue;
      }

      // Check top-level mutable collections (not indented, non-constant Map/Set or explicit registry)
      const constCollectionMatch = line.match(/^(?:export\s+)?const\s+([a-zA-Z0-9_]+)\s*(?::\s*[^=]+)?\s*=\s*new\s+(?:Map|Set)/);
      if (constCollectionMatch) {
        const id = constCollectionMatch[1];
        if (!isConstantCase(id)) {
          const key = `${rel}:${id}`;
          if (!PINNED_ACCEPTED_STATE.includes(key)) {
            violations.push({
              file: rel,
              line: i + 1,
              identifier: id,
              kind: "mutable-collection",
              snippet: trimmed,
            });
          } else {
            matchedPinned.add(key);
          }
        }
        continue;
      }

      // Check top-level mutable collections (empty array [], empty object {}, or explicit registry array)
      const constEmptyOrRegistryMatch = line.match(
        /^(?:export\s+)?const\s+([a-zA-Z0-9_]+)\s*(?::\s*[^=]+)?\s*=\s*(?:\[\s*\]|\{\s*\}|\[)/,
      );
      if (constEmptyOrRegistryMatch) {
        const id = constEmptyOrRegistryMatch[1];
        const isEmptyLiteral = /=\s*(?:\[\s*\]|\{\s*\})/.test(trimmed);
        if (id === "registry" || (!isConstantCase(id) && isEmptyLiteral)) {
          const key = `${rel}:${id}`;
          if (!PINNED_ACCEPTED_STATE.includes(key)) {
            violations.push({
              file: rel,
              line: i + 1,
              identifier: id,
              kind: "mutable-collection",
              snippet: trimmed,
            });
          } else {
            matchedPinned.add(key);
          }
          continue;
        }
      }

      // Check top-level Symbol.for registration
      const symbolMatch = line.match(
        /^(?:export\s+)?const\s+([a-zA-Z0-9_]+)\s*(?::\s*[^=]+)?\s*=\s*Symbol\.for\(/,
      );
      if (symbolMatch) {
        const id = symbolMatch[1];
        const key = `${rel}:${id}`;
        if (!PINNED_ACCEPTED_STATE.includes(key)) {
          violations.push({
            file: rel,
            line: i + 1,
            identifier: id,
            kind: "mutable-collection",
            snippet: trimmed,
          });
        } else {
          matchedPinned.add(key);
        }
        continue;
      }
    }
  }

  return { violations, matchedPinned: Array.from(matchedPinned) };
}

describe("FR-017 process-state invariant gate", () => {
  const files = SCANNED_LAYERS.flatMap((layer) =>
    listSourceFiles(join(ROOT, "src", layer))
  );

  it("bans unpinned module-level mutable state in domain, capabilities, transport, and foundations", () => {
    const { violations } = scanForModuleState(files);
    const report = violations
      .map((v) => `  - src/${v.file}:${v.line} (${v.identifier}, ${v.kind}): ${v.snippet}`)
      .join("\n");

    expect(
      violations,
      `Found ${violations.length} unpinned module-level mutable state declarations:\n${report}`
    ).toEqual([]);
  });

  it("fails if any pinned accepted state entry is no longer present in source (dead entries / list drift)", () => {
    const { matchedPinned } = scanForModuleState(files);
    const deadEntries = PINNED_ACCEPTED_STATE.filter((entry) => !matchedPinned.includes(entry));

    expect(
      deadEntries,
      `Found ${deadEntries.length} dead entries in PINNED_ACCEPTED_STATE that do not exist in source files:\n${deadEntries.map((e) => `  - ${e}`).join("\n")}`
    ).toEqual([]);
  });
});
