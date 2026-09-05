/**
 * Broker Connector Contracts — Foundations (spec 020, FR-005, US3, M14).
 *
 * Declarative mappings and descriptor contracts for data-only tool extensions.
 * Foundations imports no other Seepient layer.
 */

import type { DeclarativeConnectorMapping } from "./custom-tools.js";
import type { PreparedOperation, ActionDisplay } from "./prepared-action.js";
import type { EffectRequest, ToolRiskCategory } from "./tool-effects.js";
import type { ToolAnalysisContext } from "./custom-tools.js";

/** Evaluation result produced by evaluating a declarative connector mapping. */
export interface EvaluatedConnectorMapping {
  operation: PreparedOperation;
  effects: EffectRequest[];
  risk: ToolRiskCategory;
  display: ActionDisplay;
}

/** Builtin broker connector metadata registry. */
export interface BuiltinBrokerConnectorMeta {
  id: string;
  displayName: string;
  description: string;
  supportedOperations: string[];
}

export const BUILTIN_BROKER_CONNECTORS: readonly BuiltinBrokerConnectorMeta[] = [
  {
    id: "web-search",
    displayName: "Web Search",
    description: "Search web using external search providers (e.g. Tavily)",
    supportedOperations: ["search"],
  },
  {
    id: "http",
    displayName: "HTTP Endpoint",
    description: "Generic outbound HTTP request to an allowed remote endpoint with SSRF protection",
    supportedOperations: ["request", "get", "post", "put", "delete"],
  },
] as const;

/** Descriptor for a supported platform broker connector (closed v1 registry). */
export interface BrokerConnectorDescriptor {
  id: string;
  supportedOperations: string[];
  /** Pure builder producing the broker operation with placeholders or resolved values. */
  buildRequest(
    mapping: DeclarativeConnectorMapping,
    boundArgs: Record<string, unknown>,
    ctx: ToolAnalysisContext,
    secrets?: Readonly<Record<string, string>>,
  ): Promise<EvaluatedConnectorMapping> | EvaluatedConnectorMapping;
}

/** Error thrown when connector mapping evaluation fails. */
export class ConnectorMappingError extends Error {
  readonly code:
    | "CONNECTOR_UNKNOWN"
    | "CONNECTOR_MAPPING_INVALID"
    | "CONNECTOR_OPERATION_UNSUPPORTED"
    | "CONNECTOR_SECRET_UNRESOLVED";
  readonly retryable = false;

  constructor(
    message: string,
    code:
      | "CONNECTOR_UNKNOWN"
      | "CONNECTOR_MAPPING_INVALID"
      | "CONNECTOR_OPERATION_UNSUPPORTED"
      | "CONNECTOR_SECRET_UNRESOLVED",
  ) {
    super(`[${code}] ${message}`);
    this.name = "ConnectorMappingError";
    this.code = code;
  }
}
