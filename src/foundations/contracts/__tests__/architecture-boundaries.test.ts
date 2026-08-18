/**
 * P0 architecture-boundary enforcement (spec 008, T008 / NFR-001).
 *
 * Verifies the ARCHITECTURE.md layer rules structurally:
 *   - Foundations imports from no Seepient layer.
 *   - No upward imports (Capabilities ↩ Domain ↩ Transport ↩ UI).
 *   - Sibling capabilities do not import each other
 *     (`capabilities/tools` ↔ `capabilities/execution` is forbidden).
 *   - No service-SDK import outside `src/vendors/`.
 *
 * This is the portable CI gate; `eslint-plugin-import` is intentionally not
 * added as a dependency (no bundler, plain tsc). The check scans source files
 * directly.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..");

function listFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      listFiles(full, acc);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      acc.push(full);
    }
  }
  return acc;
}

function layerOf(absPath: string): string | null {
  const rel = relative(join(ROOT), absPath).replace(/\\/g, "/");
  if (rel.startsWith("foundations/")) return "foundations";
  if (rel.startsWith("capabilities/")) return "capabilities";
  if (rel.startsWith("domain/")) return "domain";
  if (rel.startsWith("transport/")) return "transport";
  if (rel.startsWith("ui/")) return "ui";
  if (rel.startsWith("vendors/")) return "vendors";
  return null;
}

/** Parse `import ... from "x"` / `import "x"` specifiers from a source file (static only). */
function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  const re = /import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.push(m[1]);
  return out;
}

/** Parse module specifiers across ALL reference forms — static `import … from`,
 *  dynamic `import()`, and `require()`. Used by the SDK-quarantine check so a
 *  vendor SDK can't evade the boundary via `await import("openai")`. */
function moduleSpecifiers(source: string): string[] {
  const out: string[] = [];
  const patterns = [
    /import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g, // static import
    /export\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g, // re-export
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,            // dynamic import()
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,           // require()
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) out.push(m[1]);
  }
  return out;
}

/** The package name of a bare specifier: "@scope/pkg/sub" → "@scope/pkg";
 *  "pkg/sub" → "pkg"; relative/absolute specifiers are returned as-is (relative). */
function packageName(spec: string): string {
  if (spec.startsWith(".") || spec.startsWith("/")) return spec;
  if (spec.startsWith("@")) {
    const segs = spec.split("/");
    return segs.slice(0, 2).join("/");
  }
  return spec.split("/")[0];
}

/** Relative Seepient-internal imports only (skip `node:` / external packages). */
function internalSpecifiers(specs: string[]): string[] {
  return specs.filter((s) => s.startsWith(".") || s.startsWith(".."));
}

const LAYER_RANK: Record<string, number> = {
  foundations: 0,
  vendors: 1,
  capabilities: 2,
  domain: 3,
  transport: 4,
  ui: 5,
};

describe("architecture boundaries (spec 008, T008)", () => {
  const files = listFiles(ROOT);

  it("Foundations imports from no Seepient layer", () => {
    const violations: string[] = [];
    for (const f of files) {
      if (layerOf(f) !== "foundations") continue;
      const src = readFileSync(f, "utf8");
      for (const spec of internalSpecifiers(importSpecifiers(src))) {
        if (/\/(domain|capabilities|transport|ui|vendors)\//.test(spec)) {
          violations.push(`${relative(ROOT, f)} -> ${spec}`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("no upward imports (inner layer ↩ outer layer)", () => {
    const violations: string[] = [];
    for (const f of files) {
      const layer = layerOf(f);
      if (!layer || layer === "foundations") continue;
      const src = readFileSync(f, "utf8");
      for (const spec of internalSpecifiers(importSpecifiers(src))) {
        const targetLayer = /\/vendors\//.test(spec)
          ? "vendors"
          : /\/capabilities\//.test(spec)
            ? "capabilities"
            : /\/domain\//.test(spec)
              ? "domain"
              : /\/transport\//.test(spec)
                ? "transport"
                : /\/ui\//.test(spec)
                  ? "ui"
                  : null;
        if (!targetLayer) continue;
        // allowed: importing foundations (rank 0) from anywhere, and
        // left-to-right (inner imports outer, where outer is higher rank).
        if (LAYER_RANK[targetLayer] > LAYER_RANK[layer]) {
          violations.push(
            `${relative(ROOT, f)} (${layer}) -> ${spec} (${targetLayer})`,
          );
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("sibling capabilities do not import each other (tools ↔ execution)", () => {
    const violations: string[] = [];
    for (const f of files) {
      const rel = relative(ROOT, f).replace(/\\/g, "/");
      const sibling =
        rel.startsWith("capabilities/tools/") ? "execution" :
        rel.startsWith("capabilities/execution/") ? "tools" : null;
      if (!sibling) continue;
      const src = readFileSync(f, "utf8");
      for (const spec of internalSpecifiers(importSpecifiers(src))) {
        if (spec.includes(`/capabilities/${sibling}/`)) {
          violations.push(`${rel} -> ${spec}`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("Domain exports no analyze* symbols (T008a / D46)", () => {
    // Domain must contain no tool-specific analyzers. Analyzer implementations
    // live in src/capabilities/tools/. The Domain shim (comm-analyzers.ts,
    // default-analyzers.ts) may re-export but must not define analyze* itself.
    const violations: string[] = [];
    for (const f of files) {
      const rel = relative(ROOT, f).replace(/\\/g, "/");
      if (!rel.startsWith("domain/")) continue;
      const src = readFileSync(f, "utf8");
      // Detect export declarations that define a function named analyze*
      const exportFnRe = /export\s+(?:async\s+)?function\s+(analyze[A-Za-z]+)/g;
      let m: RegExpExecArray | null;
      while ((m = exportFnRe.exec(src)) !== null) {
        violations.push(`${rel} exports analyzer function: ${m[1]}`);
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("no service-SDK import outside src/vendors/ (spec 010, S0.3)", () => {
    // Quarantined SDKs may be imported ONLY from under src/vendors/. This is the
    // documented-but-previously-unenforced check; spec 010 (S0.3 / P1.6) makes it
    // a gate now that @earendil-works/pi-ai + @google/genai have landed.
    const QUARANTINED = [
      "@earendil-works/pi-ai",
      "@google/genai",
      "openai",
      "@anthropic-ai/sdk",
      "@modelcontextprotocol/sdk",
    ];
    const violations: string[] = [];
    for (const f of files) {
      const rel = relative(ROOT, f).replace(/\\/g, "/");
      if (rel.startsWith("vendors/")) continue; // the quarantine itself
      if (rel.startsWith("test") || rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) continue;
      const src = readFileSync(f, "utf8");
      for (const spec of moduleSpecifiers(src)) {
        const pkg = packageName(spec);
        if (QUARANTINED.includes(pkg)) {
          violations.push(`${rel} -> ${spec}`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("enforces specific vendor sub-directory quarantine (pi-ai and google)", () => {
    const violations: string[] = [];
    for (const f of files) {
      const rel = relative(ROOT, f).replace(/\\/g, "/");
      if (rel.startsWith("test") || rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) continue;
      const src = readFileSync(f, "utf8");
      for (const spec of moduleSpecifiers(src)) {
        const pkg = packageName(spec);
        if (pkg === "@earendil-works/pi-ai" && !rel.startsWith("vendors/pi-ai/")) {
          violations.push(`${rel} imports @earendil-works/pi-ai outside vendors/pi-ai/`);
        }
        if (pkg === "@google/genai" && !rel.startsWith("vendors/google/")) {
          violations.push(`${rel} imports @google/genai outside vendors/google/`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("Foundations imports standalone typebox directly and never via vendor re-exports", () => {
    const violations: string[] = [];
    for (const f of files) {
      const rel = relative(ROOT, f).replace(/\\/g, "/");
      if (!rel.startsWith("foundations/")) continue;
      const src = readFileSync(f, "utf8");
      for (const spec of moduleSpecifiers(src)) {
        if (spec.includes("pi-ai") || spec.includes("vendors")) {
          violations.push(`${rel} imports from ${spec}`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("Transport and UI never import from src/vendors/ (S-12)", () => {
    const violations: string[] = [];
    for (const f of files) {
      const rel = relative(ROOT, f).replace(/\\/g, "/");
      if (!rel.startsWith("transport/") && !rel.startsWith("ui/")) continue;
      if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) continue;
      const src = readFileSync(f, "utf8");
      for (const spec of moduleSpecifiers(src)) {
        if (spec.includes("/vendors/") || spec.startsWith("vendors/")) {
          violations.push(`${rel} imports directly from vendors: ${spec}`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});
