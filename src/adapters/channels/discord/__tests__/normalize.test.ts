import { describe, it, expect } from "vitest";
import { normalizeMessage } from "../normalize.js";
import type { DjsMessage } from "../normalize.js";

function dmMessage(content: string, authorId = "u1"): DjsMessage {
  return {
    id: "100",
    content,
    createdTimestamp: 1700000000,
    channelId: "dm-1",
    channel: { id: "dm-1", isDMBased: () => true },
    author: { id: authorId, username: "alice" },
    attachments: [],
  } as any;
}

function channelMessage(content: string): DjsMessage {
  return {
    id: "101",
    content,
    createdTimestamp: 1700000001,
    channelId: "ch-1",
    channel: { id: "ch-1", isDMBased: () => false, type: 0 },
    author: { id: "u2", username: "bob" },
    attachments: [],
  } as any;
}

describe("normalizeMessage (Discord)", () => {
  it("maps a DM to conversationType 'dm'", () => {
    const msg = normalizeMessage(dmMessage("hello"))!;
    expect(msg).toBeTruthy();
    expect(msg.conversationType).toBe("dm");
    expect(msg.conversationId).toBe("dm-1");
    expect(msg.senderId).toBe("u1");
    expect(msg.senderName).toBe("alice");
    expect(msg.text).toBe("hello");
  });

  it("maps a guild channel to conversationType 'channel'", () => {
    const msg = normalizeMessage(channelMessage("hi"))!;
    expect(msg.conversationType).toBe("channel");
    expect(msg.conversationId).toBe("ch-1");
  });

  it("extracts image attachments from contentType", () => {
    const message: DjsMessage = {
      id: "102",
      content: "see this",
      createdTimestamp: 0,
      channelId: "ch-1",
      channel: { id: "ch-1", isDMBased: () => false, type: 0 },
      author: { id: "u2", username: "bob" },
      attachments: [
        { id: "a1", url: "https://cdn/img.png", contentType: "image/png", name: "img.png" },
      ],
    } as any;
    const msg = normalizeMessage(message)!;
    expect(msg.media).toHaveLength(1);
    expect(msg.media![0].type).toBe("image");
    expect(msg.media![0].url).toBe("https://cdn/img.png");
    expect(msg.media![0].caption).toBe("img.png");
  });

  it("classifies audio attachments as voice", () => {
    const message: DjsMessage = {
      id: "103",
      content: "voice memo",
      createdTimestamp: 0,
      channelId: "dm-1",
      channel: { id: "dm-1", isDMBased: () => true },
      author: { id: "u1", username: "alice" },
      attachments: [
        { id: "a2", url: "https://cdn/v.ogg", contentType: "audio/ogg" },
      ],
    } as any;
    const msg = normalizeMessage(message)!;
    expect(msg.media![0].type).toBe("voice");
  });

  it("returns null for messages with no content and no attachments", () => {
    const message: DjsMessage = {
      id: "104",
      content: "",
      createdTimestamp: 0,
      channelId: "dm-1",
      channel: { id: "dm-1", isDMBased: () => true },
      author: { id: "u1", username: "alice" },
      attachments: [],
    } as any;
    expect(normalizeMessage(message)).toBeNull();
  });

  it("captures message reference threading", () => {
    const message: DjsMessage = {
      id: "105",
      content: "replying",
      createdTimestamp: 0,
      channelId: "ch-1",
      channel: { id: "ch-1", isDMBased: () => false, type: 0 },
      author: { id: "u2", username: "bob" },
      attachments: [],
      reference: { messageId: "90" },
    } as any;
    const msg = normalizeMessage(message)!;
    expect(msg.replyTo).toEqual({ messageId: "90", senderId: "" });
  });
});
