/**
 * Legacy grant migration + quarantine — Domain (spec 008, T111, FR-012/FR-013).
 *
 * Read existing prefix grants but do not activate ambiguous entries. Convert
 * only provably exact, canonical entries; mark others quarantined (inactive).
 *
 * Unsafe patterns that are quarantined rather than widened to globs:
 *  - raw path-prefix grants (`/tmp/demo` matching `/tmp/demo-evil/file`)
 *  - shell string-prefix grants (`npm test` matching `npm test && rm -rf`)
 *  - malformed/corrupt entries
 *
 * Converted entries become exact `commit-file` / `process` capabilities with
 * project scope, written to the protected PolicyStore — never to a worktree
 * file. The conversion is one-way: ambiguous entries can only be re-approved
 * through `/permissions propose` + `approve` (the trusted administrative flow).
 */
import type {
  Capability,
  CapabilitySet,
} from "../../foundations/contracts/permission-policy.js";
import type { Grant } from "../grants.js";

/** Outcome categories for each legacy grant on read. */
export type MigrationOutcome =
  | { status: "converted"; capability: Capability }
  | { status: "quarantined"; reason: QuarantineReason }
  | { status: "ignored"; reason: "session-scope" | "unsupported-tool" };

export type QuarantineReason =
  | "path-prefix-not-exact"
  | "shell-prefix-not-exact"
  | "malformed"
  | "ambiguous-target"
  | "non-canonical-path";

/** Tools whose `pattern` is a path and could be safely converted if exact. */
const PATH_TOOLS = new Set(["write_file", "edit_file"]);
/** Tools whose `pattern` is a shell command — never safely convertible. */
const SHELL_TOOLS = new Set(["execute_shell_command"]);

/**
 * Decide the fate of one legacy grant. The decision is pure; it does not
 * activate anything. The caller writes converted capabilities through the
 * PolicyStore compare-and-set flow.
 */
export function classifyLegacyGrant(grant: Grant): MigrationOutcome {
  if (grant.scope === "session") {
    return { status: "ignored", reason: "session-scope" };
  }
  if (grant.pattern === undefined) {
    // Tool-level grant with no pattern — too broad to convert to a concrete
    // capability. Quarantine for explicit re-approval.
    return { status: "quarantined", reason: "ambiguous-target" };
  }

  if (SHELL_TOOLS.has(grant.tool)) {
    // Shell string-prefix grants are NEVER safely convertible: metacharacters
    // allow `npm test && destructive-command` to match a `npm test` grant.
    return { status: "quarantined", reason: "shell-prefix-not-exact" };
  }

  if (PATH_TOOLS.has(grant.tool)) {
    // Path grants: convert only if the path is canonical and exact. Any
    // prefix-style matching (e.g. trailing slash, wildcard intent) is
    // quarantined.
    if (!isCanonicalPath(grant.pattern)) {
      return { status: "quarantined", reason: "non-canonical-path" };
    }
    if (looksLikePrefix(grant.pattern)) {
      return { status: "quarantined", reason: "path-prefix-not-exact" };
    }
    return {
      status: "converted",
      capability: { kind: "commit-file", path: grant.pattern },
    };
  }

  return { status: "ignored", reason: "unsupported-tool" };
}

/**
 * Convert a batch of legacy grants into a capability set + quarantine list.
 * Converted capabilities are de-duplicated. Quarantined entries are returned
 * with their reasons for operator review.
 */
export function migrateLegacyGrants(grants: Grant[]): {
  capabilities: CapabilitySet;
  quarantined: Array<{ grant: Grant; reason: QuarantineReason }>;
  ignored: Grant[];
} {
  const caps: Capability[] = [];
  const seen = new Set<string>();
  const quarantined: Array<{ grant: Grant; reason: QuarantineReason }> = [];
  const ignored: Grant[] = [];

  for (const grant of grants) {
    const outcome = classifyLegacyGrant(grant);
    if (outcome.status === "converted") {
      const key = `${outcome.capability.kind}:${JSON.stringify(outcome.capability)}`;
      if (!seen.has(key)) {
        seen.add(key);
        caps.push(outcome.capability);
      }
    } else if (outcome.status === "quarantined") {
      quarantined.push({ grant, reason: outcome.reason });
    } else {
      ignored.push(grant);
    }
  }

  return {
    capabilities: { version: 1, capabilities: caps },
    quarantined,
    ignored,
  };
}

/** A path is canonical if absolute, normalized, and free of `..` segments. */
function isCanonicalPath(p: string): boolean {
  if (!p.startsWith("/")) return false;
  if (p.includes("/../") || p.includes("/./") || p.endsWith("/..") || p.endsWith("/.")) {
    return false;
  }
  if (p.includes("//")) return false;
  return true;
}

/** Heuristic: trailing slash or glob characters suggest prefix intent. */
function looksLikePrefix(p: string): boolean {
  if (p.endsWith("/")) return true;
  if (/[*?]/.test(p)) return true;
  return false;
}
