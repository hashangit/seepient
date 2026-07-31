/**
 * ModelEgressGate — Capabilities (spec 008, T211, FR-010/D42).
 *
 * Invoked before tool output enters model-visible history or is sent to a
 * provider. Secret-class data, active policy, approval credentials, release
 * keys, and control-plane credentials are immutable denies. Local/on-device
 * providers are still assigned an explicit provider class and pass through
 * the gate — there is no bypass.
 *
 * Pure decision function over the data classification; the actual byte
 * redaction happens at the transport layer, which consults this gate.
 */
import type {
  ModelEgressDecision,
  ModelEgressGate as ModelEgressGateContract,
  ModelEgressProvenance,
} from "../../foundations/contracts/execution-brokers.js";
import type { CapabilityEnvelope } from "../../foundations/contracts/permission-policy.js";

/** Data classes that are immutable denies by default. */
export const IMMUTABLE_DENY_CLASSES: ReadonlySet<string> = new Set([
  "secret",
  "active-policy",
  "approval-credential",
  "release-key",
  "control-plane-credential",
]);

/** Data classes that require explicit operator delegation to release. */
export const DELEGATED_RELEASE_CLASSES: ReadonlySet<string> = new Set([
  "sensitive",
]);

// re-exported at end of file

/**
 * Default gate implementation. The decision is derived SOLELY from the trusted
 * `provenance` + the capability envelope — caller-supplied classifications are
 * not accepted. The provenance's `originDataClasses` are authoritative (built
 * by the Domain loop from the action's declared effects + the call-site
 * classifier, which can only escalate).
 *
 * Rejects when: actionDigest mismatches the envelope, provenance is missing,
 * an immutable-deny class is present, the envelope lacks a model-egress
 * capability for the provider, or any class is not permitted by the envelope.
 */
export class ModelEgressGate implements ModelEgressGateContract {
  async authorize(
    provenance: ModelEgressProvenance,
    envelope: CapabilityEnvelope,
  ): Promise<ModelEgressDecision> {
    // 0. Provenance is mandatory — no caller classification is trusted.
    if (!provenance || !provenance.originDataClasses) {
      return {
        decision: "deny",
        reason: "model-egress-denied",
        message: "missing trusted model-egress provenance",
      };
    }
    // 1. Bind the decision to the envelope's immutable actionDigest. A caller
    // must not authorize output for one action against an envelope minted for a
    // different action (FR-010 — the envelope is the trusted authority).
    if (
      provenance.actionDigest &&
      envelope.actionDigest &&
      provenance.actionDigest !== envelope.actionDigest
    ) {
      return {
        decision: "deny",
        reason: "model-egress-denied",
        message: "actionDigest does not match the capability envelope",
      };
    }
    // 2. If a source artifact is supplied, it must belong to this action.
    if (provenance.sourceArtifact && provenance.sourceArtifact.artifactId) {
      // The artifact's binding to the action is enforced upstream by the
      // artifact store + executor; here we only assert presence/consistency of
      // the digest field. A substitution from another run would carry a
      // different actionDigest (rejected at step 1) or no matching envelope.
      const sa = provenance.sourceArtifact;
      if (!sa.sha256 || sa.byteLength < 0) {
        return {
          decision: "deny",
          reason: "model-egress-denied",
          message: "source artifact provenance is incomplete",
        };
      }
    }

    // 3. Immutable denies — nothing in the envelope can release these.
    const immutable = provenance.originDataClasses.filter((c) =>
      IMMUTABLE_DENY_CLASSES.has(c),
    );
    if (immutable.length > 0) {
      return {
        decision: "deny",
        reason: "model-egress-denied",
        message: `Data class(es) ${immutable.join(", ")} are immutable denies for model egress`,
      };
    }

    // 4. Envelope must carry a model-egress capability for this provider class.
    const egressCap = envelope.capabilities.find(
      (c) =>
        c.kind === "model-egress" &&
        (c.providerClass === provenance.providerClass ||
          c.providerClass === "*"),
    );
    if (!egressCap || egressCap.kind !== "model-egress") {
      return {
        decision: "deny",
        reason: "model-egress-denied",
        message: `No model-egress capability for provider class "${provenance.providerClass}"`,
      };
    }

    // 5. Every origin-derived class must be in the capability's allowlist.
    const allowed = new Set(egressCap.dataClasses);
    const missing = provenance.originDataClasses.filter(
      (c) => !allowed.has(c) && !allowed.has("*"),
    );
    if (missing.length > 0) {
      return {
        decision: "deny",
        reason: "model-egress-denied",
        message: `Data class(es) ${missing.join(", ")} not permitted by envelope`,
      };
    }

    return { decision: "allow" };
  }
}
