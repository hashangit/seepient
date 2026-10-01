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

  it("Profile A inference runs end-to-end through provider management (022-5-WO1 T026)", async () => {
    // The full first-hour flow: memory overlay + one account + a stored key
    // (the `seepient auth login --key` equivalent store write) + a purpose
    // assignment — then one real inference against a loopback sink.
    const seen: string[] = [];
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      seen.push(String(req.headers.authorization ?? ""));
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "sink" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const { createSeepient } = await import("../transport/sdk/index.js");
      const { MemoryCredentialStore } = await import("../domain/providers/credentials/memory-credential-store.js");
      const store = new MemoryCredentialStore();
      // The auth-login --key equivalent: the key value lands in the store.
      await store.put("smoke-acct", { kind: "api_key", keyValue: "sk-profile-a-smoke-key" });

      const agent = await createSeepient({
        tenancy: "single",
        overlayFile: ":memory:",
        credentials: store,
        providers: {
          "smoke-acct": {
            adapter: "pi-ai",
            upstreamProvider: "openai",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            credential: { kind: "seepient", id: "smoke-acct" },
          } as never,
        },
        modelAssignments: {
          text: { standard: { providerAccount: "smoke-acct", model: "gpt-6-sol" } }, // any catalog-known id; the sink never answers
        } as never,
      } as never);

      // The sink answers 500 — the assertion is what reached the wire.
      await agent.chat("hello profile a").catch(() => {});
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]).toBe("Bearer sk-profile-a-smoke-key");
      await agent.dispose();
    } finally {
      server.close();
    }
  });
});

