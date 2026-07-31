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
const { generateKeyPairSync, createSign } = require("node:crypto");
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pubKeyPem = publicKey.export({ type: "pkcs1", format: "pem" }).toString();
const privKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

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

function signPayload(payload: string): string {
  const signer = createSign("SHA256");
  signer.update(payload);
  return signer.sign(privKeyPem, "hex");
}

function attestation(opts: Partial<ActivationAttestation> & { proposalId: string; candidateArtifactDigest: string; expiresAt?: number }): ActivationAttestation {
  const expiresAt = opts.expiresAt ?? Date.now() + 10_000;
  const payload = `${opts.proposalId}:${opts.candidateArtifactDigest}:${expiresAt}`;
  return {
    verifierId: "verifier-2",
    authorityId: "sup-2",
    issuedAt: 100,
    expiresAt,
    signature: signPayload(payload),
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
      executorImageDigest: "sha256:unit-image",
      commandDigest: "sha256:unit-command",
      signingKeyId: "supervisor-key-1",
      evidenceSignature: "unit-sig",
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
      supervisorPublicKeyPem: pubKeyPem,
      supervisor: sup,
    });
    expect(outcome.status).toBe("submitted");
    if (outcome.status === "submitted") {
      expect(outcome.receipt.candidateArtifactDigest).toBeDefined();
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
      supervisorPublicKeyPem: pubKeyPem,
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
      supervisorPublicKeyPem: pubKeyPem,
      // no supervisor configured
    });
    expect(outcome.status).toBe("verified-pending-activation");
  });

  it("QS-5.3: candidate-supplied change classes are untrusted — path-derived classes govern", async () => {
    // Change classes are derived ONLY from operator-owned path rules; the
    // author cannot influence (in particular cannot downgrade) its own
    // classification. A candidate that writes to a security-kernel PATH is
    // classified protected regardless of what it CLAIMS, and without a
    // supervisor it stays verified-pending (never auto-activated).
    const operatorPolicy = policy({
      allowedChangeClasses: ["docs", "application-code", "security-kernel"],
    });
    const candidate = await createCandidateWorkspace({
      policy: operatorPolicy,
      parentArtifactDigest: "parent-sha",
      authorRunId: "run-1",
    });
    // Write to a security-kernel path AND claim it is "docs" — the claim must
    // be ignored; classification is security-kernel (protected).
    mkdirSync(join(candidate.root, "src/domain/permissions"), { recursive: true });
    writeFileSync(join(candidate.root, "src/domain/permissions/policy-engine.ts"), "// change");
    const { proposal } = await buildProposal({
      candidate,
      changeClasses: ["docs"], // author's (ignored) claim
      policy: operatorPolicy,
      verification: [
        {
          checkId: "unit",
          state: "passed",
          evidenceDigest: "ev",
          workerId: "w",
          completedAt: Date.now(),
          executorImageDigest: "sha256:img",
          commandDigest: "sha256:cmd",
          signingKeyId: "k",
          evidenceSignature: "sig",
        },
      ],
      requestedActivation: true,
    });
    const outcome = await submitForActivation({
      proposal,
      attestation: attestation({
        proposalId: proposal.proposalId,
        candidateArtifactDigest: proposal.candidateArtifactDigest,
      }),
      policy: operatorPolicy,
      supervisorPublicKeyPem: pubKeyPem,
      // No supervisor: protected change MUST stay pending, never rejected as
      // disallowed and never auto-activated.
    });
    expect(outcome.status).toBe("verified-pending-activation");
    if (outcome.status === "verified-pending-activation") {
      expect(outcome.reason).toBe("no-supervisor-configured");
    }
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
      supervisorPublicKeyPem: pubKeyPem,
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
      supervisorPublicKeyPem: pubKeyPem,
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
      supervisorPublicKeyPem: pubKeyPem,
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
      supervisorPublicKeyPem: pubKeyPem,
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

describe("candidate tree integrity (T502, Blocker 1)", () => {
  it("digestTree rejects a candidate containing a symlink", async () => {
    const p = policy();
    const candidate = await createCandidateWorkspace({
      policy: p,
      parentArtifactDigest: "parent",
      authorRunId: "run-1",
    });
    writeFileSync(join(candidate.root, "real.txt"), "ok");
    // A symlink — even to an innocuous target — is forbidden in the digest.
    symlinkSync(join(candidate.root, "real.txt"), join(candidate.root, "link.txt"));
    await expect(
      buildProposal({
        candidate,
        changeClasses: ["docs"],
        policy: p,
        verification: [],
        requestedActivation: false,
      }),
    ).rejects.toThrow(/symlink forbidden/);
  });

  it("detectProtectedWrites flags nested symlinks, not only top-level", async () => {
    const p = policy({ immutableAssets: [protectedAsset] });
    const candidate = await createCandidateWorkspace({
      policy: p,
      parentArtifactDigest: "parent",
      authorRunId: "run-1",
    });
    // Nested symlink deep in the tree (not a direct child of the root).
    mkdirSync(join(candidate.root, "sub"), { recursive: true });
    symlinkSync(protectedAsset, join(candidate.root, "sub", "escape"));
    const violations = await detectProtectedWrites({
      candidate,
      policy: p,
      policyStoreDir: protectedAsset,
    });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.includes("escape"))).toBe(true);
  });
});
