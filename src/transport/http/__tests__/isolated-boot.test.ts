/**
 * J4 Adversarial Journey — VULN-9: Default server boot on operator ambient runtime.
 *
 * Verifies that running `runSeepientServer` without options in an environment containing
 * host provider API keys (e.g. OPENAI_API_KEY) produces an isolated empty runtime,
 * emits an explicit stderr notice, and fails with a typed error on inference rather
 * than spending the host operator's credentials.
 *
 * SC-003: Server zero-write gate — multi server booted with defaults performs zero writes
 * under $HOME/.seepient and cwd during a chat turn.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runSeepientServer } from "../index.js";
import { createSecurityGuard } from "../../../domain/permissions/__tests__/composition-closure/_guard.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateApiKey } from "../../auth/auth.js";

describe("J4 Isolated Boot Journey (VULN-9)", () => {
  const originalEnv = process.env;
  let runningServer: Server | null = null;
  let stderrOutput = "";
  let guard = createSecurityGuard("VULN-9");

  const originalStderrWrite = process.stderr.write;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.OPENAI_API_KEY = "sk-host-operator-secret-token";
    process.env.ANTHROPIC_API_KEY = "sk-ant-host-operator-secret-token";
    stderrOutput = "";
    guard = createSecurityGuard("VULN-9");

    process.stderr.write = vi.fn().mockImplementation((chunk: any) => {
      const text = String(chunk);
      stderrOutput += text;
      if (/isolated/i.test(text)) {
        guard.recordHit("stderr.bootNotice");
      }
      return true;
    }) as any;
  });

  afterEach(async () => {
    process.stderr.write = originalStderrWrite;
    process.env = originalEnv;
    if (runningServer) {
      await new Promise<void>((resolve) => runningServer!.close(() => resolve()));
      runningServer = null;
    }
  });

  it("runSeepientServer without runtime boots isolated-empty, emits notice, and composes zero ambient providers", async () => {
    // Boot server with zero options on an ephemeral port
    const result = await runSeepientServer({
      port: 0,
      host: "127.0.0.1",
    });
    runningServer = result;

    // 1. One-line stderr boot notice must be emitted
    expect(stderrOutput).toMatch(/isolated/i);

    // 2. The server's runtime must be isolated (isIsolated === true)
    const runtime = (result as any).runtime ?? (result as any).getRuntime?.();
    expect(runtime).toBeDefined();
    expect(runtime?.isIsolated).toBe(true);

    // 3. Isolated runtime must compose zero ambient providers from process.env
    const config = await runtime.getConfig();
    const configuredProviders = Object.keys(config.providers ?? {});
    expect(configuredProviders).toHaveLength(0);

    guard.assertGuardedPathExecuted(1);
  });

  it("multi server booted with defaults performs zero writes under $HOME/.seepient and cwd (SC-003)", async () => {
    const sandboxHome = mkdtempSync(join(tmpdir(), "seepient-server-zero-write-home-"));
    const sandboxCwd = mkdtempSync(join(tmpdir(), "seepient-server-zero-write-cwd-"));
    const keysDir = mkdtempSync(join(tmpdir(), "seepient-server-keys-"));
    const keysFile = join(keysDir, "server-keys.json");

    process.env.HOME = sandboxHome;
    process.env.SEEPIENT_API_KEYS_FILE = keysFile;

    const apiKey = generateApiKey(["agent:run", "admin"], { filePath: keysFile });

    const originalCwd = process.cwd();
    process.chdir(sandboxCwd);

    try {
      const server = await runSeepientServer({
        port: 0,
        host: "127.0.0.1",
      });
      runningServer = server;

      const addr = server.address() as AddressInfo;
      // Perform a chat request to trigger session & permission store operations
      const res = await fetch(`http://127.0.0.1:${addr.port}/v1/chat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey.rawKey}`,
        },
        body: JSON.stringify({
          message: "hello server, please read a file",
          sessionId: "session-zero-write",
          principalId: "tenant-zero-write",
          tools: ["read_file"],
        }),
      });

      // Typed denial-generation assertion (pass-10 F5): the request must
      // traverse auth + body validation and reach the generation phase —
      // which composes the per-request permission pipeline — before failing
      // on the empty runtime. A 400/401/403 (rejected before composition)
      // fails this gate rather than silently re-vacuuming it.
      const resBody = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
      expect(res.status).toBe(500);
      expect(resBody?.error?.code).toBe("GENERATION_ERROR");

      // Zero-disk-write: with the in-memory store defaults, a full chat turn
      // (tools + sessionId) touches nothing under $HOME/.seepient or cwd.
      const seepientHomeExists = existsSync(join(sandboxHome, ".seepient"));
      const cwdFiles = readdirSync(sandboxCwd);

      expect(seepientHomeExists).toBe(false);
      expect(cwdFiles).toHaveLength(0);
    } finally {
      process.chdir(originalCwd);
      rmSync(sandboxHome, { recursive: true, force: true });
      rmSync(sandboxCwd, { recursive: true, force: true });
      rmSync(keysDir, { recursive: true, force: true });
    }
  });

  it("rejects runSeepientServer with ambient runtime (isIsolated !== true)", async () => {
    const { createAmbientProviderRuntime } = await import("../../../domain/providers/provider-runtime.js");
    const { TenancyRuntimeRequiredError } = await import("../../../domain/tenancy/tenancy-mode.js");

    await expect(
      runSeepientServer({
        port: 0,
        host: "127.0.0.1",
        runtime: createAmbientProviderRuntime(),
      }),
    ).rejects.toThrow(TenancyRuntimeRequiredError);
  });
});

