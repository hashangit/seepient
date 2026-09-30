/**
 * US0 red gates (022-5-WO4 T003, pass-14 P1-1/P1-2 + P2-1).
 *
 * The SDK multi plane must refuse an unstamped injected runtime (D1) and
 * enforce the write-side egress assert on a stamped one. Pass-14 live-probed
 * the chain on the documented embed shape: accepted → plant 200 → refresh →
 * the operator's stored key on the attacker sink, no EGRESS_REQUIRED.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSeepient } from "../index.js";
import { ProviderRuntime } from "../../../domain/providers/provider-runtime.js";
import { ProviderConfigStore } from "../../../domain/providers/config-store/provider-config-store.js";
import { MemoryCredentialStore } from "../../../domain/providers/credentials/memory-credential-store.js";
import { AggregateInferenceAdapter } from "../../../capabilities/inference/aggregate-adapter.js";

describe("SDK multi plane arming (022-5-WO4 T003)", () => {
  let dir: string;
  const fetchSpy = vi.spyOn(globalThis, "fetch");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seepient-sdk-arm-"));
    fetchSpy.mockClear();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function unstampedRuntime(): ProviderRuntime {
    const configStore = new ProviderConfigStore(":memory:");
    const creds = new MemoryCredentialStore();
    return new ProviderRuntime({
      configStore,
      credentialStore: creds,
      adapter: new AggregateInferenceAdapter(undefined, undefined, creds),
    });
  }

  async function completeStores() {
    const { InMemoryAuditStore, InMemoryPolicyStore, InMemoryCapabilityLedger } = await import(
      "../../../domain/permissions/in-memory-stores.js"
    );
    return {
      auditStore: new InMemoryAuditStore(),
      policyStore: new InMemoryPolicyStore(),
      capabilityLedger: new InMemoryCapabilityLedger(),
    };
  }

  it("createSeepient multi with an unstamped injected runtime is refused (D1)", async () => {
    const extra = await completeStores();
    await expect(
      createSeepient({
        tenancy: "multi",
        cwd: "/tmp/tenant-t1",
        principalId: "tenant-t1",
        runtime: unstampedRuntime(),
        ...extra,
        stateless: true,
      } as never),
    ).rejects.toThrow(/TENANCY/i);
  });

  it("the documented embed shape (stamped runtime + operatorBaseline) denies planting and refresh to an ungranted host", async () => {
    const attackerHits: string[] = [];
    const attackerSink = createServer((req, res) => {
      attackerHits.push(String(req.headers.authorization ?? ""));
      res.writeHead(500);
      res.end("{}");
    });
    await new Promise<void>((r) => attackerSink.listen(0, "127.0.0.1", r));
    const attackerPort = (attackerSink.address() as { port: number }).port;

    const configStore = new ProviderConfigStore(":memory:");
    await configStore.updateOverlay(
      {
        providers: {
          "operator-acct": {
            adapter: "pi-ai",
            upstreamProvider: "openai",
            baseUrl: "http://operator.example/v1",
            credential: { kind: "seepient", id: "operator-acct" },
          } as never,
        },
        modelAssignments: {},
      },
      0,
    );
    const creds = new MemoryCredentialStore();
    await creds.put("operator-acct", { kind: "api_key", keyValue: "sk-operator-real-key" });
    const stamped = new ProviderRuntime({
      configStore,
      credentialStore: creds,
      adapter: new AggregateInferenceAdapter(undefined, undefined, creds),
      tenancyMode: "multi",
    });

    const extra = await completeStores();
    const agent = await createSeepient({
      tenancy: "multi",
      cwd: "/tmp/tenant-t2",
      principalId: "tenant-t2",
      runtime: stamped,
      ...extra,
      operatorBaseline: [{ kind: "network-destination", scheme: "http", host: "operator.example" }] as never,
      stateless: true,
    } as never);

    const res = await (agent as unknown as {
      addProvider: (input: unknown) => Promise<{ ok: boolean; error?: { code?: string; message?: string } }>;
    }).addProvider({
      accountId: "operator-acct",
      upstreamProvider: "openai",
      baseUrl: `http://127.0.0.1:${attackerPort}/v1`,
      allowPrivate: true,
      credential: { mode: "preserve" },
    } as never);
    expect(res.ok, `planting must deny: ${JSON.stringify(res.error ?? {})}`).toBe(false);
    expect(JSON.stringify(res.error ?? {})).toMatch(/EGRESS_REQUIRED|egress/i);

    await agent.dispose();
    const attackerFetches = fetchSpy.mock.calls.filter((u) => String(u[0]).includes(`:${attackerPort}`));
    expect(attackerFetches.length).toBe(0);
    expect(attackerHits).toHaveLength(0);
    attackerSink.close();
  });
});
