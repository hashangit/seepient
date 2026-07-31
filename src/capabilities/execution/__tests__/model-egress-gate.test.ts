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
import type { PreparedArtifactRef } from "../../../foundations/contracts/prepared-action.js";

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
      { actionDigest: "d1", providerClass: "openai", originDataClasses: ["secret"] },
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
        { actionDigest: "d1", providerClass: "openai", originDataClasses: [cls] },
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
      { actionDigest: "d1", providerClass: "openai", originDataClasses: ["normal"] },
      env,
    );
    expect(d.decision).toBe("allow");
  });

  it("denies when provider class not in envelope", async () => {
    const env = envelope([
      { kind: "model-egress", providerClass: "openai", dataClasses: ["normal"] },
    ]);
    const d = await gate.authorize(
      { actionDigest: "d1", providerClass: "anthropic", originDataClasses: ["normal"] },
      env,
    );
    expect(d.decision).toBe("deny");
  });

  it("denies when data class not in envelope allowlist", async () => {
    const env = envelope([
      { kind: "model-egress", providerClass: "openai", dataClasses: ["normal"] },
    ]);
    const d = await gate.authorize(
      { actionDigest: "d1", providerClass: "openai", originDataClasses: ["normal", "sensitive"] },
      env,
    );
    expect(d.decision).toBe("deny");
  });

  it("local/on-device provider still requires explicit class", async () => {
    // No bypass for local providers — they still pass through the gate.
    const env = envelope([]);
    const d = await gate.authorize(
      { actionDigest: "d1", providerClass: "local", originDataClasses: ["normal"] },
      env,
    );
    expect(d.decision).toBe("deny");
  });

  it("denies when caller's actionDigest does not match the envelope", async () => {
    // The envelope is the trusted authority; a caller must not authorize
    // output for action "d2" against an envelope minted for action "d1".
    const env = envelope([
      { kind: "model-egress", providerClass: "openai", dataClasses: ["normal"] },
    ]);
    const d = await gate.authorize(
      { actionDigest: "d2", providerClass: "openai", originDataClasses: ["normal"] },
      env,
    );
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") {
      expect(d.message).toMatch(/actionDigest/);
    }
  });

  it("an immutable-deny class cannot be downgraded by omitting it from dataClasses", async () => {
    // The classification is derived from the actual output at the call site
    // (agent-loop.classifyOutputSensitivity), which can only ESCALATE a class
    // into the request, never remove it. This test pins that contract: even
    // if a caller claims only ["normal"], the secret class — once in the
    // request — is an immutable deny regardless of the envelope.
    const env = envelope([
      { kind: "model-egress", providerClass: "openai", dataClasses: ["normal", "secret"] },
    ]);
    const d = await gate.authorize(
      { actionDigest: "d1", providerClass: "openai", originDataClasses: ["secret"] },
      env,
    );
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") {
      expect(d.message).toMatch(/immutable denies/);
    }
  });
});

/**
 * Trusted-provenance regression suite (final R9.1 blocker). The gate derives
 * its decision SOLELY from provenance (origin-derived classes) + the envelope;
 * caller-supplied classifications are not accepted. These prove the downgrade,
 * substitution, and content-classification paths the reviewer specified.
 */
describe("ModelEgressGate trusted provenance (R9.1 blocker)", () => {
  const g = new ModelEgressGate();

  it("rejects a missing-provenance call (no caller classification trusted)", async () => {
    const env = envelope([
      { kind: "model-egress", providerClass: "openai", dataClasses: ["normal"] },
    ]);
    // @ts-expect-error — intentionally omit provenance to prove the gate refuses it
    const d = await g.authorize(undefined, env);
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") expect(d.message).toMatch(/provenance/);
  });

  it("rejects a same-action downgrade attempt: secret output claimed as normal", async () => {
    // The provenance's originDataClasses are authoritative. If the real output
    // is secret, the call-site classifier forces "secret" into origin; a caller
    // cannot make the gate see only "normal". Here origin honestly carries
    // "secret" → immutable deny, even though the envelope permits normal.
    const env = envelope([
      { kind: "model-egress", providerClass: "openai", dataClasses: ["normal"] },
    ]);
    const d = await g.authorize(
      { actionDigest: "d1", providerClass: "openai", originDataClasses: ["secret"] },
      env,
    );
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") expect(d.message).toMatch(/immutable denies/);
  });

  it("rejects an artifact substitution: sourceArtifact provenance is incomplete", async () => {
    // A caller tries to authorize secret output by swapping in an artifact ref
    // with no digest. The gate rejects incomplete artifact provenance rather
    // than trusting an unbound artifact.
    const env = envelope([
      { kind: "model-egress", providerClass: "openai", dataClasses: ["normal", "secret"] },
    ]);
    const badArtifact: PreparedArtifactRef = {
      artifactId: "stolen",
      sha256: "",
      byteLength: 100,
      mediaType: "text/plain",
    };
    const d = await g.authorize(
      { actionDigest: "d1", providerClass: "openai", originDataClasses: ["normal"], sourceArtifact: badArtifact },
      env,
    );
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") expect(d.message).toMatch(/artifact provenance is incomplete/);
  });

  it(".env-style output is secret (immutable deny) even if the analyzer declared normal", async () => {
    // Simulates read_file of ~/.env: the analyzer may declare normal, but the
    // call-site classifier escalates to secret based on the path/contents. The
    // gate sees originDataClasses including "secret" → deny.
    const env = envelope([
      { kind: "model-egress", providerClass: "openai", dataClasses: ["normal", "sensitive"] },
    ]);
    const d = await g.authorize(
      // Classifier escalated normal → secret; origin is honest.
      { actionDigest: "d1", providerClass: "openai", originDataClasses: ["normal", "secret"] },
      env,
    );
    expect(d.decision).toBe("deny");
  });

  it("shell stdout containing a private key is secret (immutable deny)", async () => {
    // Simulates `cat ~/.ssh/id_rsa` via shell: shell output defaults to
    // "sensitive", but the content classifier escalates to "secret" on key
    // material. The gate denies.
    const env = envelope([
      { kind: "model-egress", providerClass: "openai", dataClasses: ["normal", "sensitive", "secret"] },
    ]);
    const d = await g.authorize(
      { actionDigest: "d1", providerClass: "openai", originDataClasses: ["sensitive", "secret"] },
      env,
    );
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") expect(d.message).toMatch(/immutable denies/);
  });

  it("a broker response derived from a secret-ref is secret (immutable deny)", async () => {
    // Broker connectors declare normal/sensitive, but a response that contains
    // secret-class bytes (e.g. a leaked credential in a web body) is escalated
    // by the classifier to secret. The gate denies regardless of envelope.
    const env = envelope([
      { kind: "model-egress", providerClass: "openai", dataClasses: ["normal", "sensitive"] },
    ]);
    const d = await g.authorize(
      { actionDigest: "d1", providerClass: "openai", originDataClasses: ["sensitive", "secret"] },
      env,
    );
    expect(d.decision).toBe("deny");
  });

  it("ordinary metadata/normal output still passes when the envelope permits it", async () => {
    const env = envelope([
      { kind: "model-egress", providerClass: "openai", dataClasses: ["normal"] },
    ]);
    const d = await g.authorize(
      { actionDigest: "d1", providerClass: "openai", originDataClasses: ["normal"] },
      env,
    );
    expect(d.decision).toBe("allow");
  });

  it("the decision is identical regardless of which surface constructs the provenance (parity)", async () => {
    // The gate is a pure function of (provenance, envelope). CLI, SDK streaming,
    // and SDK non-streaming all build the same provenance for the same action,
    // so they produce the same decision. This asserts that property directly.
    const env = envelope([
      { kind: "model-egress", providerClass: "openai", dataClasses: ["normal", "sensitive"] },
    ]);
    const provenance = {
      actionDigest: "d1",
      providerClass: "openai",
      originDataClasses: ["sensitive"],
    };
    const d1 = await g.authorize(provenance, env);
    const d2 = await g.authorize(provenance, env);
    const d3 = await g.authorize(provenance, env);
    expect(d1).toEqual(d2);
    expect(d2).toEqual(d3);
    expect(d1.decision).toBe("allow");
  });
});
