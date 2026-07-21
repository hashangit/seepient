/**
 * Governed self-evolution contracts — Foundations (spec 008).
 *
 * Seepient may inspect, edit, test, and package changes to its own code,
 * prompts, skills, configuration, and safety components in a candidate
 * workspace. The compromise is an activation boundary, not a blanket write
 * ban. The same run that authored a candidate cannot directly replace active
 * trusted state or mint the attestation that activates an authority-expanding
 * change.
 *
 * Foundations imports no Seepient layer.
 */

import type { DecisionAuthority } from "./permission-policy.js";

/** Change classification. Security-kernel/deployment-policy are protected. */
export type SelfEvolutionChangeClass =
  | "docs"
  | "tests"
  | "prompts"
  | "skills"
  | "ui"
  | "application-code"
  | "dependencies"
  | "security-kernel"
  | "deployment-policy";

/** Operator-owned rule for one change-class family. */
export interface ActivationRule {
  changeClasses: SelfEvolutionChangeClass[];
  automaticSubmission: boolean;
  requiredAuthority: "delegated-service" | "independent-human-or-service";
  supervisorId?: string;
  activationProfileRef?: string;
}

/** Required verification check run in an isolated worker. */
export interface VerificationCheck {
  checkId: string;
  executorImageDigest: string;
  commandDigest: string;
  timeoutMs: number;
  required: boolean;
}

export interface VerificationResult {
  checkId: string;
  state: "passed" | "failed" | "cancelled";
  evidenceDigest: string;
  workerId: string;
  completedAt: number;
}

/** Operator-owned policy governing candidate creation and activation. */
export interface SelfEvolutionPolicy {
  policyId: string;
  allowedChangeClasses: SelfEvolutionChangeClass[];
  candidateRoots: string[];
  activationRules: ActivationRule[];
  requiredChecks: VerificationCheck[];
  immutableAssets: string[];
  authority: DecisionAuthority;
}

/** Immutable candidate manifest. Parent/candidate digests are content-addressed. */
export interface ChangeProposal {
  proposalId: string;
  parentArtifactDigest: string;
  candidateArtifactDigest: string;
  changeClasses: SelfEvolutionChangeClass[];
  changedPaths: string[];
  authorRunId: string;
  verification: VerificationResult[];
  requestedActivation: boolean;
}

/** Attestation minted by an independent verifier, never by the author run. */
export interface ActivationAttestation {
  proposalId: string;
  candidateArtifactDigest: string;
  verifierId: string;
  authorityId: string;
  issuedAt: number;
  expiresAt: number;
  signature: string;
}

export type ActivationStatus =
  | "submitted"
  | "accepted"
  | "rejected"
  | "completed"
  | "failed";

export interface ActivationReceipt {
  activationId: string;
  supervisorId: string;
  proposalId: string;
  candidateArtifactDigest: string;
  state: ActivationStatus;
  receivedAt: number;
}

/**
 * External activation supervisor contract. Without a configured supervisor,
 * activation is manual/external and Seepient remains autonomous only through
 * candidate creation and verification.
 */
export interface ActivationSupervisor {
  submit(
    proposal: ChangeProposal,
    attestation: ActivationAttestation,
  ): Promise<ActivationReceipt>;
  status(activationId: string): Promise<ActivationStatus>;
}
