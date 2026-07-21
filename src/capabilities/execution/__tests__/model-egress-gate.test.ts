/**
 * P2 model egress gate tests (spec 008, T211, QS-2.11).
 *
 * Verifies: secret-class bytes never reach the provider; immutable-deny data
 * classes are blocked regardless of envelope; envelope must carry a matching
 * model-egress capability for the provider class + data classes.
 */
import { describe, it, expect } from "vitest";
import { ModelEgressGate, IMMUTABLE_DENY_CLASSES } from "../model-egress-gate.js";
import type { CapabilityEnvelope } from "../../../foundations/contracts/permission-policy.js";

function envelope(caps: CapabilityEnvelope["capabilities"]): CapabilityEnvelope {
  return {
    version: 1,
    envelopeId: "e1",
    principalId: "u",
    runId: "r1",
    actionDigest: "d1",
    capabilities: caps,
    lifetime: { kind: "action", actionDigest: "d1", consumeOnce: true },
    issuedBy: { kind: "service", authorityId: "pe", authenticatedBy: "deployment" },
    issuedAt: 0,
    policyDigest: "dig",
  };
}

const gate = new ModelEgressGate();

describe("ModelEgressGate (T211, QS-2.11)", () => {
  it("denies secret-class data regardless of envelope", async () => {
    const env = envelope([
      { kind: "model-egress", providerClass: "openai", dataClasses: ["secret"] },
    ]);
    const d = await gate.authorize(
      { actionDigest: "d1", providerClass: "openai", dataClasses: ["secret"] },
      env,
    );
    expect(d.decision).toBe("deny");
  });

  it("denies active-policy / release-key data classes", async () => {
    for (const cls of ["active-policy", "release-key", "approval-credential"]) {
      const env = envelope([
        { kind: "model-egress", providerClass: "openai", dataClasses: [cls] },
      ]);
      const d = await gate.authorize(
        { actionDigest: "d1", providerClass: "openai", dataClasses: [cls] },
        env,
      );
      expect(d.decision, `${cls} should be denied`).toBe("deny");
    }
    expect(IMMUTABLE_DENY_CLASSES.has("secret")).toBe(true);
    expect(IMMUTABLE_DENY_CLASSES.has("active-policy")).toBe(true);
  });

  it("allows normal data when envelope permits the provider class", async () => {
    const env = envelope([
      { kind: "model-egress", providerClass: "openai", dataClasses: ["normal"] },
    ]);
    const d = await gate.authorize(
      { actionDigest: "d1", providerClass: "openai", dataClasses: ["normal"] },
      env,
    );
    expect(d.decision).toBe("allow");
  });

  it("denies when provider class not in envelope", async () => {
    const env = envelope([
      { kind: "model-egress", providerClass: "openai", dataClasses: ["normal"] },
    ]);
    const d = await gate.authorize(
      { actionDigest: "d1", providerClass: "anthropic", dataClasses: ["normal"] },
      env,
    );
    expect(d.decision).toBe("deny");
  });

  it("denies when data class not in envelope allowlist", async () => {
    const env = envelope([
      { kind: "model-egress", providerClass: "openai", dataClasses: ["normal"] },
    ]);
    const d = await gate.authorize(
      { actionDigest: "d1", providerClass: "openai", dataClasses: ["normal", "sensitive"] },
      env,
    );
    expect(d.decision).toBe("deny");
  });

  it("local/on-device provider still requires explicit class", async () => {
    // No bypass for local providers — they still pass through the gate.
    const env = envelope([]);
    const d = await gate.authorize(
      { actionDigest: "d1", providerClass: "local", dataClasses: ["normal"] },
      env,
    );
    expect(d.decision).toBe("deny");
  });
});
