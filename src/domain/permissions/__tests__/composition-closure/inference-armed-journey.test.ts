/**
 * FR-002 / T002 Red Gate: Loop-level VULN-16 inference arming journey.
 *
 * Verifies that when a multi-tenant agent executes an inference turn with a none-kind/missing
 * credential and a custom baseUrl, CREDENTIAL_REQUIRED is thrown before any vendor fetch,
 * guaranteeing zero outbound fetch and zero host env-key leakage.
 *
 * On the baseline / current tree, agent-loop.ts does NOT thread tenancyMode into executeLanguage,
 * so this test FAILS (fetch is called with host decoy key, or CREDENTIAL_REQUIRED is not thrown).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createIsolatedProviderRuntime } from "../../../providers/provider-runtime.js";
import {
  InMemoryAuditStore,
  InMemoryPolicyStore,
  InMemoryCapabilityLedger,
} from "../../in-memory-stores.js";
import { createSecurityGuard } from "./_guard.js";

describe("FR-002: Inference Boundary Armed Journey (VULN-16)", () => {
  const originalEnv = process.env;
  const originalFetch = globalThis.fetch;
  let guard = createSecurityGuard("VULN-16");

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.OPENAI_API_KEY = "sk-host-operator-decoy-token";
    guard = createSecurityGuard("VULN-16");
  });

  afterEach(() => {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("fails closed with CREDENTIAL_REQUIRED and zero outbound fetch when agent loop invokes model without tenant secret", async () => {
    const fetchCalls: Array<{ url: string; headers: any }> = [];

    globalThis.fetch = vi.fn().mockImplementation(async (input: any, init: any) => {
      guard.recordHit("outbound.fetch");
      fetchCalls.push({
        url: typeof input === "string" ? input : input?.url,
        headers: init?.headers,
      });
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "leak" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const runtime = createIsolatedProviderRuntime({ tenancyMode: "multi" });
    await runtime.updateOverlay(
      {
        providers: {
          "tenant-openai": {
            adapter: "pi-ai",
            upstreamProvider: "openai",
            credential: { kind: "none" },
            baseUrl: "https://attacker.example.com/v1",
          },
        },
        modelAssignments: {
          text: {
            standard: { providerAccount: "tenant-openai", model: "gpt-4o" },
            efficient: { providerAccount: "tenant-openai", model: "gpt-4o" },
          },
        },
      },
      0,
    );

    let error: any;
    try {
      const { askSeepient } = await import("../../../../transport/sdk/index.js");
      await askSeepient("hello from tenant", {
        cwd: "/tmp/tenant-victim",
        principalId: "tenant-victim",
        tenancy: "multi",
        runtime,
        auditStore: new InMemoryAuditStore(),
        policyStore: new InMemoryPolicyStore(),
        capabilityLedger: new InMemoryCapabilityLedger(),
        stateless: true,
      });
    } catch (err: any) {
      error = err;
      if (/CREDENTIAL_REQUIRED|EGRESS_REQUIRED/.test(err?.message || err?.code)) {
        guard.recordHit("inference.fail_closed");
      }
    }

    // 022-5 FR-007: the credential gate is tenancy-invariant, so a no-auth
    // tenant credential maps to the "unused" sentinel and the request
    // proceeds to the egress check — which denies the ungranted attacker
    // baseUrl with EGRESS_REQUIRED. A valueless/undefined credential still
    // denies CREDENTIAL_REQUIRED. Either typed denial is fail-closed; the
    // security core is that ZERO requests leave the process (on the unarmed
    // tree, pi-ai fell back to process.env.OPENAI_API_KEY and called fetch).
    expect(error).toBeDefined();
    expect(error?.message || error?.code).toMatch(/CREDENTIAL_REQUIRED|EGRESS_REQUIRED/);
    expect(fetchCalls).toHaveLength(0);
    guard.assertGuardedPathExecuted(1);
  });
});
