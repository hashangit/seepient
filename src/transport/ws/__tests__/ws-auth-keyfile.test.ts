/**
 * T034: WS-AUTH-SPLIT gate (FR-020)
 *
 * Verifies that when runSeepientServer is booted with an injected apiKeysFile:
 * - delete process.env.SEEPIENT_API_KEYS_FILE
 * - Write an ambient key into sandboxed HOME ~/.seepient/server-keys.json
 * - Write an injected key into the custom apiKeysFile
 * - Injected key authenticates successfully on both REST (200) and WS (101)
 * - Ambient-only key gets 401 on REST and upgrade rejection on WS
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
// @ts-expect-error — ws is an optional peer dependency without bundled types
import WebSocket from "ws";
import { runSeepientServer } from "../../http/index.js";
import { generateApiKey } from "../../auth/auth.js";

describe("T034: WS-AUTH-SPLIT Gate (FR-020)", () => {
  let tempHome: string;
  let customKeysDir: string;
  let customKeysPath: string;
  let ambientKeysPath: string;
  let originalHome: string;
  let originalEnvKeyFile: string | undefined;
  let activeServer: (http.Server & { dispose?: () => void }) | null = null;
  let serverPort = 0;

  let injectedKey: string;
  let ambientKey: string;

  beforeEach(async () => {
    originalHome = process.env.HOME || os.homedir();
    originalEnvKeyFile = process.env.SEEPIENT_API_KEYS_FILE;
    delete process.env.SEEPIENT_API_KEYS_FILE;

    // Sandbox HOME
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "seepient-home-sandbox-"));
    process.env.HOME = tempHome;

    const ambientSeepientDir = path.join(tempHome, ".seepient");
    fs.mkdirSync(ambientSeepientDir, { recursive: true });
    ambientKeysPath = path.join(ambientSeepientDir, "server-keys.json");

    // Custom keys directory outside HOME
    customKeysDir = fs.mkdtempSync(path.join(os.tmpdir(), "seepient-custom-keys-"));
    customKeysPath = path.join(customKeysDir, "injected-keys.json");

    // Generate injected key
    const injectedEntry = generateApiKey(["agent:run", "agent:read"], {
      filePath: customKeysPath,
      label: "injected-tenant-key",
    });
    injectedKey = injectedEntry.rawKey!;

    // Generate ambient key
    const ambientEntry = generateApiKey(["agent:run", "agent:read"], {
      filePath: ambientKeysPath,
      label: "ambient-operator-key",
    });
    ambientKey = ambientEntry.rawKey!;

    // Boot server with injected apiKeysFile
    activeServer = await runSeepientServer({
      port: 0,
      apiKeysFile: customKeysPath,
    });
    const addr = activeServer.address() as any;
    serverPort = addr.port;
  });

  afterEach(async () => {
    if (activeServer) {
      if (activeServer.dispose) activeServer.dispose();
      await new Promise<void>((resolve) => activeServer!.close(() => resolve()));
      activeServer = null;
    }
    process.env.HOME = originalHome;
    if (originalEnvKeyFile !== undefined) {
      process.env.SEEPIENT_API_KEYS_FILE = originalEnvKeyFile;
    } else {
      delete process.env.SEEPIENT_API_KEYS_FILE;
    }
    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    if (fs.existsSync(customKeysDir)) {
      fs.rmSync(customKeysDir, { recursive: true, force: true });
    }
  });

  it("injected key authenticates on REST and WS; ambient key is rejected on both", async () => {
    // 1. REST with injected key -> 200 OK
    const injectedRestRes = await fetch(`http://127.0.0.1:${serverPort}/v1/settings`, {
      headers: { authorization: `Bearer ${injectedKey}` },
    });
    expect(injectedRestRes.status).toBe(200);

    // 2. REST with ambient key -> 401 Unauthorized
    const ambientRestRes = await fetch(`http://127.0.0.1:${serverPort}/v1/settings`, {
      headers: { authorization: `Bearer ${ambientKey}` },
    });
    expect(ambientRestRes.status).toBe(401);

    // 3. WS with injected key -> 101 Switching Protocols
    const injectedWs = new WebSocket(`ws://127.0.0.1:${serverPort}/ws`, {
      headers: {
        authorization: `Bearer ${injectedKey}`,
      },
    });
    await new Promise<void>((resolve, reject) => {
      injectedWs.on("open", () => {
        injectedWs.close();
        resolve();
      });
      injectedWs.on("error", (err: any) => {
        reject(err);
      });
    });

    // 4. WS with ambient key -> rejected with 401
    const ambientWs = new WebSocket(`ws://127.0.0.1:${serverPort}/ws`, {
      headers: {
        authorization: `Bearer ${ambientKey}`,
      },
    });
    const wsError = await new Promise<any>((resolve) => {
      ambientWs.on("open", () => {
        ambientWs.close();
        resolve(null);
      });
      ambientWs.on("error", (err: any) => {
        resolve(err);
      });
    });

    expect(wsError).toBeDefined();
    expect(wsError.message).toMatch(/401/);
  });
});
