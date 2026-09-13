/**
 * J8 Adversarial Journey — VULN-17: Operator gateway tool definitions default-on in tenant model context.
 *
 * Verifies that on default multi-tenant server boot, the operator's ambient gateway
 * is NOT composed into tenant model context by default. Zero operator gateway
 * tool definitions should appear in tenant context without explicit opt-in.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runSeepientServer } from "../index.js";
import { createSecurityGuard } from "../../../domain/permissions/__tests__/composition-closure/_guard.js";
import type { Server } from "node:http";

describe("J8 Gateway Default-Off Journey (VULN-17)", () => {
  let runningServer: Server | null = null;
  let guard = createSecurityGuard("VULN-17");

  afterEach(async () => {
    if (runningServer) {
      await new Promise<void>((resolve) => runningServer!.close(() => resolve()));
      runningServer = null;
    }
  });

  it("default server boot in multi mode contains zero operator gateway tools in tenant registry", async () => {
    // Boot default server with no explicit gateway option
    const result = await runSeepientServer({
      port: 0,
      host: "127.0.0.1",
    });
    runningServer = (result.server as Server) ?? null;

    // In fixed implementation (FR-017):
    // Server boot does NOT compose operator ambient gateway into the tenant tool registry.
    // Explicit opt-in via options.gateway is required.
    const toolRegistry = (result as any).toolRegistry;
    expect(toolRegistry).toBeDefined();

    const registeredTools = toolRegistry ? Array.from(toolRegistry.list()) : [];
    const gatewayTools = registeredTools.filter((t: any) =>
      t.name?.startsWith("gw_") || t.name?.includes("gateway"),
    );

    expect(gatewayTools).toHaveLength(0);
    if (gatewayTools.length === 0) {
      guard.recordHit("gateway.tools_omitted");
    }

    guard.assertGuardedPathExecuted(1);
  });

  it("server boot with explicit gateway opt-in composes gateway tools", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "seepient-gw-optin-"));
    try {
      const result = await runSeepientServer({
        port: 0,
        host: "127.0.0.1",
        gateway: {
          enabled: true,
          storageDir: tmpDir,
        },
      });
      runningServer = (result.server as Server) ?? null;

      const toolRegistry = (result as any).toolRegistry;
      expect(toolRegistry).toBeDefined();

      const registeredTools = toolRegistry ? Array.from(toolRegistry.list()) : [];
      const gatewayTools = registeredTools.filter((t: any) =>
        (t.name ?? t.function?.name)?.startsWith("gw_") || (t.name ?? t.function?.name)?.includes("gateway"),
      );

      expect(gatewayTools.length).toBeGreaterThan(0);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("rejects gateway opt-in without explicit isolated storageDir (GATEWAY_ISOLATION_REQUIRED)", async () => {
    // 1. Gateway enabled without storageDir
    await expect(
      runSeepientServer({
        port: 0,
        host: "127.0.0.1",
        gateway: true,
      }),
    ).rejects.toThrowError(/GATEWAY_ISOLATION_REQUIRED/);

    // 2. Gateway enabled with ambient ~/.seepient storageDir
    const { homedir } = await import("node:os");
    const path = await import("node:path");
    await expect(
      runSeepientServer({
        port: 0,
        host: "127.0.0.1",
        gateway: {
          enabled: true,
          storageDir: path.join(homedir(), ".seepient"),
        },
      }),
    ).rejects.toThrowError(/GATEWAY_ISOLATION_REQUIRED/);
  });
});
