/**
 * Approval-option and choice construction — Domain (spec 011, T004/T005,
 * T026/T027/T031).
 *
 * Builds the exact/bounded capability options and complete approval choices
 * PolicyEngine attaches to a `PermissionRequest`. Every visible choice
 * originates HERE, from the prepared action's required capabilities — never
 * from raw tool arguments or prompt text (FR-006/FR-009). Each candidate is
 * filtered against the deployment ceiling (or workspace root), immutable
 * denies, and the selected backend's enforcement shape before it enters the
 * request.
 *
 * Bounded candidates are offered only for typed capability shapes the
 * selected backend can enforce:
 *   - `process` → executable + first-argument matcher
 *     (`{ kind: "process", executable, argvPrefix: [subcommand] }`), only
 *     for non-general executors (FR-009: shells, interpreters, package
 *     managers, and build drivers never receive an executable-wide session
 *     choice; an executable-only widening is not an enforceable matcher);
 *   - `read-file` → canonical-parent root (`{ kind: "read-root", root }`),
 *     offered when the backend advertises `read-root`.
 *
 * Bounded candidates are ordered by actual authority containment, never by
 * capability count; when passing candidates are incomparable, the bounded
 * choice is omitted rather than silently picking one (product acceptance).
 *
 * Root-shaped WRITE authority is NOT offered in this MVP: the local commit
 * broker enforces exact `commit-file` capabilities only, so a `write-root`
 * option could not be enforced at dispatch (it would fail closed after
 * approval). Tool-wide/wildcard and project/global options are deferred.
 */

import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import type {
  ApprovalChoice,
  ApprovalOption,
  Capability,
  DenyRule,
  PermissionDecision,
  PolicyContext,
} from "../../foundations/contracts/permission-policy.js";
import type { PreparedToolAction } from "../../foundations/contracts/prepared-action.js";
import type { ToolEffectKind } from "../../foundations/contracts/tool-effects.js";
import { covers, isDeniedByRule, setCovers } from "./capability-store.js";

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

/**
 * Canonicalize a path via realpathSync; a not-yet-existing target keeps its
 * basename but inherits the canonical parent, so a canonicalized root still
 * prefix-matches (macOS /var -> /private/var). Mirrors policy-engine's
 * canonicalPath (review round 10).
 */
function canonicalTargetPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    if (parent === p) return p;
    try {
      return join(realpathSync(parent), basename(p));
    } catch {
      return p;
    }
  }
}

function withinWorkspaceRoot(cap: Capability, workspaceRoot?: string): boolean {
  if (!workspaceRoot) return false;
  let p: string | undefined;
  if (cap.kind === "read-root" || cap.kind === "write-root") p = cap.root;
  else if (cap.kind === "read-file" || cap.kind === "commit-file") p = cap.path;
  if (p === undefined) return false;
  const root = canonicalTargetPath(workspaceRoot);
  const target = canonicalTargetPath(p);
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
 * Executables that never receive a bounded process choice (FR-009). A
 * subcommand matcher on these is still effectively arbitrary execution:
 * `bash -c`, `python -c`, `npm run`, `make -f …`, and so on are general
 * executors, not constrained tools.
 */
const GENERAL_EXECUTORS: Record<string, true> = {
  // shells
  sh: true, bash: true, zsh: true, fish: true, dash: true, ksh: true,
  tcsh: true, csh: true, ash: true,
  // interpreters
  python: true, python2: true, python3: true, node: true, nodejs: true,
  deno: true, bun: true, ruby: true, perl: true, php: true, lua: true,
  pwsh: true, powershell: true,
  // package managers
  npm: true, npx: true, yarn: true, pnpm: true, bunx: true, pip: true,
  pip2: true, pip3: true, pipx: true, uv: true, uvx: true, poetry: true,
  pipenv: true, conda: true, mamba: true, brew: true, apt: true,
  "apt-get": true, dnf: true, yum: true, pacman: true, apk: true,
  snap: true, flatpak: true,
  // build drivers that execute arbitrary project scripts
  cargo: true, go: true, make: true, cmake: true, ninja: true, meson: true,
  gradle: true, mvn: true, ant: true, composer: true, gem: true,
  bundle: true, rake: true,
  // command wrappers whose FIRST argv token is not the real command —
  // pinning it still allows arbitrary execution (review round 10)
  env: true, sudo: true, su: true, doas: true, xargs: true, nohup: true,
  timeout: true, nice: true, setsid: true, watch: true, ssh: true,
  parallel: true,
  // tools with an embedded arbitrary-execution escape hatch (-exec, system())
  find: true, awk: true,
};

function isGeneralExecutor(executable: string): boolean {
  return GENERAL_EXECUTORS[basename(executable)] === true;
}

/**
 * Bounded process candidate: keep the executable and the FIRST argv token
 * (subcommand) as the matcher — strictly narrower than the executable
 * (FR-009, product acceptance). Executable-wide widening is never offered;
 * general executors and argv-less process caps (no subcommand to pin) are
 * skipped. Non-process missing capabilities stay exact inside the candidate.
 */
function processBoundedCandidates(missing: Capability[]): Capability[][] {
  const widened = new Map<string, Capability>();
  for (const c of missing) {
    if (c.kind !== "process") continue;
    if (c.executable === undefined || isGeneralExecutor(c.executable)) continue;
    const argv = c.argvPrefix ?? [];
    if (argv.length === 0) continue; // no subcommand matcher possible
    const key = `${c.executable}\u0000${argv[0]}`;
    if (!widened.has(key)) {
      widened.set(key, {
        kind: "process" as const,
        executable: c.executable,
        argvPrefix: [argv[0]],
      });
    }
  }
  if (widened.size === 0) return [];
  const rest = missing.filter((c) => c.kind !== "process");
  return [dedupe([...rest, ...widened.values()])];
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

// ── Labels (plain-language display data — never parsed as authority) ─────
//
// Copy follows the product acceptance feedback: the prompt must read like a
// consent dialog, not a policy grammar. Headlines name the choice; the
// explanation says what happens in plain words.

function familyOf(caps: Capability[]): "process" | "file" | "other" {
  if (caps.some((c) => c.kind === "process")) return "process";
  if (
    caps.some(
      (c) =>
        c.kind === "read-file" ||
        c.kind === "commit-file" ||
        c.kind === "read-root" ||
        c.kind === "write-root",
    )
  ) {
    return "file";
  }
  return "other";
}

/** Exact-option copy: one headline + explanation per capability family. */
function exactLabel(caps: Capability[]): string {
  switch (familyOf(caps)) {
    case "process":
      return "Only this command — runs exactly the command shown. Any change will ask again.";
    case "file":
      return "Only this file — changes exactly what's shown. Any change will ask again.";
    default:
      return "Only this action — any change will ask again.";
  }
}

/** Bounded-option copy: one headline + explanation per capability family. */
function boundedLabel(caps: Capability[]): string {
  switch (familyOf(caps)) {
    case "process":
      return "Other commands using this program — allows other commands through this program during the chosen time.";
    case "file":
      return "Other files in this folder — allows other files in this folder during the chosen time.";
    default:
      return "Similar actions — allows similar actions during the chosen time.";
  }
}

// ── Public construction ───────────────────────────────────────────────────

export interface ApprovalOptionInput {
  action: PreparedToolAction;
  /** The exact capabilities the action requires but the effective set lacks. */
  missing: Capability[];
  context: PolicyContext;
  /** Offered lifetimes of the parent request (session only when bound). */
  offeredLifetimes: Array<"action" | "run" | "session" | "project" | "global">;
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
      label: exactLabel(exact),
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

  // The prompt offers AT MOST ONE bounded option next to the exact option
  // (product acceptance: a bounded choice is a single widening decision).
  const passing: Array<{ caps: Capability[]; key: string }> = [];
  const seenKeys = new Set<string>();
  for (const caps of candidates) {
    const deduped = dedupe(caps);
    if (deduped.length === 0) continue;
    const key = canonicalCaps(deduped);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    // Every capability in the candidate must be eligible, backend-enforceable,
    // and not immutable-denied. A single failure drops the whole candidate.
    const pass = deduped.every(
      (c) =>
        backend.capabilityKinds.includes(c.kind) &&
        !deniedForCap(context.immutableDenies, c) &&
        eligible(c, context),
    );
    if (pass) passing.push({ caps: deduped, key });
  }
  // Order candidates by ACTUAL authority containment, not capability count
  // (product acceptance): drop any candidate that covers another — the
  // narrowest surviving candidate is the least privilege. When the remaining
  // candidates are incomparable, the bounded choice is omitted entirely
  // rather than silently picking one — Domain never guesses which widening
  // the user wanted.
  const coversSet = (outer: Capability[], inner: Capability[]): boolean =>
    inner.every((ic) => outer.some((oc) => covers(oc, ic)));
  const minimal = passing.filter(
    (p) =>
      !passing.some((q) => q.key !== p.key && coversSet(p.caps, q.caps)),
  );
  const boundedCandidate = minimal.length === 1 ? minimal[0] : undefined;
  if (boundedCandidate) {
    options.push({
      optionId: optionIdFor(action.actionDigest, "bounded", boundedCandidate.caps),
      actionDigest: action.actionDigest,
      kind: "bounded",
      label: boundedLabel(boundedCandidate.caps),
      capabilities: boundedCandidate.caps,
      supportedLifetimes: [...offeredLifetimes],
    });
  }

  return options;
}

// ── Complete approval choices (spec 011 T026/T027) ───────────────────────

/** Stable, request-bound choice ID derived from the option ID + lifetime. */
export function choiceIdFor(
  optionId: string,
  lifetime: "action" | "session" | "project" | "global",
): string {
  return `${optionId}::${lifetime}`;
}

/**
 * One plain-language line per material authority in the capability delta
 * (product acceptance: a mixed-capability action is never hidden behind a
 * single family label). Secret VALUES never appear — refs are identifiers.
 */
export function capabilityBullet(cap: Capability): string {
  switch (cap.kind) {
    case "process": {
      const exe = cap.executable ? basename(cap.executable) : "the program";
      const argv = cap.argvPrefix?.length ? ` ${cap.argvPrefix.join(" ")}` : "";
      return `Run \`${exe}${argv}\``;
    }
    case "read-file":
      return `Read \`${cap.path}\``;
    case "read-root":
      return `Read files under \`${cap.root}\``;
    case "commit-file":
      return `Write \`${cap.path}\``;
    case "write-root":
      return `Write files under \`${cap.root}\``;
    case "network-destination": {
      const scheme = `${cap.scheme}://`;
      const port = cap.port !== undefined ? `:${cap.port}` : "";
      return `Connect to \`${scheme}${cap.host}${port}\``;
    }
    case "external-recipient":
      return `Send to \`${cap.recipient}\` via ${cap.service}`;
    case "secret-ref":
      return `Use the stored secret \`${cap.ref}\``;
    case "model-egress":
      return `Send ${cap.dataClasses.join(", ")} to the ${cap.providerClass} model`;
    case "activate-change-class":
      return `Apply a ${cap.changeClass} policy change`;
    case "trusted-host":
      return cap.registrationId
        ? `Allow callbacks from the registered host \`${cap.registrationId}\``
        : "Allow callbacks from a registered host";
  }
}

/** Full authority summary for a capability set — one bullet per capability. */
export function authoritySummary(caps: Capability[]): string[] {
  return caps.map(capabilityBullet);
}

/** Plain-language title for a bounded choice, from its matcher shape. */
function boundedTitle(caps: Capability[]): string {
  const processCaps = caps.filter((c) => c.kind === "process");
  if (processCaps.length > 0) {
    const matchers = processCaps
      .filter((c) => c.executable !== undefined && (c.argvPrefix?.length ?? 0) > 0)
      .map((c) => `\`${basename(c.executable as string)} ${(c.argvPrefix as string[]).join(" ")} …\``);
    if (matchers.length > 0) {
      return `Allow matching ${matchers.join(" and ")} commands until I close Seepient`;
    }
  }
  if (caps.some((c) => c.kind === "read-root")) {
    return "Allow other files in this folder until I close Seepient";
  }
  return "Allow similar actions until I close Seepient";
}

/**
 * Build the complete choices for the request. The meaningful pairs are
 * exact/action, exact/session, exact/project, exact/global, and
 * bounded/session (FR-010). Bounded/action and BOUNDED persistent choices
 * are never issued — persistent authority is exact-capability only, because
 * a widened root/prefix grant written to the protected store would be a
 * silent policy change. Persistent choices require a workspace identity;
 * session choices require a stable session identity. The least-privileged
 * choice (exact/action) is marked Recommended; the TUI never preselects it.
 */
export function buildApprovalChoices(
  options: ApprovalOption[],
  sessionId?: string,
  workspaceId?: string,
): ApprovalChoice[] {
  const choices: ApprovalChoice[] = [];
  for (const option of options) {
    const lifetimes: Array<"action" | "session" | "project" | "global"> =
      option.kind === "exact"
        ? [
            "action",
            ...(sessionId ? (["session"] as const) : []),
            ...(workspaceId ? (["project", "global"] as const) : []),
          ]
        : sessionId
          ? (["session"] as const)
          : [];
    for (const lifetime of lifetimes) {
      if (!option.supportedLifetimes.includes(lifetime)) continue;
      choices.push({
        choiceId: choiceIdFor(option.optionId, lifetime),
        optionId: option.optionId,
        lifetime,
        title: choiceTitle(option, lifetime),
        description:
          lifetime === "action"
            ? "You'll be asked again next time."
            : lifetime === "session"
              ? "Seepient will remember this permission until you close it."
              : lifetime === "project"
                ? "Seepient will remember this permission for this project."
                : "Seepient will remember this permission for all projects.",
        authoritySummary: authoritySummary(option.capabilities),
        recommended: false,
      });
    }
  }
  const recommended = choices.find((c) => c.lifetime === "action");
  if (recommended) {
    return choices.map((c) =>
      c.choiceId === recommended.choiceId ? { ...c, recommended: true } : c,
    );
  }
  return choices;
}

/** Plain-language headline for a choice, from its lifetime. */
function choiceTitle(
  option: ApprovalOption,
  lifetime: "action" | "session" | "project" | "global",
): string {
  if (option.kind !== "exact") return boundedTitle(option.capabilities);
  switch (lifetime) {
    case "action":
      return "Allow this action once";
    case "session":
      return "Allow this exact action until I close Seepient";
    case "project":
      return "Allow in this project";
    case "global":
      return "Allow always";
  }
}

/**
 * Deep-freeze a plain-data value (permission requests are JSON-serializable).
 * Used to give brokers a read-only view so a mutation attempt fails loudly
 * instead of silently widening an approval.
 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * Validate that an approval decision actually matches the request it claims to
 * answer. Round 4 P1: approved decisions MUST carry the EXACT request ID and
 * action digest — missing binding is rejected, never forgiven. (Legacy
 * adapters normalize by filling these fields from the request they were
 * given, before Domain sees the decision.)
 */
export function validFor(
  answer: PermissionDecision,
  expectedActionDigest: string,
  expectedRequestId: string,
): boolean {
  if (!answer.approved) return true;
  return (
    answer.actionDigest === expectedActionDigest &&
    answer.requestId === expectedRequestId
  );
}

