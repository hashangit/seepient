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
 *
 * The probe goes through the SAME factory the execution boundary uses
 * (`createNativeProcessSandbox`), so the status can never claim containment
 * while the boundary runs uncontained: a missing SDK or failed session init
 * is reported exactly like a missing binary (T213).
 */
import { createNativeProcessSandbox } from "../../vendors/sandbox-runtime/index.js";

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
  const sandbox = await createNativeProcessSandbox();
  const probe = sandbox.probe;
  if (!probe.available || probe.backend === "none") {
    const setupHint =
      probe.platform === "darwin"
        ? "Seatbelt (sandbox-exec) is missing, or the sandbox runtime SDK failed to initialize — verify /usr/bin/sandbox-exec exists and that @anthropic-ai/sandbox-runtime is installed (run pnpm install). Run with SEEPIENT_UNCONTAINED=1 to explicitly disable containment."
        : probe.platform === "linux"
          ? "Bubblewrap (bwrap) is not installed, or the sandbox runtime SDK failed to initialize. Install it with your package manager (e.g. `sudo apt install bubblewrap` or `brew install bwrap`), run pnpm install, or run with SEEPIENT_UNCONTAINED=1 to explicitly disable containment."
          : "Containment is not supported on this platform. Run with SEEPIENT_UNCONTAINED=1 to explicitly disable containment.";
    return {
      ok: false,
      reason: probe.reason ?? "binary-missing",
      setupHint,
    };
  }
  return {
    ok: true,
    backend: probe.backend,
    workspaceRoot: opts?.workspaceRoot,
  };
}
