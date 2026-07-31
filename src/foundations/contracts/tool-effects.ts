/**
 * Tool effect vocabulary — Foundations contract (spec 008).
 *
 * Effects are the canonical, machine-readable description of what a tool
 * call does to the world. Policy decides allow/deny on effects and targets,
 * never on risk hints. Every effect that can re-enter model-visible history
 * carries a `model-egress` effect so the egress gate can evaluate provider
 * trust class and data classification before release.
 *
 * Foundations imports no Seepient layer.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Canonical effect kinds. `risk` remains a presentation hint only. */
export type ToolEffectKind =
  | "filesystem-read"
  | "filesystem-write"
  | "process-exec"
  | "network-egress"
  | "external-send"
  | "secret-use"
  | "model-egress"
  | "security-policy-change"
  | "software-activation"
  | "host-callback";
/** Presentation-only risk category. Never a substitute for effect analysis. */
export type ToolRiskCategory = "safe" | "edit" | "communications" | "destructive";

/** Sensitivity classification for read/file data used by `model-egress`. */
export type SensitivityClass = "normal" | "sensitive" | "secret";

/** Canonical, no-follow-resolved filesystem target. */
export interface CanonicalPathTarget {
  canonicalPath: string;
  canonicalParent: string;
  basename: string;
  exists: boolean;
  /** True iff the resolved path's final component is a symlink. */
  finalSymlink: boolean;
}

/** Pre-capture snapshot used to detect TOCTOU between analysis and commit. */
export interface FileSnapshot {
  exists: boolean;
  device?: string;
  inode?: string;
  size?: number;
  modifiedNs?: string;
  sha256?: string;
}

/** Create/replace mode for a write target. */
export interface WriteTarget {
  target: CanonicalPathTarget;
  mode: "create" | "replace";
  expected?: FileSnapshot;
}

/** Root-shaped filesystem capability request for shell execution. */
export interface RootRequest {
  access: "read" | "write";
  canonicalRoot: string;
}

/** Normalized executable descriptor. No shell interpolation. */
export interface CommandDescriptor {
  executable: string;
  argv: string[];
  cwd: string;
}

/** Static, pre-declared network destination (pre-DNS). */
export interface NetworkDestination {
  scheme: "https" | "http";
  host: string;
  port?: number;
  pathPrefix?: string;
}

/** Addressable external recipient for a typed send operation. */
export interface ExternalRecipient {
  service: string;
  recipient: string;
}

/**
 * A request to perform one effect. Each variant enumerates the concrete
 * targets/destinations/recipients/secrets the action will touch; brokers
 * verify these against the capability envelope at execution time.
 */
export type EffectRequest =
  | {
      kind: "filesystem-read";
      targets: CanonicalPathTarget[];
      sensitivity: SensitivityClass;
    }
  | { kind: "filesystem-write"; targets: WriteTarget[] }
  | {
      kind: "process-exec";
      command: CommandDescriptor;
      requestedRoots: RootRequest[];
    }
  | { kind: "network-egress"; destinations: NetworkDestination[] | "dynamic" }
  | {
      kind: "external-send";
      destinations: ExternalRecipient[];
      dataClasses: string[];
    }
  | { kind: "secret-use"; secretRefs: string[] }
  | {
      kind: "model-egress";
      providerClass: string;
      dataClasses: string[];
      sources: string[];
    }
  | { kind: "security-policy-change"; proposalId: string }
  | { kind: "software-activation"; candidateId: string }
  | HostCallbackEffect;
export interface HostCallbackEffect {
  kind: "host-callback";
  toolName: string;
}
