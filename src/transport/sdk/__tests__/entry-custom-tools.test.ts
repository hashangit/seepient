/**
 * Public SDK Entry & Custom Tools Integration Test Suite (0.5.7)
 *
 * Verifies:
 *  1. Custom tool factories and types are exported directly from package entry.
 *  2. Multi-tool per-agent execution through createAgent({ permissionPipeline: true }).
 *  3. generateText execution with explicit trustedHostTool registrations.
 *  4. Seepient.listProviders() derives distinct upstream providers from the catalog.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgent,
  generateText,
  createSeepient,
  preparedTool,
  brokerConnector,
  trustedHostTool,
  type AnyToolRegistration,
  type TrustedHostToolRegistration,
  type PreparedToolRegistration,
  type BrokerConnectorRegistration,
  type LegacyHostToolRegistration,
  type HostToolContext,
} from "../index.js";
import { createMockRuntime } from "../../../domain/__tests__/test-doubles.js";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-entry-custom-tools-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("SDK Entry Re-exports (W1)", () => {
  it("exports trustedHostTool factory directly from package entry", () => {
    expect(typeof trustedHostTool).toBe("function");
  });

  it("constructs valid registration records from custom tool factories", () => {
    const hostReg: TrustedHostToolRegistration = trustedHostTool({
      definition: {
        type: "function",
        function: {
          name: "get_balance",
          description: "Get account balance",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
      execute: async (_args, _ctx: HostToolContext) => "100.00",
    });
    expect(hostReg.trust).toBe("host");
    expect(hostReg.definition.function.name).toBe("get_balance");

    const prepReg: PreparedToolRegistration = preparedTool({
      definition: {
        type: "function",
        function: {
          name: "prep_action",
          description: "Prepare action",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
      allowedOperationKinds: ["commit-files"],
      analyze: async () => {
        const target = {
          canonicalPath: "/workspace/prep.txt",
          canonicalParent: "/workspace",
          basename: "prep.txt",
          exists: false,
          finalSymlink: false,
        };
        return {
          operation: {
            kind: "commit-files" as const,
            commits: [
              {
                destination: target,
                content: { artifactId: "art-prep", byteLength: 5, mediaType: "text/plain", sha256: "sha256:5678" },
              },
            ],
          },
          effects: [{ kind: "filesystem-write" as const, targets: [{ target, mode: "create" }] }],
          risk: "edit" as const,
          display: { title: "prep_action", summary: "Prepare action", canonicalTargets: [target.canonicalPath], effects: ["filesystem-write" as const] },
        };
      },
    });
    expect(prepReg.kind).toBe("prepared");
    expect(prepReg.trust).toBe("analyzer");

    const brokerReg: BrokerConnectorRegistration = brokerConnector({
      definition: {
        type: "function",
        function: {
          name: "search_broker",
          description: "Search broker",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
      connector: "tavily",
      mapping: {
        version: 1,
        operation: "search",
        argumentBindings: { query: "/query" },
      },
    });
    expect(brokerReg.kind).toBe("broker-connector");
  });
});

describe("Multi-tool per-agent composition (W1, W2)", () => {
  it("executes multiple registered trustedHostTools through createAgent({ permissionPipeline: true }) without global registry", async () => {
    const calls: string[] = [];

    const getBalanceTool = trustedHostTool({
      definition: {
        type: "function",
        function: {
          name: "get_account_balance",
          description: "Query bank balance",
          parameters: {
            type: "object",
            properties: { accountId: { type: "string" } },
            required: ["accountId"],
          },
        },
      },
      execute: async (args) => {
        const { accountId } = (args ?? {}) as { accountId: string };
        calls.push(`get_account_balance:${accountId}`);
        return { output: JSON.stringify({ accountId, balance: 4200 }), success: true };
      },
    });

    const transferTool = trustedHostTool({
      definition: {
        type: "function",
        function: {
          name: "transfer_funds",
          description: "Transfer money between accounts",
          parameters: {
            type: "object",
            properties: {
              from: { type: "string" },
              to: { type: "string" },
              amount: { type: "number" },
            },
            required: ["from", "to", "amount"],
          },
        },
      },
      execute: async (args) => {
        const { from, to, amount } = (args ?? {}) as { from: string; to: string; amount: number };
        calls.push(`transfer_funds:${from}->${to}:${amount}`);
        return { output: JSON.stringify({ txId: "tx_123", status: "completed" }), success: true };
      },
    });

    const runtime = createMockRuntime([
      {
        toolCalls: [
          {
            id: "tc_bal",
            name: "get_account_balance",
            args: { accountId: "acc_checking" },
          },
        ],
      },
      {
        toolCalls: [
          {
            id: "tc_tx",
            name: "transfer_funds",
            args: { from: "acc_checking", to: "acc_savings", amount: 500 },
          },
        ],
      },
      { content: "Transfer complete." },
    ]);

    const tools: AnyToolRegistration[] = [getBalanceTool, transferTool];

    const agent = await createAgent({
      permissionPipeline: true,
      runtime: runtime as never,
      tools,
      cwd: dir,
      approveTool: async () => true,
    } as never);

    const response = await agent.chat("Check balance and transfer 500");
    expect(calls).toEqual([
      "get_account_balance:acc_checking",
      "transfer_funds:acc_checking->acc_savings:500",
    ]);
    expect(response.text).toBe("Transfer complete.");
  });
});

describe("generateText with trustedHostTool registration (W2)", () => {
  it("executes a registered host tool in one-shot generateText", async () => {
    const calls: string[] = [];

    const calculateTaxTool = trustedHostTool({
      definition: {
        type: "function",
        function: {
          name: "calculate_tax",
          description: "Calculate tax rate",
          parameters: {
            type: "object",
            properties: { amount: { type: "number" } },
            required: ["amount"],
          },
        },
      },
      execute: async (args) => {
        const { amount } = (args ?? {}) as { amount: number };
        calls.push(`tax:${amount}`);
        return `Tax is ${amount * 0.2}`;
      },
    });

    const runtime = createMockRuntime([
      {
        toolCalls: [
          {
            id: "tc_tax",
            name: "calculate_tax",
            args: { amount: 1000 },
          },
        ],
      },
      { content: "Calculation finished: Tax is 200" },
    ]);

    const result = await generateText("Calculate tax on 1000", {
      permissionPipeline: true,
      runtime: runtime as never,
      tools: [calculateTaxTool],
      cwd: dir,
      approveTool: async () => true,
    } as never);

    expect(calls).toEqual(["tax:1000"]);
    expect(result.text).toBe("Calculation finished: Tax is 200");
  });
});

describe("Seepient.listProviders (W3)", () => {
  it("derives distinct sorted upstreamProvider values from catalog", async () => {
    const seepient = await createSeepient({
      overlayFile: ":memory:",
    });

    const providers = await seepient.listProviders();
    expect(Array.isArray(providers)).toBe(true);
    expect(providers.length).toBeGreaterThan(0);
    // Values should be distinct and sorted
    const sortedCopy = [...providers].sort();
    expect(providers).toEqual(sortedCopy);
    const set = new Set(providers);
    expect(set.size).toBe(providers.length);
  });
});
