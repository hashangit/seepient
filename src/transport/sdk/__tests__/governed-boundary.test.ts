/**
 * Governed Boundary Integration Test Suite (Task 3.1).
 *
 * Asserts that every SDK entry point:
 * 1. createSeepient
 * 2. createAgent
 * 3. generateText
 * 4. streamText
 *
 * routes through the governed permission pipeline and execution boundary,
 * recording audit events in the injected AuditStore and enforcing fail-closed
 * execution.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSeepient,
  createAgent,
  generateText,
  streamText,
  trustedHostTool,
} from "../index.js";
import {
  FakeAuditStore,
  FakePolicyStore,
  FakeCapabilityLedger,
  createFakeRuntime,
} from "./helpers/fake-stores.js";
import { diskBackedFakeHelper } from "../../../capabilities/execution/__tests__/helpers/commit-helper-fakes.js";

describe("Governed Boundary Test Suite (Task 3.1)", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-gov-boundary-")));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("createSeepient routes tool execution through governed boundary and audit store", async () => {
    const auditStore = new FakeAuditStore();
    const policyStore = new FakePolicyStore();
    const capabilityLedger = new FakeCapabilityLedger();
    const filePath = join(workspaceDir, "seepient.txt");

    const runtime = createFakeRuntime({
      responses: [
        {
          toolCalls: [
            {
              id: "call-1",
              name: "write_file",
              args: { path: filePath, content: "seepient content" },
            },
          ],
        },
        { content: "Wrote seepient file successfully." },
      ],
    });

    const seepient = await createSeepient({
      cwd: workspaceDir,
      runtime,
      auditStore,
      policyStore,
      capabilityLedger,
      consentMode: "autonomous",
      commitHelper: diskBackedFakeHelper(),
      model: "mock-model",
    });

    const res = await seepient.chat("Write file");
    expect(res.text).toContain("Wrote seepient file successfully");
    expect(existsSync(filePath)).toBe(true);

    // Verified: Injected audit store captured the execution event
    expect(auditStore.appends.length).toBeGreaterThan(0);
    const writeEvent = auditStore.appends.find((a) => a.event.state === "succeeded");
    expect(writeEvent).toBeDefined();

    await seepient.close();
  });

  it("createAgent (alias) routes through governed boundary and audit store", async () => {
    const auditStore = new FakeAuditStore();
    const policyStore = new FakePolicyStore();
    const capabilityLedger = new FakeCapabilityLedger();
    const filePath = join(workspaceDir, "agent.txt");

    const runtime = createFakeRuntime({
      responses: [
        {
          toolCalls: [
            {
              id: "call-2",
              name: "write_file",
              args: { path: filePath, content: "agent content" },
            },
          ],
        },
        { content: "Wrote agent file successfully." },
      ],
    });

    const agent = await createAgent({
      cwd: workspaceDir,
      runtime,
      auditStore,
      policyStore,
      capabilityLedger,
      consentMode: "autonomous",
      commitHelper: diskBackedFakeHelper(),
      model: "mock-model",
    });

    const res = await agent.chat("Write file");
    expect(res.text).toContain("Wrote agent file successfully");
    expect(existsSync(filePath)).toBe(true);

    expect(auditStore.appends.length).toBeGreaterThan(0);
    const writeEvent = auditStore.appends.find((a) => a.event.state === "succeeded");
    expect(writeEvent).toBeDefined();

    await agent.close();
  });

  it("generateText routes through governed boundary and audit store", async () => {
    const auditStore = new FakeAuditStore();
    const policyStore = new FakePolicyStore();
    const capabilityLedger = new FakeCapabilityLedger();
    const filePath = join(workspaceDir, "gen.txt");

    const runtime = createFakeRuntime({
      responses: [
        {
          toolCalls: [
            {
              id: "call-3",
              name: "write_file",
              args: { path: filePath, content: "gen content" },
            },
          ],
        },
        { content: "Wrote gen file successfully." },
      ],
    });

    const res = await generateText("Write file", {
      cwd: workspaceDir,
      runtime,
      auditStore,
      policyStore,
      capabilityLedger,
      consentMode: "autonomous",
      commitHelper: diskBackedFakeHelper(),
      model: "mock-model",
    });

    expect(res.text).toContain("Wrote gen file successfully");
    expect(existsSync(filePath)).toBe(true);

    expect(auditStore.appends.length).toBeGreaterThan(0);
    const writeEvent = auditStore.appends.find((a) => a.event.state === "succeeded");
    expect(writeEvent).toBeDefined();
  });

  it("streamText routes through governed boundary and audit store", async () => {
    const auditStore = new FakeAuditStore();
    const policyStore = new FakePolicyStore();
    const capabilityLedger = new FakeCapabilityLedger();
    const filePath = join(workspaceDir, "stream.txt");

    const runtime = createFakeRuntime({
      responses: [
        {
          toolCalls: [
            {
              id: "call-4",
              name: "write_file",
              args: { path: filePath, content: "stream content" },
            },
          ],
        },
        { content: "Wrote stream file successfully." },
      ],
    });

    const streamRes = await streamText("Stream write file", {
      cwd: workspaceDir,
      runtime,
      auditStore,
      policyStore,
      capabilityLedger,
      consentMode: "autonomous",
      commitHelper: diskBackedFakeHelper(),
      model: "mock-model",
    });

    const fullText = await streamRes.fullText;
    expect(fullText).toContain("Wrote stream file successfully");
    expect(existsSync(filePath)).toBe(true);

    expect(auditStore.appends.length).toBeGreaterThan(0);
    const writeEvent = auditStore.appends.find((a) => a.event.state === "succeeded");
    expect(writeEvent).toBeDefined();
  });

  it("custom tools execute through registered host callbacks and boundary", async () => {
    const calls: string[] = [];
    const customProbe = trustedHostTool({
      definition: {
        type: "function",
        function: {
          name: "gov_custom_tool",
          description: "governed custom tool",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
      execute: async () => {
        calls.push("custom_invoked");
        return { output: "custom-ok", success: true };
      },
    });

    const runtime = createFakeRuntime({
      responses: [
        {
          toolCalls: [
            {
              id: "call-custom",
              name: "gov_custom_tool",
              args: {},
            },
          ],
        },
        { content: "Custom tool completed." },
      ],
    });

    const agent = await createSeepient({
      cwd: workspaceDir,
      runtime,
      tools: [customProbe],
      approveTool: async () => true,
    });

    const res = await agent.chat("Run custom");
    expect(calls).toEqual(["custom_invoked"]);
    expect(res.text).toContain("Custom tool completed");

    await agent.close();
  });
});
