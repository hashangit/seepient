/**
 * Spec 027 (T010): seepient-core public surface pin.
 *
 * The core entry's export set must equal the contract list — GENERATED from
 * the actual export sites in `src/transport/sdk/core.ts` (value exports only;
 * type exports erase at runtime), never hand-copied. The fail-closed
 * registration denial must name `seepient`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import * as coreEntry from "../transport/sdk/core.js";
import { ToolRegistry, resolveTools } from "../transport/sdk/core.js";

const CORE_TS = join(dirname(new URL(import.meta.url).pathname), "../transport/sdk/core.ts");

/** Value-export names declared by the core entry source (the contract list). */
function declaredValueExports(source: string): Set<string> {
  const names = new Set<string>();
  // export { a, b, type c } from "..." — value names only
  for (const m of source.matchAll(/export\s+\{([^}]+)\}/g)) {
    for (const raw of m[1].split(",")) {
      const item = raw.trim();
      if (!item || item.startsWith("type ")) continue;
      names.add(item.split(/\s+as\s+/).pop()!.trim());
    }
  }
  // export const/function/class/let/var <name>
  for (const m of source.matchAll(
    /export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class)\s+([a-zA-Z0-9_$]+)/g,
  )) {
    names.add(m[1]);
  }
  return names;
}

function pinViolations(expected: Set<string>, actual: Set<string>): string[] {
  const violations: string[] = [];
  for (const name of actual) {
    if (!expected.has(name)) violations.push(`unplanned export: ${name}`);
  }
  for (const name of expected) {
    if (!actual.has(name)) violations.push(`missing export: ${name}`);
  }
  return violations;
}

describe("seepient-core surface pin (027 T010)", () => {
  it("runtime exports equal the contract list generated from core.ts", () => {
    const expected = declaredValueExports(readFileSync(CORE_TS, "utf8"));
    expect(expected.size).toBeGreaterThan(20); // the parse itself must be live

    const actual = new Set(Object.keys(coreEntry));
    const violations = pinViolations(expected, actual);
    expect(violations, violations.join("; ")).toEqual([]);
  });

  it("negative self-test: an unplanned export fails the pin", () => {
    const expected = declaredValueExports(readFileSync(CORE_TS, "utf8"));
    const tampered = new Set([...Object.keys(coreEntry), "createStatelessAgent"]);
    const violations = pinViolations(expected, tampered);
    expect(violations).toContain("unplanned export: createStatelessAgent");
    expect(violations.length).toBeGreaterThan(0);
  });

  it("fail-closed registration denial names seepient", () => {
    expect(() => resolveTools(["read_file"], new ToolRegistry())).toThrow(/seepient/);
  });
});
