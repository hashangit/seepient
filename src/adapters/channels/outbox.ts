/**
 * Zoe Channels — Proactive outbound queue + scheduler (spec 002 §7)
 *
 * A persisted queue of pending outbound deliveries the agent can raise outside
 * a direct inbound reply — scheduled messages, tool-result-driven notifications.
 * Backed by a `PersistenceBackend` (via the SessionRegistry's backend) so it
 * survives restarts. The scheduler is minimal — `setTimeout`-based, no cron
 * library (constitution III).
 */

import type { ChannelPlatform } from "../../core/types.js";
import type { ConversationRef, OutboundPayload } from "./types.js";

export type OutboxTrigger = "scheduled" | "event";

export interface OutboxEntry {
  id: string;
  sessionId: string;
  platform: ChannelPlatform;
  conversation: ConversationRef;
  payload: OutboundPayload;
  /** Absolute ms timestamp at which to deliver. */
  scheduledFor: number;
  trigger: OutboxTrigger;
  createdAt: number;
  delivered: boolean;
}

export interface OutboxStorage {
  load(): Promise<OutboxEntry[]>;
  save(entries: OutboxEntry[]): Promise<void>;
}

/** Deliver function the scheduler calls when an entry comes due. */
export type OutboxDeliverFn = (
  platform: ChannelPlatform,
  conversation: ConversationRef,
  payload: OutboundPayload,
) => Promise<void>;

export interface OutboxOptions {
  storage: OutboxStorage;
  /** How often (ms) to scan for due entries in the polling fallback. */
  pollIntervalMs?: number;
  /** Max proactive deliveries per conversation per minute (default 10). */
  maxPerConversationPerMin?: number;
  /** Optional observer for every outbox fire (observability — spec §12). */
  onFire?: (entry: OutboxEntry) => void;
}

/**
 * In-memory outbox storage (default). For restart-safe persistence, wrap a
 * `PersistenceBackend` — the gateway passes a backend-backed implementation.
 */
export class MemoryOutboxStorage implements OutboxStorage {
  private entries: OutboxEntry[] = [];
  async load(): Promise<OutboxEntry[]> {
    return [...this.entries];
  }
  async save(entries: OutboxEntry[]): Promise<void> {
    this.entries = [...entries];
  }
}

export class Outbox {
  private storage: OutboxStorage;
  private pollIntervalMs: number;
  private maxPerConversationPerMin: number;
  private onFire?: (entry: OutboxEntry) => void;
  private entries: OutboxEntry[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private deliver: OutboxDeliverFn | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  /** Per-conversation send timestamps (last minute) for the rate limiter. */
  private sendTimes = new Map<string, number[]>();

  constructor(options: OutboxOptions) {
    this.storage = options.storage;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.maxPerConversationPerMin = options.maxPerConversationPerMin ?? 10;
    this.onFire = options.onFire;
  }

  /** Provide the delivery function (the gateway wires this to adapter.deliver). */
  setDeliverFn(fn: OutboxDeliverFn): void {
    this.deliver = fn;
  }

  /** Load persisted entries and begin scheduling. Idempotent. */
  async start(): Promise<void> {
    if (this.started) return;
    this.entries = await this.storage.load();
    this.started = true;
    for (const entry of this.entries) {
      if (!entry.delivered) this.schedule(entry);
    }
    // Polling fallback catches any timers that slipped (clock drift, missed fire).
    this.pollTimer = setInterval(() => this.fireDue(), this.pollIntervalMs);
    if (this.pollTimer.unref) this.pollTimer.unref();
  }

  /** Stop scheduling, clear timers. In-flight deliveries finish. */
  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.started = false;
  }

  /** Enqueue a new outbound delivery. Returns the entry id. */
  async enqueue(input: {
    sessionId: string;
    platform: ChannelPlatform;
    conversation: ConversationRef;
    payload: OutboundPayload;
    scheduledFor: number;
    trigger: OutboxTrigger;
  }): Promise<string> {
    const entry: OutboxEntry = {
      id: randomId(),
      sessionId: input.sessionId,
      platform: input.platform,
      conversation: input.conversation,
      payload: input.payload,
      scheduledFor: input.scheduledFor,
      trigger: input.trigger,
      createdAt: Date.now(),
      delivered: false,
    };
    this.entries.push(entry);
    await this.persist();
    if (this.started) this.schedule(entry);
    return entry.id;
  }

  /** All pending (undelivered) entries due at or before `now`. */
  due(now = Date.now()): OutboxEntry[] {
    return this.entries.filter((e) => !e.delivered && e.scheduledFor <= now);
  }

  /** Mark an entry delivered and persist. */
  async markDelivered(id: string): Promise<void> {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return;
    entry.delivered = true;
    this.timers.delete(id);
    await this.persist();
  }

  // ── Internals ───────────────────────────────────────────────────────

  private schedule(entry: OutboxEntry): void {
    const delay = Math.max(0, entry.scheduledFor - Date.now());
    const timer = setTimeout(() => {
      void this.fire(entry.id);
    }, delay);
    this.timers.set(entry.id, timer);
  }

  private async fire(id: string): Promise<void> {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry || entry.delivered) return;
    await this.deliverEntry(entry);
  }

  /** Polling fallback — fire everything currently due. */
  private async fireDue(): Promise<void> {
    const due = this.due();
    for (const entry of due) {
      if (!this.timers.has(entry.id)) await this.deliverEntry(entry);
    }
  }

  private async deliverEntry(entry: OutboxEntry): Promise<void> {
    if (entry.delivered || !this.deliver) return;
    // Per-conversation rate limit (defense-in-depth against agent-initiated
    // spam, spec §12). When exhausted, defer to the next poll tick.
    if (!this.allowSend(entry.conversation.conversationId)) return;
    try {
      this.onFire?.(entry);
      await this.deliver(entry.platform, entry.conversation, entry.payload);
      this.recordSend(entry.conversation.conversationId);
    } catch {
      // Delivery failed — leave it undelivered so a later poll can retry.
      return;
    }
    await this.markDelivered(entry.id);
  }

  /** Token-bucket check: at most `maxPerConversationPerMin` sends per minute. */
  private allowSend(conversationId: string): boolean {
    const now = Date.now();
    const cutoff = now - 60_000;
    const times = (this.sendTimes.get(conversationId) ?? []).filter((t) => t > cutoff);
    this.sendTimes.set(conversationId, times);
    return times.length < this.maxPerConversationPerMin;
  }

  private recordSend(conversationId: string): void {
    const times = this.sendTimes.get(conversationId) ?? [];
    times.push(Date.now());
    this.sendTimes.set(conversationId, times);
  }

  private async persist(): Promise<void> {
    await this.storage.save(this.entries);
  }
}

function randomId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return `out-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
