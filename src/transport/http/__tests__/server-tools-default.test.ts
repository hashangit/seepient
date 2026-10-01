/**
 * T040: SERVER-TOOLS-DEFAULT gate (FR-027)
 *
 * Verifies that on a multi-tenant server:
 * - With `tools` omitted, zero tool definitions are passed to the model context.
 * - With explicit `builtInTools: true`, built-in tool definitions are present.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { runSeepientServer } from "../index.js";
import { generateApiKey } from "../../auth/auth.js";
import { createFakeRuntime } from "../../sdk/__tests__/helpers/fake-stores.js";

describe("T040: SERVER-TOOLS-DEFAULT Gate (FR-027)", () => {
  let tempKeyPath: string;
  let tempDir: string;
  let activeServers: Array<http.Server & { dispose?: () => void }> = [];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "seepient-tools-default-"));
    tempKeyPath = path.join(tempDir, "keys.json");
  });

  afterEach(async () => {
    for (const s of activeServers) {
      if (s.dispose) s.dispose();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    activeServers = [];
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("omitting tools on multi server passes zero tool definitions to model context", async () => {
    let capturedTools: any[] | undefined;
    const fakeRuntime = createFakeRuntime({
      responses: (req: any) => {
        capturedTools = req.tools;
        return { text: "Hello from server" };
      },
    });

    const keyEntry = generateApiKey(["agent:run"], { filePath: tempKeyPath, label: "tenant" });
    const server = await runSeepientServer({
      port: 0,
      apiKeysFile: tempKeyPath,
      runtime: fakeRuntime as any,
    });
    activeServers.push(server);
    const addr = server.address() as any;

    const res = await fetch(`http://127.0.0.1:${addr.port}/v1/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${keyEntry.rawKey}`,
      },
      body: JSON.stringify({
        message: "hello",
      }),
    });

    expect(res.status).toBe(200);
    expect(capturedTools).toBeDefined();
    expect(capturedTools).toHaveLength(0);
  });

  it("explicit operator opt-in builtInTools: true includes built-in tools", async () => {
    let capturedTools: any[] | undefined;
    const fakeRuntime = createFakeRuntime({
      responses: (req: any) => {
        capturedTools = req.tools;
        return { text: "Hello with tools" };
      },
    });

    const keyEntry = generateApiKey(["agent:run"], { filePath: tempKeyPath, label: "tenant" });
    const server = await runSeepientServer({
      port: 0,
      apiKeysFile: tempKeyPath,
      runtime: fakeRuntime as any,
      builtInTools: true,
    });
    activeServers.push(server);
    const addr = server.address() as any;

    const res = await fetch(`http://127.0.0.1:${addr.port}/v1/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${keyEntry.rawKey}`,
      },
      body: JSON.stringify({
        message: "hello with tools",
      }),
    });

    expect(res.status).toBe(200);
    expect(capturedTools).toBeDefined();
    expect(capturedTools!.length).toBeGreaterThan(0);
  });
});
