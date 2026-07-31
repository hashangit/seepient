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

/**
 * Digest every file under a directory recursively (content-addressed), WITHOUT
 * following links. Per spec 008 (T502) and the data-model "candidate escape
 * rejection" rules, the verifier MUST treat the candidate tree as untrusted:
 * symlinks, hardlinks, special files, and any traversal/read error are
 * rejection, not silently skipped. A candidate that disappears mid-walk is also
 * rejection — a missing tree is not "no violations".
 */
async function digestTree(root: string): Promise<{ digest: string; paths: string[] }> {
  const paths: string[] = [];
  const hashes: string[] = [];
  // Integrity-check the root itself BEFORE walking: `fs.readdir(root)` follows
  // a symlink transparently when `root` is the path argument, so the per-entry
  // Dirent.isSymbolicLink() check would not protect a root that was replaced
  // with a symlink. lstat does not follow the final component.
  let rootStat: import("node:fs").Stats;
  try {
    rootStat = await fs.lstat(root);
  } catch (err) {
    throw new CandidateIntegrityError(
      `candidate root inaccessible: ${(err as Error).message}`,
    );
  }
  if (rootStat.isSymbolicLink()) {
    throw new CandidateIntegrityError(`candidate root is a symlink: ${root}`);
  }
  if (!rootStat.isDirectory()) {
    throw new CandidateIntegrityError(`candidate root is not a plain directory: ${root}`);
  }
  const walk = async (dir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      // Traversal error or vanished candidate → reject (never silently skip).
      throw new CandidateIntegrityError(
        `candidate tree read failed at ${dir}: ${(err as Error).message}`,
      );
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        // No symlink is followed into the digest — every symlink is a rejection
        // (nested or top-level), since a link can escape the candidate root.
        throw new CandidateIntegrityError(`symlink forbidden in candidate tree: ${full}`);
      }
      if (e.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!e.isFile()) {
        // Block devices, FIFOs, sockets — not a legitimate source artifact.
        throw new CandidateIntegrityError(`special file forbidden in candidate tree: ${full}`);
      }
      // Hardlink check: nlink > 1 means the inode is shared outside this file,
      // which can be a write into a protected root aliased into the candidate.
      let stat: import("node:fs").Stats;
      try {
        stat = await fs.stat(full);
      } catch (err) {
        throw new CandidateIntegrityError(
          `candidate file stat failed at ${full}: ${(err as Error).message}`,
        );
      }
      if (stat.nlink > 1) {
        throw new CandidateIntegrityError(`hardlink forbidden in candidate tree (nlink=${stat.nlink}): ${full}`);
      }
      const bytes = await fs.readFile(full);
      paths.push(path.relative(root, full));
      hashes.push(createHash("sha256").update(bytes).digest("hex"));
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

/** Raised when the candidate tree fails an integrity check (link/special/traversal). */
export class CandidateIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidateIntegrityError";
  }
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
  supervisorPublicKeyPem: string;
  supervisor?: ActivationSupervisor;
  now?: () => number;
}): Promise<SubmissionOutcome> {
  const now = (opts.now ?? Date.now)();
  // 1. Attestation must match the candidate digest, be unexpired, and verify signature.
  if (
    !attestationMatches(opts.attestation, opts.proposal, now, opts.supervisorPublicKeyPem) ||
    !isIndependentAttestation(opts.attestation, opts.proposal)
  ) {
    return {
      status: "rejected",
      reason: "attestation mismatch, expired, invalid signature, or not independent of author",
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
 * candidate paths that are links into a protected root, or special/hardlinked
 * files. Active executable/image, release credentials, activation identities,
 * supervisor config, and the policy store's own directory must all be immutable
 * to the candidate.
 *
 * Walks the WHOLE candidate tree (not just top level) so nested symlinks,
 * hardlinks, and special files are detected. A vanished or unreadable
 * candidate root is reported as a violation rather than silently ignored —
 * `detectProtectedWrites` plus `digestTree` together enforce that a candidate
 * which cannot be fully inspected is rejected.
 */
export async function detectProtectedWrites(opts: {
  candidate: CandidateWorkspace;
  policy: SelfEvolutionPolicy;
  policyStoreDir?: string;
}): Promise<string[]> {
  const protectedRoots = [
    ...opts.policy.immutableAssets,
    ...(opts.policyStoreDir ? [opts.policyStoreDir] : []),
  ].map((r) => path.resolve(r));
  const violations: string[] = [];
  // Integrity-check the root itself before walking (mirrors digestTree): a
  // symlinked root would be followed transparently by readdir, bypassing the
  // per-entry symlink detection below.
  try {
    const rootStat = await fs.lstat(opts.candidate.root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return [`${opts.candidate.root} (root is not a plain directory)`];
    }
  } catch (err) {
    return [`${opts.candidate.root} (unreadable root: ${(err as Error).message})`];
  }
  const walk = async (dir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      // Unreadable or vanished candidate → violation (fail closed).
      violations.push(`${dir} (unreadable: ${(err as Error).message})`);
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        let target: string;
        try {
          target = path.resolve(path.dirname(full), await fs.readlink(full));
        } catch {
          violations.push(full);
          continue;
        }
        if (protectedRoots.some((r) => target === r || target.startsWith(r + path.sep))) {
          violations.push(full);
        } else {
          // Even a symlink to a non-protected target is suspicious in a
          // candidate tree; report it so `digestTree`'s stricter rejection
          // stays the authoritative gate.
          violations.push(full);
        }
        continue;
      }
      if (e.isDirectory()) {
        await walk(full);
        continue;
      }
      if (e.isFile()) {
        try {
          const stat = await fs.stat(full);
          if (stat.nlink > 1) {
            violations.push(`${full} (hardlink, nlink=${stat.nlink})`);
          }
        } catch {
          violations.push(full);
        }
      } else {
        // Special files (block/char device, FIFO, socket) are not legitimate
        // source artifacts — flag them, matching digestTree's rejection.
        violations.push(`${full} (special file: ${e.isFile() ? "file" : "non-regular"})`);
      }
    }
  };
  await walk(opts.candidate.root);
  return violations;
}

/** Re-export PolicyStore type for composition roots that wire the runtime. */
export type { PolicyStore };
