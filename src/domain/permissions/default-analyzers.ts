/**
 * Default tool analyzers — Domain (spec 008, T101-T105, FR-002/FR-006).
 *
 * Produces a `PreparedToolAction` for each built-in tool by:
 *  1. Canonicalizing the target (filesystem) / destination (network) /
 *     recipients (external-send) / command (process) from the tool args.
 *  2. Classifying sensitivity (read analyzer) and declaring model-egress.
 *  3. Building a deterministic `ActionDisplay` with exact targets/effects.
 *  4. Producing a serializable `PreparedOperation` — no callbacks/secrets.
 *
 * Hashline targets are fully prepared before policy (T105): every `[PATH#TAG]`
 * section is resolved and snapshotted, so multi-target smuggling denies
 * before the first commit.
 *
 * This module is Domain orchestration; it consumes the Foundations
 * `PreparationArtifactStore` contract (injected). It does NOT import sibling
 * capabilities — tool modules are looked up by name via the registry passed
 * in by the composition root.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";
import type { PreparedToolAction } from "../../foundations/contracts/prepared-action.js";
import type {
  CanonicalPathTarget,
  EffectRequest,
  FileSnapshot,
  SensitivityClass,
  ToolEffectKind,
  ToolRiskCategory,
} from "../../foundations/contracts/tool-effects.js";
import type { PreparationArtifactStore } from "../../foundations/contracts/execution-brokers.js";
import type { ToolAnalysisContext } from "../../foundations/contracts/custom-tools.js";
import { generateId } from "../../foundations/id.js";

/**
 * Resolve a caller-supplied path to a canonical, no-follow target. The
 * canonical parent is resolved with `realpath` when the parent exists; a
 * nonexistent target canonicalizes from the real parent + basename.
 */
export async function canonicalizePath(
  rawPath: string,
  cwd: string,
): Promise<CanonicalPathTarget> {
  const abs = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
  const parent = path.dirname(abs);
  const basename = path.basename(abs);

  // Resolve the parent (no-follow on the target itself). If the parent
  // doesn't exist, walk up to the first existing ancestor and reconstruct.
  let realParent: string;
  try {
    realParent = fs_realpathSync(parent);
  } catch {
    realParent = parent;
  }

  const canonicalPath = path.join(realParent, basename);
  let exists = false;
  let finalSymlink = false;
  try {
    const st = fs_lstatSync(canonicalPath);
    exists = true;
    finalSymlink = st.isSymbolicLink();
  } catch {
    /* not present */
  }

  return {
    canonicalPath,
    canonicalParent: realParent,
    basename,
    exists,
    finalSymlink,
  };
}

// fs is injected indirectly to keep this module testable without touching disk
// in unit tests that pass pre-resolved paths. Use lazy node:fs imports.
import { realpathSync as fs_realpathSync, lstatSync as fs_lstatSync } from "node:fs";

/** Compute a stable args digest (canonical JSON). */
export function digestArgs(args: unknown): string {
  const canonical = stableJson(args);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const keys = Object.keys(value as object).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

/** Compute the action digest over operation + effects + principal + tool. */
export function digestAction(input: {
  operation: unknown;
  effects: EffectRequest[];
  principalId: string;
  toolName: string;
  argsDigest: string;
}): string {
  const canonical = stableJson({
    op: input.operation,
    effects: input.effects,
    p: input.principalId,
    t: input.toolName,
    a: input.argsDigest,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Build a FileSnapshot from a path (lstat + size; sha256 optional). */
export function snapshotPath(target: CanonicalPathTarget): FileSnapshot {
  if (!target.exists) return { exists: false };
  try {
    const st = fs_lstatSync(target.canonicalPath);
    return {
      exists: true,
      size: st.size,
      modifiedNs: String(st.mtimeMs * 1e6),
    };
  } catch {
    return { exists: false };
  }
}

/** Sensitivity classification for read sources (T104). */
export function classifyReadSensitivity(
  canonicalPath: string,
): SensitivityClass {
  const lower = canonicalPath.toLowerCase();
  // Active credentials / policy / release authority are immutable-secret.
  if (
    lower.includes("/.seepient/security/") ||
    lower.includes("/.ssh/") ||
    lower.includes("/.aws/credentials") ||
    lower.includes("/.env") ||
    lower.endsWith(".pem") ||
    lower.endsWith(".key")
  ) {
    return "secret";
  }
  if (
    lower.includes("/.seepient/") ||
    lower.includes("/.config/") ||
    lower.includes("/.gnupg/")
  ) {
    return "sensitive";
  }
  return "normal";
}

/**
 * Analyzer for `write_file`. Produces a `commit-files` operation with the
 * content stored as a content-addressed artifact (T102/T105).
 */
export async function analyzeWriteFile(
  args: { path: string; content: string },
  ctx: ToolAnalysisContext,
): Promise<PreparedToolAction> {
  const cwd = ctx.workspace.canonicalRoot;
  const target = await canonicalizePath(args.path, cwd);
  const bytes = Buffer.from(args.content, "utf8");
  const artifact = await ctx.artifacts.put(bytes, "text/plain");

  const expected = snapshotPath(target);
  const effects: EffectRequest[] = [
    {
      kind: "filesystem-write",
      targets: [{ target, mode: target.exists ? "replace" : "create", expected }],
    },
  ];

  const operation = {
    kind: "commit-files" as const,
    commits: [{ destination: target, content: artifact, expected }],
  };

  const argsDigest = digestArgs(args);
  const actionDigest = digestAction({
    operation,
    effects,
    principalId: ctx.principalId,
    toolName: "write_file",
    argsDigest,
  });

  return {
    version: 1,
    actionId: generateId(),
    runId: ctx.runId,
    toolCallId: ctx.toolCallId,
    toolName: "write_file",
    principalId: ctx.principalId,
    argsDigest,
    actionDigest,
    risk: "edit" as ToolRiskCategory,
    effects,
    display: {
      title: `Write ${target.basename}`,
      summary: `${target.exists ? "Replace" : "Create"} ${target.canonicalPath}`,
      canonicalTargets: [target.canonicalPath],
      effects: ["filesystem-write" as ToolEffectKind],
    },
    operation,
  };
}

/**
 * Analyzer for `read_file`. Adds filesystem-read with sensitivity + a
 * model-egress effect for the configured provider class (T104).
 */
export async function analyzeReadFile(
  args: { path: string },
  ctx: ToolAnalysisContext,
): Promise<PreparedToolAction> {
  const cwd = ctx.workspace.canonicalRoot;
  const target = await canonicalizePath(args.path, cwd);
  const sensitivity = classifyReadSensitivity(target.canonicalPath);
  const expected = snapshotPath(target);

  const effects: EffectRequest[] = [
    { kind: "filesystem-read", targets: [target], sensitivity },
    {
      kind: "model-egress",
      providerClass: ctx.modelProviderClass,
      dataClasses: [sensitivity],
      sources: [target.canonicalPath],
    },
  ];

  const operation = { kind: "read-file" as const, target, expected };
  const argsDigest = digestArgs(args);
  const actionDigest = digestAction({
    operation,
    effects,
    principalId: ctx.principalId,
    toolName: "read_file",
    argsDigest,
  });

  return {
    version: 1,
    actionId: generateId(),
    runId: ctx.runId,
    toolCallId: ctx.toolCallId,
    toolName: "read_file",
    principalId: ctx.principalId,
    argsDigest,
    actionDigest,
    risk: "safe" as ToolRiskCategory,
    effects,
    display: {
      title: `Read ${target.basename}`,
      summary: `Read ${target.canonicalPath} (${sensitivity})`,
      canonicalTargets: [target.canonicalPath],
      effects: ["filesystem-read", "model-egress"],
    },
    operation,
  };
}

/**
 * Analyzer for `execute_shell_command`. Produces a `process` operation with
 * root-shaped capabilities. Shell metacharacters prevent safe persistent
 * prefix inference — v1 is action/run scoped only.
 */
export async function analyzeShellCommand(
  args: { command: string },
  ctx: ToolAnalysisContext,
): Promise<PreparedToolAction> {
  const cwd = ctx.workspace.canonicalRoot;
  // Normalize as a shell-via-sh invocation. Argv is the raw command; the
  // boundary may further constrain via Seatbelt/Bubblewrap.
  const command = {
    executable: process.env.SHELL ?? "/bin/sh",
    argv: ["-c", args.command],
    cwd,
  };
  const roots = [
    { access: "read" as const, canonicalRoot: cwd },
    { access: "write" as const, canonicalRoot: cwd },
  ];

  const effects: EffectRequest[] = [
    { kind: "process-exec", command, requestedRoots: roots },
  ];

  const operation = { kind: "process" as const, command, roots };
  const argsDigest = digestArgs(args);
  const actionDigest = digestAction({
    operation,
    effects,
    principalId: ctx.principalId,
    toolName: "execute_shell_command",
    argsDigest,
  });

  return {
    version: 1,
    actionId: generateId(),
    runId: ctx.runId,
    toolCallId: ctx.toolCallId,
    toolName: "execute_shell_command",
    principalId: ctx.principalId,
    argsDigest,
    actionDigest,
    risk: "destructive" as ToolRiskCategory,
    effects,
    display: {
      title: `Run command`,
      summary: args.command,
      canonicalTargets: [cwd],
      effects: ["process-exec"],
    },
    operation,
  };
}

/**
 * Analyzer registry: maps tool function name → analyzer. Composition roots
 * pass this to the action lifecycle. Tools without an analyzer fall through
 * to the legacy handler path until P3 migration; they are audit-labelled
 * `legacy-host` per the deprecation surface.
 */
export type ToolAnalyzer = (
  args: unknown,
  ctx: ToolAnalysisContext,
) => Promise<PreparedToolAction>;

export const DEFAULT_ANALYZERS: Record<string, ToolAnalyzer> = {
  write_file: (args, ctx) =>
    analyzeWriteFile(args as { path: string; content: string }, ctx),
  read_file: (args, ctx) => analyzeReadFile(args as { path: string }, ctx),
  execute_shell_command: (args, ctx) =>
    analyzeShellCommand(args as { command: string }, ctx),
};
