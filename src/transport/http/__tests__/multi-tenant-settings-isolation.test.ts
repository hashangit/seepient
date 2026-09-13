import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { runSeepientServer } from "../index.js";
import { generateApiKey } from "../../auth/auth.js";

describe("NEW-1 Multi-Tenant Server Settings Isolation", () => {
  let activeServers: Array<http.Server & { dispose?: () => void }> = [];
  let tempKeyPath: string;
  let tempDir: string;
  let originalCwd: string;
  let originalDefaultModel: string | undefined;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalDefaultModel = process.env.SEEPIENT_DEFAULT_MODEL;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "seepient-settings-iso-"));
    process.chdir(tempDir);

    tempKeyPath = path.join(
      tempDir,
      `test-keys-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    process.env.SEEPIENT_API_KEYS_FILE = tempKeyPath;
    process.env.SEEPIENT_DEFAULT_MODEL = "host-operator-secret-model";
  });

  afterEach(async () => {
    if (originalDefaultModel !== undefined) {
      process.env.SEEPIENT_DEFAULT_MODEL = originalDefaultModel;
    } else {
      delete process.env.SEEPIENT_DEFAULT_MODEL;
    }
    process.chdir(originalCwd);
    for (const s of activeServers) {
      if (s.dispose) s.dispose();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    activeServers = [];
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("GET /v1/settings in multi-tenant mode returns only allowlisted server settings and no host env origins", async () => {
    const keyEntry = generateApiKey(["agent:read"], { filePath: tempKeyPath, label: "tenant-read" });
    const server = await runSeepientServer({ port: 0, apiKeysFile: tempKeyPath });
    activeServers.push(server);
    const addr = server.address() as any;
    const port = addr.port;

    const res = await fetch(`http://127.0.0.1:${port}/v1/settings`, {
      headers: { authorization: `Bearer ${keyEntry.rawKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;

    // Must NOT contain ambient categories (general, telemetry, smtp, etc.)
    expect(body.general).toBeUndefined();
    expect(body.smtp).toBeUndefined();
    expect(body.telemetry).toBeUndefined();

    // Must ONLY contain server category
    expect(body.server).toBeDefined();
    expect(Array.isArray(body.server)).toBe(true);

    // All keys in server must be in the allowlist
    const allowlist = new Set(["server.corsOrigins", "server.maxBodyBytes", "server.rateLimitRpm"]);
    for (const entry of body.server) {
      expect(allowlist.has(entry.dotKey)).toBe(true);
      expect(entry.origin).toBe("server");
    }

    // Ensure host-operator-secret-model is nowhere in the response
    const rawJson = JSON.stringify(body);
    expect(rawJson).not.toContain("host-operator-secret-model");
    expect(rawJson).not.toContain("env:");
  });

  it("PATCH /v1/settings in multi-tenant mode rejects non-allowlisted settings with 403 FORBIDDEN", async () => {
    const keyEntry = generateApiKey(["admin"], { filePath: tempKeyPath, label: "tenant-admin" });
    const server = await runSeepientServer({ port: 0, apiKeysFile: tempKeyPath });
    activeServers.push(server);
    const addr = server.address() as any;
    const port = addr.port;

    // Try to modify a non-allowlisted setting
    const res = await fetch(`http://127.0.0.1:${port}/v1/settings`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${keyEntry.rawKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        general: { defaultModel: "malicious-override" },
      }),
    });

    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.error?.code).toBe("FORBIDDEN");
    expect(body.error?.message).toContain("multi-tenant mode");

    // But updating an allowlisted setting succeeds
    const patchRes = await fetch(`http://127.0.0.1:${port}/v1/settings`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${keyEntry.rawKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        server: { rateLimitRpm: 120 },
      }),
    });

    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json() as any;
    expect(patchBody.applied?.server?.rateLimitRpm).toBe(120);
  });
});
