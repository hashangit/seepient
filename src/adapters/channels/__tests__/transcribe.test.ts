import { describe, it, expect, beforeEach } from "vitest";
import { transcribeVoice, configureTranscription } from "../transcribe.js";
import type { MediaAttachment } from "../types.js";

function voice(data: Buffer, url?: string): MediaAttachment {
  return { type: "voice", data, ...(url ? { url } : {}) };
}

describe("transcribeVoice (fail-safe)", () => {
  beforeEach(() => {
    configureTranscription(null);
  });

  it("returns an empty string when no backend is configured (fail-safe)", async () => {
    expect(await transcribeVoice(voice(Buffer.from("x")))).toBe("");
  });

  it("uses a configured backend and caches by content hash", async () => {
    let calls = 0;
    configureTranscription(async () => {
      calls++;
      return "hello world";
    });
    const media = voice(Buffer.from("audio-bytes"));
    expect(await transcribeVoice(media)).toBe("hello world");
    expect(await transcribeVoice(media)).toBe("hello world"); // cache hit
    expect(calls).toBe(1);
  });

  it("returns an empty string when the backend throws (fail-safe)", async () => {
    configureTranscription(async () => {
      throw new Error("upstream down");
    });
    expect(await transcribeVoice(voice(Buffer.from("y")))).toBe("");
  });

  it("distinguishes different content hashes", async () => {
    const seen: string[] = [];
    configureTranscription(async (m) => {
      seen.push(m.data!.toString());
      return m.data!.toString();
    });
    await transcribeVoice(voice(Buffer.from("a")));
    await transcribeVoice(voice(Buffer.from("b")));
    expect(seen.sort()).toEqual(["a", "b"]);
  });
});
