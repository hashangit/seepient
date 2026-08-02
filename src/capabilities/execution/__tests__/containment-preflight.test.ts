import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SandboxProbe } from "../../../vendors/sandbox-runtime/index.js";

const factoryMock = vi.fn<() => Promise<{ probe: SandboxProbe }>>();

vi.mock("../../../vendors/sandbox-runtime/index.js", () => ({
  createNativeProcessSandbox: () => factoryMock(),
}));

import { preflightContainment } from "../containment-preflight.js";

describe("containment preflight (spec 011 T032)", () => {
  beforeEach(() => {
    factoryMock.mockReset();
  });

  it("reports the active backend and writable root when containment is available", async () => {
    factoryMock.mockResolvedValue({
      probe: { available: true, platform: "darwin", backend: "seatbelt" },
    });
    const result = await preflightContainment({ workspaceRoot: "/work" });
    expect(result).toEqual({ ok: true, backend: "seatbelt", workspaceRoot: "/work" });
  });

  it("fails closed with a macOS setup hint when sandbox-exec is missing", async () => {
    factoryMock.mockResolvedValue({
      probe: {
        available: false,
        platform: "darwin",
        backend: "none",
        reason: "binary-missing",
      },
    });
    const result = await preflightContainment();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("binary-missing");
      expect(result.setupHint).toMatch(/sandbox-exec/);
    }
  });

  it("fails closed with a Linux setup hint when bwrap is missing", async () => {
    factoryMock.mockResolvedValue({
      probe: {
        available: false,
        platform: "linux",
        backend: "none",
        reason: "binary-missing",
      },
    });
    const result = await preflightContainment();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("binary-missing");
      expect(result.setupHint).toMatch(/bubblewrap \(bwrap\)/i);
    }
  });

  it("fails closed when the SDK fallback reports a backend of none despite the binary probe", async () => {
    // The UncontainedSandbox fallback reports backend "none" with reason
    // primitive-unsupported — the exact path a missing/old ASRT SDK takes.
    factoryMock.mockResolvedValue({
      probe: {
        available: false,
        platform: "darwin",
        backend: "none",
        reason: "primitive-unsupported",
      },
    });
    const result = await preflightContainment();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("primitive-unsupported");
      expect(result.setupHint).toMatch(/SEEPIENT_UNCONTAINED|sandbox-runtime/);
    }
  });
});
