/**
 * Refresh threading through every reachability surface (022-5-WO1 T022).
 *
 * The runtime-level parity (T007) is only real if the typed denial reaches
 * the caller on each surface a user can actually trigger refresh from:
 * the ProviderManagerApi seam (models CLI + TUI dock both call it) and the
 * REST catalog route.
 */
import { describe, it, expect, vi } from "vitest";
import { ProviderConfigStore } from "../config-store/provider-config-store.js";
import { MemoryCredentialStore } from "../credentials/memory-credential-store.js";
import { ProviderRuntime } from "../provider-runtime.js";
import { AggregateInferenceAdapter } from "../../../capabilities/inference/aggregate-adapter.js";
import { createProviderManagerApi } from "../../../transport/cli/provider-manager-api.js";
import type { ApiKeyEntry } from "../../../transport/auth/auth.js";

async function multiRuntimeWithAttackerAccount(): Promise<ProviderRuntime> {
  const configStore = new ProviderConfigStore(":memory:");
  await configStore.updateOverlay(
    {
      providers: {
        "attacker-acct": {
          adapter: "pi-ai",
          upstreamProvider: "openai",
          baseUrl: "https://attacker.example.com/v1",
          credential: { kind: "none" },
        } as never,
      },
      modelAssignments: {},
    },
    0,
  );
  return new ProviderRuntime({ configStore, credentialStore: new MemoryCredentialStore(), adapter: new AggregateInferenceAdapter(), tenancyMode: "multi" });
}

describe("refreshModels threading (022-5-WO1 T022)", () => {
  it("manager-api seam (models CLI + TUI dock): the typed egress denial reaches the RefreshResult", async () => {
    const runtime = await multiRuntimeWithAttackerAccount();
    const api = createProviderManagerApi(runtime);
    const res = await api.refreshModels("attacker-acct");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(JSON.stringify(res.error)).toMatch(/EGRESS_REQUIRED/);
    }
  });

  it("REST catalog route: the typed denial surfaces as a 400 with the egress message", async () => {
    const runtime = await multiRuntimeWithAttackerAccount();
    const { handleRefreshModels } = await import("../../../transport/http/provider-management/catalog.js");
    const calls: { status?: number; body?: string } = {};
    const res = {
      statusCode: 0,
      setHeader: vi.fn(),
      end: vi.fn((body?: string) => {
        calls.status = res.statusCode;
        calls.body = body;
      }),
    } as never;
    const key = { scopes: ["provider:admin"], keyHash: "h" } as unknown as ApiKeyEntry;
    await handleRefreshModels({ method: "POST" } as never, res, runtime, key, "attacker-acct");
    expect(calls.status).toBe(400);
    const body = JSON.parse(calls.body ?? "{}");
    expect(body.error?.message).toMatch(/EGRESS_REQUIRED/);
  });

  it("both interactive surfaces wire refresh through api.refreshModels (wiring pin)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const cli = readFileSync(join(process.cwd(), "src/transport/cli/commands/models-cli.ts"), "utf-8");
    const tui = readFileSync(join(process.cwd(), "src/ui/tui/overlays/model-manager/use-manager-state.ts"), "utf-8");
    expect(cli).toMatch(/api\.refreshModels\(/);
    expect(tui).toMatch(/refreshModels\(/);
  });
});
