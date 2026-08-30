/**
 * Public custom-tool registration — Transport SDK (spec 008, T304, FR-012/D41).
 *
 * Three explicit trust models (no silent host authority):
 *
 *  - `preparedTool({ trust: "analyzer", ... })` — application JavaScript that
 *    produces a serializable `PreparedToolAction`. The analyzer joins the
 *    application TCB; the emitted operation is policy-governed.
 *  - `brokerConnector({ ... })` — data-only argument-to-request mapping. No
 *    developer callback runs during preparation or execution. The preferred
 *    untrusted-input extension point.
 *  - `trustedHostTool({ trust: "host", ... })` — arbitrary JavaScript with
 *    ambient host authority. Always audit-labelled; excluded from agent-grant
 *    persistence; disabled by default in server/multi-tenant roots and only
 *    an operator allowlist can enable them.
 *
 * The legacy `tool({ execute })` factory emits a deprecation warning and the
 * registration fails closed at execution until the developer selects a trust
 * model. It never silently becomes policy-governed or `safe`.
 */
import type {
  PreparedToolRegistration,
  BrokerConnectorRegistration,
  TrustedHostToolRegistration,
  LegacyHostToolRegistration,
  HostToolContext,
  AnyToolRegistration,
} from "../../foundations/contracts/custom-tools.js";

export type {
  PreparedToolRegistration,
  BrokerConnectorRegistration,
  TrustedHostToolRegistration,
  LegacyHostToolRegistration,
  HostToolContext,
  AnyToolRegistration,
};

/**
 * `preparedTool` — register an application-trusted analyzer. The analyzer's
 * JavaScript can perform ambient side effects before returning, so it joins
 * the application TCB even though the returned operation is policy-governed.
 * The `trust: "analyzer"` label makes this explicit.
 */
export function preparedTool(reg: Omit<PreparedToolRegistration, "kind" | "trust">): PreparedToolRegistration {
  return { kind: "prepared", trust: "analyzer", ...reg };
}

/**
 * `brokerConnector` — register a data-only tool whose args map to a broker
 * request via static JSON Pointers. No developer callback runs during
 * preparation or execution. This is the preferred extension point for
 * untrusted input.
 */
export function brokerConnector(reg: Omit<BrokerConnectorRegistration, "kind">): BrokerConnectorRegistration {
  return { kind: "broker-connector", ...reg };
}

/**
 * `trustedHostTool` — register an arbitrary JavaScript callback with ambient
 * host authority. The registration is always audit-labelled; it is excluded
 * from agent-grant persistence; and it is disabled by default in server/
 * multi-tenant roots. Only an operator allowlist can enable host tools —
 * requests, skills, models, and approvals cannot.
 */
export function trustedHostTool(reg: Omit<TrustedHostToolRegistration, "trust">): TrustedHostToolRegistration {
  return { trust: "host", ...reg };
}

/**
 * Classify a legacy `tool({ execute })` registration. Emits a deprecation
 * warning and returns a `LegacyHostToolRegistration` that FAILS CLOSED at
 * execution until migrated to an explicit trust model. It never silently
 * becomes policy-governed or `safe`.
 */
export { classifyLegacyTool } from "../../foundations/contracts/custom-tools.js";

/**
 * Decide whether a host tool is permitted in the current deployment. Server
 * and multi-tenant roots disable host tools unless an operator allowlist
 * explicitly names the registration. Requests, skills, models, and approvals
 * cannot add to the allowlist.
 */
export function isHostToolPermitted(
  reg: TrustedHostToolRegistration | LegacyHostToolRegistration,
  opts: { deployment: "local" | "server"; allowlist?: Set<string> },
): boolean {
  if (opts.deployment === "local") return true; // local surfaces trust the application
  // Server/multi-tenant: only operator-allowlisted host tools run.
  const name = reg.definition.function.name;
  return opts.allowlist?.has(name) ?? false;
}
