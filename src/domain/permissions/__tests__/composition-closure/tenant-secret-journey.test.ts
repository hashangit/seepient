/**
 * FR-013 / T005 Red Gate: End-to-end brokered secret resolution journey.
 *
 * Verifies that in multi mode:
 * 1. A registered custom broker tool declaring `secretRefs: ["MY_SECRET"]` resolves
 *    the tenant-injected secret from the tenant's isolated CompositeCredentialStore,
 *    forwarding it to the mock transport.
 * 2. Host environment secrets (e.g. process.env.MY_SECRET) are NEVER used.
 * 3. When the tenant secret is missing, execution fails closed with machine-readable
 *    `code: "CREDENTIAL_REQUIRED"`.
 *
 * On the baseline / current tree, buildLocalBoundary does not accept or wire secretResolver,
 * so this test FAILS (tool call fails with CREDENTIAL_REQUIRED even when tenant secret is present).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createIsolatedProviderRuntime } from "../../../providers/provider-runtime.js";
import {
  InMemoryAuditStore,
  InMemoryPolicyStore,
  InMemoryCapabilityLedger,
} from "../../in-memory-stores.js";
import { createMockRuntime } from "../../../__tests__/test-doubles.js";
import { createSecurityGuard } from "./_guard.js";
import type { BrokerNetworkAdapter } from "../../../../capabilities/execution/effect-broker.js";

describe("FR-013: End-to-End Brokered Secret Journey (US4)", () => {
  const originalEnv = process.env;
  let guard = createSecurityGuard("VULN-1");

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.MY_SECRET = "host-decoy-secret-never-use";
    guard = createSecurityGuard("VULN-1");
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("resolves tenant-injected secret and sends it to mock transport without leaking host env secret", async () => {
    let capturedAuth: string | undefined;

    const mockNetwork: BrokerNetworkAdapter = {
      resolve: vi.fn().mockResolvedValue(["93.184.216.34"]),
      fetch: vi.fn().mockImplementation(async (_dest, init) => {
        guard.recordHit("network.fetch");
        capturedAuth =
          (init?.headers as Record<string, string>)?.[
            "authorization"
          ] ??
          (init?.headers as Record<string, string>)?.[
            "Authorization"
          ];
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          bytes: Buffer.from(JSON.stringify({ ok: true })),
          effectiveIp: "93.184.216.34",
        };
      }),
    };

    const { askSeepient, brokerConnector } = await import("../../../../transport/sdk/index.js");
    const customTool = brokerConnector({
      definition: {
        type: "function",
        function: {
          name: "fetch_secure_data",
          description: "Fetch secure data from external API",
          parameters: {
            type: "object",
            properties: { endpoint: { type: "string" } },
            required: ["endpoint"],
          },
        },
      },
      connector: "http",
      mapping: {
        version: 1,
        operation: "get",
        argumentBindings: { url: "/endpoint" },
        secretRefs: ["MY_SECRET"],
      },
    });

    const runtime = createMockRuntime([
      {
        toolCalls: [
          {
            id: "tc-1",
            name: "fetch_secure_data",
            args: { endpoint: "https://api.example.com/data" },
          },
        ],
      },
      { content: "Tool call finished." },
    ]);

    // Inject tenant credential into runtime credential store
    await runtime.credentialStore.put("MY_SECRET", {
      kind: "api_key",
      keyValue: "tenant-secret-value-12345",
    });

    // Run askSeepient in multi mode
    const res = await askSeepient("fetch the secure data", {
      cwd: "/tmp/tenant-secret-test",
      principalId: "tenant-secret-tester",
      tenancy: "multi",
      runtime: runtime as any,
      tools: [customTool],
      network: mockNetwork,
      auditStore: new InMemoryAuditStore(),
      policyStore: new InMemoryPolicyStore(),
      capabilityLedger: new InMemoryCapabilityLedger(),
      stateless: true,
      consentMode: "autonomous",
    });

    // In fixed implementation:
    // Tenant secret resolves via secretResolver -> capturedAuth === "Bearer tenant-secret-value-12345"
    expect(capturedAuth).toBe("Bearer tenant-secret-value-12345");
    expect(capturedAuth).not.toContain("host-decoy-secret");
    guard.assertGuardedPathExecuted(1);
  });

  it("fails closed with CREDENTIAL_REQUIRED when tenant secret is missing and does not leak host env", async () => {
    let fetchCalled = false;

    const mockNetwork: BrokerNetworkAdapter = {
      resolve: vi.fn().mockResolvedValue(["93.184.216.34"]),
      fetch: vi.fn().mockImplementation(async () => {
        fetchCalled = true;
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          bytes: Buffer.from(JSON.stringify({ ok: true })),
          effectiveIp: "93.184.216.34",
        };
      }),
    };

    const { askSeepient, brokerConnector } = await import("../../../../transport/sdk/index.js");
    const customTool = brokerConnector({
      definition: {
        type: "function",
        function: {
          name: "fetch_secure_data",
          description: "Fetch secure data from external API",
          parameters: {
            type: "object",
            properties: { endpoint: { type: "string" } },
            required: ["endpoint"],
          },
        },
      },
      connector: "http",
      mapping: {
        version: 1,
        operation: "get",
        argumentBindings: { url: "/endpoint" },
        secretRefs: ["MY_SECRET"],
      },
    });

    // Mock runtime without any injected tenant secret
    const runtime = createMockRuntime([
      {
        toolCalls: [
          {
            id: "tc-1",
            name: "fetch_secure_data",
            args: { endpoint: "https://api.example.com/data" },
          },
        ],
      },
      { content: "Tool call finished." },
    ]);

    const res = await askSeepient("fetch the secure data", {
      cwd: "/tmp/tenant-secret-test",
      principalId: "tenant-secret-tester",
      tenancy: "multi",
      runtime: runtime as any,
      tools: [customTool],
      network: mockNetwork,
      auditStore: new InMemoryAuditStore(),
      policyStore: new InMemoryPolicyStore(),
      capabilityLedger: new InMemoryCapabilityLedger(),
      stateless: true,
      consentMode: "autonomous",
    });

    expect(fetchCalled).toBe(false);
    const toolResult = res.steps.find((s) => s.type === "tool_call" && s.toolCall?.id === "tc-1");
    expect(toolResult).toBeDefined();
    expect(toolResult?.metadata?.errorCode).toBe("CREDENTIAL_REQUIRED");
    expect(toolResult?.toolCall?.result).toContain("CREDENTIAL_REQUIRED");
    expect(toolResult?.toolCall?.result).not.toContain("host-decoy-secret");

    if (toolResult?.metadata?.errorCode === "CREDENTIAL_REQUIRED") {
      guard.recordHit("credential.required");
    }
    guard.assertGuardedPathExecuted(1);
  });
});
