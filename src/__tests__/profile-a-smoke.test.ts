/**
 * J11 Profile A Smoke Pin (FR-020).
 *
 * Pins the political guarantee that Profile A (Local Operator / Single-User)
 * remains zero-ceremony and unchanged:
 * 1. Bare SDK single-mode scripts (e.g. createSeepient with no runtime) work cleanly.
 * 2. Host keys and dotfiles remain accessible in single mode.
 * 3. CLI runtime flags resolve single-mode defaults.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSeepient } from "../transport/sdk/seepient.js";
import { resolveTenancyMode } from "../domain/tenancy/tenancy-mode.js";
import { resolveRuntimeFlags } from "../transport/cli/bootstrap.js";

describe("J11 Profile A Smoke Pin (FR-020)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("default tenancy resolves to single when no options are provided", () => {
    const resolved = resolveTenancyMode({});
    expect(resolved.mode).toBe("single");
  });

  it("bare SDK single-mode createSeepient works ceremony-free without explicit runtime injection", async () => {
    const agent = await createSeepient({
      tenancy: "single",
    });

    expect(agent).toBeDefined();
    expect(typeof agent.chat).toBe("function");
    expect(typeof agent.listProviders).toBe("function");
  });

  it("CLI runtime flags resolve edit-enabled consent default in local mode", () => {
    const flags = resolveRuntimeFlags({});
    expect(flags.autoConfirm).toBe(false);
    expect(flags.consentMode).toBe("edit-enabled");
  });

  it("Profile A ambient provider runtime is not isolated and reads host configuration", async () => {
    const { createAmbientProviderRuntime } = await import("../domain/providers/provider-runtime.js");
    const runtime = createAmbientProviderRuntime();
    expect(runtime.isIsolated).toBe(false);
    expect(typeof runtime.createTurnSnapshot).toBe("function");
    expect(typeof runtime.resolvePlan).toBe("function");
  });

  it("bare SDK single-mode defaults work with createSeepient without any arguments", async () => {
    const agent = await createSeepient();
    expect(agent).toBeDefined();
    expect(typeof agent.chat).toBe("function");
  });
});

