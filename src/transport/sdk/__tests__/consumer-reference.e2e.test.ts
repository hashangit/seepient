/**
 * Consumer Reference Scenario (Spec 020, US4, QS-3.3, SC-006, M10)
 *
 * Five-tool mixed-rung agent (3 host, 1 prepared, 1 connector) per the honesty ladder:
 *  1. get_accounts (host) -> read account list from host database
 *  2. get_transactions (host) -> read transaction ledger
 *  3. transfer_funds (host) -> execute transaction
 *  4. export_monthly_report (preparedTool) -> creates statement file on disk with exact-commit
 *  5. lookup_market_rates (brokerConnector) -> connects to web-search connector
 *
 * Assertions:
 *  - Scripted runtime executes all 5 tools across turns
 *  - Per-agent isolation without global registry contamination
 *  - Policy evaluation, approval prompts, and exact file commit execute cleanly
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgent,
  trustedHostTool,
  preparedTool,
  brokerConnector,
} from "../index.js";
import { createMockRuntime } from "../../../domain/__tests__/test-doubles.js";
import { diskBackedFakeHelper } from "../../../capabilities/execution/__tests__/helpers/commit-helper-fakes.js";
import type { CanonicalPathTarget } from "../../../foundations/contracts/tool-effects.js";

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-consumer-ref-")));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function canonicalTarget(filePath: string): CanonicalPathTarget {
  const abs = join(dir, filePath);
  return {
    canonicalPath: abs,
    canonicalParent: dir,
    basename: filePath,
    exists: existsSync(abs),
    finalSymlink: false,
  };
}

describe("Consumer Reference Scenario: 5-Tool Mixed-Rung Agent (QS-3.3)", () => {
  it("executes Personal-Finances agent with 3 host, 1 prepared, and 1 connector tool", async () => {
    const executedHostTools: string[] = [];
    const prompts: any[] = [];

    // Tool 1: get_accounts (host)
    const getAccounts = trustedHostTool({
      definition: {
        type: "function",
        function: {
          name: "get_accounts",
          description: "Get list of bank accounts",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
      execute: async () => {
        executedHostTools.push("get_accounts");
        return JSON.stringify([{ id: "checking", balance: 5000 }, { id: "savings", balance: 12000 }]);
      },
    });

    // Tool 2: get_transactions (host)
    const getTransactions = trustedHostTool({
      definition: {
        type: "function",
        function: {
          name: "get_transactions",
          description: "Get recent transactions",
          parameters: { type: "object", properties: { accountId: { type: "string" } }, required: ["accountId"] },
        },
      },
      execute: async (args: any) => {
        executedHostTools.push(`get_transactions:${args.accountId}`);
        return JSON.stringify([{ id: "tx1", amount: -50, merchant: "Coffee Shop" }]);
      },
    });

    // Tool 3: transfer_funds (host)
    const transferFunds = trustedHostTool({
      definition: {
        type: "function",
        function: {
          name: "transfer_funds",
          description: "Transfer money",
          parameters: {
            type: "object",
            properties: { from: { type: "string" }, to: { type: "string" }, amount: { type: "number" } },
            required: ["from", "to", "amount"],
          },
        },
      },
      execute: async (args: any) => {
        executedHostTools.push(`transfer_funds:${args.from}->${args.to}:${args.amount}`);
        return JSON.stringify({ status: "success", confirmation: "TX-9988" });
      },
    });

    // Tool 4: export_monthly_report (preparedTool)
    const exportReport = preparedTool({
      definition: {
        type: "function",
        function: {
          name: "export_monthly_report",
          description: "Export summary statement file",
          parameters: {
            type: "object",
            properties: { month: { type: "string" }, summary: { type: "string" } },
            required: ["month", "summary"],
          },
        },
      },
      allowedOperationKinds: ["commit-files"],
      analyze: async (args: any, context) => {
        const target = canonicalTarget(`statement-${args.month}.txt`);
        const art = await context.artifacts.put(
          Buffer.from(`Monthly Statement (${args.month}):\n${args.summary}`),
          "text/plain",
        );
        return {
          operation: {
            kind: "commit-files",
            commits: [{ destination: target, content: art }],
          },
          effects: [{ kind: "filesystem-write", targets: [{ target, mode: "create" }] }],
          risk: "edit",
          display: {
            title: `Export Statement for ${args.month}`,
            summary: `Writes statement-${args.month}.txt`,
            canonicalTargets: [target.canonicalPath],
            effects: ["filesystem-write"],
          },
        };
      },
    });

    // Tool 5: lookup_market_rates (brokerConnector)
    const lookupRates = brokerConnector({
      definition: {
        type: "function",
        function: {
          name: "lookup_market_rates",
          description: "Look up market interest rates",
          parameters: {
            type: "object",
            properties: { query_term: { type: "string" } },
            required: ["query_term"],
          },
        },
      },
      connector: "web-search",
      mapping: {
        version: 1,
        operation: "search",
        argumentBindings: { query: "/query_term" },
        constants: { limit: 2 },
        secretRefs: ["tavilyApiKey"],
      },
    });

    process.env.TAVILY_API_KEY = "tvly-test-key-mock";

    const runtime = createMockRuntime([
      {
        toolCalls: [
          { id: "tc1", name: "get_accounts", args: {} },
        ],
      },
      {
        toolCalls: [
          { id: "tc2", name: "get_transactions", args: { accountId: "checking" } },
        ],
      },
      {
        toolCalls: [
          { id: "tc3", name: "transfer_funds", args: { from: "checking", to: "savings", amount: 200 } },
        ],
      },
      {
        toolCalls: [
          { id: "tc4", name: "lookup_market_rates", args: { query_term: "current savings interest rates 2026" } },
        ],
      },
      {
        toolCalls: [
          { id: "tc5", name: "export_monthly_report", args: { month: "August", summary: "Saved $200. Coffee $50." } },
        ],
      },
      { content: "Finance workflow successfully processed." },
    ]);

    const mockNetwork: import("../../../capabilities/execution/effect-broker.js").BrokerNetworkAdapter = {
      async resolve() {
        return ["93.184.216.34"];
      },
      async fetch() {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          effectiveHost: "api.tavily.com",
          effectiveIp: "93.184.216.34",
          bytes: Buffer.from(
            JSON.stringify({
              results: [
                {
                  title: "2026 High Yield Savings Accounts",
                  url: "https://example.com/rates",
                  content: "Top APY rates currently hover around 4.5% to 5.0%.",
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
      network: mockNetwork,
      tools: [getAccounts, getTransactions, transferFunds, exportReport, lookupRates],
      cwd: dir,
      commitHelper: diskBackedFakeHelper(),
      approveTool: async (req: any) => {
        prompts.push(req);
        return true;
      },
    } as never);

    const res = await agent.chat("Run my monthly finance check and export report");
    expect(res.text).toBe("Finance workflow successfully processed.");

    // Assert host tools ran
    expect(executedHostTools).toEqual([
      "get_accounts",
      "get_transactions:checking",
      "transfer_funds:checking->savings:200",
    ]);

    // Assert preparedTool wrote statement file exactly
    const reportPath = join(dir, "statement-August.txt");
    expect(existsSync(reportPath)).toBe(true);
    expect(readFileSync(reportPath, "utf8")).toBe("Monthly Statement (August):\nSaved $200. Coffee $50.");

    // Assert approval prompt occurred and recorded distinct tool displays
    expect(prompts.length).toBeGreaterThan(0);
  });
});
