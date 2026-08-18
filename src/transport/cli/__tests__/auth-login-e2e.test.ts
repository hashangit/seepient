import { describe, it, expect } from "vitest";
import { MemoryCredentialStore } from "../../../domain/providers/credentials/memory-credential-store.js";
import { ProviderConfigStore } from "../../../domain/providers/config-store/provider-config-store.js";
import { ProviderRuntime } from "../../../domain/providers/provider-runtime.js";

describe("Auth Login & Credential Resolution E2E", () => {
  it("stores credential in CredentialStore and links provider overlay with seepient id", async () => {
    const credStore = new MemoryCredentialStore();
    const configStore = new ProviderConfigStore(":memory:");

    const providerId = "openai";
    const apiKey = "sk-live-secret-test-key";

    // 1. Simulating auth login
    await credStore.put(
      providerId,
      { kind: "api_key", keyValue: apiKey },
      { source: "disk" },
    );

    await configStore.updateOverlay(
      {
        providers: {
          [providerId]: {
            adapter: "pi-ai",
            upstreamProvider: providerId,
            credential: { kind: "seepient", id: providerId },
          },
        },
        modelAssignments: {
          text: {
            standard: { providerAccount: providerId, model: "gpt-4o" },
          },
        },
      },
      0,
    );

    // 2. Runtime resolving plan and credential
    const runtime = new ProviderRuntime({
      configStore,
      credentialStore: credStore,
      adapter: {
        id: "test-adapter",
        async bind() {
          return { language: { async *stream() {} } } as any;
        },
      },
    });

    const snapshot = await runtime.createTurnSnapshot();
    const plan = await runtime.resolvePlan(snapshot, "text", "standard");

    expect(plan.selectedTarget.providerAccount).toBe("openai");
    expect(plan.selectedTarget.credential.ref).toEqual({
      kind: "seepient",
      id: "openai",
    });

    const lease = plan.selectedTarget.credential.acquireLease();
    const secret = await lease.secret();
    expect(secret.kind).toBe("api_key");
    if (secret.kind === "api_key") {
      expect(secret.value).toBe(apiKey);
    }
    await lease.release();
  });
});
