/**
 * US0 red gate (022-5-WO3 T003, pass-13 P1-2): the standalone
 * `--providers-file` channel must keep working — the operator's own
 * pre-provisioned custom-endpoint account must refresh successfully. Pass-13
 * live-probed the breakage: WO2's arming gives the boot no capabilities and
 * there is no channel to supply them, so every refresh/mutation on a
 * custom-endpoint account denies EGRESS_REQUIRED on the shipped binary.
 * Product contract (WO3 D1): the operator baseline is DERIVED from the
 * providers file at boot — each configured account's scheme/host/port is
 * granted by construction.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStandaloneServer } from "../../http/standalone.js";
import { generateApiKey } from "../../../transport/auth/auth.js";

describe("standalone operator channel (022-5-WO3 T003)", () => {
  let dir: string;
  let server: Server | null = null;
  const originalArgv = process.argv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seepient-op-baseline-"));
  });
  afterEach(() => {
    process.argv = originalArgv;
    server?.close();
    server = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it("the operator's own pre-provisioned custom-endpoint account refreshes", async () => {
    const operatorHits: string[] = [];
    const operatorSink = createServer((req, res) => {
      operatorHits.push(String(req.headers.authorization ?? ""));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
    });
    await new Promise<void>((r) => operatorSink.listen(0, "127.0.0.1", r));
    const operatorPort = (operatorSink.address() as { port: number }).port;

    const keysFile = join(dir, "server-keys.json");
    const adminKey = generateApiKey(["provider:admin", "admin"], { filePath: keysFile });

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

    process.argv = ["node", "seepient-server", "--providers-file", providersFile];
    process.env.SEEPIENT_API_KEYS_FILE = keysFile;
    process.env.SEEPIENT_PORT = "0";
    // startStandaloneServer composes the options from argv and boots; it
    // returns the running server handle. (Port 0 comes from the env — the
    // CLI parser rejects a literal "0" flag.)
    const result = await startStandaloneServer(process.argv.slice(2));
    server = (result && typeof result === "object" && "server" in result ? result.server : result) as Server;

    const addr = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}/v1/providers/operator-acct/refresh-models`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminKey.rawKey}` },
    });
    expect(res.status, "the operator's own account must refresh (derived baseline)").toBe(200);
    expect(operatorHits.length).toBeGreaterThan(0);
    operatorSink.close();
  });
});
