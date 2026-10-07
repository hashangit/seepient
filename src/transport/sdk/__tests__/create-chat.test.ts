/**
 * Spec 027 (T009/D14): createChat — the multi-turn front door. Thin sugar
 * over the stateless agent; the session owns its history across turns.
 */
import { describe, it, expect } from "vitest";
import { createChat } from "../chat.js";
import { createMockRuntime } from "../../../domain/__tests__/test-doubles.js";

describe("createChat (spec 027 D14)", () => {
  it("carries message history across turns and supports send + stream", async () => {
    const runtime = createMockRuntime([
      { content: "first answer" },
      { content: "second answer" },
      { content: "streamed answer" },
    ]);

    const chat = await createChat({
      stateless: true,
      tenancy: "single",
      runtime: runtime as never,
      skills: false,
    } as never);

    const first = await chat.send("hello");
    expect(first.text).toBe("first answer");
    expect(chat.messages.some((m) => m.role === "user" && m.content === "hello")).toBe(true);

    const second = await chat.send("again");
    expect(second.text).toBe("second answer");
    // The session owns its history: both turns are present.
    expect(chat.messages.filter((m) => m.role === "assistant").length).toBe(2);

    const streamed = await chat.stream("stream please");
    let streamedText = "";
    for await (const delta of streamed.textStream) streamedText += delta;
    expect(streamedText).toBe("streamed answer");
    expect(await streamed.finishReason).toBe("stop");
  });
});
