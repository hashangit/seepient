/**
 * Gateway SSRF routing (021-4 W142).
 *
 * Gateway tools are model-callable: their fetches must go through the
 * SSRF-validated, pinned fetch path — a loopback/metadata URL must be
 * refused through the tool path, and `gateway_import_openapi` must no
 * longer be classified `safe`.
 */

import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MCPGateway } from "../gateway.js";
import { importOpenApiSpec } from "../openapi-importer.js";
import { createGatewayTools } from "../tool-factory.js";
import { GatewaySettingsAdapter } from "../settings-adapter.js";
import type { RestTarget } from "../types.js";

const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "seepient-gw-ssrf-"));
afterAll(() => {
  fs.rmSync(storageDir, { recursive: true, force: true });
});

function makeGateway(): MCPGateway {
  const settings = new GatewaySettingsAdapter(storageDir);
  return new MCPGateway(settings, {
    enabled: true,
    semanticTopK: 5,
    defaultRateLimitPerMin: 60,
    maxAuditLogsInMemory: 100,
  } as any);
}

function restTarget(baseUrl: string): RestTarget {
  return {
    kind: "rest",
    baseUrl,
    description: "ssrf test target",
    auth: { type: "none" },
    defaultHeaders: {},
    operations: [
      { opId: "get_thing", method: "GET", path: "/things", summary: "get" },
    ],
    tags: [],
    enabled: true,
  };
}

describe("W142 — gateway fetches refuse private/metadata targets", () => {
  it("importOpenApiSpec refuses a loopback spec URL", async () => {
    const gateway = makeGateway();
    await expect(
      importOpenApiSpec(gateway, "loopback-target", "http://127.0.0.1:9/openapi.json"),
    ).rejects.toThrow(/SSRF Blocked|private\/local/i);
  });

  it("importOpenApiSpec refuses a metadata spec URL", async () => {
    const gateway = makeGateway();
    await expect(
      importOpenApiSpec(gateway, "metadata-target", "http://169.254.169.254/latest/meta-data"),
    ).rejects.toThrow(/metadata/i);
  });

  it("gateway REST calls refuse a loopback base URL", async () => {
    const gateway = makeGateway();
    await gateway.registerTarget("loopback-rest", restTarget("http://127.0.0.1:9/v1"));

    await expect(
      gateway.callRest("agent-1", "loopback-rest", "/things", "GET"),
    ).rejects.toThrow(/SSRF Blocked|private\/local/i);
  });

  it("the gateway_import_openapi tool is no longer classified safe", async () => {
    const gateway = makeGateway();
    const tools = createGatewayTools(gateway);
    const importTool = tools.find((t: any) => t.name === "gateway_import_openapi");
    expect(importTool).toBeDefined();
    expect((importTool as any).risk).not.toBe("safe");
    expect((importTool as any).risk).toBe("communications");
  });
});
