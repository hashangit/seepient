/**
 * Embedding safety suite (021-4 W130/W131).
 *
 * W130 — `runSeepientServer` must not hijack the host process: signal
 * handlers are registered only when the server listens, and the returned
 * server carries a `dispose()` handle that un-registers them.
 *
 * W131 — the WebSocket layer is per-instance: two servers in one process
 * get independent WSS + registries, and closing one must not break the
 * other's WS chat.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
// @ts-expect-error — ws is an optional peer dependency without bundled types
import { WebSocket as WsClient } from "ws";
import { runSeepientServer } from "../index.js";
import { generateApiKey } from "../../auth/auth.js";
import { MemoryPersistenceBackend } from "../../../domain/sessions/session-store.js";
import {
  FakeAuditStore,
  FakePolicyStore,
  FakeCapabilityLedger,
  createFakeRuntime,
} from "../../sdk/__tests__/helpers/fake-stores.js";

type DisposableServer = http.Server & { dispose?: () => void };

const servers: DisposableServer[] = [];
const tempFiles: string[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.dispose?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  for (const f of tempFiles.splice(0)) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

function makeKeysFile(): string {
  const p = path.join(
    os.tmpdir(),
    `seepient-embed-keys-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  tempFiles.push(p);
  process.env.SEEPIENT_API_KEYS_FILE = p;
  return generateApiKey(["agent:run"], { filePath: p }).rawKey!;
}

function listenPort(server: http.Server): number {
  return (server.address() as { port: number }).port;
}

/** Open a WS chat and resolve with the accumulated assistant text. */
function wsChat(port: number, rawKey: string, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(`ws://127.0.0.1:${port}/ws`, {
      headers: { authorization: `Bearer ${rawKey}` },
    });
    let text = "";
    ws.on("message", (data: Buffer) => {
      let msg: { type: string; delta?: string; code?: string; message?: string };
      try {
        msg = JSON.parse(data.toString("utf-8"));
      } catch {
        return;
      }
      if (msg.type === "text" && typeof msg.delta === "string") text += msg.delta;
      if (msg.type === "done") {
        ws.close();
        resolve(text);
      }
      if (msg.type === "error") {
        ws.close();
        reject(new Error(`${msg.code}: ${msg.message}`));
      }
    });
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "chat", id: "m1", message }));
    });
    ws.on("error", reject);
  });
}

/** Server options shared by the multi-server tests (disk-free, listening). */
function embeddedServerOptions(runtime: ReturnType<typeof createFakeRuntime>) {
  return {
    port: 0,
    host: "127.0.0.1",
    cors: false,
    persist: new MemoryPersistenceBackend(),
    runtime,
    auditStore: new FakeAuditStore(),
    policyStore: new FakePolicyStore(),
    capabilityLedger: new FakeCapabilityLedger(),
  } as const;
}

describe("W130 — runSeepientServer signal-handler hygiene", () => {
  it("listen:false registers no SIGINT/SIGTERM handlers", async () => {
    const beforeSigint = process.listenerCount("SIGINT");
    const beforeSigterm = process.listenerCount("SIGTERM");

    const server = await runSeepientServer({ listen: false });
    servers.push(server);

    expect(process.listenerCount("SIGINT")).toBe(beforeSigint);
    expect(process.listenerCount("SIGTERM")).toBe(beforeSigterm);
  });

  it("a listening server registers handlers and dispose() removes them", async () => {
    makeKeysFile();
    const beforeSigint = process.listenerCount("SIGINT");
    const beforeSigterm = process.listenerCount("SIGTERM");

    const server = await runSeepientServer(
      embeddedServerOptions(createFakeRuntime({ responses: [{ text: "unused" }] })),
    );
    servers.push(server);
    expect(listenPort(server)).toBeGreaterThan(0);

    expect(process.listenerCount("SIGINT")).toBe(beforeSigint + 1);
    expect(process.listenerCount("SIGTERM")).toBe(beforeSigterm + 1);

    server.dispose();
    expect(process.listenerCount("SIGINT")).toBe(beforeSigint);
    expect(process.listenerCount("SIGTERM")).toBe(beforeSigterm);
  });
});

describe("W131 — multiple servers per process", () => {
  it("closing one server leaves another server's WS chat working", async () => {
    const rawKey = makeKeysFile();
    const runtime = createFakeRuntime({
      responses: [{ text: "hello from mock" }, { text: "hello from mock" }],
    });

    const a = await runSeepientServer(embeddedServerOptions(runtime));
    const b = await runSeepientServer(embeddedServerOptions(runtime));
    servers.push(a, b);

    // Independent ports — two real servers are listening
    expect(listenPort(a)).not.toBe(listenPort(b));

    // Chat on A works before B is closed
    const textBefore = await wsChat(listenPort(a), rawKey, "ping one");
    expect(textBefore).toBe("hello from mock");

    // Close B entirely (its dispose + close must not touch A's WS layer)
    b.dispose();
    await new Promise<void>((resolve) => b.close(() => resolve()));
    const idx = servers.indexOf(b);
    if (idx >= 0) servers.splice(idx, 1);

    // A still accepts a fresh WS connection and completes a chat
    const textAfter = await wsChat(listenPort(a), rawKey, "ping two");
    expect(textAfter).toBe("hello from mock");
  });

  it("a second server's close event does not terminate the first server's connections", async () => {
    const rawKey = makeKeysFile();
    const runtime = createFakeRuntime({
      responses: [{ text: "still alive" }, { text: "still alive" }],
    });

    const a = await runSeepientServer(embeddedServerOptions(runtime));
    const b = await runSeepientServer(embeddedServerOptions(runtime));
    servers.push(a, b);

    // Hold an open WS connection on A while B shuts down
    const ws = new WsClient(`ws://127.0.0.1:${listenPort(a)}/ws`, {
      headers: { authorization: `Bearer ${rawKey}` },
    });
    const opened = new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    await opened;

    b.dispose();
    await new Promise<void>((resolve) => b.close(() => resolve()));
    const idx = servers.indexOf(b);
    if (idx >= 0) servers.splice(idx, 1);

    // Give any erroneous cross-server close a beat to surface
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Chat on the same open connection still completes
    const reply = await new Promise<string>((resolve, reject) => {
      let text = "";
      ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString("utf-8"));
        if (msg.type === "text") text += msg.delta;
        if (msg.type === "done") resolve(text);
        if (msg.type === "error") reject(new Error(`${msg.code}: ${msg.message}`));
      });
      ws.send(JSON.stringify({ type: "chat", id: "m2", message: "ping" }));
    });
    expect(reply).toBe("still alive");

    // The connection is still ours to close — not killed by B's shutdown
    const closeEvent = await new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on("close", (code: number, reason: Buffer) => {
        resolve({ code, reason: reason.toString() });
      });
      ws.close();
    });
    expect(closeEvent.code).not.toBe(1001); // not a server-shutdown close
  });
});
