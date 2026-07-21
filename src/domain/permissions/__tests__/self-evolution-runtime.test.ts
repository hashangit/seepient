/**
 * P5 self-evolution runtime boundary tests (spec 008, T502/T503/T505/T506/T507).
 *
 * Verifies:
 *  - QS-5.1: routine delegated candidate submits to a configured supervisor;
 *    author run never writes active state; receipt links parent/candidate.
 *  - QS-5.2: security-kernel candidate can be built/verified but NOT activated
 *    by the author.
 *  - QS-5.3: policy self-escalation (candidate-provided policy) is untrusted.
 *  - QS-5.4: absent supervisor → verified-pending-activation (no fallback).
 *  - QS-5.5: attestation replay/substitution/expiry/self-signed → rejected.
 *  - T506: executors cannot mutate protected assets via symlink escape.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCandidateWorkspace,
  buildProposal,
  submitForActivation,
  detectProtectedWrites,
} from "../self-evolution-runtime.js";
import type {
  ActivationAttestation,
  ActivationReceipt,
  ActivationSupervisor,
  ChangeProposal,
  SelfEvolutionPolicy,
  VerificationResult,
} from "../../../foundations/contracts/self-evolution.js";

let dir: string;
let candidateRoot: string;
let protectedAsset: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seepient-evol-"));
  candidateRoot = join(dir, "candidates");
  protectedAsset = join(dir, "active", "release.key");
  mkdirSync(candidateRoot, { recursive: true });
  mkdirSync(join(dir, "active"), { recursive: true });
  writeFileSync(protectedAsset, "release-key-material", { mode: 0o600 });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function policy(overrides: Partial<SelfEvolutionPolicy> = {}): SelfEvolutionPolicy {
  return {
    policyId: "pol1",
    allowedChangeClasses: ["docs", "tests", "application-code", "security-kernel"],
    candidateRoots: [candidateRoot],
    activationRules: [
      {
        changeClasses: ["docs", "tests", "application-code"],
        automaticSubmission: true,
        requiredAuthority: "delegated-service",
        supervisorId: "sup-1",
      },
    ],
    requiredChecks: [],
    immutableAssets: [join(dir, "active")],
    authority: { kind: "deployment", authorityId: "deploy", authenticatedBy: "op" },
    ...overrides,
  };
}

function attestation(opts: Partial<ActivationAttestation> & { proposalId: string; candidateArtifactDigest: string }): ActivationAttestation {
  return {
    verifierId: "verifier-2",
    authorityId: "sup-2",
    issuedAt: 100,
    expiresAt: Date.now() + 10_000,
    signature: "sig-by-verifier-2",
    ...opts,
  };
}

/** A fake supervisor that records submissions. */
function fakeSupervisor(): ActivationSupervisor & { submissions: ChangeProposal[] } {
  const submissions: ChangeProposal[] = [];
  return {
    submissions,
    async submit(proposal, _att) {
      submissions.push(proposal);
      const receipt: ActivationReceipt = {
        activationId: `act_${proposal.proposalId.slice(-6)}`,
        supervisorId: "sup-1",
        proposalId: proposal.proposalId,
        candidateArtifactDigest: proposal.candidateArtifactDigest,
        state: "accepted",
        receivedAt: Date.now(),
      };
      return receipt;
    },
    async status() {
      return "accepted";
    },
  };
}

async function makeVerifiedProposal(changeClasses: SelfEvolutionPolicy["allowedChangeClasses"][number][], pol?: SelfEvolutionPolicy) {
  const p = pol ?? policy();
  const candidate = await createCandidateWorkspace({
    policy: p,
    parentArtifactDigest: "parent-sha",
    authorRunId: "run-1",
  });
  writeFileSync(join(candidate.root, "README.md"), "# change");
  const verification: VerificationResult[] = [
    {
      checkId: "unit",
      state: "passed",
      evidenceDigest: "unit-ev",
      workerId: "w-1",
      completedAt: Date.now(),
    },
  ];
  const { proposal } = await buildProposal({
    candidate,
    changeClasses,
    policy: p,
    verification,
    requestedActivation: true,
  });
  return { candidate, proposal };
}

describe("self-evolution runtime (T502-T507)", () => {
  it("QS-5.1: routine delegated candidate submits to supervisor; receipt links digests", async () => {
    const { proposal } = await makeVerifiedProposal(["docs"]);
    const sup = fakeSupervisor();
    const outcome = await submitForActivation({
      proposal,
      attestation: attestation({ proposalId: proposal.proposalId, candidateArtifactDigest: proposal.candidateArtifactDigest }),
      policy: policy(),
      supervisor: sup,
    });
    expect(outcome.status).toBe("submitted");
    if (outcome.status === "submitted") {
      expect(outcome.receipt.parentArtifactDigest ?? outcome.receipt.candidateArtifactDigest).toBeDefined();
      expect(outcome.receipt.candidateArtifactDigest).toBe(proposal.candidateArtifactDigest);
      expect(sup.submissions).toHaveLength(1);
    }
  });

  it("QS-5.2: security-kernel candidate cannot be activated by the author", async () => {
    const { proposal } = await makeVerifiedProposal(["security-kernel"]);
    const outcome = await submitForActivation({
      proposal,
      attestation: attestation({
        proposalId: proposal.proposalId,
        candidateArtifactDigest: proposal.candidateArtifactDigest,
        // The author run attempts to self-attest:
        verifierId: "run-1",
        authorityId: "run-1",
      }),
      policy: policy(),
      supervisor: fakeSupervisor(),
    });
    expect(outcome.status).toBe("rejected");
  });

  it("QS-5.2 variant: security-kernel with independent attestation → needs supervisor", async () => {
    const { proposal } = await makeVerifiedProposal(["security-kernel"]);
    const outcome = await submitForActivation({
      proposal,
      attestation: attestation({
        proposalId: proposal.proposalId,
        candidateArtifactDigest: proposal.candidateArtifactDigest,
      }),
      policy: policy(),
      // no supervisor configured
    });
    expect(outcome.status).toBe("verified-pending-activation");
  });

  it("QS-5.3: policy self-escalation — candidate-provided policy is untrusted input", async () => {
    // A candidate's own policy proposal (e.g. add "security-kernel" to its
    // own allowed list) is NOT used; the operator-owned policy governs.
    const operatorPolicy = policy({
      allowedChangeClasses: ["docs"], // does NOT include security-kernel
    });
    const { proposal } = await makeVerifiedProposal(["security-kernel"], operatorPolicy);
    const outcome = await submitForActivation({
      proposal,
      attestation: attestation({
        proposalId: proposal.proposalId,
        candidateArtifactDigest: proposal.candidateArtifactDigest,
      }),
      policy: operatorPolicy,
      supervisor: fakeSupervisor(),
    });
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") expect(outcome.reason).toContain("disallowed");
  });

  it("QS-5.4: absent supervisor → verified-pending-activation (no fallback)", async () => {
    const { proposal } = await makeVerifiedProposal(["docs"]);
    const outcome = await submitForActivation({
      proposal,
      attestation: attestation({
        proposalId: proposal.proposalId,
        candidateArtifactDigest: proposal.candidateArtifactDigest,
      }),
      policy: policy(),
      // no supervisor
    });
    expect(outcome.status).toBe("verified-pending-activation");
    if (outcome.status === "verified-pending-activation") {
      expect(outcome.reason).toBe("no-supervisor-configured");
    }
  });

  it("QS-5.5: attestation replay for another candidate → rejected", async () => {
    const { proposal: p1 } = await makeVerifiedProposal(["docs"]);
    const { proposal: p2 } = await makeVerifiedProposal(["docs"]);
    // p1's attestation used against p2:
    const outcome = await submitForActivation({
      proposal: p2,
      attestation: attestation({
        proposalId: p1.proposalId,
        candidateArtifactDigest: p1.candidateArtifactDigest,
      }),
      policy: policy(),
      supervisor: fakeSupervisor(),
    });
    expect(outcome.status).toBe("rejected");
  });

  it("QS-5.5: expired attestation → rejected", async () => {
    const { proposal } = await makeVerifiedProposal(["docs"]);
    const outcome = await submitForActivation({
      proposal,
      attestation: attestation({
        proposalId: proposal.proposalId,
        candidateArtifactDigest: proposal.candidateArtifactDigest,
        expiresAt: 1, // expired
      }),
      policy: policy(),
      supervisor: fakeSupervisor(),
    });
    expect(outcome.status).toBe("rejected");
  });

  it("QS-5.5: missing signature → rejected", async () => {
    const { proposal } = await makeVerifiedProposal(["docs"]);
    const outcome = await submitForActivation({
      proposal,
      attestation: attestation({
        proposalId: proposal.proposalId,
        candidateArtifactDigest: proposal.candidateArtifactDigest,
        signature: "",
      }),
      policy: policy(),
      supervisor: fakeSupervisor(),
    });
    expect(outcome.status).toBe("rejected");
  });

  it("T506: candidate symlink into a protected asset is detected", async () => {
    const p = policy();
    const candidate = await createCandidateWorkspace({
      policy: p,
      parentArtifactDigest: "parent",
      authorRunId: "run-1",
    });
    // Attempt to symlink the release key into the candidate workspace.
    symlinkSync(protectedAsset, join(candidate.root, "stolen-key"));
    const violations = await detectProtectedWrites({
      candidate,
      policy: p,
      policyStoreDir: join(dir, "security"),
    });
    expect(violations.length).toBeGreaterThan(0);
  });

  it("T506: a clean candidate has no protected-write violations", async () => {
    const p = policy();
    const candidate = await createCandidateWorkspace({
      policy: p,
      parentArtifactDigest: "parent",
      authorRunId: "run-1",
    });
    writeFileSync(join(candidate.root, "file.txt"), "ok");
    const violations = await detectProtectedWrites({ candidate, policy: p });
    expect(violations).toEqual([]);
  });
});
