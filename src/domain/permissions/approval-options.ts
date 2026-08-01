/**
 * Approval-option construction — Domain (spec 011, T004/T005).
 *
 * Builds the exact/bounded capability choices PolicyEngine attaches to a
 * `PermissionRequest`. Every visible choice originates HERE, from the
 * prepared action's required capabilities — never from raw tool arguments or
 * prompt text (FR-006/FR-009). Each candidate is filtered against the
 * deployment ceiling (or workspace root), immutable denies, and the selected
 * backend's enforcement shape before it enters the request.
 *
 * Bounded candidates are offered only for typed capability shapes the
 * selected backend can enforce:
 *   - `process` → executable-bound (`{ kind: "process", executable }`),
 *     offered when the backend advertises `process`;
 *   - `read-file` → canonical-parent root (`{ kind: "read-root", root }`),
 *     offered when the backend advertises `read-root`.
 *
 * Root-shaped WRITE authority is NOT offered in this MVP: the local commit
 * broker enforces exact `commit-file` capabilities only, so a `write-root`
 * option could not be enforced at dispatch (it would fail closed after
 * approval). Tool-wide/wildcard and project/global options are deferred.
 */

import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { realpathSync } from "node:fs";
import type {
  ApprovalOption,
  Capability,
  DenyRule,
  PolicyContext,
} from "../../foundations/contracts/permission-policy.js";
import type { PreparedToolAction } from "../../foundations/contracts/prepared-action.js";
import type { ToolEffectKind } from "../../foundations/contracts/tool-effects.js";
import { isDeniedByRule, setCovers } from "./capability-store.js";

/** Path-segment containment mirroring capability-store (incl. /private/). */
function normalizePathForComparison(p: string): string {
  if (p.startsWith("/private/")) return p.slice(8);
  return p;
}

function pathContains(parent: string, child: string): boolean {
  const normParent = normalizePathForComparison(parent);
  const normChild = normalizePathForComparison(child);
  if (normChild === normParent) return true;
  if (normParent === "/") return normChild.startsWith("/");
  const prefix = normParent.endsWith("/") ? normParent : normParent + "/";
  return normChild.startsWith(prefix);
}

/** Recursively sort object keys for deterministic serialization. */
function deepSort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSort);
  if (value === null || typeof value !== "object") return value;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[k] = deepSort((value as Record<string, unknown>)[k]);
  }
  return sorted;
}

function canonicalCaps(caps: Capability[]): string {
  return JSON.stringify(deepSort(caps));
}

/** Stable, request-bound option ID derived from canonical option data. */
function optionIdFor(
  actionDigest: string | undefined,
  kind: "exact" | "bounded",
  caps: Capability[],
): string {
  const digest = actionDigest ?? "";
  const hash = createHash("sha256")
    .update(`${digest}\n${kind}\n${canonicalCaps(caps)}`, "utf8")
    .digest("hex");
  return `${digest.slice(0, 8)}:${kind}:${hash.slice(0, 20)}`;
}

/** Deduplicate capabilities by canonical shape, preserving order. */
function dedupe(caps: Capability[]): Capability[] {
  const seen = new Set<string>();
  const out: Capability[] = [];
  for (const c of caps) {
    const key = JSON.stringify(c);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

// ── Capability → effect/target mapping for immutable-deny checks ─────────

function effectForCap(cap: Capability): ToolEffectKind | undefined {
  switch (cap.kind) {
    case "read-root":
    case "read-file":
      return "filesystem-read";
    case "write-root":
    case "commit-file":
      return "filesystem-write";
    case "process":
      return "process-exec";
    case "network-destination":
      return "network-egress";
    case "external-recipient":
      return "external-send";
    case "secret-ref":
      return "secret-use";
    case "model-egress":
      return "model-egress";
    case "activate-change-class":
      return "security-policy-change";
    case "trusted-host":
      return "host-callback";
  }
}

function targetForCap(cap: Capability): string | undefined {
  switch (cap.kind) {
    case "read-root":
    case "write-root":
      return cap.root;
    case "read-file":
    case "commit-file":
      return cap.path;
    case "process":
      return cap.executable;
    case "network-destination":
      return cap.host;
    case "external-recipient":
      return cap.recipient;
    case "secret-ref":
      return cap.ref;
    case "model-egress":
      return cap.providerClass;
    case "activate-change-class":
      return cap.changeClass;
    case "trusted-host":
      return cap.registrationId;
  }
}

/**
 * A capability is immutable-denied when a rule matches its effect and either
 * the rule's target contains the capability's target (exact/prefix deny) or
 * the capability's target contains the rule's target (root-shaped capability
 * would newly cover a denied path).
 */
function deniedForCap(denies: DenyRule[], cap: Capability): boolean {
  const effect = effectForCap(cap);
  if (!effect) return false;
  const target = targetForCap(cap);
  if (isDeniedByRule(denies, effect, target)) return true;
  // Root-shaped caps: a deny rule on ANY path inside the root forbids the root.
  if (target !== undefined) {
    return denies.some((r) => {
      if (r.effect !== "*" && r.effect !== effect) return false;
      if (r.target === undefined) return false;
      return pathContains(target, r.target);
    });
  }
  return false;
}

// ── Ceiling / workspace-root eligibility (mirrors policy-engine inCeiling) ─

function withinWorkspaceRoot(cap: Capability, workspaceRoot?: string): boolean {
  if (!workspaceRoot) return false;
  let p: string | undefined;
  if (cap.kind === "read-root" || cap.kind === "write-root") p = cap.root;
  else if (cap.kind === "read-file" || cap.kind === "commit-file") p = cap.path;
  if (p === undefined) return false;
  let root = workspaceRoot;
  let target = p;
  try {
    root = realpathSync(root);
    target = realpathSync(target);
  } catch {
    /* keep raw paths */
  }
  return target === root || pathContains(root, target);
}

/**
 * A candidate capability is approvable only when it stays inside the
 * deployment ceiling — or, for interactive file operations, inside the
 * workspace root (the same rule the engine applies to the requested
 * capabilities). `trusted-host` callbacks are operator-registered.
 */
function eligible(cap: Capability, context: PolicyContext): boolean {
  if (cap.kind === "trusted-host") return true;
  if (setCovers(context.deploymentCeiling, cap)) return true;
  return withinWorkspaceRoot(cap, context.workspaceRoot);
}

// ── Bounded candidate widening ───────────────────────────────────────────

/**
 * Executable-bound process candidate: keep the exact executable, drop the
 * argv constraint. One option per distinct executable in the request.
 */
function processBoundedCandidates(missing: Capability[]): Capability[][] {
  const executables = new Set<string>();
  for (const c of missing) {
    if (c.kind === "process" && c.executable !== undefined) {
      executables.add(c.executable);
    }
  }
  if (executables.size === 0) return [];
  const widened = [...executables].map((exe) => ({
    kind: "process" as const,
    executable: exe,
  }));
  const rest = missing.filter((c) => c.kind !== "process");
  return [dedupe([...rest, ...widened])];
}

/**
 * Canonical-parent read-root candidate: widen each `read-file` capability to
 * a `read-root` over its canonical parent directory. The backend enforces
 * reads through the prepared targets, so a root option never widens what the
 * executor may touch.
 */
function readRootBoundedCandidates(missing: Capability[]): Capability[][] {
  const readFiles = missing.filter((c) => c.kind === "read-file");
  if (readFiles.length === 0) return [];
  const roots = new Map<string, string>();
  for (const c of readFiles) {
    if (c.kind !== "read-file") continue;
    roots.set(c.path, dirname(c.path));
  }
  const widened = [...roots.values()].map((root) => ({
    kind: "read-root" as const,
    root,
  }));
  const rest = missing.filter((c) => c.kind !== "read-file");
  return [dedupe([...rest, ...widened])];
}

// ── Labels (display data — never parsed as authority) ────────────────────

function describeCapability(cap: Capability): string {
  switch (cap.kind) {
    case "read-root":
      return `read anything under ${cap.root}`;
    case "write-root":
      return `write anything under ${cap.root}`;
    case "read-file":
      return `read ${cap.path}`;
    case "commit-file":
      return `write ${cap.path}`;
    case "process": {
      const exe = cap.executable ?? "any executable";
      return cap.argvPrefix && cap.argvPrefix.length > 0
        ? `run ${exe} with exact arguments`
        : `run ${exe} with any arguments`;
    }
    case "network-destination":
      return `connect to ${cap.host}`;
    case "external-recipient":
      return `send to ${cap.recipient} via ${cap.service}`;
    case "secret-ref":
      return `use secret ${cap.ref}`;
    case "model-egress":
      return `send model data to ${cap.providerClass}`;
    case "activate-change-class":
      return `activate ${cap.changeClass} changes`;
    case "trusted-host":
      return `call host callback ${cap.registrationId ?? "(any)"}`;
  }
}

function describeCapabilities(caps: Capability[]): string {
  return caps.map(describeCapability).join(", ");
}

// ── Public construction ───────────────────────────────────────────────────

export interface ApprovalOptionInput {
  action: PreparedToolAction;
  /** The exact capabilities the action requires but the effective set lacks. */
  missing: Capability[];
  context: PolicyContext;
  /** Offered lifetimes of the parent request (session only when bound). */
  offeredLifetimes: Array<"action" | "run" | "session">;
}

/**
 * Build the policy-issued options for a needs-approval request. Returns the
 * options ordered narrowest → broadest (exact first), or `null` when no
 * representable option survives the filters — the caller then denies with
 * `approval-unavailable` instead of sending an empty prompt.
 */
export function buildApprovalOptions(
  input: ApprovalOptionInput,
): ApprovalOption[] | null {
  const { action, missing, context, offeredLifetimes } = input;
  const exact = dedupe(missing);
  if (exact.length === 0) return null;

  const options: ApprovalOption[] = [
    {
      optionId: optionIdFor(action.actionDigest, "exact", exact),
      actionDigest: action.actionDigest,
      kind: "exact",
      label: `Exact — ${describeCapabilities(exact)}`,
      capabilities: exact,
      supportedLifetimes: [...offeredLifetimes],
    },
  ];

  const backend = context.backendCapabilities;
  const candidates: Capability[][] = [];
  if (backend.capabilityKinds.includes("process")) {
    candidates.push(...processBoundedCandidates(exact));
  }
  if (backend.capabilityKinds.includes("read-root")) {
    candidates.push(...readRootBoundedCandidates(exact));
  }

  const bounded: ApprovalOption[] = [];
  for (const caps of candidates) {
    const deduped = dedupe(caps);
    if (deduped.length === 0) continue;
    // Every capability in the candidate must be eligible, backend-enforceable,
    // and not immutable-denied. A single failure drops the whole candidate.
    const pass = deduped.every(
      (c) =>
        backend.capabilityKinds.includes(c.kind) &&
        !deniedForCap(context.immutableDenies, c) &&
        eligible(c, context),
    );
    if (!pass) continue;
    bounded.push({
      optionId: optionIdFor(action.actionDigest, "bounded", deduped),
      actionDigest: action.actionDigest,
      kind: "bounded",
      label: `Bounded — ${describeCapabilities(deduped)}`,
      capabilities: deduped,
      supportedLifetimes: [...offeredLifetimes],
    });
  }

  // Deterministic narrowest→broadest order: exact first, then bounded sorted
  // by capability count (fewer capabilities = narrower) and canonical shape.
  bounded.sort((a, b) => {
    if (a.capabilities.length !== b.capabilities.length) {
      return a.capabilities.length - b.capabilities.length;
    }
    return canonicalCaps(a.capabilities).localeCompare(
      canonicalCaps(b.capabilities),
    );
  });
  options.push(...bounded);

  return options.length > 0 ? options : null;
}
