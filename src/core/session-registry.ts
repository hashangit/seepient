/**
 * Zoe Core — Session Registry (Track 2, spec 002 §4.6)
 *
 * Wraps a `PersistenceBackend` and adds the two things channels and the future
 * memory layer need that the raw KV backend lacks: **indexing** and **events**.
 *
 * - The wrapped backend stays a dumb KV store — its interface is UNCHANGED.
 * - Session IDs stay UUIDs. Composite conversation identity lives in typed
 *   fields on `SessionData`, never encoded in the id string (spec §4.3).
 * - Indexes are in-memory and rebuild lazily from `backend.list()` on first
 *   use, then cached.
 * - Events fire AFTER a successful backend write, so memory-layer hooks can
 *   re-index transcripts safely.
 */

import type {
  ChannelPlatform,
  Message,
  PersistenceBackend,
  SessionData,
} from "./types.js";

// ── Types ──────────────────────────────────────────────────────────────

/** Composite conversation identity — the channels lookup key. */
export interface ConversationIdentity {
  platform: ChannelPlatform;
  conversationId: string;
  /** Which bot account received this (multi-bot deploys). Optional. */
  botId?: string;
}

export interface SessionEvent {
  type: "sessionSaved" | "messageAppended";
  sessionId: string;
  userId?: string;
  message?: Message;
  timestamp: number;
}

export type SessionEventHandler = (payload: SessionEvent) => void;

export interface SessionRegistry {
  /** Lookup by composite conversation identity (channels). Loads or creates. */
  resolveSession(identity: ConversationIdentity): Promise<SessionData>;
  /** Lookup by canonical user (memory layer, admin tools). */
  sessionsForUser(userId: string): Promise<SessionData[]>;
  /** Enumerate all sessions (admin tools, the CLI session selector). Loads
   *  each via the backend — O(N) — so callers should page for large stores. */
  listAll(): Promise<SessionData[]>;
  /** Mutation — emits `sessionSaved` after a successful backend write. */
  save(session: SessionData): Promise<void>;
  /** Append a message to a session and persist — emits `messageAppended`. */
  appendMessage(sessionId: string, message: Message): Promise<void>;
  /** Delete a session and drop its index entries. */
  delete(sessionId: string): Promise<void>;
  /** Subscribe to mutation events. Returns an unsubscribe function. */
  on(event: "sessionSaved" | "messageAppended", handler: SessionEventHandler): () => void;
}

// ── Implementation ─────────────────────────────────────────────────────

/**
 * In-memory index built lazily from `backend.list()`. Two maps:
 *  - conversationIndex: `${platform}::${conversationId}::${botId?}` → sessionId
 *  - userIndex: userId → Set<sessionId>
 */
interface Indexes {
  conversation: Map<string, string>;
  user: Map<string, Set<string>>;
}

function conversationKey(identity: ConversationIdentity): string {
  return `${identity.platform}::${identity.conversationId}::${identity.botId ?? ""}`;
}

class SessionRegistryImpl implements SessionRegistry {
  private backend: PersistenceBackend;
  private indexes: Indexes = { conversation: new Map(), user: new Map() };
  private indexBuilt = false;
  private building: Promise<void> | null = null;
  /** Per-key in-flight session creation — serializes concurrent resolveSession
   *  calls for the SAME conversation so they return one session, not many. */
  private resolving = new Map<string, Promise<SessionData>>();
  private handlers: {
    sessionSaved: Set<SessionEventHandler>;
    messageAppended: Set<SessionEventHandler>;
  } = { sessionSaved: new Set(), messageAppended: new Set() };

  constructor(backend: PersistenceBackend) {
    this.backend = backend;
  }

  // ── Index rebuild ───────────────────────────────────────────────────

  /**
   * Lazily build indexes from `backend.list()`. Safe to call concurrently —
   * the second caller awaits the first build.
   */
  private async ensureIndexes(): Promise<void> {
    if (this.indexBuilt) return;
    if (!this.building) {
      this.building = this.buildIndexes();
    }
    await this.building;
  }

  private async buildIndexes(): Promise<void> {
    const ids = await this.backend.list();
    for (const id of ids) {
      const data = await this.backend.load(id);
      if (!data) continue;
      this.indexLoaded(data);
    }
    this.indexBuilt = true;
    this.building = null;
  }

  /** Add a single loaded session to the in-memory indexes. */
  private indexLoaded(data: SessionData): void {
    if (data.platform && data.conversationId) {
      const identity: ConversationIdentity = {
        platform: data.platform,
        conversationId: data.conversationId,
        botId: data.botId,
      };
      this.indexes.conversation.set(conversationKey(identity), data.id);
    }
    if (data.userId) {
      let set = this.indexes.user.get(data.userId);
      if (!set) {
        set = new Set();
        this.indexes.user.set(data.userId, set);
      }
      set.add(data.id);
    }
  }

  /** Drop a session's index entries. */
  private unindexSession(data: SessionData): void {
    if (data.platform && data.conversationId) {
      const identity: ConversationIdentity = {
        platform: data.platform,
        conversationId: data.conversationId,
        botId: data.botId,
      };
      this.indexes.conversation.delete(conversationKey(identity));
    }
    if (data.userId) {
      const set = this.indexes.user.get(data.userId);
      if (set) {
        set.delete(data.id);
        if (set.size === 0) this.indexes.user.delete(data.userId);
      }
    }
  }

  // ── Event emission ──────────────────────────────────────────────────

  private emit(event: SessionEvent): void {
    const set = event.type === "sessionSaved" ? this.handlers.sessionSaved : this.handlers.messageAppended;
    for (const handler of set) {
      try {
        handler(event);
      } catch {
        // Non-fatal — a handler must never break the registry (constitution V).
      }
    }
  }

  on(event: "sessionSaved" | "messageAppended", handler: SessionEventHandler): () => void {
    this.handlers[event].add(handler);
    return () => this.handlers[event].delete(handler);
  }

  // ── Public API ──────────────────────────────────────────────────────

  async resolveSession(identity: ConversationIdentity): Promise<SessionData> {
    await this.ensureIndexes();
    const key = conversationKey(identity);
    const existingId = this.indexes.conversation.get(key);
    if (existingId) {
      const loaded = await this.backend.load(existingId);
      if (loaded) return loaded;
      // Stale index entry — fall through to creation.
      this.indexes.conversation.delete(key);
    }
    // Serialize concurrent same-key creation: the first caller creates, the
    // rest await its result (returning the same session).
    const inflight = this.resolving.get(key);
    if (inflight) return inflight;
    const promise = this.createSession(identity, key).finally(() => {
      this.resolving.delete(key);
    });
    this.resolving.set(key, promise);
    return promise;
  }

  private async createSession(identity: ConversationIdentity, _key: string): Promise<SessionData> {
    // Re-check after entering the critical section: a prior in-flight creator
    // may have just populated the index.
    const existingId = this.indexes.conversation.get(conversationKey(identity));
    if (existingId) {
      const loaded = await this.backend.load(existingId);
      if (loaded) return loaded;
    }
    const now = Date.now();
    const session: SessionData = {
      id: cryptoRandomSessionId(),
      messages: [],
      createdAt: now,
      updatedAt: now,
      platform: identity.platform,
      conversationId: identity.conversationId,
      ...(identity.botId ? { botId: identity.botId } : {}),
    };
    await this.backend.save(session.id, session);
    this.indexLoaded(session);
    this.emit({ type: "sessionSaved", sessionId: session.id, timestamp: now });
    return session;
  }

  async sessionsForUser(userId: string): Promise<SessionData[]> {
    await this.ensureIndexes();
    const ids = this.indexes.user.get(userId);
    if (!ids || ids.size === 0) return [];
    const sessions: SessionData[] = [];
    for (const id of ids) {
      const data = await this.backend.load(id);
      if (data) sessions.push(data);
    }
    return sessions;
  }

  async listAll(): Promise<SessionData[]> {
    const ids = await this.backend.list();
    const sessions: SessionData[] = [];
    for (const id of ids) {
      const data = await this.backend.load(id);
      if (data) sessions.push(data);
    }
    return sessions;
  }

  async save(session: SessionData): Promise<void> {
    // Drop any prior index entries derived from the loaded copy so we reindex
    // from the freshly saved version (handles platform/userId changes).
    const prior = await this.backend.load(session.id);
    if (prior) this.unindexSession(prior);

    await this.backend.save(session.id, session);
    this.indexLoaded(session);
    this.emit({ type: "sessionSaved", sessionId: session.id, userId: session.userId, timestamp: Date.now() });
  }

  async appendMessage(sessionId: string, message: Message): Promise<void> {
    const session = await this.backend.load(sessionId);
    if (!session) {
      throw new Error(`SessionRegistry.appendMessage: session "${sessionId}" not found`);
    }
    session.messages.push(message);
    session.updatedAt = Date.now();
    await this.backend.save(sessionId, session);
    this.emit({
      type: "messageAppended",
      sessionId,
      userId: session.userId,
      message,
      timestamp: Date.now(),
    });
  }

  async delete(sessionId: string): Promise<void> {
    const session = await this.backend.load(sessionId);
    await this.backend.delete(sessionId);
    if (session) this.unindexSession(session);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Generate an opaque UUID-style session id that satisfies /^[a-zA-Z0-9-]+$/. */
function cryptoRandomSessionId(): string {
  // Prefer the Web Crypto randomUUID when available; fall back to a manual v4.
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  // Manual fallback (rare path) — uuid v4 shape using randomBytes.
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

// ── Factory ────────────────────────────────────────────────────────────

/**
 * Create a `SessionRegistry` over a `PersistenceBackend`. The backend is the
 * transcript source of truth; the registry owns the query/event layer above it.
 */
export function createSessionRegistry(backend: PersistenceBackend): SessionRegistry {
  return new SessionRegistryImpl(backend);
}
