/**
 * US0 red gate (022-5-WO3 T002, pass-13 P1-1): the injected-runtime embed
 * path must be multi-ARMED. Pass-13 live-probed the chain on a single-
 * stamped injected runtime: provider:admin → PUT attacker baseUrl with
 * credential preserve → 200 → refresh-models → 200 → the attacker sink
 * received Bearer sk-operator-real, no EGRESS_REQUIRED. Product contract
 * (WO3 D2): an unstamped injected runtime is REFUSED on a multi server;
 * a properly stamped one enforces the same write-side egress assert as the
 * boot-composed roots.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSeepientServer } from "../../http/index.js";
import { ProviderRuntime } from "../../../domain/providers/provider-runtime.js";
import { ProviderConfigStore } from "../../../domain/providers/config-store/provider-config-store.js";
import { MemoryCredentialStore } from "../../../domain/providers/credentials/memory-credential-store.js";
import { AggregateInferenceAdapter } from "../../../capabilities/inference/aggregate-adapter.js";
import { generateApiKey } from "../../../transport/auth/auth.js";

describe("injected-runtime multi arming (022-5-WO3 T002)", () => {
  let dir: string;
  let server: Server | null = null;
  const realFetch = globalThis.fetch; // captured BEFORE the spy — the passthrough target
  const fetchSpy = vi.spyOn(globalThis, "fetch");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seepient-inject-arm-"));
    fetchSpy.mockClear();
  });
  afterEach(() => {
    server?.close();
    server = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it("a single-stamped injected runtime is refused on a multi server", async () => {
    // Exactly the runtime createSeepient's own multi branch builds (WO2's
    // miss): isolated stores, no tenancyMode.
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
    const unstamped = new ProviderRuntime({ configStore, credentialStore: creds, adapter: new AggregateInferenceAdapter() });

    const keysFile = join(dir, "server-keys.json");
    const adminKey = generateApiKey(["provider:admin", "admin"], { filePath: keysFile });
    process.env.SEEPIENT_API_KEYS_FILE = keysFile;

    await expect(
      runSeepientServer({ port: 0, host: "127.0.0.1", runtime: unstamped }),
    ).rejects.toThrow(/TENANCY|multi/i);
  });

  it("a multi-stamped injected runtime enforces the write-side egress assert", async () => {
    const attackerHits: string[] = [];
    const attackerSink = createServer((req, res) => {
      attackerHits.push(String(req.headers.authorization ?? ""));
      res.writeHead(500);
      res.end("{}");
    });
    await new Promise<void>((r) => attackerSink.listen(0, "127.0.0.1", r));
    const attackerPort = (attackerSink.address() as { port: number }).port;

    // Pass-15 fix (WO4 T017 claim): the spy used to call through, so the
    // refresh leg dialed operator.example for real. Loopback traffic (the
    // local server + attacker sink) still goes to the wire; everything else
    // gets a stub response — no external DNS from this suite.
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input);
      if (u.includes("operator.example")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return realFetch(input, init);
    });

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
    // Properly stamped embedder runtime: multi, with its granted baseline.
    const stamped = new ProviderRuntime({
      configStore,
      credentialStore: creds,
      adapter: new AggregateInferenceAdapter(),
      tenancyMode: "multi",
      capabilities: [{ kind: "network-destination", scheme: "http", host: "operator.example" }] as never,
    });

    const keysFile = join(dir, "server-keys.json");
    const adminKey = generateApiKey(["provider:admin", "admin"], { filePath: keysFile });
    process.env.SEEPIENT_API_KEYS_FILE = keysFile;

    server = await runSeepientServer({ port: 0, host: "127.0.0.1", runtime: stamped });
    const addr = server.address() as { port: number };
    const base = `http://127.0.0.1:${addr.port}`;
    const auth = { "content-type": "application/json", authorization: `Bearer ${adminKey.rawKey}` };

    // The plant: rewrite to the attacker sink, preserving the stored key.
    const current = (await (await fetch(`${base}/v1/providers/operator-acct`, { headers: auth })).json()) as { revision?: number };
    const putRes = await fetch(`${base}/v1/providers/operator-acct`, {
      method: "PUT",
      headers: { ...auth, "if-match": String(current.revision ?? 1) },
      body: JSON.stringify({
        adapter: "pi-ai",
        upstreamProvider: "openai",
        baseUrl: `http://127.0.0.1:${attackerPort}/v1`,
        allowPrivate: true,
        credential: { mode: "preserve" },
      }),
    });
    expect(putRes.status, "the plant must be denied on the stamped runtime too").toBe(400);

    // The refresh leg: the planted attacker baseUrl never landed (the plant
    // was denied above), and the account's own operator.example refresh is
    // asserted rather than fire-and-forgotten. On this fixture the baseline
    // GRANTS operator.example, so the egress assert passes and the refresh
    // dies at endpoint validation (the fake domain does not resolve) — a
    // deterministic 400. The load-bearing properties: the assert did not
    // block the granted host, and the attacker sink/URLs received nothing.
    const refreshRes = await fetch(`${base}/v1/providers/operator-acct/refresh-models`, { method: "POST", headers: auth });
    expect(refreshRes.status).toBe(400);
    expect(attackerHits.filter((a) => a.includes("sk-operator-real-key"))).toHaveLength(0);
    const attackerFetches = fetchSpy.mock.calls.filter((u) => String(u[0]).includes(`:${attackerPort}`));
    expect(attackerFetches.length).toBe(0);
    attackerSink.close();
  });
});
