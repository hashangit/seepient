/**
 * Platform/backend capability matrix — Capabilities (spec 008, T602, FR-003/
 * FR-007-FR-011).
 *
 * Publishes the actual enforcement shape of each backend so operators and
 * the UI can reason about what is enforceable on the current platform. Fail-
 * closed diagnostics: when a capability is unsupported, the boundary reports
 * it rather than approximating.
 *
 * This is a static declaration consumed by composition roots to populate
 * `ExecutionBackendCapabilities` and by `/permissions status` to render the
 * effective enforcement shape.
 */

export interface PlatformCapabilityRow {
  backend:
    | "local-native"
    | "docker-worker"
    | "remote-worker"
    | "browser-worker"
    | "uncontained";
  platform: "darwin" | "linux" | "windows" | "container";
  /** Native primitives available on this platform. */
  primitives: {
    seatbelt: boolean; // macOS sandbox-exec
    bubblewrap: boolean; // Linux namespaces
    openat2: boolean; // Linux restricted path resolution
    openatNoFollow: boolean; // macOS component-wise validation
    dockerSocket: boolean; // container-runtime access (scheduler only)
  };
  /** Enforcement guarantees the backend can honestly make. */
  guarantees: {
    exactCommit: boolean;
    hostFilteredEgress: boolean;
    environmentIsolation: boolean;
    processContainment: boolean;
    tenantIsolation: boolean;
  };
  /** Operation kinds this backend can execute. */
  supportedOperationKinds: Array<
    "none" | "read-file" | "commit-files" | "process" | "broker"
  >;
  /** When false, the backend fails closed for unsupported capabilities. */
  failClosed: boolean;
}

/**
 * The published capability matrix. Rows reflect ACTUAL platform support, not
 * aspirations. Backends that cannot enforce a capability report it as
 * unsupported — policy never offers an unenforceable shape.
 */
export const CAPABILITY_MATRIX: PlatformCapabilityRow[] = [
  {
    backend: "local-native",
    platform: "darwin",
    primitives: {
      seatbelt: true,
      bubblewrap: false,
      openat2: false,
      openatNoFollow: true,
      dockerSocket: false,
    },
    guarantees: {
      exactCommit: true, // via seepient-fs-commit helper (openat + O_NOFOLLOW)
      hostFilteredEgress: true, // via typed EffectBroker
      environmentIsolation: true, // via sanitized env
      processContainment: true, // via Seatbelt
      tenantIsolation: false, // local is single-tenant
    },
    supportedOperationKinds: ["none", "read-file", "commit-files", "process", "broker"],
    failClosed: true,
  },
  {
    backend: "local-native",
    platform: "linux",
    primitives: {
      seatbelt: false,
      bubblewrap: true,
      openat2: true,
      openatNoFollow: true,
      dockerSocket: false,
    },
    guarantees: {
      exactCommit: true, // via seepient-fs-commit helper (openat2)
      hostFilteredEgress: true,
      environmentIsolation: true,
      processContainment: true, // via Bubblewrap namespaces
      tenantIsolation: false,
    },
    supportedOperationKinds: ["none", "read-file", "commit-files", "process", "broker"],
    failClosed: true,
  },
  {
    backend: "local-native",
    platform: "windows",
    primitives: {
      seatbelt: false,
      bubblewrap: false,
      openat2: false,
      openatNoFollow: false,
      dockerSocket: false,
    },
    guarantees: {
      exactCommit: false, // no native primitive — fails closed
      hostFilteredEgress: true, // broker still works
      environmentIsolation: true,
      processContainment: false, // v1 non-goal: Windows native sandbox
      tenantIsolation: false,
    },
    supportedOperationKinds: ["none", "read-file", "broker"],
    failClosed: true,
  },
  {
    backend: "docker-worker",
    platform: "container",
    primitives: {
      seatbelt: false,
      bubblewrap: false,
      openat2: true,
      openatNoFollow: true,
      dockerSocket: false, // held by scheduler only, not workers
    },
    guarantees: {
      exactCommit: true,
      hostFilteredEgress: true,
      environmentIsolation: true,
      processContainment: true,
      tenantIsolation: true, // per-run/session ephemeral container
    },
    supportedOperationKinds: ["none", "read-file", "commit-files", "process", "broker"],
    failClosed: true,
  },
  {
    backend: "browser-worker",
    platform: "container",
    primitives: {
      seatbelt: false,
      bubblewrap: false,
      openat2: false,
      openatNoFollow: false,
      dockerSocket: false,
    },
    guarantees: {
      exactCommit: false,
      hostFilteredEgress: false,
      environmentIsolation: false,
      processContainment: false,
      tenantIsolation: false,
    },
    // Browser tools are UNSUPPORTED until a dedicated browser-worker backend
    // is declared. No flag launches control-plane Chromium (T212).
    supportedOperationKinds: [],
    failClosed: true,
  },
  {
    backend: "uncontained",
    platform: "darwin",
    primitives: {
      seatbelt: false,
      bubblewrap: false,
      openat2: false,
      openatNoFollow: false,
      dockerSocket: false,
    },
    guarantees: {
      exactCommit: true, // commit broker still works
      hostFilteredEgress: true, // effect broker still works
      environmentIsolation: false, // explicit loss of containment (T213)
      processContainment: false,
      tenantIsolation: false,
    },
    supportedOperationKinds: ["none", "read-file", "commit-files", "process", "broker"],
    failClosed: false, // operator opted into uncontained — audit-labelled
  },
];

/**
 * Look up the capability row for the current platform + selected backend.
 * Returns `undefined` if the combination is unsupported (fail closed).
 */
export function lookupPlatformCapability(
  backend: PlatformCapabilityRow["backend"],
  platform: NodeJS.Platform,
): PlatformCapabilityRow | undefined {
  const p: PlatformCapabilityRow["platform"] =
    platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : platform === "win32" ? "windows" : "container";
  return CAPABILITY_MATRIX.find((row) => row.backend === backend && row.platform === p);
}

/**
 * Render the matrix as a human-readable status string. Used by
 * `/permissions status` to show the effective enforcement shape.
 */
export function renderCapabilityMatrix(): string {
  const lines: string[] = ["Platform/backend capability matrix (spec 008 T602)", ""];
  for (const row of CAPABILITY_MATRIX) {
    const g = row.guarantees;
    lines.push(
      `${row.backend.padEnd(16)} ${row.platform.padEnd(10)} ` +
        `exact:${g.exactCommit ? "✓" : "✗"} ` +
        `egress:${g.hostFilteredEgress ? "✓" : "✗"} ` +
        `env:${g.environmentIsolation ? "✓" : "✗"} ` +
        `proc:${g.processContainment ? "✓" : "✗"} ` +
        `tenant:${g.tenantIsolation ? "✓" : "✗"} ` +
        `${row.failClosed ? "(fail-closed)" : "(operator-opt-in)"}`,
    );
  }
  return lines.join("\n");
}
