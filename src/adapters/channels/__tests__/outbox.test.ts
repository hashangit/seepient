import { describe, it, expect, vi } from "vitest";
import { Outbox, MemoryOutboxStorage } from "../outbox.js";

function conv(id = "chat-1") {
  return { conversationId: id, conversationType: "dm" as const };
}

describe("Outbox — proactive scheduling + rate limiting (T048)", () => {
  it("fires scheduled entries at their scheduledFor time", async () => {
    const fires: string[] = [];
    const outbox = new Outbox({
      storage: new MemoryOutboxStorage(),
      pollIntervalMs: 5,
      onFire: (e) => fires.push(e.payload.text ?? ""),
    });
    outbox.setDeliverFn(async (_p, _c, payload) => {
      // delivery recorded via onFire
    });
    await outbox.start();

    await outbox.enqueue({
      sessionId: "s1",
      platform: "telegram",
      conversation: conv(),
      payload: { text: "ping" },
      scheduledFor: Date.now() + 10,
      trigger: "scheduled",
    });

    await new Promise((r) => setTimeout(r, 60));
    expect(fires).toContain("ping");
    await outbox.stop();
  });

  it("rate-limits to maxPerConversationPerMin per conversation", async () => {
    const delivered: string[] = [];
    const outbox = new Outbox({
      storage: new MemoryOutboxStorage(),
      pollIntervalMs: 5,
      maxPerConversationPerMin: 2,
    });
    outbox.setDeliverFn(async (_p, _c, payload) => {
      delivered.push(payload.text ?? "");
    });
    await outbox.start();

    // Enqueue 3 immediate deliveries to the SAME conversation.
    for (let i = 0; i < 3; i++) {
      await outbox.enqueue({
        sessionId: "s1",
        platform: "telegram",
        conversation: conv(),
        payload: { text: `msg-${i}` },
        scheduledFor: Date.now(),
        trigger: "event",
      });
    }

    // The limiter allows 2; the third is deferred (never delivered in this window).
    await new Promise((r) => setTimeout(r, 30));
    expect(delivered.length).toBeLessThanOrEqual(2);
    expect(delivered.length).toBeGreaterThanOrEqual(1);
    await outbox.stop();
  });

  it("survives restart by reloading pending entries from storage", async () => {
    const storage = new MemoryOutboxStorage();
    const outbox1 = new Outbox({ storage, pollIntervalMs: 5 });
    await outbox1.start();
    const id = await outbox1.enqueue({
      sessionId: "s1",
      platform: "telegram",
      conversation: conv(),
      payload: { text: "persisted" },
      scheduledFor: Date.now() + 100,
      trigger: "scheduled",
    });
    await outbox1.stop();

    // A fresh outbox over the same storage sees the pending entry.
    const outbox2 = new Outbox({ storage, pollIntervalMs: 5 });
    await outbox2.start();
    const pending = outbox2.due(Date.now() + 200).filter((e) => e.id === id);
    expect(pending.length).toBe(1);
    await outbox2.stop();
  });

  it("marks entries delivered after a successful fire", async () => {
    const outbox = new Outbox({ storage: new MemoryOutboxStorage(), pollIntervalMs: 5 });
    outbox.setDeliverFn(async () => {});
    await outbox.start();
    const id = await outbox.enqueue({
      sessionId: "s1",
      platform: "telegram",
      conversation: conv(),
      payload: { text: "x" },
      scheduledFor: Date.now(),
      trigger: "event",
    });
    await new Promise((r) => setTimeout(r, 30));
    const entry = outbox.due(Date.now() + 1000).find((e) => e.id === id);
    // After delivery it's no longer "due" (delivered=true filtered out).
    expect(entry).toBeUndefined();
    await outbox.stop();
  });
});
