import { describe, it, expect } from "vitest";
import { normalizeUpdate, extractMedia } from "../normalize.js";
import type { TgUpdate } from "../normalize.js";

function privateTextUpdate(text: string, fromId = 111): TgUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1700000000,
      chat: { id: -1, type: "private" },
      from: { id: fromId, first_name: "Alice" },
      text,
    },
  };
}

function groupTextUpdate(text: string): TgUpdate {
  return {
    update_id: 2,
    message: {
      message_id: 11,
      date: 1700000001,
      chat: { id: -100, type: "group", title: "Team" },
      from: { id: 222, first_name: "Bob" },
      text,
    },
  };
}

describe("normalizeUpdate", () => {
  it("maps a private chat to conversationType 'dm'", async () => {
    const msg = await normalizeUpdate(privateTextUpdate("hello"));
    expect(msg).not.toBeNull();
    expect(msg!.conversationType).toBe("dm");
    expect(msg!.conversationId).toBe("-1");
    expect(msg!.senderId).toBe("111");
    expect(msg!.senderName).toBe("Alice");
    expect(msg!.text).toBe("hello");
  });

  it("maps a group chat to conversationType 'group'", async () => {
    const msg = await normalizeUpdate(groupTextUpdate("hi all"));
    expect(msg!.conversationType).toBe("group");
    expect(msg!.conversationId).toBe("-100");
  });

  it("extracts media from a photo update and keeps the caption as text", async () => {
    const update: TgUpdate = {
      update_id: 3,
      message: {
        message_id: 12,
        date: 1700000002,
        chat: { id: -1, type: "private" },
        from: { id: 111, first_name: "Alice" },
        caption: "look at this",
        photo: [
          { file_id: "small", width: 100, height: 100 },
          { file_id: "large", width: 800, height: 600 },
        ],
      },
    };
    const msg = await normalizeUpdate(update);
    expect(msg).not.toBeNull();
    expect(msg!.text).toBe("look at this");
    expect(msg!.media).toHaveLength(1);
    expect(msg!.media![0].type).toBe("image");
    // Largest size selected.
    expect(msg!.media![0].url).toBe("large");
  });

  it("extracts voice attachments", async () => {
    const update: TgUpdate = {
      update_id: 4,
      message: {
        message_id: 13,
        date: 1700000003,
        chat: { id: -1, type: "private" },
        from: { id: 111, first_name: "Alice" },
        voice: { file_id: "voice-1", duration: 5, mime_type: "audio/ogg" },
      },
    };
    const msg = await normalizeUpdate(update);
    expect(msg!.media).toHaveLength(1);
    expect(msg!.media![0].type).toBe("voice");
    expect(msg!.media![0].mimeType).toBe("audio/ogg");
  });

  it("returns null for updates with no message and no media", async () => {
    const update: TgUpdate = {
      update_id: 5,
      message: {
        message_id: 14,
        date: 1700000004,
        chat: { id: -1, type: "private" },
        from: { id: 111, first_name: "Alice" },
        // no text, no media
      },
    };
    expect(await normalizeUpdate(update)).toBeNull();
  });

  it("returns null when the update has no message at all", async () => {
    expect(await normalizeUpdate({ update_id: 6 })).toBeNull();
  });

  it("captures reply_to threading context", async () => {
    const update: TgUpdate = {
      update_id: 7,
      message: {
        message_id: 20,
        date: 1700000005,
        chat: { id: -1, type: "private" },
        from: { id: 111, first_name: "Alice" },
        text: "replying",
        reply_to_message: {
          message_id: 19,
          date: 1700000000,
          chat: { id: -1, type: "private" },
          from: { id: 222, first_name: "Bob" },
          text: "original",
        },
      },
    };
    const msg = await normalizeUpdate(update);
    expect(msg!.replyTo).toEqual({ messageId: "19", senderId: "222" });
  });

  it("selects the largest photo size", () => {
    const media = extractMedia({
      message_id: 1,
      date: 0,
      chat: { id: 1, type: "private" },
      photo: [
        { file_id: "a", width: 10, height: 10 },
        { file_id: "b", width: 1000, height: 1000 },
        { file_id: "c", width: 50, height: 50 },
      ],
    } as any);
    expect(media[0].url).toBe("b");
  });
});
