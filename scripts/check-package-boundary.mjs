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
import { readFileSync, readdirSync, mkdtempSync, rmSync, existsSync, writeFileSync, cpSync } from "node:fs";
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

// ── main ─────────────────────────────────────────────────────────────────────
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

if (selfTestFailures.length > 0) {
  console.error("[boundary] SELF-TEST FAILURES:");
  for (const f of selfTestFailures) console.error("  -", f);
  process.exit(1);
}
console.log("[boundary] self-tests: banned-import RED ✓, dynamic full-edge RED ✓, doc-comment inert ✓");

for (const v of orphanViolations) violations.push(v);

if (violations.length > 0) {
  console.error(`[boundary] VIOLATIONS (${violations.length}):`);
  for (const v of violations) console.error("  -", v);
  process.exit(1);
}
console.log("[boundary] OK — the core closure respects the package boundary");
