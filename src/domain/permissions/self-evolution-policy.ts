/**
 * SelfEvolutionPolicy evaluation — Domain (spec 008, T501, FR-019/FR-020).
 *
 * Trusted change classification: a candidate's change classes are derived
 * from its changed paths against the operator-owned
 * `SelfEvolutionPolicy.allowedChangeClasses`. The authoring run cannot change
 * its own classification or activation policy — candidate-provided policy is
 * untrusted input.
 *
 * Security-kernel / deployment-policy / identity / tenant-isolation / audit /
 * authority-expanding changes require independent activation authority; the
 * authoring run cannot self-attest them.
 */
import type {
  ActivationRule,
  ChangeProposal,
  SelfEvolutionChangeClass,
  SelfEvolutionPolicy,
} from "../../foundations/contracts/self-evolution.js";

import { createVerify } from "node:crypto";
/** Protected change classes — always require independent activation. */
export const PROTECTED_CHANGE_CLASSES: ReadonlySet<SelfEvolutionChangeClass> =
  new Set<SelfEvolutionChangeClass>([
    "security-kernel",
    "deployment-policy",
  ]);

/**
 * Classify a candidate against the operator policy. Returns:
 *  - `delegated` if every change class is allowed AND an activation rule
 *    permits automatic submission with delegated authority.
 *  - `protected` if any change class is in PROTECTED_CHANGE_CLASSES.
 *  - `needs-attestation` otherwise (allowed but needs independent verifier).
 *  - `disallowed` if any change class is outside `allowedChangeClasses`.
 */
export type ClassificationResult =
  | { status: "delegated"; rule: ActivationRule }
  | { status: "protected"; protectedClasses: SelfEvolutionChangeClass[] }
  | { status: "needs-attestation" }
  | { status: "disallowed"; disallowedClasses: SelfEvolutionChangeClass[] };

export function classifyPathsToChangeClasses(paths: string[]): SelfEvolutionChangeClass[] {
  const classes = new Set<SelfEvolutionChangeClass>();
  for (const p of paths) {
    const normalized = p.replace(/\\/g, "/");
    if (
      normalized.includes("domain/permissions/") ||
      normalized.includes("capabilities/execution/") ||
      normalized.includes("vendors/") ||
      normalized.includes("foundations/contracts/") ||
      normalized.includes("policy-engine") ||
      normalized.includes("native-helper")
    ) {
      classes.add("security-kernel");
    } else if (normalized.includes(".seepient/security/") || normalized.includes("deployment/")) {
      classes.add("deployment-policy");
    } else if (normalized.startsWith("docs/") || normalized.endsWith(".md")) {
      classes.add("docs");
    } else if (normalized.startsWith("src/") || normalized.includes("src/")) {
      classes.add("application-code");
    }
  }
  return [...classes];
}
export function classifyProposal(
  policy: SelfEvolutionPolicy,
  proposal: Pick<
    ChangeProposal,
    "changeClasses" | "changedPaths" | "authorRunId"
  >,
): ClassificationResult {
  // D47: Automatically derive canonical change classes from changedPaths
  const derivedClasses = classifyPathsToChangeClasses(proposal.changedPaths ?? []);
  const effectiveClasses = Array.from(new Set([...proposal.changeClasses, ...derivedClasses]));
  // Disallowed: any class outside the operator allowlist.
  const allowed = new Set(policy.allowedChangeClasses);
  const disallowed = effectiveClasses.filter((c) => !allowed.has(c));
  if (disallowed.length > 0) {
    return { status: "disallowed", disallowedClasses: disallowed };
  }

  // Protected: any class in the protected set.
  const protectedClasses = effectiveClasses.filter((c) =>
    PROTECTED_CHANGE_CLASSES.has(c),
  );
  if (protectedClasses.length > 0) {
    return { status: "protected", protectedClasses };
  }

  // Delegated: an activation rule covers every class and permits automatic
  // submission with delegated authority.
  const matchingRule = policy.activationRules.find((r) =>
    effectiveClasses.every((c) => r.changeClasses.includes(c)),
  );
  if (
    matchingRule &&
    matchingRule.automaticSubmission &&
    matchingRule.requiredAuthority === "delegated-service"
  ) {
    return { status: "delegated", rule: matchingRule };
  }

  return { status: "needs-attestation" };
}

/**
 * Is an attestation independent of the authoring run? The verifier must not
 * share identity with the author. In v1, identity is run-id-scoped; a real
 * deployment uses a separately-installed supervisor key.
 */
export function isIndependentAttestation(
  attestation: { verifierId: string; authorityId: string },
  proposal: { authorRunId: string },
): boolean {
  return (
    attestation.verifierId !== proposal.authorRunId &&
    attestation.authorityId !== proposal.authorRunId
  );
}

/**
 * Does the attestation match the candidate it claims to cover? Digest match
 * + non-expiry + signature presence. Full signature verification belongs to
 * the external supervisor; this is the structural gate.
 */
export function attestationMatches(
  attestation: {
    proposalId: string;
    candidateArtifactDigest: string;
    expiresAt: number;
    signature: string;
  },
  proposal: { proposalId: string; candidateArtifactDigest: string },
  now: number,
  publicKeyPem: string,
): boolean {
  if (
    attestation.proposalId !== proposal.proposalId ||
    attestation.candidateArtifactDigest !== proposal.candidateArtifactDigest ||
    attestation.expiresAt <= now ||
    !attestation.signature ||
    attestation.signature.trim().length === 0 ||
    !publicKeyPem ||
    publicKeyPem.trim().length === 0
  ) {
    return false;
  }
  try {
    const payload = `${attestation.proposalId}:${attestation.candidateArtifactDigest}:${attestation.expiresAt}`;
    const verifier = createVerify("SHA256");
    verifier.update(payload);
    return verifier.verify(publicKeyPem, attestation.signature, "hex");
  } catch {
    return false;
  }
}
