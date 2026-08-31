/**
 * Broker Connector Registry & Evaluator Unit Tests (Spec 020, US3, QS-2.1 – QS-2.4)
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  evaluateBrokerConnector,
  getBrokerConnector,
  registerBrokerConnector,
  clearBrokerConnectors,
  resolveJsonPointer,
} from "../connector-registry.js";
import { ConnectorMappingError } from "../../../foundations/contracts/broker-connectors.js";
import type {
  BrokerConnectorRegistration,
  ToolAnalysisContext,
} from "../../../foundations/contracts/custom-tools.js";
import { InMemoryArtifactStore } from "../../execution/in-memory-artifact-store.js";

describe("Broker Connector Registry & Evaluator (QS-2.1 – QS-2.4)", () => {
  let ctx: ToolAnalysisContext;
  let artifacts: InMemoryArtifactStore;

  beforeEach(() => {
    clearBrokerConnectors();
    artifacts = new InMemoryArtifactStore();
    ctx = {
      principalId: "test-user",
      runId: "run-1",
      toolCallId: "tc-1",
      modelProviderClass: "openai",
      artifacts,
      workspace: {
        workspaceId: "ws-1",
        canonicalRoot: "/workspace",
        policyVersion: 1,
        policyDigest: "sha256:abcd",
      },
    };
  });

  it("QS-2.1: happy path — web-search connector produces valid broker action", async () => {
    const reg: BrokerConnectorRegistration = {
      kind: "broker-connector",
      definition: {
        type: "function",
        function: {
          name: "search_docs",
          description: "Search documentation",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      },
      connector: "web-search",
      mapping: {
        version: 1,
        operation: "search",
        argumentBindings: { query: "/query" },
        constants: { limit: 10 },
        secretRefs: ["tavily"],
      },
    };

    const draft = await evaluateBrokerConnector(reg, { query: "Seepient agent architecture" }, ctx);

    expect(draft.operation.kind).toBe("broker");
    expect(draft.risk).toBe("safe");
    expect(draft.display.title).toBe("Web search");
    expect(draft.display.summary).toBe("Seepient agent architecture");
    expect(draft.effects.some((e) => e.kind === "network-egress")).toBe(true);
    expect(draft.effects.some((e) => e.kind === "secret-use")).toBe(true);

    if (draft.operation.kind === "broker" && draft.operation.request.kind === "http") {
      const bodyBytes = await artifacts.read(draft.operation.request.body!);
      const parsedBody = JSON.parse(Buffer.from(bodyBytes).toString("utf8"));
      expect(parsedBody.query).toBe("Seepient agent architecture");
      expect(parsedBody.max_results).toBe(10);
    }
  });

  it("QS-2.2: secret handling — secretRef is referenced by key only, never raw values in display/effects", async () => {
    const SECRET_KEY_REF = "tavilyApiKey";
    const reg: BrokerConnectorRegistration = {
      kind: "broker-connector",
      definition: {
        type: "function",
        function: {
          name: "tavily_search",
          description: "Search",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
      connector: "web-search",
      mapping: {
        version: 1,
        operation: "search",
        argumentBindings: { query: "/search_term" },
        secretRefs: [SECRET_KEY_REF],
      },
    };

    const action = await evaluateBrokerConnector(reg, { search_term: "latest AI news" }, ctx);

    if (action.operation.kind === "broker") {
      expect(action.operation.request.secretRefs).toEqual([SECRET_KEY_REF]);
    }
    const secretEffect = action.effects.find((e) => e.kind === "secret-use") as any;
    expect(secretEffect).toBeDefined();
    expect(secretEffect.secretRefs).toEqual([SECRET_KEY_REF]);
    // The display does not embed authorization tokens or credentials
    expect(JSON.stringify(action.display)).not.toContain("Bearer");
    expect(JSON.stringify(action.display)).not.toContain("Authorization");
  });

  it("QS-2.3: fail-closed matrix for connector errors", async () => {
    // 1. Unknown connector
    const unknownReg: BrokerConnectorRegistration = {
      kind: "broker-connector",
      definition: { type: "function", function: { name: "unknown_tool", description: "d", parameters: { type: "object", properties: {}, required: [] } } },
      connector: "non-existent-connector",
      mapping: { version: 1, operation: "search", argumentBindings: {} },
    };
    await expect(evaluateBrokerConnector(unknownReg, {}, ctx)).rejects.toThrowError(
      expect.objectContaining({ code: "CONNECTOR_UNKNOWN" }),
    );

    // 2. Unsupported version
    const badVersionReg: BrokerConnectorRegistration = {
      kind: "broker-connector",
      definition: { type: "function", function: { name: "search_tool", description: "d", parameters: { type: "object", properties: {}, required: [] } } },
      connector: "web-search",
      mapping: { version: 2 as any, operation: "search", argumentBindings: { query: "/q" } },
    };
    await expect(evaluateBrokerConnector(badVersionReg, { q: "test" }, ctx)).rejects.toThrowError(
      expect.objectContaining({ code: "CONNECTOR_MAPPING_INVALID" }),
    );

    // 3. Unsupported operation
    const badOpReg: BrokerConnectorRegistration = {
      kind: "broker-connector",
      definition: { type: "function", function: { name: "search_tool", description: "d", parameters: { type: "object", properties: {}, required: [] } } },
      connector: "web-search",
      mapping: { version: 1, operation: "unsupported_op", argumentBindings: { query: "/q" } },
    };
    await expect(evaluateBrokerConnector(badOpReg, { q: "test" }, ctx)).rejects.toThrowError(
      expect.objectContaining({ code: "CONNECTOR_OPERATION_UNSUPPORTED" }),
    );

    // 4. Constant / binding collision
    const collisionReg: BrokerConnectorRegistration = {
      kind: "broker-connector",
      definition: { type: "function", function: { name: "search_tool", description: "d", parameters: { type: "object", properties: {}, required: [] } } },
      connector: "web-search",
      mapping: {
        version: 1,
        operation: "search",
        argumentBindings: { query: "/q" },
        constants: { query: "fixed_query" as any },
      },
    };
    await expect(evaluateBrokerConnector(collisionReg, { q: "test" }, ctx)).rejects.toThrowError(
      expect.objectContaining({ code: "CONNECTOR_MAPPING_INVALID" }),
    );

    // 5. Invalid JSON Pointer syntax
    const badPointerReg: BrokerConnectorRegistration = {
      kind: "broker-connector",
      definition: { type: "function", function: { name: "search_tool", description: "d", parameters: { type: "object", properties: {}, required: [] } } },
      connector: "web-search",
      mapping: { version: 1, operation: "search", argumentBindings: { query: "bad-pointer-no-slash" } },
    };
    await expect(evaluateBrokerConnector(badPointerReg, { query: "test" }, ctx)).rejects.toThrowError(
      expect.objectContaining({ code: "CONNECTOR_MAPPING_INVALID" }),
    );

    // 6. Missing bound argument
    const missingArgReg: BrokerConnectorRegistration = {
      kind: "broker-connector",
      definition: { type: "function", function: { name: "search_tool", description: "d", parameters: { type: "object", properties: {}, required: [] } } },
      connector: "web-search",
      mapping: { version: 1, operation: "search", argumentBindings: { query: "/missing_field" } },
    };
    await expect(evaluateBrokerConnector(missingArgReg, { other_field: "test" }, ctx)).rejects.toThrowError(
      expect.objectContaining({ code: "CONNECTOR_MAPPING_INVALID" }),
    );
  });

  it("QS-2.4: model-hostile args — handles nested objects, JSON pointers, and large strings safely", async () => {
    // Test nested pointer resolution
    expect(resolveJsonPointer({ a: { b: { c: "deep-val" } } }, "/a/b/c")).toBe("deep-val");
    expect(resolveJsonPointer({ "slash/field": "escaped" }, "/slash~1field")).toBe("escaped");

    const reg: BrokerConnectorRegistration = {
      kind: "broker-connector",
      definition: { type: "function", function: { name: "search_tool", description: "d", parameters: { type: "object", properties: {}, required: [] } } },
      connector: "web-search",
      mapping: {
        version: 1,
        operation: "search",
        argumentBindings: { query: "/payload/data/nested_query" },
      },
    };

    const longQuery = "a".repeat(2000);
    const draft = await evaluateBrokerConnector(
      reg,
      { payload: { data: { nested_query: longQuery } } },
      ctx,
    );

    expect(draft.operation.kind).toBe("broker");
    if (draft.operation.kind === "broker" && draft.operation.request.kind === "http") {
      const bodyBytes = await artifacts.read(draft.operation.request.body!);
      const parsed = JSON.parse(Buffer.from(bodyBytes).toString("utf8"));
      expect(parsed.query.length).toBe(1000); // capped length without crashing
    }
  });

  it("Hardening: resolveJsonPointer rejects prototype properties and inherited keys", () => {
    expect(() => resolveJsonPointer({}, "/constructor/name")).toThrowError(ConnectorMappingError);
    expect(() => resolveJsonPointer({}, "/__proto__/polluted")).toThrowError(ConnectorMappingError);
    expect(() => resolveJsonPointer({}, "/prototype/something")).toThrowError(ConnectorMappingError);

    // Gating on own properties (inherited properties on prototype are rejected)
    const protoObj = { inheritedField: "should-not-resolve" };
    const childObj = Object.create(protoObj);
    childObj.ownField = "resolves";

    expect(resolveJsonPointer(childObj, "/ownField")).toBe("resolves");
    expect(() => resolveJsonPointer(childObj, "/inheritedField")).toThrowError(
      expect.objectContaining({ code: "CONNECTOR_MAPPING_INVALID" }),
    );
  });

  it("Hardening: evaluateBrokerConnector rejects prototype keys in mappings and constants", async () => {
    const protoKeyReg: BrokerConnectorRegistration = {
      kind: "broker-connector",
      definition: { type: "function", function: { name: "search_tool", description: "d", parameters: { type: "object", properties: {}, required: [] } } },
      connector: "web-search",
      mapping: {
        version: 1,
        operation: "search",
        argumentBindings: { __proto__: "/q" } as any,
      },
    };
    await expect(evaluateBrokerConnector(protoKeyReg, { q: "test" }, ctx)).rejects.toThrowError(
      expect.objectContaining({ code: "CONNECTOR_MAPPING_INVALID" }),
    );

    const protoConstReg: BrokerConnectorRegistration = {
      kind: "broker-connector",
      definition: { type: "function", function: { name: "search_tool", description: "d", parameters: { type: "object", properties: {}, required: [] } } },
      connector: "web-search",
      mapping: {
        version: 1,
        operation: "search",
        argumentBindings: { query: "/q" },
        constants: { constructor: "bad" } as any,
      },
    };
    await expect(evaluateBrokerConnector(protoConstReg, { q: "test" }, ctx)).rejects.toThrowError(
      expect.objectContaining({ code: "CONNECTOR_MAPPING_INVALID" }),
    );
  });
});
