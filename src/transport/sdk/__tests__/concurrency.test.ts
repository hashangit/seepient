import { describe, it, expect } from "vitest";
import { createSeepient } from "../seepient.js";
import { createMockRuntime } from "../../../domain/__tests__/test-doubles.js";
import { runAgentLoop } from "../../../domain/agent-loop.js";

describe("SDK Concurrency & Mutex Correctness (Task 1.1, Task 1.2)", () => {
  it("two overlapping chat() calls serialize and resolve with correct turn ordering", async () => {
    let firstTurnActive = false;
    let turnOverlapDetected = false;

    const runtime = createMockRuntime([
      { content: "Response to first turn" },
      { content: "Response to second turn" },
    ]);

    const origExecute = runtime.executeLanguage.bind(runtime);
    let firstCall = true;
    runtime.executeLanguage = async function* (plan, req, opts) {
      if (firstCall) {
        firstCall = false;
        firstTurnActive = true;
        await new Promise((r) => setTimeout(r, 40));
        for await (const event of origExecute(plan, req, opts)) {
          yield event;
        }
        firstTurnActive = false;
      } else {
        if (firstTurnActive) {
          turnOverlapDetected = true;
        }
        for await (const event of origExecute(plan, req, opts)) {
          yield event;
        }
      }
    };

    const seepient = await createSeepient({
      runtime,
      tools: [],
    });

    const [res1, res2] = await Promise.all([
      seepient.chat("First turn"),
      seepient.chat("Second turn"),
    ]);

    expect(turnOverlapDetected).toBe(false);
    expect(res1.text).toBe("Response to first turn");
    expect(res2.text).toBe("Response to second turn");

    const history = seepient.getHistory();
    const userMessages = history.filter((m) => m.role === "user").map((m) => m.content);
    expect(userMessages).toEqual(["First turn", "Second turn"]);
  });

  it("chatStream() aborted mid-stream followed immediately by chat() completes without hanging", async () => {
    const runtime = createMockRuntime([
      { content: "Streaming partial content" },
      { content: "Immediate chat response" },
    ]);

    const seepient = await createSeepient({
      runtime,
      tools: [],
    });

    const stream = await seepient.chatStream("Stream prompt");
    for await (const _chunk of stream.textStream) {
      stream.abort();
      break;
    }

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Timeout: chat() hung after stream abort")), 2000),
    );

    const chatPromise = seepient.chat("Follow-up prompt");
    const result = await Promise.race([chatPromise, timeoutPromise]);

    expect(result).toBeDefined();
    expect(result.text).toBe("Immediate chat response");
  });

  it("runAgentLoop honors purpose and tier in the initial probe and in-loop plan resolution (Task 1.2)", async () => {
    const recordedCalls: Array<{ purpose?: string; tier?: string }> = [];

    const runtime = createMockRuntime([
      { content: "Processed image" },
    ]);

    const origResolvePlan = runtime.resolvePlan.bind(runtime);
    runtime.resolvePlan = async (snapshot, purpose, tier, override) => {
      recordedCalls.push({ purpose, tier });
      return origResolvePlan(snapshot, purpose, tier, override);
    };

    await runAgentLoop({
      runtime,
      model: "test-model",
      purpose: "vision",
      tier: "complex",
      messages: [{ id: "1", role: "user", content: "Analyze photo", timestamp: Date.now() }],
      toolDefs: [],
      maxSteps: 1,
    });

    expect(recordedCalls.length).toBeGreaterThanOrEqual(2);
    // Initial probe
    expect(recordedCalls[0].purpose).toBe("vision");
    expect(recordedCalls[0].tier).toBe("complex");
    // In-loop step
    expect(recordedCalls[1].purpose).toBe("vision");
    expect(recordedCalls[1].tier).toBe("complex");
  });

  it("chatStream() mutex survives persistence backend failure (FR-007, E7)", async () => {
    let saveCount = 0;
    const rejectingBackend = {
      save: async () => {
        saveCount++;
        if (saveCount === 1) {
          throw new Error("Persistence failed intentionally on turn 1");
        }
      },
      load: async () => null,
      delete: async () => {},
      list: async () => [],
    };

    const runtime = createMockRuntime([
      { content: "Turn 1 content" },
      { content: "Turn 2 content" },
    ]);

    const seepient = await createSeepient({
      runtime,
      tools: [],
      persist: rejectingBackend,
    });

    const stream = await seepient.chatStream("Turn 1 prompt");
    for await (const _chunk of stream.textStream) {
      // consume
    }

    await new Promise((r) => setTimeout(r, 20));

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Timeout: Turn 2 hung waiting for turn 1 mutex")), 2000),
    );

    const turn2Result = await Promise.race([
      seepient.chat("Turn 2 prompt"),
      timeoutPromise,
    ]);

    expect(turn2Result.text).toBe("Turn 2 content");
  });
});
