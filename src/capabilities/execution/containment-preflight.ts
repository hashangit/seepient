/**
 * Containment preflight — Capabilities (spec 011, T032/FR-019).
 *
 * A local approval is actionable only when the containment backend is
 * operational: the user must not be able to understand and approve an
 * action, only to discover that no Seatbelt/Bubblewrap backend is available
 * at dispatch (product acceptance). PolicyEngine enforces the same rule via
 * `backendCapabilities.environmentIsolation` before a prompt is issued;
 * this module is the composition-root surface that produces the status line
 * and the actionable setup message.
 */
import { probeSandbox } from "../../vendors/sandbox-runtime/index.js";

export type ContainmentPreflightResult =
  | {
      ok: true;
      backend: "seatbelt" | "bubblewrap";
      workspaceRoot?: string;
    }
  | {
      ok: false;
      reason: "unsupported-platform" | "binary-missing" | "primitive-unsupported";
      /** One actionable setup message, not a permission-policy lecture. */
      setupHint: string;
    };

export async function preflightContainment(opts?: {
  workspaceRoot?: string;
}): Promise<ContainmentPreflightResult> {
  const probe = await probeSandbox();
  if (!probe.available) {
    const setupHint =
      probe.platform === "darwin"
        ? "Seatbelt (sandbox-exec) is missing — expected at /usr/bin/sandbox-exec. Reinstall macOS system tools, or run with SEEPIENT_UNCONTAINED=1 to explicitly disable containment."
        : probe.platform === "linux"
          ? "Bubblewrap (bwrap) is not installed. Install it with your package manager (e.g. `sudo apt install bubblewrap` or `brew install bwrap`), or run with SEEPIENT_UNCONTAINED=1 to explicitly disable containment."
          : "Containment is not supported on this platform. Run with SEEPIENT_UNCONTAINED=1 to explicitly disable containment.";
    return {
      ok: false,
      reason: probe.reason ?? "binary-missing",
      setupHint,
    };
  }
  if (probe.backend === "none") {
    return {
      ok: false,
      reason: "primitive-unsupported",
      setupHint: "Containment primitives are not available on this system. Run with SEEPIENT_UNCONTAINED=1 to explicitly disable containment.",
    };
  }
  return {
    ok: true,
    backend: probe.backend,
    workspaceRoot: opts?.workspaceRoot,
  };
}
