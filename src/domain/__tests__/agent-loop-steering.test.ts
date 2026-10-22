/**
 * 029 T034 — per-step steering claim at safe model-turn boundaries (FR-027).
 * The loop claims BEFORE each provider request; claimed items ride the next
 * request as tagged user content; seen-ID suppression fences duplicates.
 */
import { describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../agent-loop.js";
import type { ClaimedSteeringItem } from "../agent-loop.js";
import { createMockRuntime } from "./test-doubles.js";
import type { ToolModule } from "../../foundations/contracts/tool.js";
import { ToolRegistry } from "../tool-executor.js";

describe("029 S15 — per-step steering claim (T034)", () => {
  it("busy-turn steering: a follow-up arriving mid-run is consumed at the next boundary and rides the next request", async () => {
    // The store: first claim (step 0) returns nothing; the follow-up lands
    // between steps; the step-1 claim returns it exactly once.
    let step = 0;
    const claimCalls: string[][] = [];
    const store = [
      { id: "steer-1", text: "Also deploy to staging." },
    ];
    const claimSteering = vi.fn(async (seenIds: string[]) => {
      claimCalls.push([...seenIds]);
      step += 1;
      if (step === 1) return []; // nothing yet at the first boundary
      return store.filter((m) => !seenIds.includes(m.id));
    });

    const runtime = createMockRuntime([
      {
        text: "I will deploy.",
        toolCalls: [{ id: "call-1", name: "get_current_datetime", arguments: "{}" }],
      },
      { text: "Deployed." },
    ]);

    const result = await runAgentLoop({
      runtime,
      messages: [{ id: "m1", role: "user", content: "Deploy to production", timestamp: Date.now() }],
      toolDefs: [],
      maxSteps: 4,
      autoConfirm: true,
      claimSteering,
    });

    // Claimed at every boundary (2 claims for 2 provider turns).
    expect(claimCalls).toHaveLength(2);
    expect(claimCalls[0]).toEqual([]);
    // The steering item rode the second request as tagged user content.
    const steerMessages = result.messages.filter(
      (m) => m.role === "user" && (m.content as string).includes("[steering] Also deploy to staging."),
    );
    expect(steerMessages).toHaveLength(1);
  });

  it("duplicate claim fencing: the store's seen-ID suppression is honored by the loop", async () => {
    // A broken store that returns the same item twice: the loop must not
    // inject it twice (its own claimedSteeringIds fence).
    const item: ClaimedSteeringItem = { id: "steer-dup", text: "Deploy to staging." };
    const claimSteering = vi.fn(async () => [item]);

    const runtime = createMockRuntime([
      { text: "Working." },
      { text: "Working more." },
      { text: "Done." },
    ]);

    const result = await runAgentLoop({
      runtime,
      messages: [{ id: "m1", role: "user", content: "go", timestamp: Date.now() }],
      toolDefs: [],
      maxSteps: 4,
      autoConfirm: true,
      claimSteering,
    });

    const steerMessages = result.messages.filter(
      (m) => m.role === "user" && (m.content as string).includes("[steering] Deploy to staging."),
    );
    expect(steerMessages).toHaveLength(1);
  });

  it("image-bearing steering rides the injected user message", async () => {
    let claimed = false;
    const claimSteering = vi.fn(async (seenIds: string[]) => {
      if (claimed) return [];
      claimed = true;
      return [
        {
          id: "steer-img",
          text: "Use this screenshot.",
          images: [{ data: "QUJD", mimeType: "image/png" }],
        },
      ];
    });

    const runtime = createMockRuntime([{ text: "Looking at it." }, { text: "Done." }]);
    const result = await runAgentLoop({
      runtime,
      messages: [{ id: "m1", role: "user", content: "check", timestamp: Date.now() }],
      toolDefs: [],
      maxSteps: 3,
      autoConfirm: true,
      claimSteering,
    });
    const injected = result.messages.find(
      (m) => m.role === "user" && (m.content as string).includes("[steering] Use this screenshot."),
    );
    expect(injected?.images).toEqual([{ data: "QUJD", mimeType: "image/png" }]);
  });

  it("a claim failure never kills the run (non-fatal steering)", async () => {
    const claimSteering = vi.fn(async () => {
      throw new Error("steering store unavailable");
    });
    const runtime = createMockRuntime([{ text: "Done regardless." }]);
    const result = await runAgentLoop({
      runtime,
      messages: [{ id: "m1", role: "user", content: "go", timestamp: Date.now() }],
      toolDefs: [],
      maxSteps: 2,
      autoConfirm: true,
      claimSteering,
    });
    expect(result.finishReason).toBe("stop");
    expect(result.messages.some((m) => (m.content as string) === "Done regardless.")).toBe(true);
  });

  it("executes a registered tool normally alongside per-step steering (wiredPipeline)", async () => {
    const claims: string[][] = [];
    const claimSteering = vi.fn(async (seenIds: string[]) => {
      claims.push([...seenIds]);
      return [];
    });
    const executed = vi.fn(async () => ({ success: true, output: "date is X" }));
    const tool: ToolModule = {
      definition: {
        type: "function",
        function: { name: "get_current_datetime", description: "date", parameters: { type: "object", properties: {}, required: [] } },
      },
      name: "get_current_datetime",
      handler: executed,
    };
    const registry = new ToolRegistry([tool]);
    const runtime = createMockRuntime([
      { text: "checking", toolCalls: [{ id: "c1", name: "get_current_datetime", arguments: "{}" }] },
      { text: "done" },
    ]);
    const result = await runAgentLoop({
      runtime,
      messages: [{ id: "m1", role: "user", content: "what date", timestamp: Date.now() }],
      toolDefs: registry.definitions(),
      toolRegistry: registry,
      maxSteps: 3,
      autoConfirm: true,
      claimSteering,
    });
    expect(executed).toHaveBeenCalled();
    expect(result.finishReason).toBe("stop");
    // The loop claimed at each of the 2 provider turns.
    expect(claims).toHaveLength(2);
  });
});
