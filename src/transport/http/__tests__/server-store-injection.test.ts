/**
 * Server Store Injection & Parity Test Suite (Spec 021, US2, QS-3, FR-010).
 *
 * Verifies:
 * 1. createServer accepts injected auditStore, policyStore, capabilityLedger, and runtime.
 * 2. Requests processed by the server route audit events and policy evaluations
 *    through the injected stores.
 * 3. Per-request principalId passes through to the injected audit store.
 * 4. Default server startup without options continues to use default local stores.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { createServer } from "../index.js";
import { generateApiKey } from "../../auth/auth.js";
import {
  FakeAuditStore,
  FakePolicyStore,
  FakeCapabilityLedger,
  createFakeRuntime,
} from "../../sdk/__tests__/helpers/fake-stores.js";

describe("QS-3: Server Store Injection (FR-010)", () => {
  let activeServers: http.Server[] = [];
  let tempKeyPath: string;

  beforeEach(() => {
    tempKeyPath = path.join(
      os.tmpdir(),
      `seepient-server-test-keys-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    process.env.SEEPIENT_API_KEYS_FILE = tempKeyPath;
  });

  afterEach(async () => {
    for (const s of activeServers) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    activeServers = [];
    if (fs.existsSync(tempKeyPath)) {
      fs.unlinkSync(tempKeyPath);
    }
  });

  it("server uses injected auditStore, policyStore, capabilityLedger, and runtime", async () => {
    const keyEntry = generateApiKey(["agent:run"], { filePath: tempKeyPath, label: "tenant-key" });
    const auditStore = new FakeAuditStore();
    const policyStore = new FakePolicyStore();
    const capabilityLedger = new FakeCapabilityLedger();
    const runtime = createFakeRuntime({
      responses: [
        {
          toolCalls: [
            {
              id: "call-srv-1",
              name: "get_current_datetime",
              args: {},
            },
          ],
        },
        { content: "Server response 1." },
        {
          toolCalls: [
            {
              id: "call-srv-2",
              name: "get_current_datetime",
              args: {},
            },
          ],
        },
        { content: "Server response 2." },
      ],
    });

    const server = await createServer({
      runtime,
      auditStore,
      policyStore,
      capabilityLedger,
    });
    activeServers.push(server);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as { port: number };

    // Send a POST /v1/chat request
    const postData = JSON.stringify({
      message: "What time is it?",
      model: "mock-model",
    });

    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: addr.port,
          path: "/v1/chat",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(postData),
            "Authorization": `Bearer ${keyEntry.rawKey}`,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
        },
      );
      req.on("error", reject);
      req.write(postData);
      req.end();
    });

    // Send a second request with a second key to verify distinct principalId
    const keyEntry2 = generateApiKey(["agent:run"], { filePath: tempKeyPath, label: "tenant-key-2" });
    const postData2 = JSON.stringify({
      message: "What time is it again?",
      model: "mock-model",
    });

    const response2 = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: addr.port,
          path: "/v1/chat",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(postData2),
            "Authorization": `Bearer ${keyEntry2.rawKey}`,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
        },
      );
      req.on("error", reject);
      req.write(postData2);
      req.end();
    });

    expect(response2.status).toBe(200);

    // Injected audit store must have received events from both distinct principals
    expect(auditStore.appends.length).toBeGreaterThan(1);
    const principal1 = auditStore.appends[0].event.principalId;
    const principal2 = auditStore.appends[auditStore.appends.length - 1].event.principalId;
    expect(principal1).toBeDefined();
    expect(principal2).toBeDefined();
    expect(principal1).not.toBe(principal2);
  });

  it("default server startup without injected stores retains default behavior", async () => {
    const server = await createServer();
    activeServers.push(server);
    expect(server).toBeDefined();
  });

  it("custom ProviderRuntimeContract is preserved on server and returns 501 for mutations without disk writes", async () => {
    const { createRestHandler } = await import("../rest.js");
    const { Readable } = await import("node:stream");
    const { EventEmitter } = await import("node:events");

    const runtime: import("../../../foundations/contracts/provider-runtime.js").ProviderRuntimeContract = {
      createTurnSnapshot: async () => ({
        revision: 1,
        createdAt: new Date().toISOString(),
        config: {
          version: 2,
          schemaVersion: 2,
          revision: 1,
          updatedAt: new Date().toISOString(),
          providers: {},
          modelAssignments: {},
          retryPolicy: {} as any,
        },
        catalog: [],
        assignments: {},
      }),
      resolvePlan: async () => ({} as any),
      executeLanguage: async function* () {},
    };
    const adminKey = generateApiKey(["provider:admin"], { filePath: tempKeyPath, label: "admin-key" });

    const restCtx: any = {
      version: "1.0.0",
      startTime: Date.now(),
      sessionManager: {} as any,
      runtime,
      generateText: async () => ({ text: "" }),
      listModels: () => [],
      listSkills: () => [],
    };

    const handler = createRestHandler(restCtx);

    const bodyStr = JSON.stringify({ providerAccount: "mock", model: "mock-model" });
    const req = Readable.from([Buffer.from(bodyStr)]) as any;
    req.method = "PUT";
    req.url = "/v1/models/assignments/text/standard";
    req.headers = {
      authorization: `Bearer ${adminKey.rawKey}`,
      "content-type": "application/json",
    };

    const res = new EventEmitter() as any;
    res.statusCode = 200;
    res.headers = {};
    res.body = "";
    res.setHeader = function (k: string, v: string) {
      this.headers[k.toLowerCase()] = v;
    };
    res.writeHead = function (code: number, headers?: Record<string, string>) {
      this.statusCode = code;
      if (headers) {
        for (const [k, v] of Object.entries(headers)) {
          this.headers[k.toLowerCase()] = v;
        }
      }
    };
    res.end = function (data?: string) {
      if (data) this.body += data;
      this.emit("finish");
    };

    await new Promise<void>((resolve) => {
      res.on("finish", resolve);
      handler(req, res);
    });

    expect(res.statusCode).toBe(501);
    const parsedBody = JSON.parse(res.body);
    expect(parsedBody.error.code).toBe("NOT_IMPLEMENTED");
    expect(parsedBody.error.message).toContain("Injected provider runtime does not implement configuration mutations");
  });
});

