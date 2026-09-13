/**
 * J7 Adversarial Journey — VULN-5: Dim 8 Zero-write de-vacuumed with real brokered tool call.
 *
 * Extends Dim 8 to execute a REAL brokered tool call in multi mode and verify
 * that $HOME/.seepient stays completely untouched (no PersistedReplayLedger disk writes
 * or lock contention).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EffectBroker } from "../../../../capabilities/execution/effect-broker.js";
import { InMemoryArtifactStore } from "../../../../capabilities/execution/in-memory-artifact-store.js";
import { createSecurityGuard } from "./_guard.js";
import type { BrokerNetworkAdapter } from "../../../../capabilities/execution/effect-broker.js";
import type { BrokeredEffectRequest } from "../../../../foundations/contracts/prepared-action.js";
import type { CapabilityEnvelope } from "../../../../foundations/contracts/permission-policy.js";
import type { BrokerAuthContext } from "../../../../foundations/contracts/execution-brokers.js";

describe("J7 De-vacuumed Zero-Write Journey (VULN-5)", () => {
  let sandboxHome: string;
  const originalEnv = process.env;
  let guard = createSecurityGuard("VULN-5");

  beforeEach(() => {
    sandboxHome = mkdtempSync(join(tmpdir(), "seepient-j7-zero-write-"));
    process.env = { ...originalEnv, HOME: sandboxHome };
    guard = createSecurityGuard("VULN-5");
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(sandboxHome, { recursive: true, force: true });
  });

  it("multi mode brokered effect execution performs zero writes under $HOME/.seepient", async () => {
    const mockNetwork: BrokerNetworkAdapter = {
      resolve: vi.fn().mockResolvedValue(["93.184.216.34"]),
      fetch: vi.fn().mockImplementation(async () => {
        guard.recordHit("network.fetch");
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          bytes: Buffer.from(JSON.stringify({ ok: true })),
          effectiveIp: "93.184.216.34",
        };
      }),
    };

    // On baseline (0b7fe4e): EffectBroker defaults to `new PersistedReplayLedger()` which
    // immediately creates `$HOME/.seepient/security/replay/ledger.ndjson`.
    const broker = new EffectBroker({
      artifacts: new InMemoryArtifactStore(),
      network: mockNetwork,
      tenancyMode: "multi",
      secretResolver: () => "secret-value",
    });

    const request: BrokeredEffectRequest = {
      kind: "http",
      requestId: "req-brokered-turn-1",
      destination: {
        scheme: "https",
        host: "api.example.com",
        port: 443,
      },
      method: "POST",
      headers: {},
      secretRefs: ["MY_API_KEY"],
    };

    const envelope: CapabilityEnvelope = {
      version: 1,
      envelopeId: "env-zero-write-1",
      principalId: "tenant-zero-write",
      runId: "run-zero-write-1",
      actionDigest: "digest-zero-write-1",
      capabilities: [
        { kind: "network-destination", scheme: "https", host: "api.example.com", port: 443 },
        { kind: "secret-ref", ref: "MY_API_KEY" },
      ],
      lifetime: { kind: "action", actionDigest: "digest-zero-write-1", consumeOnce: true },
      issuedBy: { kind: "service", authorityId: "policy-engine", authenticatedBy: "test" },
      issuedAt: Date.now(),
      policyDigest: "pol-1",
    };

    const auth: BrokerAuthContext = {
      leaseId: "lease-zero-write-1",
      actionDigest: "digest-zero-write-1",
      singleUseRequestId: "req-brokered-turn-1",
      expiresAt: Date.now() + 60_000,
    };

    const result = await broker.execute(request, envelope, auth);
    expect(result.status).toBe("succeeded");

    // De-vacuumed assertion: verify $HOME/.seepient was NEVER created
    const seepientExists = existsSync(join(sandboxHome, ".seepient"));
    const files = readdirSync(sandboxHome);
    expect(seepientExists).toBe(false);
    expect(files).toEqual([]);

    if (result.status === "succeeded" && !seepientExists && files.length === 0) {
      guard.recordHit("zero_write.verified");
    }

    guard.assertGuardedPathExecuted(1);
  });
});
