/**
 * P2 native helper probes (spec 008, T203/T207/T208, QS-2.9).
 *
 * Verifies: probes fail closed on unsupported platforms; PackagedCommitHelper
 * reports `available:false` and returns `primitive-unsupported` when the
 * binary is missing; UncontainedSandbox honestly reports `isolated:false`.
 */
import { describe, it, expect } from "vitest";
import {
  PackagedCommitHelper,
  probeCommitHelper,
} from "../../../vendors/native-fs-commit/index.js";
import {
  UncontainedSandbox,
  probeSandbox,
} from "../../../vendors/sandbox-runtime/index.js";

describe("native-fs-commit probe (T203, QS-2.9)", () => {
  it("PackagedCommitHelper fails closed when binary missing", async () => {
    const helper = new PackagedCommitHelper({
      available: false,
      reason: "binary-missing",
      platform: process.platform,
      digestVerified: false,
    });
    expect(helper.available).toBe(false);
    const result = await helper.commit({
      destination: "/tmp/x",
      content: new Uint8Array([1]),
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("primitive-unsupported");
  });

  it("probeCommitHelper returns a structured result", async () => {
    const probe = await probeCommitHelper();
    expect(typeof probe.available).toBe("boolean");
    expect(probe.platform).toBe(process.platform);
    // On macOS/Linux: may or may not have the binary packaged, but the probe
    // itself must not throw.
    if (!probe.available) {
      expect(probe.reason).toBeDefined();
    }
  });
});

describe("sandbox probe (T207/T208, T213)", () => {
  it("probeSandbox returns backend type", async () => {
    const probe = await probeSandbox();
    expect(probe.platform).toBe(process.platform);
    if (probe.available) {
      expect(["seatbelt", "bubblewrap", "none"]).toContain(probe.backend);
    }
  });

  it("UncontainedSandbox honestly reports isolated:false", async () => {
    const sandbox = new UncontainedSandbox();
    expect(sandbox.probe.backend).toBe("none");
    // No shell-injection risk in the smoke test — use a harmless command.
    const result = await sandbox.exec({
      command: {
        executable: process.platform === "win32" ? "cmd.exe" : "/bin/echo",
        argv: process.platform === "win32" ? ["/c", "echo hi"] : ["hi"],
        cwd: process.cwd(),
      },
      roots: [],
      env: {},
    });
    expect(result.isolated).toBe(false); // NEVER claims containment
    expect(result.exitCode).toBe(0);
  });
});
