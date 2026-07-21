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
} from "../../foundations/contracts/execution-brokers.js";
import type { CapabilityEnvelope } from "../../foundations/contracts/permission-policy.js";
import type { PreparedArtifactRef } from "../../foundations/contracts/prepared-action.js";

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
 * Default gate implementation. Uses the envelope's model-egress capability to
 * decide: if the envelope permits the provider class AND every requested data
 * class, allow. Secret-class and protected-class data are immutable denies
 * unless the envelope explicitly carries a `model-egress` capability that
 * names them (operator delegation).
 */
export class ModelEgressGate implements ModelEgressGateContract {
  async authorize(
    req: {
      actionDigest: string;
      providerClass: string;
      dataClasses: string[];
      sourceArtifact?: PreparedArtifactRef;
    },
    envelope: CapabilityEnvelope,
  ): Promise<ModelEgressDecision> {
    // 1. Immutable denies — nothing in the envelope can release these.
    const immutable = req.dataClasses.filter((c) =>
      IMMUTABLE_DENY_CLASSES.has(c),
    );
    if (immutable.length > 0) {
      return {
        decision: "deny",
        reason: "model-egress-denied",
        message: `Data class(es) ${immutable.join(", ")} are immutable denies for model egress`,
      };
    }

    // 2. Find the envelope's model-egress capability for this provider class.
    const egressCap = envelope.capabilities.find(
      (c) =>
        c.kind === "model-egress" &&
        c.providerClass === req.providerClass,
    );
    if (!egressCap || egressCap.kind !== "model-egress") {
      return {
        decision: "deny",
        reason: "model-egress-denied",
        message: `No model-egress capability for provider class "${req.providerClass}"`,
      };
    }

    // 3. Every requested data class must be in the capability's allowlist.
    const allowed = new Set(egressCap.dataClasses);
    const missing = req.dataClasses.filter((c) => !allowed.has(c));
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
