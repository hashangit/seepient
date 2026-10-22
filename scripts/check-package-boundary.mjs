#!/usr/bin/env node
/**
 * Package-boundary tracer (spec 027, contracts/package-boundary.md).
 *
 * Walks the COMPILED core output (packages/core/dist) from the core entry
 * over static AND dynamic edges, with comments stripped before specifier
 * extraction (a doc-comment import must not register — the hazard verified
 * in transport/sdk/settings.ts:5).
 *
 * Rules:
 *   B-1  no module in core's closure references a full-package module — a
 *        relative specifier must resolve INSIDE packages/core/dist, except
 *        for the explicit GUARDED_DYNAMIC_OK allowlist (absence-tolerant
 *        lazy imports that degrade with typed errors in core-only installs).
 *   B-2  external (bare) imports ⊆ { @earendil-works/pi-ai, typebox, node:* }
 *        — and never a BANNED_DEPS entry.
 *
 * Self-tests (run on every invocation, on a throwaway copy of the emit):
 *   (1) a planted banned import flips the tracer RED,
 *   (2) a planted dynamic edge into a full module flips it RED,
 *   (3) a planted doc-comment import does NOT register.
 *
 * Exit 0 = boundary holds; exit 1 = violations (CI error).
 */
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, cpSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { isBuiltin } from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORE_DIST = join(ROOT, "packages/core/dist");
const ENTRY = "transport/sdk/core.js";

/** Mirrors contracts/package-boundary.md §2 (authoritative table). */
const BANNED_DEPS = new Set([
  // browser automation
  "playwright", "playwright-core",
  // HTML/DOM parsing
  "jsdom", "@mozilla/readability",
  // terminal UI
  "ink", "ink-select-input", "ink-spinner", "react", "inquirer", "figlet", "ora",
  "chalk", "terminal-link", "get-east-asian-width", "es-toolkit", "@inquirer",
  // MCP gateway
  "@modelcontextprotocol/sdk", "rxjs",
  // OS sandbox
  "@anthropic-ai/sandbox-runtime", "web-streams-polyfill",
  // email transport
  "nodemailer",
  // exact tokenizer
  "gpt-tokenizer",
  // CLI plumbing
  "commander", "diff", "dotenv", "js-yaml", "ws",
  // duplicate provider majors (top-level)
  "openai", "@google/genai", "@anthropic-ai/sdk",
]);

/**
 * Absence-tolerant dynamic imports (spec 027 FR-004 / contracts §4): the
 * specifier stays in core source, the module does NOT ship in the core
 * artifact, and the import site degrades with a typed error when absent.
 * Adding an entry requires naming the engine-spine reason in the PR.
 */
const GUARDED_DYNAMIC_OK = new Set(); // absence-tolerant lazy imports (none today — the tokenizer vendor arrives via the registered loader)

const ALLOWED_EXTERNALS = [/^node:/, /^@earendil-works\/pi-ai(\/|$)/, /^typebox(\/|$)/];

function stripComments(source) {
  // Order matters: comments before strings would mangle string contents that
  // contain comment markers; we do a single pass honoring both contexts.
  let out = "";
  let i = 0;
  let mode = "code"; // code | line | block | squote | dquote | template
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (mode === "code") {
      if (c === "/" && next === "/") { mode = "line"; i += 2; continue; }
      if (c === "/" && next === "*") { mode = "block"; i += 2; continue; }
      if (c === "'") { mode = "squote"; out += c; i += 1; continue; }
      if (c === '"') { mode = "dquote"; out += c; i += 1; continue; }
      if (c === "`") { mode = "template"; out += c; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (mode === "line") { if (c === "\n") { mode = "code"; out += c; } i += 1; continue; }
    if (mode === "block") { if (c === "*" && next === "/") { mode = "code"; i += 2; } else { i += 1; } continue; }
    if (mode === "squote") { out += c; if (c === "\\") { out += next ?? ""; i += 2; continue; } if (c === "'") mode = "code"; i += 1; continue; }
    if (mode === "dquote") { out += c; if (c === "\\") { out += next ?? ""; i += 2; continue; } if (c === '"') mode = "code"; i += 1; continue; }
    if (mode === "template") { out += c; if (c === "\\") { out += next ?? ""; i += 2; continue; } if (c === "`") mode = "code"; i += 1; continue; }
  }
  return out;
}

function listJsFiles(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) listJsFiles(p, acc);
    else if (e.name.endsWith(".js")) acc.push(p);
  }
  return acc;
}

function extractSpecifiers(source) {
  const stripped = stripComments(source);
  const specs = [];
  for (const line of stripped.split("\n")) {
    // bare module import: import "x";
    let m = /^\s*import\s*["']([^"']+)["']\s*;?\s*$/.exec(line);
    if (m) { specs.push(m[1]); continue; }
    // import ... from "x";  |  export ... from "x";
    m = /^\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']\s*;?\s*$/.exec(line);
    if (m) { specs.push(m[1]); continue; }
    // dynamic: import("x") — anywhere on the line
    for (const d of line.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)) specs.push(d[1]);
  }
  return specs;
}

function traceCore(distDir, entry) {
  const violations = [];
  const externals = new Set();
  const builtins = new Set();
  const visited = new Set();
  const queue = [entry];

  while (queue.length > 0) {
    const relFile = queue.pop();
    const absFile = join(distDir, relFile);
    if (visited.has(relFile) || !existsSync(absFile)) continue;
    visited.add(relFile);

    const source = readFileSync(absFile, "utf8");
    for (const spec of extractSpecifiers(source)) {
      if (spec.startsWith(".")) {
        const targetAbs = resolve(dirname(absFile), spec);
        const relTarget = relative(distDir, targetAbs);
        if (!relTarget.startsWith("..") && existsSync(targetAbs)) {
          queue.push(relTarget);
        } else {
          // Missing target: a guarded dynamic edge into a full-package module?
          const normalized = relTarget.split("\\").join("/");
          const line = source.split("\n").findIndex((l) => l.includes(spec)) + 1;
          if (GUARDED_DYNAMIC_OK.has(normalized)) {
            if (existsSync(join(distDir, normalized))) {
              violations.push(
                `GUARDLIST-MISUSE: ${relFile}:${line} allowlists ${normalized} but it EXISTS in the core emit — remove the entry`,
              );
            }
          } else {
            violations.push(
              `B-1: ${relFile}:${line} references ${spec} — outside the core emit (full-package module or missing file)`,
            );
          }
        }
      } else if (spec.startsWith("node:") || isBuiltin(spec)) {
        builtins.add(spec.startsWith("node:") ? spec : "node:" + spec);
      } else {
        externals.add(spec);
        const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
        if (BANNED_DEPS.has(pkg)) {
          const line = source.split("\n").findIndex((l) => l.includes(spec)) + 1;
          violations.push(`B-2: ${relFile}:${line} imports banned package "${pkg}"`);
        } else if (!ALLOWED_EXTERNALS.some((re) => re.test(spec))) {
          const line = source.split("\n").findIndex((l) => l.includes(spec)) + 1;
          violations.push(`B-2: ${relFile}:${line} imports undeclared external "${spec}" (allowed: pi-ai, typebox, node:*)`);
        }
      }
    }
  }
  return { violations, externals, builtins, moduleCount: visited.size };
}

function runCheck(distDir, entry) {
  if (!existsSync(join(distDir, entry))) {
    return { violations: [`entry not found: ${entry} (run \`pnpm run build:core\`)`], externals: new Set(), builtins: new Set(), moduleCount: 0 };
  }
  return traceCore(distDir, entry);
}

function scanOrphans(distDir, closure) {
  // Review P2-1: the tarball ships files:["dist"] — an emitted-but-unreachable
  // file still installs. Flag orphans whose imports would violate B-2.
  const violations = [];
  const all = listJsFiles(distDir);
  let orphanCount = 0;
  for (const abs of all) {
    const rel = relative(distDir, abs).split("\\").join("/");
    if (closure.has(rel)) continue;
    orphanCount += 1;
    const source = stripComments(readFileSync(abs, "utf8"));
    for (const spec of extractSpecifiers(source)) {
      // Orphans stay load-bearing for the full package's deep imports — only
      // banned/undeclared NON-builtin externals in them are violations.
      if (spec.startsWith(".") || spec.startsWith("node:") || isBuiltin(spec)) continue;
      const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      if (BANNED_DEPS.has(pkg)) {
        violations.push(`ORPHAN-B-2: ${rel} (unreachable from the entry) imports banned package "${pkg}"`);
      } else if (!ALLOWED_EXTERNALS.some((re) => re.test(spec))) {
        violations.push(`ORPHAN-B-2: ${rel} (unreachable from the entry) imports undeclared external "${spec}"`);
      }
    }
  }
  return { violations, orphanCount };
}

// ── Spec 029 (M02 US4): source-level rule families over the imported tree ────
//
// The B-1/B-2 machinery above walks the COMPILED core emit. The two families
// below scan IMPORTED SOURCE (the @seepients/* tree is built by turbo with its
// own toolchains — there is no single compiled emit to walk). Same discipline:
// comments stripped before extraction (doc-comment imports never register),
// static + dynamic + re-export edges covered, and every family ships a
// planted-probe self-test that flips it RED (FR-024/025/026).

import { readdirSync as rdSync } from "node:fs";

const APP_ROOT = join(ROOT, "apps");
const PKG_ROOT = join(ROOT, "packages");
const INFRA_SANDBOX = join(ROOT, "infra/sandboxes/supervisor");
const INFRA_UPDATER = join(ROOT, "infra/updater");
const ENGINE_SRC = join(ROOT, "src");

/** Layout-decision §2 responsibility classes → package dir name. */
const PACKAGE_CLASSES = {
  // Contract
  contracts: "Contract",
  "adapter-kit": "Contract",
  // Vendor
  adapters: "Vendor",
  db: "Vendor",
  // Capability
  auth: "Capability",
  logging: "Capability",
  memory: "Capability",
  // Domain-app
  "app-core": "DomainApp",
  // UI (shared component packages — the apps sit in APP_CLASSES)
  "chat-ui": "UI",
  "ui-tokens": "UI",
  "ui-web": "UI",
  // TestInfra
  testkit: "TestInfra",
};
const APP_CLASSES = {
  api: "CompositionRoot",
  worker: "CompositionRoot",
  web: "UI",
  desktop: "UI",
  mobile: "UI",
  www: "UI",
};
const INFRA_CLASSES = { "sandbox-supervisor": "CompositionRoot", updater: "Vendor" };

/**
 * Sanctioned class-level import edges — the §2.2 mirror, derived from the
 * ACTUAL dependency graph at the pinned import (see provenance-manifest.md).
 * A new class-level edge requires a migration-exceptions.md entry.
 */
const CLASS_EDGES = {
  Contract: ["Contract"],
  Vendor: ["Contract", "Capability", "Vendor", "DomainApp"],
  Capability: ["Contract", "Capability", "Vendor", "DomainApp"],
  UI: ["Contract", "DomainApp", "UI"],
  DomainApp: ["Contract"],
  CompositionRoot: ["Contract", "Capability", "Vendor", "DomainApp", "UI"],
  TestInfra: ["Contract", "Capability", "Vendor", "DomainApp", "UI", "CompositionRoot"],
};

/** Renderer process roots (client runtime only; test files excluded). */
const RENDERER_ROOTS = [
  join(APP_ROOT, "web/src"),
  join(APP_ROOT, "mobile/app"),
  join(APP_ROOT, "mobile/lib"),
  join(APP_ROOT, "mobile/components"),
  join(APP_ROOT, "mobile/modules"),
  join(PKG_ROOT, "chat-ui/src"),
  join(PKG_ROOT, "ui-web/src"),
];
// apps/www is deliberately NOT a renderer root: it is an Astro static site
// whose build-time code legitimately runs in Node; Astro's own bundler rejects
// node builtins in the client bundle.
const RENDERER_BANNED_BARE = [
  /^@prisma\//, // Prisma client (server-only)
  /^keytar$/, // OS credential store
  /^@seepients\/db$/, // DB barrel (Postgres/Graphile)
  /^@seepients\/adapters$/, // vendor clients barrel
  /^node:(fs|fs\/promises|child_process|net|http|https|dgram)$/, // raw host fs/net
];
const TEST_FILE = /(^|\/)([^/]+)\.(test|spec)\.[tj]sx?$|__tests__\//;

function listSourceFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const e of rdSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "__tests__" || e.name === "generated") continue;
      listSourceFiles(p, acc);
    } else if (/\.[tj]sx?$/.test(e.name) && !TEST_FILE.test(p.split("node_modules").pop())) {
      acc.push(p);
    }
  }
  return acc;
}

/** FR-024/025/026: renderer entrypoints cannot reach Prisma, credential
 *  stores, raw fs/net, or the vendor/DB barrels — across static, re-export
 *  and dynamic import forms. */
function scanRendererIsolation(roots = RENDERER_ROOTS) {
  const violations = [];
  for (const root of roots) {
    for (const file of listSourceFiles(root)) {
      const relFile = relative(ROOT, file).split("\\").join("/");
      // Pure `import type`/`export type` lines are erased at compile time and
      // carry no runtime edge — the renderer hazard is runtime code. Mixed
      // inline `type` modifiers still extract (value imports on the same line).
      const source = stripComments(readFileSync(file, "utf8"))
        .split("\n")
        .filter((l) => !/^\s*(?:import|export)\s+type\s/.test(l))
        .join("\n");
      for (const spec of extractSpecifiers(source)) {
        const line = source.split("\n").findIndex((l) => l.includes(spec)) + 1;
        if (RENDERER_BANNED_BARE.some((re) => re.test(spec))) {
          violations.push(`R-1 (renderer-isolation): ${relFile}:${line} imports "${spec}" — forbidden in renderer runtime code`);
        }
      }
    }
  }
  return violations;
}

/**
 * Types-only import discipline for one specifier (ARCHITECTURE.md §118): every
 * import statement of `spec` must be `import type …` / `export type …`, or carry
 * only inline `type` specifiers. Statement-level (multi-line imports included);
 * side-effect imports and dynamic `import()` count as runtime-value edges.
 * Returns the 1-based lines that violate; empty means clean (or unused).
 */
function valueTypeImportLines(source, spec) {
  const stripped = stripComments(source);
  const escaped = spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lines = [];
  const statementRe = /(?:^|\n)[ \t]*(import|export)\s+(type\s+)?([\s\S]*?)from\s*["']([^"']+)["']/g;
  for (const m of stripped.matchAll(statementRe)) {
    if (m[4] !== spec) continue;
    if (m[2]) continue; // whole-statement `import type` / `export type`
    const names = m[3]
      .replace(/[{}]/g, " ")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (names.length === 0 || !names.every((n) => /^type\s/.test(n))) {
      lines.push(stripped.slice(0, m.index).split("\n").length);
    }
  }
  for (const re of [
    new RegExp(`import\\s*\\(\\s*["']${escaped}["']`),
    new RegExp(`(?:^|\\n)[ \\t]*import\\s*["']${escaped}["']`),
  ]) {
    const at = stripped.search(re);
    if (at >= 0) lines.push(stripped.slice(0, at).split("\n").length + 1);
  }
  return lines;
}

/** FR-024/025 (D9): @seepients/* imports mirror the §2.2 class table; the ONE
 *  sanctioned engine edge is src/transport/app/** → @seepients/adapter-kit.
 *  `base` lets the self-test point the scanner at a throwaway fixture tree
 *  with the same relative layout. */
function scanAppLayering(base = ROOT) {
  const violations = [];
  const classify = (abs) => {
    const rel = relative(base, abs).split("\\").join("/");
    if (rel.startsWith("apps/")) return { pkg: rel.split("/")[1], cls: APP_CLASSES[rel.split("/")[1]] };
    if (rel.startsWith("packages/")) {
      const name = rel.split("/")[1];
      return { pkg: name, cls: PACKAGE_CLASSES[name] ?? (name === "core" ? "EngineCore" : undefined) };
    }
    if (rel.startsWith("infra/sandboxes/supervisor")) return { pkg: "sandbox-supervisor", cls: "CompositionRoot" };
    if (rel.startsWith("infra/updater")) return { pkg: "updater", cls: "Vendor" };
    return { pkg: undefined, cls: undefined };
  };
  const srcRoots = [join(base, "apps"), join(base, "packages"), join(base, "infra/sandboxes/supervisor"), join(base, "infra/updater")];
  for (const root of srcRoots) {
    for (const file of listSourceFiles(root)) {
      // Build-config files (vite/astro/metro/expo/playwright/vitest configs)
      // are Node tooling that runs at build time, not app runtime code — the
      // §2.2 layering table governs the shipped graph, not the toolchain.
      if (/[.-]config\.[cm]?[jt]sx?$/.test(file.split("/").pop() ?? "")) continue;
      const from = classify(file);
      if (!from.cls) continue;
      const relFile = relative(ROOT, file).split("\\").join("/");
      const source = stripComments(readFileSync(file, "utf8"));
      for (const spec of extractSpecifiers(source)) {
        let targetPkg;
        if (spec.startsWith("@seepients/")) targetPkg = spec.split("/")[1];
        else if (spec.startsWith(".")) {
          const t = classify(resolve(dirname(file), spec));
          if (t.pkg && t.pkg !== from.pkg) targetPkg = t.pkg;
        }
        if (!targetPkg) continue;
        const targetCls = PACKAGE_CLASSES[targetPkg] ?? APP_CLASSES[targetPkg] ?? INFRA_CLASSES[targetPkg];
        if (!targetCls) continue;
        if (!(CLASS_EDGES[from.cls] ?? []).includes(targetCls)) {
          const line = source.split("\n").findIndex((l) => l.includes(spec)) + 1;
          violations.push(
            `L-1 (app-layering): ${relFile}:${line} — ${from.cls} (${from.pkg}) imports ${targetCls} (${targetPkg}) outside the §2.2 table; add a migration-exceptions.md entry or restructure`,
          );
        }
      }
    }
  }
  // The single sanctioned engine → app edge (D9): src/transport/app/** may
  // import @seepients/adapter-kit and NOTHING else @seepients/*; any other
  // engine src/** file importing any @seepients/* is a violation. The edge
  // is TYPES-ONLY (ARCHITECTURE.md §118): runtime values are injected at the
  // composition roots (apps/api, apps/worker), never imported engine-side.
  for (const file of listSourceFiles(join(base, "src"))) {
    const relFile = relative(base, file).split("\\").join("/");
    const source = stripComments(readFileSync(file, "utf8"));
    if (relFile.startsWith("src/transport/app/")) {
      for (const line of valueTypeImportLines(source, "@seepients/adapter-kit")) {
        violations.push(
          `L-2 (app-layering): ${relFile}:${line} — the sanctioned "@seepients/adapter-kit" edge is TYPES-ONLY (ARCHITECTURE.md §118); a runtime-value import crosses it. Inject the value via construction options from the composition root instead`,
        );
      }
    }
    for (const spec of extractSpecifiers(source)) {
      if (!spec.startsWith("@seepients/")) continue;
      if (relFile.startsWith("src/transport/app/") && spec === "@seepients/adapter-kit") continue;
      const line = source.split("\n").findIndex((l) => l.includes(spec)) + 1;
      violations.push(
        `L-2 (app-layering): ${relFile}:${line} — engine import of "${spec}" outside the sanctioned src/transport/app → @seepients/adapter-kit edge`,
      );
    }
  }
  return violations;
}

const { violations, externals, builtins, moduleCount } = runCheck(CORE_DIST, ENTRY);
console.log(`[boundary] core closure: ${moduleCount} modules from ${ENTRY}`);
console.log(`[boundary] externals: ${[...externals].sort().join(", ") || "(none)"}`);
console.log(`[boundary] node builtins: ${[...builtins].sort().join(", ") || "(none)"}`);

// Orphan scan needs the closure set — re-run with collection.
const closureSet = new Set((function collect(distDir, entry) {
  const visited = new Set();
  const queue = [entry];
  while (queue.length) {
    const rel = queue.pop();
    if (visited.has(rel)) continue;
    visited.add(rel);
    const abs = join(distDir, rel);
    if (!existsSync(abs)) continue;
    for (const spec of extractSpecifiers(stripComments(readFileSync(abs, "utf8")))) {
      if (!spec.startsWith(".")) continue;
      const t = relative(distDir, resolve(dirname(abs), spec));
      if (!t.startsWith("..") && existsSync(join(distDir, t))) queue.push(t);
    }
  }
  return visited;
})(CORE_DIST, ENTRY));
const { violations: orphanViolations, orphanCount } = scanOrphans(CORE_DIST, closureSet);
console.log(`[boundary] emitted files: ${closureSet.size + orphanCount} (${orphanCount} orphans from the entry)`);

// Spec 029 families over the imported source tree.
const rendererViolations = scanRendererIsolation();
const layeringViolations = scanAppLayering();
console.log(`[boundary] renderer-isolation: ${rendererViolations.length} violation(s); app-layering: ${layeringViolations.length} violation(s)`);

// ── negative self-tests (on a throwaway copy) ────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), "boundary-selftest-"));
let selfTestFailures = [];
try {
  cpSync(CORE_DIST, join(tmp, "dist"), { recursive: true });
  const entryAbs = join(tmp, "dist", ENTRY);
  const original = readFileSync(entryAbs, "utf8");

  // (1) planted banned import → RED
  writeFileSync(entryAbs, original + `\nimport "chalk";\n`);
  const r1 = runCheck(join(tmp, "dist"), ENTRY);
  if (!r1.violations.some((v) => v.includes("chalk"))) selfTestFailures.push("self-test 1: planted banned import did NOT flip RED");

  // (2) planted dynamic edge into a full module → RED
  writeFileSync(entryAbs, original + `\nexport async function __planted() { return import("../vendors/jsdom.js"); }\n`);
  const r2 = runCheck(join(tmp, "dist"), ENTRY);
  if (!r2.violations.some((v) => v.includes("vendors/jsdom.js"))) selfTestFailures.push("self-test 2: planted dynamic full-module edge did NOT flip RED");

  // (3) planted doc-comment import → must NOT register
  writeFileSync(entryAbs, original + `\n// import x from "chalk";\n/* import y from "playwright"; */\n`);
  const r3 = runCheck(join(tmp, "dist"), ENTRY);
  if (r3.violations.length > 0) selfTestFailures.push(`self-test 3: doc-comment import registered: ${r3.violations.join("; ")}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ── family self-tests: every 029 family must flip RED on a planted violation
//    (FR-026) and stay green on its sanctioned shape. ────────────────────────
const fam = mkdtempSync(join(tmpdir(), "boundary-families-"));
try {
  // renderer-isolation: planted node:fs import → RED
  const webDir = join(fam, "apps/web/src");
  mkdirSync(webDir, { recursive: true });
  writeFileSync(join(webDir, "probe.ts"), `import { readFileSync } from "node:fs";\nexport const p = readFileSync;\n`);
  if (scanRendererIsolation([webDir]).length === 0) selfTestFailures.push("family self-test R: planted renderer node:fs import did NOT flip RED");

  // renderer-isolation: dynamic @seepients/db barrel → RED
  writeFileSync(join(webDir, "probe2.ts"), `export async function load() { return import("@seepients/db"); }\n`);
  if (!scanRendererIsolation([webDir]).some((v) => v.includes("@seepients/db"))) selfTestFailures.push("family self-test R: planted dynamic DB-barrel import did NOT flip RED");

  // renderer-isolation: doc-comment import stays inert
  writeFileSync(join(webDir, "probe3.ts"), `// import { readFileSync } from "node:fs";\n/* import prisma from "@prisma/client"; */\nexport const q = 1;\n`);
  const docProbe = scanRendererIsolation([webDir]).filter((v) => v.includes("probe3"));
  if (docProbe.length > 0) selfTestFailures.push(`family self-test R: doc-comment import registered: ${docProbe.join("; ")}`);

  // app-layering: planted Domain-app → UI import → RED
  const coreDir = join(fam, "packages/app-core/src");
  mkdirSync(coreDir, { recursive: true });
  writeFileSync(join(coreDir, "probe.ts"), `import { Button } from "@seepients/ui-web";\nexport const b = Button;\n`);
  if (!scanAppLayering(fam).some((v) => v.includes("L-1") && v.includes("app-core"))) selfTestFailures.push("family self-test L: planted Domain-app→UI import did NOT flip RED");

  // app-layering: the sanctioned engine edge (src/transport/app → adapter-kit) stays GREEN
  const adapterDir = join(fam, "src/transport/app");
  mkdirSync(adapterDir, { recursive: true });
  writeFileSync(join(adapterDir, "probe.ts"), `import type { AgentRuntime } from "@seepients/adapter-kit";\nexport type R = AgentRuntime;\n`);
  if (scanAppLayering(fam).some((v) => v.includes("src/transport/app/probe.ts"))) selfTestFailures.push("family self-test L: the sanctioned adapter-kit edge flipped RED");

  // app-layering: engine import OUTSIDE the sanctioned edge → RED
  const domainDir = join(fam, "src/domain");
  mkdirSync(domainDir, { recursive: true });
  writeFileSync(join(domainDir, "probe.ts"), `import type { AgentRuntime } from "@seepients/adapter-kit";\nexport type R = AgentRuntime;\n`);
  if (!scanAppLayering(fam).some((v) => v.includes("L-2") && v.includes("src/domain/probe.ts"))) selfTestFailures.push("family self-test L: planted engine import outside src/transport/app did NOT flip RED");

  // app-layering TYPES-ONLY edge: planted single-line runtime-value import → RED
  writeFileSync(join(adapterDir, "probe-value.ts"), `import { describeToolActivity } from "@seepients/adapter-kit";\nexport const d = describeToolActivity;\n`);
  if (!scanAppLayering(fam).some((v) => v.includes("TYPES-ONLY") && v.includes("src/transport/app/probe-value.ts"))) selfTestFailures.push("family self-test L: planted adapter-kit VALUE import did NOT flip RED");

  // app-layering TYPES-ONLY edge: planted multi-line runtime-value import → RED
  // (extractSpecifiers is line-based; the statement-level scanner must catch it)
  writeFileSync(
    join(adapterDir, "probe-value-multi.ts"),
    `import {\n  describeToolActivity,\n  DEFAULT_CONTEXT_STRATEGY,\n} from "@seepients/adapter-kit";\nexport const d = describeToolActivity;\n`,
  );
  if (!scanAppLayering(fam).some((v) => v.includes("TYPES-ONLY") && v.includes("src/transport/app/probe-value-multi.ts"))) selfTestFailures.push("family self-test L: planted multi-line adapter-kit VALUE import did NOT flip RED");

  // app-layering TYPES-ONLY edge: planted dynamic import() of adapter-kit → RED
  writeFileSync(join(adapterDir, "probe-dynamic.ts"), `export async function load() { return import("@seepients/adapter-kit"); }\n`);
  if (!scanAppLayering(fam).some((v) => v.includes("TYPES-ONLY") && v.includes("src/transport/app/probe-dynamic.ts"))) selfTestFailures.push("family self-test L: planted dynamic adapter-kit import did NOT flip RED");

  // app-layering TYPES-ONLY edge: mixed inline specifiers (one value among types) → RED
  writeFileSync(join(adapterDir, "probe-mixed.ts"), `import { type AgentRuntime, describeToolActivity } from "@seepients/adapter-kit";\nexport const d = describeToolActivity;\n`);
  if (!scanAppLayering(fam).some((v) => v.includes("TYPES-ONLY") && v.includes("src/transport/app/probe-mixed.ts"))) selfTestFailures.push("family self-test L: planted mixed adapter-kit import did NOT flip RED");

  // app-layering TYPES-ONLY edge: multi-line TYPE-ONLY import stays GREEN
  writeFileSync(
    join(adapterDir, "probe-type-multi.ts"),
    `import type {\n  AgentRuntime,\n  AgentRunRequest,\n} from "@seepients/adapter-kit";\nexport type R = AgentRuntime;\n`,
  );
  if (scanAppLayering(fam).some((v) => v.includes("src/transport/app/probe-type-multi.ts"))) selfTestFailures.push("family self-test L: the multi-line TYPE-ONLY adapter-kit edge flipped RED");

  // app-layering TYPES-ONLY edge: all-inline `type` specifiers stay GREEN
  writeFileSync(join(adapterDir, "probe-type-inline.ts"), `import { type AgentRuntime, type AgentRunRequest } from "@seepients/adapter-kit";\nexport type R = AgentRuntime;\n`);
  if (scanAppLayering(fam).some((v) => v.includes("src/transport/app/probe-type-inline.ts"))) selfTestFailures.push("family self-test L: the all-inline-type adapter-kit edge flipped RED");
} finally {
  rmSync(fam, { recursive: true, force: true });
}

console.log("[boundary] self-tests: banned-import RED ✓, dynamic full-edge RED ✓, doc-comment inert ✓, family probes RED ✓ (incl. types-only adapter-kit edge)");

for (const v of orphanViolations) violations.push(v);
for (const v of [...rendererViolations, ...layeringViolations]) violations.push(v);

if (selfTestFailures.length > 0 || violations.length > 0) {
  if (selfTestFailures.length > 0) {
    console.error("[boundary] SELF-TEST FAILURES:");
    for (const f of selfTestFailures) console.error("  -", f);
  }
  if (violations.length > 0) {
    console.error(`[boundary] VIOLATIONS (${violations.length}):`);
    for (const v of violations) console.error("  -", v);
    process.exit(1);
  }
  process.exit(1);
}
console.log("[boundary] OK — the core closure respects the package boundary");
