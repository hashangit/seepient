/**
 * P1 self-evolution classifier tests (spec 008, T501).
 *
 * Verifies: routine delegated submission, security-kernel rejection,
 * policy self-escalation rejection, and attestation independence/matching.
 */
import { describe, it, expect } from "vitest";
import {
  classifyProposal,
  isIndependentAttestation,
  attestationMatches,
  PROTECTED_CHANGE_CLASSES,
} from "../self-evolution-policy.js";
import type {
  SelfEvolutionPolicy,
  ChangeProposal,
  ActivationAttestation,
} from "../../../foundations/contracts/self-evolution.js";

const routinePolicy: SelfEvolutionPolicy = {
  policyId: "pol1",
  allowedChangeClasses: ["docs", "tests", "application-code"],
  candidateRoots: ["/cand"],
  activationRules: [
    {
      changeClasses: ["docs", "tests"],
      automaticSubmission: true,
      requiredAuthority: "delegated-service",
      supervisorId: "sup1",
    },
  ],
  requiredChecks: [],
  immutableAssets: ["/active/policy"],
  authority: { kind: "deployment", authorityId: "deploy", authenticatedBy: "op" },
};

describe("classifyProposal (T501)", () => {
  it("delegates routine docs change when rule matches", () => {
    const proposal: Pick<ChangeProposal, "changeClasses" | "changedPaths" | "authorRunId"> = {
      changeClasses: ["docs"],
      changedPaths: ["/cand/README.md"],
      authorRunId: "run-1",
    };
    const result = classifyProposal(routinePolicy, proposal);
    expect(result.status).toBe("delegated");
  });

  it("rejects disallowed change classes", () => {
    const proposal = {
      changeClasses: ["docs", "dependencies"],
      changedPaths: [],
      authorRunId: "run-1",
    };
    const result = classifyProposal(routinePolicy, proposal);
    expect(result.status).toBe("disallowed");
  });

  it("marks security-kernel as protected (even if allowed)", () => {
    const policy: SelfEvolutionPolicy = {
      ...routinePolicy,
      allowedChangeClasses: ["docs", "security-kernel"],
    };
    const proposal = {
      changeClasses: ["security-kernel"],
      changedPaths: ["/cand/policy-engine.ts"],
      authorRunId: "run-1",
    };
    const result = classifyProposal(policy, proposal);
    expect(result.status).toBe("protected");
    expect(PROTECTED_CHANGE_CLASSES.has("security-kernel")).toBe(true);
    expect(PROTECTED_CHANGE_CLASSES.has("deployment-policy")).toBe(true);
  });

  it("needs-attestation when allowed but no automatic rule", () => {
    const policy: SelfEvolutionPolicy = {
      ...routinePolicy,
      activationRules: [],
    };
    const proposal = {
      changeClasses: ["application-code"],
      changedPaths: ["/cand/x.ts"],
      authorRunId: "run-1",
    };
    const result = classifyProposal(policy, proposal);
    expect(result.status).toBe("needs-attestation");
  });
});

describe("attestation independence (T504)", () => {
  it("rejects author as verifier", () => {
    expect(
      isIndependentAttestation(
        { verifierId: "run-1", authorityId: "sup2" },
        { authorRunId: "run-1" },
      ),
    ).toBe(false);
    expect(
      isIndependentAttestation(
        { verifierId: "verifier-2", authorityId: "sup2" },
        { authorRunId: "run-1" },
      ),
    ).toBe(true);
  });

  it("attestation must match proposal digest and not be expired", () => {
    const att: ActivationAttestation = {
      proposalId: "p1",
      candidateArtifactDigest: "sha256:abc",
      verifierId: "v1",
      authorityId: "a1",
      issuedAt: 100,
      expiresAt: 200,
      signature: "sig",
    };
    const proposal = {
      proposalId: "p1",
      candidateArtifactDigest: "sha256:abc",
    };
    expect(attestationMatches(att, proposal, 150)).toBe(true);
    expect(attestationMatches(att, proposal, 250)).toBe(false); // expired
    expect(
      attestationMatches(
        { ...att, candidateArtifactDigest: "sha256:other" },
        proposal,
        150,
      ),
    ).toBe(false); // digest mismatch
    expect(
      attestationMatches({ ...att, signature: "" }, proposal, 150),
    ).toBe(false); // missing sig
  });
});
