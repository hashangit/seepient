/**
 * US0 red gates (022-5-WO1 T007/T008): credential tripwire completion.
 * T007 — refreshModels in multi must assert the account baseUrl against
 * granted capabilities before discovery (parity with the wrapper seams) and
 * surface errors on a recorded channel, not console-only. T008 — every
 * vendored pi-ai import site must carry the FR-007 gate, discovered by
 * source scan (a fixed file list cannot see a new unarmed producer).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderConfigStore } from "../config-store/provider-config-store.js";
import { MemoryCredentialStore } from "../credentials/memory-credential-store.js";
import { ProviderRuntime } from "../provider-runtime.js";
import { AggregateInferenceAdapter } from "../../../capabilities/inference/aggregate-adapter.js";

describe("refreshModels multi parity (022-5-WO1 T007)", () => {
  const originalEnv = process.env;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env = { ...originalEnv, OPENAI_API_KEY: "sk-DECOY-host-key" };
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    process.env = originalEnv;
    fetchSpy.mockRestore();
    vi.restoreAllMocks();
  });

  async function multiRuntime(baseUrl: string | undefined, credential: Record<string, unknown>): Promise<ProviderRuntime> {
    const configStore = new ProviderConfigStore(":memory:");
    await configStore.updateOverlay(
      {
        providers: {
          "attacker-acct": {
            adapter: "pi-ai",
            upstreamProvider: "openai",
            ...(baseUrl ? { baseUrl } : {}),
            credential,
          } as never,
        },
        modelAssignments: {},
      },
      0,
    );
    const creds = new MemoryCredentialStore();
    return new ProviderRuntime({ configStore, credentialStore: creds, adapter: new AggregateInferenceAdapter() });
  }

  it("denies typed with zero outbound fetches when the attacker baseUrl has no network-destination grant", async () => {
    const runtime = await multiRuntime("https://attacker.example.com/v1", { kind: "none" });
    await expect(runtime.refreshModels("attacker-acct")).rejects.toThrow(/EGRESS_REQUIRED|network-destination/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a valueless api_key denies CREDENTIAL_REQUIRED before any vendor call", async () => {
    const runtime = await multiRuntime("https://api.openai.com/v1", { kind: "api_key", keyValue: "" });
    await expect(runtime.refreshModels("attacker-acct")).rejects.toThrow(/CREDENTIAL_REQUIRED/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("discovery errors land on a recorded surface, not console.error alone", async () => {
    const runtime = await multiRuntime("http://127.0.0.1:9/v1", { kind: "none" });
    const recorded: unknown[] = [];
    // The recorded surface does not exist today — this is the red assertion.
    const anyRuntime = runtime as unknown as { onDiscoveryError?: (cb: (err: unknown) => void) => void };
    expect(typeof anyRuntime.onDiscoveryError).toBe("function");
    anyRuntime.onDiscoveryError!((err: unknown) => recorded.push(err));
    await runtime.refreshModels("attacker-acct").catch(() => {});
    expect(recorded.length).toBeGreaterThan(0);
  });
});

describe("producer source-scan tripwire (022-5-WO1 T008)", () => {
  const fixtureDir = join(process.cwd(), "src/vendors/pi-ai");
  const fixturePath = join(fixtureDir, "__scan-fixture__.ts");

  afterEach(() => {
    if (existsSync(fixturePath)) rmSync(fixturePath);
  });

  it("flags a throwaway unarmed vendored-import fixture", async () => {
    // A new producer that imports the vendored library and constructs a
    // client without the FR-007 gate — exactly the shape the scan must catch.
    writeFileSync(
      fixturePath,
      `// throwaway scan fixture (022-5-WO1 T008)
import { stream } from "@earendil-works/pi-ai";
export async function unarmedStream(model: unknown, ctx: unknown) {
  return stream(model as never, ctx as never, { apiKey: undefined });
}
`,
    );
    const { scanVendoredProducerSites } = await import("./producer-scan.js");
    const flagged = scanVendoredProducerSites();
    expect(flagged).toContain("src/vendors/pi-ai/__scan-fixture__.ts");
  });
});
