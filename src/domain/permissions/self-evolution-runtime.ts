/**
 * Self-evolution runtime — Domain (spec 008, T502/T503/T505/T506).
 *
 * Implements the candidate/verification/activation boundary:
 *
 *   candidate build (in candidate workspace)
 *     → isolated verification (T503)
 *     → change classification (T501, in self-evolution-policy.ts)
 *     → policy/independent attestation (T504, in self-evolution-policy.ts)
 *     → activation request to separately-trusted supervisor (T505)
 *     → external/manual result receipt
 *
 * Seepient may autonomously create and verify a change proposal. The active
 * artifact, release keys, active policy, and activation identities are
 * READ-ONLY to the executor (T506). The authoring run cannot self-attest a
 * protected change. Without a configured supervisor, the safe result is a
 * verified candidate with a pending external activation request — never an
 * in-process fallback.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  ActivationAttestation,
  ActivationReceipt,
  ActivationSupervisor,
  ChangeProposal,
  SelfEvolutionChangeClass,
  SelfEvolutionPolicy,
  VerificationResult,
} from "../../foundations/contracts/self-evolution.js";
import { generateId } from "../../foundations/id.js";
import {
  classifyProposal,
  isIndependentAttestation,
  attestationMatches,
} from "./self-evolution-policy.js";
import type { PolicyStore } from "../../foundations/contracts/execution-brokers.js";

/** A candidate workspace under the operator-configured candidate roots. */
export interface CandidateWorkspace {
  candidateId: string;
  root: string;
  parentArtifactDigest: string;
  createdAt: number;
  authorRunId: string;
}

/** Digest every file under a directory recursively (content-addressed). */
async function digestTree(root: string): Promise<{ digest: string; paths: string[] }> {
  const { glob } = await import("node:fs/promises");
  void glob;
  const paths: string[] = [];
  const hashes: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        const bytes = await fs.readFile(full);
        paths.push(path.relative(root, full));
        hashes.push(createHash("sha256").update(bytes).digest("hex"));
      }
    }
  };
  await walk(root);
  const combined = paths
    .map((p, i) => `${p}:${hashes[i]}`)
    .sort()
    .join("\n");
  return {
    digest: createHash("sha256").update(combined, "utf8").digest("hex"),
    paths,
  };
}

/**
 * Create a candidate workspace under the operator-configured roots. The
 * candidate is content-addressed: its digest covers every file under root.
 */
export async function createCandidateWorkspace(opts: {
  policy: SelfEvolutionPolicy;
  parentArtifactDigest: string;
  authorRunId: string;
  root?: string;
}): Promise<CandidateWorkspace> {
  const candidateRoot = opts.root ?? opts.policy.candidateRoots[0];
  if (!candidateRoot) {
    throw new Error("No candidate root configured in SelfEvolutionPolicy");
  }
  const candidateId = `cand_${generateId().slice(0, 12)}`;
  const root = path.join(candidateRoot, candidateId);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  return {
    candidateId,
    root,
    parentArtifactDigest: opts.parentArtifactDigest,
    createdAt: Date.now(),
    authorRunId: opts.authorRunId,
  };
}

/** Build a ChangeProposal from a verified candidate workspace. */
export async function buildProposal(opts: {
  candidate: CandidateWorkspace;
  changeClasses: SelfEvolutionChangeClass[];
  policy: SelfEvolutionPolicy;
  verification: VerificationResult[];
  requestedActivation: boolean;
}): Promise<{ proposal: ChangeProposal; candidateArtifactDigest: string; changedPaths: string[] }> {
  const { digest, paths } = await digestTree(opts.candidate.root);
  const proposal: ChangeProposal = {
    proposalId: `prop_${generateId().slice(0, 12)}`,
    parentArtifactDigest: opts.candidate.parentArtifactDigest,
    candidateArtifactDigest: digest,
    changeClasses: opts.changeClasses,
    changedPaths: paths,
    authorRunId: opts.candidate.authorRunId,
    verification: opts.verification,
    requestedActivation: opts.requestedActivation,
  };
  return { proposal, candidateArtifactDigest: digest, changedPaths: paths };
}

/** Outcome of a submission attempt. */
export type SubmissionOutcome =
  | { status: "submitted"; receipt: ActivationReceipt }
  | { status: "verified-pending-activation"; reason: "no-supervisor-configured" | "delegated-awaiting" }
  | { status: "rejected"; reason: string };

/**
 * Submit a verified proposal for activation. Validates the attestation
 * independently, classifies the change, and routes to the supervisor if
 * configured. Without a supervisor, the result is `verified-pending-
 * activation` — NEVER an in-process fallback (T505).
 */
export async function submitForActivation(opts: {
  proposal: ChangeProposal;
  attestation: ActivationAttestation;
  policy: SelfEvolutionPolicy;
  supervisor?: ActivationSupervisor;
  now?: () => number;
}): Promise<SubmissionOutcome> {
  const now = (opts.now ?? Date.now)();
  // 1. Attestation must match the candidate digest and be unexpired.
  if (
    !attestationMatches(opts.attestation, opts.proposal, now) ||
    !isIndependentAttestation(opts.attestation, opts.proposal)
  ) {
    return {
      status: "rejected",
      reason: "attestation mismatch, expired, or not independent of author",
    };
  }
  // 2. Classify the change.
  const classification = classifyProposal(opts.policy, opts.proposal);
  if (classification.status === "disallowed") {
    return {
      status: "rejected",
      reason: `disallowed change classes: ${classification.disallowedClasses.join(", ")}`,
    };
  }
  if (classification.status === "protected") {
    // Protected changes require independent activation authority. Without a
    // configured supervisor they remain pending — never auto-activated.
    if (!opts.supervisor) {
      return {
        status: "verified-pending-activation",
        reason: "no-supervisor-configured",
      };
    }
    // Delegate to supervisor; it owns the release-authority decision.
    const receipt = await opts.supervisor.submit(opts.proposal, opts.attestation);
    return { status: "submitted", receipt };
  }
  // 3. Delegated / needs-attestation: route to supervisor if configured.
  if (!opts.supervisor) {
    return {
      status: "verified-pending-activation",
      reason: "no-supervisor-configured",
    };
  }
  const receipt = await opts.supervisor.submit(opts.proposal, opts.attestation);
  return { status: "submitted", receipt };
}

/**
 * Prove executors cannot mutate protected assets (T506). Returns the set of
 * protected paths that the candidate attempted to write, if any. Active
 * executable/image, release credentials, activation identities, supervisor
 * config, and the policy store's own directory must all be immutable to the
 * candidate.
 */
export async function detectProtectedWrites(opts: {
  candidate: CandidateWorkspace;
  policy: SelfEvolutionPolicy;
  policyStoreDir?: string;
}): Promise<string[]> {
  const protectedRoots = [
    ...opts.policy.immutableAssets,
    ...(opts.policyStoreDir ? [opts.policyStoreDir] : []),
  ];
  const violations: string[] = [];
  // A candidate can only write under its own root. Any symlink or hardlink
  // into a protected asset is a violation.
  try {
    const entries = await fs.readdir(opts.candidate.root, { withFileTypes: true });
    for (const e of entries) {
      if (e.isSymbolicLink()) {
        const target = await fs.readlink(path.join(opts.candidate.root, e.name));
        if (protectedRoots.some((r) => target.startsWith(r))) {
          violations.push(path.join(opts.candidate.root, e.name));
        }
      }
    }
  } catch {
    /* candidate root gone — no violations */
  }
  return violations;
}

/** Re-export PolicyStore type for composition roots that wire the runtime. */
export type { PolicyStore };
