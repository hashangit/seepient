/**
 * Spec 027 (T010): seepient-core public surface pin.
 *
 * The core entry's runtime export set is pinned against a COMMITTED GOLDEN
 * SNAPSHOT (`core-entry-exports.json`). The real property this pins: any
 * commit that adds, removes, or renames a core export fails here until the
 * golden file is regenerated — and that regeneration is the reviewable diff
 * (v0.9.0 gate r1 P1-3: the previous pin generated its expected set from
 * `core.ts` itself, so a scope-creeping commit updated both sides and stayed
 * green; a self-read can never catch a source change).
 *
 * The surface itself is narrated by contracts/core-package-surface.md §2;
 * the fail-closed registration denial must name `seepient`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import * as coreEntry from "../transport/sdk/core.js";
import { ToolRegistry, resolveTools } from "../transport/sdk/core.js";

const GOLDEN = join(
  dirname(new URL(import.meta.url).pathname),
  "core-entry-exports.json",
);

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
  it("runtime exports equal the committed golden surface", () => {
    const golden: string[] = JSON.parse(readFileSync(GOLDEN, "utf8"));
    expect(golden.length).toBeGreaterThan(20); // the snapshot itself must be live

    const actual = new Set(Object.keys(coreEntry));
    const violations = pinViolations(new Set(golden), actual);
    expect(violations, violations.join("; ")).toEqual([]);
  });

  it("negative self-test: an unplanned export fails the pin comparator", () => {
    // In-suite this can only validate the comparator — the real guarantee is
    // golden-vs-runtime above (a source commit cannot tamper this copy). See
    // the file header for why the previous self-generated pin was hollow.
    const golden: string[] = JSON.parse(readFileSync(GOLDEN, "utf8"));
    const tampered = new Set([...golden, "createStatelessAgent"]);
    const violations = pinViolations(new Set(golden), tampered);
    expect(violations).toContain("unplanned export: createStatelessAgent");
    expect(violations.length).toBeGreaterThan(0);
  });

  it("fail-closed registration denial names seepient", () => {
    expect(() => resolveTools(["read_file"], new ToolRegistry())).toThrow(/seepient/);
  });
});

describe("full-entry parity (027 T015 wrapper pin)", () => {
  it("the full entry re-exports the engine's createSeepient by identity — no re-plumbing wrapper", async () => {
    const full = await import("../transport/sdk/index.js");
    const core = await import("../transport/sdk/core.js");
    expect(full.createSeepient).toBe(core.createSeepient);
    expect(full.askSeepient).toBe(core.askSeepient);
    expect(full.createChat).toBe(core.createChat);
    // The full entry additionally carries its own surface.
    expect(typeof full.createProviderManagerApi).toBe("function");
    expect(full.gateway).toBeDefined();
  });
});
