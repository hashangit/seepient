/**
 * Broker Connector Registry & Evaluator — Capabilities (spec 020, FR-005, US3).
 *
 * Closed v1 registry of platform-provided broker connectors and declarative mapping
 * evaluator. Embedder registrations provide static data mappings only; no embedder
 * code executes.
 *
 * Layer rule: Capabilities imports Foundations only.
 */

import { generateId } from "../../foundations/id.js";
import type {
  BrokerConnectorRegistration,
  DeclarativeConnectorMapping,
  ToolAnalysisContext,
} from "../../foundations/contracts/custom-tools.js";
import type {
  BrokerConnectorDescriptor,
  EvaluatedConnectorMapping,
} from "../../foundations/contracts/broker-connectors.js";
import { ConnectorMappingError } from "../../foundations/contracts/broker-connectors.js";
import type { PreparedOperation } from "../../foundations/contracts/prepared-action.js";
import type { EffectRequest, NetworkDestination } from "../../foundations/contracts/tool-effects.js";

/** Resolve a JSON Pointer (RFC 6901) into an object. */
export function resolveJsonPointer(obj: unknown, pointer: string): unknown {
  if (pointer === "") return obj;
  if (!pointer.startsWith("/")) {
    throw new ConnectorMappingError(
      `Invalid JSON Pointer "${pointer}": must start with "/"`,
      "CONNECTOR_MAPPING_INVALID",
    );
  }
  const parts = pointer.slice(1).split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: any = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") {
      throw new ConnectorMappingError(
        `JSON Pointer "${pointer}" cannot be traversed on non-object value`,
        "CONNECTOR_MAPPING_INVALID",
      );
    }
    if (part === "__proto__" || part === "constructor" || part === "prototype") {
      throw new ConnectorMappingError(
        `JSON Pointer "${pointer}" cannot access prototype property "${part}"`,
        "CONNECTOR_MAPPING_INVALID",
      );
    }
    if (!Object.prototype.hasOwnProperty.call(current, part)) {
      throw new ConnectorMappingError(
        `JSON Pointer "${pointer}" resolved field "${part}" not found in arguments`,
        "CONNECTOR_MAPPING_INVALID",
      );
    }
    current = current[part];
  }
  return current;
}

/** Built-in web-search connector descriptor */
export const WEB_SEARCH_CONNECTOR: BrokerConnectorDescriptor = {
  id: "web-search",
  supportedOperations: ["search"],
  async buildRequest(
    mapping: DeclarativeConnectorMapping,
    boundArgs: Record<string, unknown>,
    ctx: ToolAnalysisContext,
  ): Promise<EvaluatedConnectorMapping> {
    const rawQuery = boundArgs.query;
    if (typeof rawQuery !== "string" || !rawQuery.trim()) {
      throw new ConnectorMappingError(
        `"query" is required and must be a non-empty string`,
        "CONNECTOR_MAPPING_INVALID",
      );
    }
    const query = String(rawQuery).slice(0, 1000); // cap length
    const destination: NetworkDestination = {
      scheme: "https",
      host: "api.tavily.com",
      pathPrefix: "/search",
    };

    const secretRefs = mapping.secretRefs ?? ["tavily"];

    const payload = {
      query,
      max_results: typeof boundArgs.limit === "number" ? boundArgs.limit : 5,
      search_depth: "basic",
      include_answer: true,
      include_raw_content: false,
    };

    const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
    const payloadArtifact = await ctx.artifacts.put(payloadBytes, "application/json");

    const effects: EffectRequest[] = [
      { kind: "network-egress", destinations: [destination] },
      { kind: "secret-use", secretRefs },
      {
        kind: "model-egress",
        providerClass: ctx.modelProviderClass,
        dataClasses: ["normal"],
        sources: ["tavily-response"],
      },
    ];

    const operation: PreparedOperation = {
      kind: "broker",
      request: {
        kind: "http",
        requestId: generateId(),
        destination,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payloadArtifact,
        secretRefs,
      },
    };

    return {
      operation,
      effects,
      risk: "safe",
      display: {
        title: `Web search`,
        summary: query,
        canonicalTargets: ["https://api.tavily.com/search"],
        effects: ["network-egress", "secret-use"],
      },
    };
  },
};

const registry = new Map<string, BrokerConnectorDescriptor>([
  [WEB_SEARCH_CONNECTOR.id, WEB_SEARCH_CONNECTOR],
]);

export function registerBrokerConnector(descriptor: BrokerConnectorDescriptor): void {
  registry.set(descriptor.id, descriptor);
}

export function getBrokerConnector(id: string): BrokerConnectorDescriptor | undefined {
  return registry.get(id);
}

export function clearBrokerConnectors(): void {
  registry.clear();
  registry.set(WEB_SEARCH_CONNECTOR.id, WEB_SEARCH_CONNECTOR);
}

/**
 * Evaluate a declarative BrokerConnectorRegistration at analysis time.
 * Pure static data evaluation; returns an EvaluatedConnectorMapping (PreparedActionDraft).
 */
export async function evaluateBrokerConnector(
  registration: BrokerConnectorRegistration,
  rawArgs: unknown,
  ctx: ToolAnalysisContext,
): Promise<EvaluatedConnectorMapping> {
  const descriptor = getBrokerConnector(registration.connector);
  if (!descriptor) {
    throw new ConnectorMappingError(
      `Unknown broker connector: "${registration.connector}". Registered connectors: ${[...registry.keys()].join(", ")}`,
      "CONNECTOR_UNKNOWN",
    );
  }

  const { mapping } = registration;
  if (!mapping || mapping.version !== 1) {
    throw new ConnectorMappingError(
      `Unsupported connector mapping version: ${mapping?.version}. Expected version 1.`,
      "CONNECTOR_MAPPING_INVALID",
    );
  }

  if (!descriptor.supportedOperations.includes(mapping.operation)) {
    throw new ConnectorMappingError(
      `Operation "${mapping.operation}" is not supported by connector "${descriptor.id}". Supported: ${descriptor.supportedOperations.join(", ")}`,
      "CONNECTOR_OPERATION_UNSUPPORTED",
    );
  }

  // Check collision between argumentBindings and constants
  if (mapping.constants && mapping.argumentBindings) {
    for (const key of Object.keys(mapping.argumentBindings)) {
      if (key in mapping.constants) {
        throw new ConnectorMappingError(
          `Collision detected: field "${key}" is defined in both argumentBindings and constants`,
          "CONNECTOR_MAPPING_INVALID",
        );
      }
    }
  }

  // Resolve JSON Pointers from rawArgs
  const boundArgs: Record<string, unknown> = Object.create(null);
  if (mapping.argumentBindings) {
    for (const [field, pointer] of Object.entries(mapping.argumentBindings)) {
      if (field === "__proto__" || field === "constructor" || field === "prototype") {
        throw new ConnectorMappingError(
          `Invalid argument binding field "${field}": cannot target prototype properties`,
          "CONNECTOR_MAPPING_INVALID",
        );
      }
      boundArgs[field] = resolveJsonPointer(rawArgs, pointer);
    }
  }

  // Merge constants
  if (mapping.constants) {
    for (const [key, value] of Object.entries(mapping.constants)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new ConnectorMappingError(
          `Invalid constant key "${key}": cannot target prototype properties`,
          "CONNECTOR_MAPPING_INVALID",
        );
      }
      boundArgs[key] = value;
    }
  }

  // Build and return draft request
  return descriptor.buildRequest(mapping, boundArgs, ctx);
}
