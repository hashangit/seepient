/**
 * J8 Adversarial Journey — VULN-17: Operator gateway tool definitions default-on in tenant model context.
 *
 * Verifies that on default multi-tenant server boot, the operator's ambient gateway
 * is NOT composed into tenant model context by default. Zero operator gateway
 * tool definitions should appear in tenant context without explicit opt-in.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runSeepientServer } from "../index.js";
import { createSecurityGuard } from "../../../domain/permissions/__tests__/composition-closure/_guard.js";
import type { Server } from "node:http";

it("multi chat path never composes registry definitions into tenant context when tools are omitted (022-5 FR-008 seam probe)", async () => {
  const guard = createSecurityGuard("VULN-17");
  const { serverGenerateText } = await import("../server-core.js");
  const { createIsolatedProviderRuntime } = await import("../../../domain/providers/provider-runtime.js");

  const definitions = vi.fn(() => [
    { type: "function", function: { name: "read_file", description: "builtin", parameters: { type: "object", properties: {} } } },
  ]);
  const registry = { list: () => [], definitions, resolve: () => undefined, register: () => {}, registerMany: () => {} } as never;

  try {
    await serverGenerateText(
      { messages: [{ id: "m1", role: "user", content: "hi", timestamp: Date.now() }], tenancyMode: "multi", runtime: createIsolatedProviderRuntime(), toolRegistry: registry } as never,
    );
  } catch {
    /* generation fails on the empty runtime — the assertion is whether the
       registry's definitions were ever consulted for the tenant context. */
  }

  // With the VULN-17 guard live, toolDefs default to [] in multi when the
  // caller omits tools — definitions() must never be consulted. A neutralized
  // seam re-adds registry.definitions() and this expectation fails.
  expect(definitions).not.toHaveBeenCalled();
  guard.recordHit("vuln-17.defs_not_consulted");
  guard.assertGuardedPathExecuted(1);
});

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
    // 022-5 FR-008: built-in tool defs are default-off in multi too — the
    // whole tenant registry is empty when no tools are requested. (Without
    // this line a neutralized VULN-17 seam that re-adds built-ins stays green.)
    expect(registeredTools).toHaveLength(0);
    if (gatewayTools.length === 0 && registeredTools.length === 0) {
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
