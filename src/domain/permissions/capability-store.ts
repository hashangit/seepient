/**
 * Capability intersection logic — Domain (spec 008, T106/T107).
 *
 * The effective capability is a monotonic intersection. Every term may
 * narrow; no term may expand a term to its left. This module computes the
 * intersection and answers "is this requested capability covered by the
 * effective set?" — the core of `PolicyEngine.evaluate()`.
 *
 * Pure functions: no I/O, no secrets, no logging. Fully unit-testable.
 */
import type {
  Capability,
  CapabilitySet,
  DenyRule,
} from "../../foundations/contracts/permission-policy.js";
import type {
  EffectRequest,
  ToolEffectKind,
} from "../../foundations/contracts/tool-effects.js";

/** Empty capability set (the "deny everything" baseline). */
export const EMPTY_CAPABILITY_SET: CapabilitySet = {
  version: 1,
  capabilities: [],
};

/** Union of the supported capability kinds (mirror of `Capability["kind"]`). */
type CapKind = Capability["kind"];

/**
 * Path-segment containment: does `child` live inside `parent`?
 *
 * `/project/data` covers `/project/data`, `/project/data/x`, `/project/data/sub/y`.
 * It does NOT cover `/project/database` (different folder) or `/project/dat` (shorter).
 *
 * This replaces the unsafe `startsWith` check that let a grant for
 * `/project/data` match `/project/database`.
 */
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

/**
 * Does an outer capability `outer` cover (permit) an inner requested
 * capability `inner`? Coverage is the monotonic relation: the outer must be
 * at least as broad as the inner on every dimension, and shape must match.
 *
 * Example: `{kind:"write-root", root:"/project"}` covers
 * `{kind:"commit-file", path:"/project/file.txt"}` only when policy
 * explicitly widens — v1 does NOT auto-widen exact→root, so the caller must
 * pass a matching outer shape. This function is strict by default.
 */
export function covers(outer: Capability, inner: Capability): boolean {
  // A deny on a kind can never cover anything.
  if (outer.kind !== inner.kind) {
    // Cross-kind coverage: a root-shaped capability can cover a more specific
    // capability of the same family within the root.
    if (outer.kind === "read-root" && inner.kind === "read-file") {
      return pathContains(outer.root, inner.path);
    }
    // write-root covers commit-file: if you have write authority over a folder,
    // you can commit files in it. The enforcement mechanism (exact-commit
    // broker vs direct write) is a backend detail, not an authority boundary.
    if (outer.kind === "write-root" && inner.kind === "commit-file") {
      return pathContains(outer.root, inner.path);
    }
    return false;
  }
  switch (outer.kind) {
    case "read-root":
      return inner.kind === "read-root" && pathContains(outer.root, inner.root);
    case "read-file":
      return inner.kind === "read-file" && inner.path === outer.path;
    case "write-root":
      return inner.kind === "write-root" && pathContains(outer.root, inner.root);
    case "commit-file":
      // Exact match only — a commit-file cap never covers a sibling path.
      return inner.kind === "commit-file" && inner.path === outer.path;
    case "network-destination": {
      if (inner.kind !== "network-destination") return false;
      if (inner.host !== outer.host || inner.scheme !== outer.scheme) return false;
      if (outer.port !== undefined && inner.port !== undefined && outer.port !== inner.port) return false;
      return true;
    }
    case "external-recipient":
      return (
        inner.kind === "external-recipient" &&
        inner.service === outer.service &&
        inner.recipient === outer.recipient
      );
    case "process": {
      if (inner.kind !== "process") return false;
      if (outer.executable !== undefined && outer.executable !== inner.executable) return false;
      if (outer.argvPrefix !== undefined) {
        const innerArgv = inner.argvPrefix ?? [];
        if (outer.argvPrefix.length > innerArgv.length) return false;
        for (let i = 0; i < outer.argvPrefix.length; i++) {
          if (outer.argvPrefix[i] !== innerArgv[i]) return false;
        }
      }
      return true;
    }
    case "secret-ref":
      return inner.kind === "secret-ref" && inner.ref === outer.ref;
    case "model-egress": {
      if (inner.kind !== "model-egress") return false;
      if (outer.providerClass !== "*" && outer.providerClass !== inner.providerClass) return false;
      // Outer must permit every data class the inner requests.
      const allowed = new Set(outer.dataClasses);
      return inner.dataClasses.every((c) => allowed.has(c) || allowed.has("*"));
    }
    case "trusted-host":
      if (inner.kind !== "trusted-host") return false;
      if (outer.registrationId !== undefined && outer.registrationId !== inner.registrationId) return false;
      return true;
    case "activate-change-class":
      return (
        inner.kind === "activate-change-class" &&
        inner.changeClass === outer.changeClass
      );
  }
}

/**
 * Does any capability in `set` cover the requested capability?
 */
export function setCovers(set: CapabilitySet, requested: Capability): boolean {
  return set.capabilities.some((c) => c != null && covers(c, requested));
}

/**
 * The monotonic intersection of two capability sets. The result contains only
 * capabilities that are permitted by BOTH inputs (narrower wins). An inner
 * capability is retained only when an outer capability covers it.
 *
 * Intersection is computed inner-relative-to-outer: for each inner cap, keep
 * it only if the outer set covers it. Union of outer is not performed — the
 * intersection narrows.
 */
export function intersect(outer: CapabilitySet, inner: CapabilitySet): CapabilitySet {
  const kept: Capability[] = [];
  for (const ic of inner.capabilities) {
    if (ic.kind === "trusted-host" || setCovers(outer, ic)) kept.push(ic);
  }
  return { version: 1, capabilities: kept };
}

export function effectiveCapabilities(
  deployment: CapabilitySet,
  principal: CapabilitySet,
  runtime: CapabilitySet,
  active: CapabilitySet,
): CapabilitySet {
  const maxAuthority = intersect(intersect(deployment, principal), runtime);
  return intersect(maxAuthority, active);
}
/**
 * Capabilities implied by an `EffectRequest`. Each effect maps to one or more
 * concrete capabilities that must be present in the effective set.
 */
export function capabilitiesForEffect(req: EffectRequest): Capability[] {
  switch (req.kind) {
    case "filesystem-read":
      return req.targets.map((t) => ({ kind: "read-file", path: t.canonicalPath }));
    case "filesystem-write":
      // v1 structured writes use exact commit-file caps; write-root is for shell.
      return req.targets.map((t) => ({
        kind: "commit-file",
        path: t.target.canonicalPath,
      }));
    case "process-exec":
      return [
        {
          kind: "process",
          executable: req.command.executable,
          argvPrefix: req.command.argv,
        },
        ...req.requestedRoots.map((r) => ({
          kind: r.access === "read" ? ("read-root" as const) : ("write-root" as const),
          root: r.canonicalRoot,
        })),
      ];
    case "network-egress":
      if (req.destinations === "dynamic") {
        // Dynamic egress requires the broker to reauthorize per-destination.
        // Represented as an empty static list — the broker enforces at connect.
        return [];
      }
      return req.destinations.map((d) => ({
        kind: "network-destination",
        scheme: d.scheme,
        host: d.host,
        port: d.port,
      }));
    case "external-send":
      return req.destinations.map((d) => ({
        kind: "external-recipient",
        service: d.service,
        recipient: d.recipient,
      }));
    case "secret-use":
      return req.secretRefs.map((ref) => ({ kind: "secret-ref", ref }));
    case "model-egress":
      return [
        {
          kind: "model-egress",
          providerClass: req.providerClass === "normal" ? "*" : req.providerClass,
          dataClasses: req.dataClasses,
        },
      ];
    case "security-policy-change":
    case "software-activation":
      // Authority-expanding effects have no capability shape in the general
      // engine; they route through SelfEvolutionPolicy and the activation
      // boundary. Represent as an uncapped effect (policy will deny unless
      // explicitly delegated).
      return [];
    case "host-callback":
      return [{ kind: "trusted-host", registrationId: req.toolName }];
  }
}

/**
 * All capabilities required by an action's combined effects.
 */
export function requiredCapabilities(effects: EffectRequest[]): Capability[] {
  return effects.flatMap(capabilitiesForEffect);
}

/**
 * Does any immutable deny rule forbid this effect kind / target?
 */
export function isDeniedByRule(
  denies: DenyRule[],
  effect: ToolEffectKind,
  target?: string,
): DenyRule | undefined {
  return denies.find((r) => {
    if (r.effect !== "*" && r.effect !== effect) return false;
    if (r.target === undefined) return true;
    if (target === undefined) return false;
    // Path-segment containment — a deny on /project/data must not be escaped
    // by /project/database.
    return target === r.target || pathContains(r.target, target);
  });
}

/** Re-export the kind type for callers that need to exhaust-switch. */
export type { CapKind };
