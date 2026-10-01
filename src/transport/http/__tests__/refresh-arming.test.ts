/**
 * US0 red gate (022-5-WO2 T003, pass-12 P1-2): the multi server's composed
 * runtime must be multi-ARMED. The pass-12 chain: provider:admin key → PUT
 * the operator account to an attacker baseUrl (preserve keeps the real key;
 * allowPrivate points it at the attacker's loopback sink) → refresh sends
 * the operator's real Bearer key to that sink with no EGRESS_REQUIRED.
 * Product contract (WO2 D1/D2): on a multi server the operator baseline
 * grants refresh hosts; an ungranted host is denied at the WRITE and the
 * refresh never dials anything ungranted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSeepientServer } from "../../http/index.js";
import { generateApiKey } from "../../../transport/auth/auth.js";

describe("multi server refresh arming (022-5-WO2 T003)", () => {
  let dir: string;
  let server: Server | null = null;
  const fetchSpy = vi.spyOn(globalThis, "fetch");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seepient-refresh-arm-"));
    fetchSpy.mockClear();
  });
  afterEach(() => {
    server?.close();
    server = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it("an ungranted host cannot be planted, and refresh never dials it", async () => {
    // Two loopback sinks: the operator's configured host, and the attacker's.
    const operatorHits: string[] = [];
    const attackerHits: string[] = [];
    const mkSink = (hits: string[]) =>
      createServer((req, res) => {
        hits.push(String(req.headers.authorization ?? ""));
        res.writeHead(500);
        res.end("{}");
      });
    const operatorSink = mkSink(operatorHits);
    const attackerSink = mkSink(attackerHits);
    await new Promise<void>((r) => operatorSink.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => attackerSink.listen(0, "127.0.0.1", r));
    const operatorPort = (operatorSink.address() as { port: number }).port;
    const attackerPort = (attackerSink.address() as { port: number }).port;

    const keysDir = join(dir, "keys");
    mkdirSync(keysDir, { recursive: true });
    const keysFile = join(keysDir, "server-keys.json");
    const adminKey = generateApiKey(["provider:admin", "admin"], { filePath: keysFile });
    process.env.SEEPIENT_API_KEYS_FILE = keysFile;

    const providersFile = join(dir, "providers.json");
    writeFileSync(
      providersFile,
      JSON.stringify({
        providers: {
          "operator-acct": {
            adapter: "pi-ai",
            upstreamProvider: "openai",
            baseUrl: `http://127.0.0.1:${operatorPort}/v1`,
            ssrfAllowPrivate: true,
            credential: { kind: "seepient", id: "operator-acct" },
          },
        },
        credentials: { "operator-acct": { kind: "api_key", keyValue: "sk-operator-real-key" } },
        modelAssignments: {},
      }),
    );

    // D1: the operator baseline grants the operator's host by port. The
    // attacker sink shares the host but not the port — the assert must
    // separate them.
    server = await runSeepientServer({
      port: 0,
      host: "127.0.0.1",
      providersFile,
      operatorBaseline: [
        { kind: "network-destination", scheme: "http", host: "127.0.0.1", port: operatorPort },
      ] as never,
    });
    const addr = server.address() as { port: number };
    const base = `http://127.0.0.1:${addr.port}`;
    const auth = { "content-type": "application/json", authorization: `Bearer ${adminKey.rawKey}` };

    // 0. The operator's own configured host refreshes fine (baseline-granted).
    const okRes = await fetch(`${base}/v1/providers/operator-acct/refresh-models`, { method: "POST", headers: auth });
    expect(okRes.status).toBe(200);
    const preAttacker = fetchSpy.mock.calls.filter((u) => String(u[0]).includes(`:${attackerPort}`));
    expect(preAttacker.length).toBe(0);

    // 1. The pass-12 plant: rewrite to the attacker loopback sink, preserving
    //    the stored key, opting into private addresses.
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
    // D2 write-side deny: an ungranted host cannot be planted at all.
    expect(putRes.status, "PUT planting the attacker host must be denied (D2)").toBe(400);

    // 2. Refresh must never reach the attacker host, whatever the PUT did.
    await fetch(`${base}/v1/providers/operator-acct/refresh-models`, { method: "POST", headers: auth });
    const attackerWires = attackerHits.filter((a) => a.includes("sk-operator-real-key"));
    expect(attackerWires, "the operator's real key must never reach the attacker sink").toHaveLength(0);
    const attackerFetches = fetchSpy.mock.calls.filter((u) => String(u[0]).includes(`:${attackerPort}`));
    expect(attackerFetches.length, "zero outbound fetches to the attacker host").toBe(0);

    operatorSink.close();
    attackerSink.close();
  });
});
