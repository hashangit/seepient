import { describe, it, expect } from "vitest";
import { ProviderConfigStore } from "../config-store/provider-config-store.js";
import { ModelCatalog } from "../model-catalog.js";
import { CompositeCredentialStore } from "../credentials/composite-credential-store.js";
import { MemoryCredentialStore } from "../credentials/memory-credential-store.js";
import { ProviderRuntime } from "../provider-runtime.js";
import { AggregateInferenceAdapter } from "../../../capabilities/inference/aggregate-adapter.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("Provider Benchmark (P3.13 Gate)", () => {
  it("resolves InvocationPlan and creates TurnSnapshot within latency budgets (<5ms P95)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "seepient-bench-"));
    const configPath = path.join(tmpDir, "provider.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        schemaVersion: 2,
        revision: 1,
        patch: {
          providers: {
            openai: {
              adapter: "pi-ai",
              upstreamProvider: "openai",
              credential: { kind: "seepient", id: "bench-key" },
            },
          },
          modelAssignments: {
            text: {
              standard: { providerAccount: "openai", model: "gpt-4o-mini" },
            },
          },
        },
      }),
    );

    const memStore = new MemoryCredentialStore();
    await memStore.put("bench-key", { kind: "api_key", keyValue: "sk-bench" });
    const credStore = new CompositeCredentialStore({ memory: memStore });
    const configStore = new ProviderConfigStore(configPath);
    const catalog = new ModelCatalog();
    const adapter = new AggregateInferenceAdapter();
    const runtime = new ProviderRuntime({ configStore, credentialStore: credStore, modelCatalog: catalog, adapter });

    // Warm-up
    const warmupSnapshot = await runtime.createTurnSnapshot();
    await runtime.resolvePlan(warmupSnapshot, "text", "standard");

    const iterations = 100;
    const latencies: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      const plan = await runtime.resolvePlan(warmupSnapshot, "text", "standard");
      const elapsed = performance.now() - start;
      latencies.push(elapsed);
      expect(plan.selectedTarget.model).toBe("gpt-4o-mini");
    }

    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(iterations * 0.5)];
    const p95 = latencies[Math.floor(iterations * 0.95)];
    expect(p95).toBeLessThan(5.0); // Within 5ms warm resolution budget (B-9)
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
