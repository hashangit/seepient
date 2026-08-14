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

/**
 * Cap on generated intersection tuples per evaluation. Policy layers are
 * small in practice; beyond this the layer-sourced candidates keep the
 * pre-generation behavior (review round 9).
 */
const MAX_GENERATION_TUPLES = 4_096;

/**
 * Stable identity key for a capability (field-order insensitive).
 */
export function capabilityKey(cap: Capability): string {
  return JSON.stringify(cap, Object.keys(cap).sort());
}

/**
 * Order-preserving dedupe of identical capabilities.
 */
function dedupeCapabilities(caps: Capability[]): Capability[] {
  const seen = new Set<string>();
  const out: Capability[] = [];
  for (const cap of caps) {
    const key = capabilityKey(cap);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cap);
  }
  return out;
}

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
      const outerArgv = outer.argvPrefix ?? [];
      const innerArgv = inner.argvPrefix ?? [];
      if (outerArgv.length > innerArgv.length) return false;
      for (let i = 0; i < outerArgv.length; i++) {
        if (outerArgv[i] !== innerArgv[i]) return false;
      }
      // EXACT argv (P0 review fix): an exact capability means "exactly this
      // command" — a request with ADDITIONAL trailing arguments is NOT
      // covered. Prefix matching is reserved for explicitly bounded options
      // (which omit `argvExact`). Without this, an approved "rm safe.txt"
      // would also authorize "rm safe.txt other.txt".
      if (outer.argvExact === true && outerArgv.length !== innerArgv.length) {
        return false;
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

/**
 * Field-wise intersection of two same-kind capabilities (v1). Unset fields
 * are wildcards, so the intersection carries the narrower value. Returns
 * `undefined` when the two capabilities constrain an exact field
 * differently — the intersection is empty.
 *
 * Only the multi-dimension kinds (process, model-egress,
 * network-destination) need this: single-dimension kinds are already
 * handled by the layer-sourced candidate loop below.
 */
function intersectCapabilityFields(a: Capability, b: Capability): Capability | undefined {
  switch (a.kind) {
    case "process": {
      if (b.kind !== "process") return undefined;
      if (
        a.executable !== undefined &&
        b.executable !== undefined &&
        a.executable !== b.executable
      ) {
        return undefined;
      }
      const argvA = a.argvPrefix ?? [];
      const argvB = b.argvPrefix ?? [];
      const longer = argvA.length >= argvB.length ? argvA : argvB;
      const shorter = argvA.length >= argvB.length ? argvB : argvA;
      for (let i = 0; i < shorter.length; i++) {
        if (shorter[i] !== longer[i]) return undefined;
      }
      const executable = a.executable ?? b.executable;
      const argvPrefix = longer.length > 0 ? longer : undefined;
      // A layer that pins argvExact narrows the intersection to that exact
      // length; the every-layer coverage check below rejects the combined
      // capability when a shorter exact pin and a longer prefix conflict.
      const argvExact = a.argvExact === true || b.argvExact === true;
      return {
        kind: "process",
        ...(executable !== undefined ? { executable } : {}),
        ...(argvPrefix !== undefined ? { argvPrefix } : {}),
        ...(argvExact ? { argvExact: true } : {}),
      };
    }
    case "model-egress": {
      if (b.kind !== "model-egress") return undefined;
      const providerClass =
        a.providerClass === "*"
          ? b.providerClass
          : b.providerClass === "*" || b.providerClass === a.providerClass
            ? a.providerClass
            : undefined;
      if (providerClass === undefined) return undefined;
      // "*" is the universal data class: a wildcard layer lets the other
      // layer's list through unchanged.
      const aAll = a.dataClasses.includes("*");
      const bAll = b.dataClasses.includes("*");
      const dataClasses = aAll
        ? b.dataClasses
        : bAll
          ? a.dataClasses
          : a.dataClasses.filter((c) => b.dataClasses.includes(c));
      if (dataClasses.length === 0) return undefined;
      return { kind: "model-egress", providerClass, dataClasses };
    }
    case "network-destination": {
      if (b.kind !== "network-destination") return undefined;
      if (a.host !== b.host || a.scheme !== b.scheme) return undefined;
      if (a.port !== undefined && b.port !== undefined && a.port !== b.port) {
        return undefined;
      }
      const port = a.port ?? b.port;
      return {
        kind: "network-destination",
        scheme: a.scheme,
        host: a.host,
        ...(port !== undefined ? { port } : {}),
      };
    }
    default:
      return undefined;
  }
}

export function effectiveCapabilities(
  deployment: CapabilitySet,
  principal: CapabilitySet,
  runtime: CapabilitySet,
  active: CapabilitySet,
): CapabilitySet {
  const layers = [deployment, principal, runtime, active];
  const effective: Capability[] = [];

  // A candidate is effective only when every layer covers it; the widest
  // equivalent candidate is retained.
  const consider = (candidate: Capability): void => {
    if (candidate.kind === "trusted-host") return;
    if (!layers.every((layer) => setCovers(layer, candidate))) return;
    if (effective.some((cap) => covers(cap, candidate))) return;
    for (let i = effective.length - 1; i >= 0; i--) {
      if (covers(candidate, effective[i])) effective.splice(i, 1);
    }
    effective.push(candidate);
  };

  // `intersect()` is intentionally directional: it filters capabilities from
  // its right-hand set through a left-hand ceiling. Chaining it across policy
  // layers is therefore incorrect when a later layer is broader than an
  // earlier one (for example, an exact persisted process grant followed by a
  // broad runtime process ceiling). Build the representable set intersection
  // from every layer's candidates instead.
  //
  // Multi-dimension kinds first (GENERATED intersections): a layer-sourced
  // candidate is covered by a layer as soon as each WILDCARD dimension of the
  // candidate is unconstrained on that layer, so independent constraints
  // defeat the every-layer check. A deployment ceiling "https api.example.com
  // on any port" plus a grant "…:443" would otherwise retain the any-port
  // candidate (false grant), and "anthropic on any data class" plus "any
  // provider, user-context only" yields nothing although "anthropic,
  // user-context only" is the valid combined intersection (false deny). For
  // every tuple of same-kind capabilities (one per layer) generate the
  // field-wise intersection; being the narrowest valid candidate, it replaces
  // the wider layer-sourced candidates below.
  const overflowKinds = new Set<Capability["kind"]>();
  for (const kind of ["process", "model-egress", "network-destination"] as const) {
    // The enumeration below is the product of the per-layer counts; dedupe
    // identical capabilities (the same ceiling is commonly repeated across
    // layers) and fail CLOSED for the kind beyond the bound: the layer-
    // sourced fallback could retain wildcard-dimension candidates (false
    // grant), so an oversized kind contributes nothing rather than a
    // possibly widened one (review round 9).
    const perLayer = layers.map((layer) =>
      dedupeCapabilities(layer.capabilities.filter((c) => c.kind === kind)),
    );
    if (perLayer.some((caps) => caps.length === 0)) continue;
    const tupleCount = perLayer.reduce((n, caps) => n * caps.length, 1);
    if (tupleCount > MAX_GENERATION_TUPLES) {
      overflowKinds.add(kind);
      continue;
    }
    const generate = (layerIndex: number, acc: Capability | undefined): void => {
      // `undefined` at a non-first level means the fold already collapsed
      // (empty intersection) — prune the branch instead of resurrecting it
      // as a fresh accumulator (review round 9).
      if (acc === undefined && layerIndex > 0) return;
      if (layerIndex === layers.length) {
        if (acc !== undefined) consider(acc);
        return;
      }
      for (const cap of perLayer[layerIndex]) {
        generate(layerIndex + 1, acc === undefined ? cap : intersectCapabilityFields(acc, cap));
      }
    };
    generate(0, undefined);
  }

  // Layer-sourced candidates (single-dimension kinds and any multi-dimension
  // candidate not already superseded by a generated intersection). Kinds
  // that overflowed the generation bound above are excluded — they fail
  // closed.
  for (const candidate of layers.flatMap((layer) => layer.capabilities)) {
    if (overflowKinds.has(candidate.kind)) continue;
    consider(candidate);
  }

  // Trusted host callbacks are registered by the host composition root and
  // have always been treated as active-set authority outside static ceilings.
  for (const candidate of active.capabilities) {
    if (
      candidate.kind === "trusted-host" &&
      !effective.some((cap) => covers(cap, candidate))
    ) {
      effective.push(candidate);
    }
  }

  return { version: 1, capabilities: effective };
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
          // The requested command IS the exact command: coverage must be
          // equal-length, never prefix (P0 review fix — "rm safe.txt" must
          // not authorize "rm safe.txt other.txt"). Bounded options omit
          // this flag and keep prefix semantics.
          argvExact: true,
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
