/**
 * BrokerConnector Dispatch E2E Test Suite (Spec 020, US3, QS-2.1 – QS-2.4)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createAgent } from "../index.js";
import { brokerConnector } from "../custom-tools.js";
import { createMockRuntime } from "../../../domain/__tests__/test-doubles.js";
import type { BrokerNetworkAdapter } from "../../../capabilities/execution/effect-broker.js";

const ORIGINAL_ENV = { ...process.env };

describe("brokerConnector Dispatch & Parity (QS-2.1 – QS-2.4)", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("QS-2.1: executes brokerConnector via createAgent with zero embedder code execution and stubbed network", async () => {
    process.env.TAVILY_API_KEY = "tvly-test-valid-key-999";

    const searchTool = brokerConnector({
      definition: {
        type: "function",
        function: {
          name: "web_search_custom",
          description: "Search web using custom connector mapping",
          parameters: {
            type: "object",
            properties: { search_query: { type: "string" } },
            required: ["search_query"],
          },
        },
      },
      connector: "web-search",
      mapping: {
        version: 1,
        operation: "search",
        argumentBindings: { query: "/search_query" },
        constants: { limit: 3 },
        secretRefs: ["tavilyApiKey"],
      },
    });

    // Verify registration has NO execute or analyze method
    expect((searchTool as any).execute).toBeUndefined();
    expect((searchTool as any).analyze).toBeUndefined();

    const runtime = createMockRuntime([
      {
        toolCalls: [
          {
            id: "tc_search",
            name: "web_search_custom",
            args: { search_query: "autonomous agents" },
          },
        ],
      },
      { content: "Search complete." },
    ]);

    const mockNetwork: BrokerNetworkAdapter = {
      async resolve() {
        return ["93.184.216.34"];
      },
      async fetch(_dest, _init) {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          effectiveHost: "api.tavily.com",
          effectiveIp: "93.184.216.34",
          bytes: Buffer.from(
            JSON.stringify({
              results: [
                {
                  title: "Autonomous Agents Overview",
                  url: "https://example.com/agents",
                  content: "Autonomous agents use LLMs to perform multi-step planning and tool execution.",
                },
              ],
            }),
            "utf8",
          ),
        };
      },
    };

    const agent = await createAgent({
      permissionPipeline: true,
      runtime: runtime as never,
      tools: [searchTool],
      network: mockNetwork,
    } as never);

    const res = await agent.chat("Search for autonomous agents");
    expect(res.text).toBe("Search complete.");

    const history = agent.getHistory();
    const toolMsg = history.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.content).toContain("Autonomous Agents Overview");
    expect(toolMsg?.content).toContain("https://example.com/agents");
  });

  it("QS-2.2: secret handling — secret is resolved securely; fails closed if unresolved; no secret leakage in tool output", async () => {
    const SECRET_VAL = "tvly-super-secret-key-xyz-12345";
    process.env.TAVILY_API_KEY = SECRET_VAL;

    const searchTool = brokerConnector({
      definition: {
        type: "function",
        function: {
          name: "search_with_secret",
          description: "Search",
          parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
        },
      },
      connector: "web-search",
      mapping: {
        version: 1,
        operation: "search",
        argumentBindings: { query: "/q" },
        secretRefs: ["tavilyApiKey"],
      },
    });

    const runtime = createMockRuntime([
      {
        toolCalls: [
          {
            id: "tc_sec",
            name: "search_with_secret",
            args: { q: "quantum computing" },
          },
        ],
      },
      { content: "Done searching." },
    ]);

    let capturedAuthHeader: string | undefined;
    const mockNetwork: BrokerNetworkAdapter = {
      async resolve() {
        return ["93.184.216.34"];
      },
      async fetch(_dest, init) {
        capturedAuthHeader = (init.headers as any)?.Authorization ?? (init.headers as any)?.authorization;
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          effectiveHost: "api.tavily.com",
          effectiveIp: "93.184.216.34",
          bytes: Buffer.from(
            JSON.stringify({
              results: [
                {
                  title: "Quantum Computing Basics",
                  url: "https://example.com/quantum",
                  content: "Quantum computing harnesses quantum mechanics.",
                },
              ],
            }),
            "utf8",
          ),
        };
      },
    };

    const agent = await createAgent({
      permissionPipeline: true,
      runtime: runtime as never,
      tools: [searchTool],
      network: mockNetwork,
    } as never);

    await agent.chat("Search quantum computing");
    const history = agent.getHistory();
    const toolMsg = history.find((m) => m.role === "tool");

    // The tool result must not leak the raw secret value
    expect(toolMsg?.content).not.toContain(SECRET_VAL);
    expect(toolMsg?.content).not.toContain("trustedHostAllowlist");
    expect(toolMsg?.content).toContain("Quantum Computing Basics");
    expect(capturedAuthHeader).toBe(`Bearer ${SECRET_VAL}`);

    // Now test unresolved secret fail-closed behavior (spec 020 FR-005, P1.1)
    const missingSecretTool = brokerConnector({
      definition: {
        type: "function",
        function: {
          name: "search_with_missing_secret",
          description: "Search",
          parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
        },
      },
      connector: "web-search",
      mapping: {
        version: 1,
        operation: "search",
        argumentBindings: { query: "/q" },
        secretRefs: ["missingApiKey_999"],
      },
    });

    const runtime2 = createMockRuntime([
      {
        toolCalls: [
          {
            id: "tc_missing_sec",
            name: "search_with_missing_secret",
            args: { q: "quantum computing" },
          },
        ],
      },
      { content: "Unresolved secret handled." },
    ]);

    const agent2 = await createAgent({
      permissionPipeline: true,
      consentMode: "autonomous",
      runtime: runtime2 as never,
      tools: [missingSecretTool],
    } as never);

    await agent2.chat("Search with missing secret");
    const history2 = agent2.getHistory();
    const toolMsg2 = history2.find((m) => m.role === "tool");
    expect(toolMsg2?.content).toContain('Required secret reference "missingApiKey_999" cannot be resolved');
  });

  it("QS-2.3: bad connector mapping fails closed at analysis time without approval prompt", async () => {
    let promptShown = false;

    const badConnectorTool = brokerConnector({
      definition: {
        type: "function",
        function: {
          name: "bad_connector_tool",
          description: "Bad connector",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
      connector: "unknown-connector-xyz",
      mapping: {
        version: 1,
        operation: "search",
        argumentBindings: { query: "/q" },
      },
    });

    const runtime = createMockRuntime([
      {
        toolCalls: [
          { id: "tc_bad", name: "bad_connector_tool", args: {} },
        ],
      },
      { content: "Handled failure." },
    ]);

    const agent = await createAgent({
      permissionPipeline: true,
      runtime: runtime as never,
      tools: [badConnectorTool],
      approveTool: async () => {
        promptShown = true;
        return true;
      },
    } as never);

    await agent.chat("Run bad connector");
    expect(promptShown).toBe(false);
    const history = agent.getHistory();
    const toolMsg = history.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("CONNECTOR_UNKNOWN");
  });
});
