import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { TuiApp } from "../app.js";
import type { Agent } from "../../../transport/cli/agent.js";
import type { SkillRegistry } from "../../../capabilities/skills/index.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > 3000) {
      throw new Error(`waitFor timeout: ${what}`);
    }
    await tick();
  }
}

describe("TUI slash-command skill launch & REPL parity", () => {
  it("launches an installed skill when slash command matches skill in registry", async () => {
    const mockSkill = {
      name: "sample-skill",
      description: "A test skill",
      body: "Instructions for sample skill",
    };

    const mockRegistry: Partial<SkillRegistry> = {
      get: vi.fn((name: string) => (name === "sample-skill" ? (mockSkill as any) : undefined)),
      getAll: vi.fn(() => [mockSkill as any]),
      getBody: vi.fn(async (name: string) => (name === "sample-skill" ? mockSkill.body : undefined)),
    };

    const chatCalls: Array<{ input: string; providerFactory?: any }> = [];
    const fakeAgent = {
      chat: vi.fn(async (input: string, signal?: any, approveTool?: any, onStep?: any, providerFactory?: any) => {
        chatCalls.push({ input, providerFactory });
        return { finishReason: "stop" };
      }),
      createAbortSignal: vi.fn(() => new AbortController().signal),
      isPermissionPipelineEnabled: vi.fn(() => false),
      setPipelineApprovalBroker: vi.fn(),
      getSkillRegistry: vi.fn(() => mockRegistry as SkillRegistry),
      getProviderRuntime: vi.fn(() => ({
        getSlot: vi.fn(),
        getAccount: vi.fn(),
        listSlots: vi.fn(() => []),
      })),
      getConsentMode: vi.fn(() => "edit-enabled" as const),
      getModel: vi.fn(() => "mock-model"),
      clearConversation: vi.fn(),
    } as unknown as Agent;

    const dispatchCommand = vi.fn(async () => ({ status: "fallthrough" as const }));

    const { stdin, lastFrame } = render(
      <TuiApp
        agent={fakeAgent}
        consentMode="edit-enabled"
        onExit={() => {}}
        dispatchCommand={dispatchCommand}
        commands={[]}
        skills={[]}
        resetView={() => {}}
        providerType="mock"
        gatewayOn={false}
        skillCount={1}
        mcpCount={0}
        getSettingsList={() => []}
        onSetSetting={async () => {}}
        listSessions={async () => []}
        onSwitchSession={async () => null}
        onDeleteSession={async () => {}}
        onExportSession={async () => null}
        onTranscriptSession={async () => null}
        onRenameSession={async () => true}
        getSessionId={() => "sess-test"}
      />,
    );

    await tick();

    // Type "/sample-skill" then Enter
    stdin.write("/sample-skill");
    await tick();
    stdin.write("\r");

    await waitFor(() => chatCalls.length > 0, "agent.chat to be called with skill prompt");

    expect(chatCalls.length).toBe(1);
    expect(chatCalls[0].input).toContain("Instructions for sample skill");
    expect(lastFrame()).toContain("Loading skill: sample-skill");
  });

  it("appends unknown command info entry when command matches neither built-in nor skill", async () => {
    const mockRegistry: Partial<SkillRegistry> = {
      get: vi.fn(() => undefined),
      getAll: vi.fn(() => []),
      getBody: vi.fn(async () => undefined),
    };

    const chatCalls: string[] = [];
    const fakeAgent = {
      chat: vi.fn(async (input: string) => {
        chatCalls.push(input);
        return { finishReason: "stop" };
      }),
      createAbortSignal: vi.fn(() => new AbortController().signal),
      isPermissionPipelineEnabled: vi.fn(() => false),
      setPipelineApprovalBroker: vi.fn(),
      getSkillRegistry: vi.fn(() => mockRegistry as SkillRegistry),
      getProviderRuntime: vi.fn(() => ({})),
      getConsentMode: vi.fn(() => "edit-enabled" as const),
      getModel: vi.fn(() => "mock-model"),
      clearConversation: vi.fn(),
    } as unknown as Agent;

    const dispatchCommand = vi.fn(async () => ({ status: "fallthrough" as const }));

    const { stdin, lastFrame } = render(
      <TuiApp
        agent={fakeAgent}
        consentMode="edit-enabled"
        onExit={() => {}}
        dispatchCommand={dispatchCommand}
        commands={[]}
        skills={[]}
        resetView={() => {}}
        providerType="mock"
        gatewayOn={false}
        skillCount={0}
        mcpCount={0}
        getSettingsList={() => []}
        onSetSetting={async () => {}}
        listSessions={async () => []}
        onSwitchSession={async () => null}
        onDeleteSession={async () => {}}
        onExportSession={async () => null}
        onTranscriptSession={async () => null}
        onRenameSession={async () => true}
        getSessionId={() => "sess-test"}
      />,
    );

    await tick();

    // Type "/nonexistent-cmd" then Enter
    stdin.write("/nonexistent-cmd");
    await tick();
    stdin.write("\r");

    await waitFor(
      () => lastFrame()?.includes("Unknown command: /nonexistent-cmd") ?? false,
      "feed to show unknown command info entry",
    );

    expect(chatCalls.length).toBe(0);
    expect(lastFrame()).toContain("Unknown command: /nonexistent-cmd. Type /? for help.");
    expect(lastFrame()).not.toContain("arrives in US2");
  });
});
