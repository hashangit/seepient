import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SandboxProbe } from "../../../vendors/sandbox-runtime/index.js";

const probeMock = vi.fn<() => Promise<SandboxProbe>>();

vi.mock("../../../vendors/sandbox-runtime/index.js", () => ({
  probeSandbox: () => probeMock(),
}));

import { preflightContainment } from "../containment-preflight.js";

describe("containment preflight (spec 011 T032)", () => {
  beforeEach(() => {
    probeMock.mockReset();
  });

  it("reports the active backend and writable root when containment is available", async () => {
    probeMock.mockResolvedValue({
      available: true,
      platform: "darwin",
      backend: "seatbelt",
    });
    const result = await preflightContainment({ workspaceRoot: "/work" });
    expect(result).toEqual({ ok: true, backend: "seatbelt", workspaceRoot: "/work" });
  });

  it("fails closed with a macOS setup hint when sandbox-exec is missing", async () => {
    probeMock.mockResolvedValue({
      available: false,
      platform: "darwin",
      backend: "none",
      reason: "binary-missing",
    });
    const result = await preflightContainment();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("binary-missing");
      expect(result.setupHint).toMatch(/sandbox-exec/);
    }
  });

  it("fails closed with a Linux setup hint when bwrap is missing", async () => {
    probeMock.mockResolvedValue({
      available: false,
      platform: "linux",
      backend: "none",
      reason: "binary-missing",
    });
    const result = await preflightContainment();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("binary-missing");
      expect(result.setupHint).toMatch(/bubblewrap \(bwrap\)/i);
    }
  });

  it("fails closed when the probe reports a backend of none despite availability", async () => {
    probeMock.mockResolvedValue({
      available: true,
      platform: "linux",
      backend: "none",
    });
    const result = await preflightContainment();
    expect(result).toEqual({
      ok: false,
      reason: "primitive-unsupported",
      setupHint: expect.stringMatching(/SEEPIENT_UNCONTAINED/),
    });
  });
});
