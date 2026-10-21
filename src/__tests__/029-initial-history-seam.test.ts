/**
 * Spec 029 (M02 T028): the `initialHistory` hydration seam — externally owned
 * product history seeds a stateless agent exactly once at construction; the
 * engine never writes back to the product store (single history authority).
 */
import { describe, expect, it } from "vitest";
import { createSeepient } from "../transport/sdk/seepient.js";

describe("createSeepient initialHistory hydration seam (029 T028)", () => {
  it("seeds stateless history once, preserving the system prompt", async () => {
    const agent = await createSeepient({
      stateless: true,
      tenancy: "single",
      systemPrompt: "engine instructions",
      initialHistory: [
        { id: "m1", role: "user", content: "hi", timestamp: 1 },
        { id: "m2", role: "assistant", content: "hello", timestamp: 2 },
      ],
    });
    try {
      const history = agent.getHistory();
      expect(history).toHaveLength(3);
      expect(history[0].role).toBe("system");
      // The engine composes its system prompt (skills catalog appended).
      expect(history[0].content.startsWith("engine instructions")).toBe(true);
      expect(history[1]).toMatchObject({ role: "user", content: "hi" });
      expect(history[2]).toMatchObject({ role: "assistant", content: "hello" });
    } finally {
      await agent.close();
    }
  });

  it("stays inert when initialHistory is absent (behavior unchanged)", async () => {
    const agent = await createSeepient({ stateless: true, tenancy: "single", systemPrompt: "only" });
    try {
      const history = agent.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].role).toBe("system");
    } finally {
      await agent.close();
    }
  });
});
