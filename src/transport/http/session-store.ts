/**
 * Seepient Server — Server-side Session Management
 *
 * Wraps a PersistenceBackend for server-specific needs:
 *  - TTL-based session expiration
 *  - Per-API-key concurrency limits
 *  - Periodic cleanup of stale sessions
 *
 * Raw storage is delegated to a PersistenceBackend (default: file-based).
 * Server metadata (apiKeyHash, lastActivityAt) lives in memory and in
 * the `metadata` field of SessionData.
 */

import type { Message, SessionData, PersistenceBackend } from "../../foundations/types.js";
import { createPersistenceBackend } from "../../domain/sessions/session-store.js";
import { logTransportEvent } from "../logging.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface ServerSessionManagerOptions {
  /** Session TTL in milliseconds (default: 24 hours) */
  sessionTTL?: number;
  /** Inactivity timeout in milliseconds (default: 30 minutes) */
  inactivityTimeout?: number;
  /** Max concurrent sessions per API key (default: 5) */
  maxSessionsPerKey?: number;
  /** Cleanup interval in milliseconds (default: 5 minutes) */
  cleanupInterval?: number;
  /** Directory for file-based session storage (ignored when `backend` is set) */
  sessionDir?: string;
  /** Custom persistence backend (overrides sessionDir) */
  backend?: PersistenceBackend;
}

export interface SessionSummary {
  id: string;
  createdAt: number;
  updatedAt: number;
  provider?: string;
  model?: string;
  messageCount: number;
}

export interface CreateSessionOptions {
  id?: string;
  provider?: string;
  model?: string;
  apiKeyHash?: string;
}

const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;
// W154a/b: aligned with the domain backends (charset incl. `_`) and capped.
const MAX_SESSION_ID_LENGTH = 128;

interface TrackedSession extends SessionData {
  apiKeyHash: string;
  lastActivityAt: number;
}

// ── Defaults ───────────────────────────────────────────────────────────

const DEFAULT_SESSION_TTL = 24 * 60 * 60 * 1000;       // 24 hours
const DEFAULT_INACTIVITY_TIMEOUT = 30 * 60 * 1000;      // 30 minutes
const DEFAULT_MAX_SESSIONS = 5;
const DEFAULT_CLEANUP_INTERVAL = 5 * 60 * 1000;         // 5 minutes

// ── Helpers ────────────────────────────────────────────────────────────

import * as crypto from "crypto";

export function hashKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

// ── ServerSessionManager ───────────────────────────────────────────────

export class ServerSessionManager {
  private sessions: Map<string, TrackedSession> = new Map();
  private sessionTTL: number;
  private inactivityTimeout: number;
  private maxSessionsPerKey: number;
  private cleanupInterval: number;
  private backend: PersistenceBackend;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private inFlightTurns: Set<string> = new Set();
  private inFlightCreations: Set<string> = new Set();
  /** W154g: per-key in-flight createSession count (closes the cap race). */
  private inFlightCreatesPerKey: Map<string, number> = new Map();

  /**
   * Attempt to acquire an in-flight turn lock for a session ID.
   * Returns true if lock was acquired, false if a turn is already in-flight.
   */
  acquireTurn(sessionId: string): boolean {
    if (this.inFlightTurns.has(sessionId)) {
      return false;
    }
    this.inFlightTurns.add(sessionId);
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivityAt = Date.now();
    }
    return true;
  }

  /**
   * Release the in-flight turn lock for a session ID.
   */
  releaseTurn(sessionId: string): void {
    this.inFlightTurns.delete(sessionId);
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivityAt = Date.now();
    }
  }

  /**
   * Check if a turn is currently in flight for this session ID.
   */
  isTurnInFlight(sessionId: string): boolean {
    return this.inFlightTurns.has(sessionId);
  }

  constructor(options?: ServerSessionManagerOptions) {
    this.sessionTTL = options?.sessionTTL ?? DEFAULT_SESSION_TTL;
    this.inactivityTimeout = options?.inactivityTimeout ?? DEFAULT_INACTIVITY_TIMEOUT;
    this.maxSessionsPerKey = options?.maxSessionsPerKey ?? DEFAULT_MAX_SESSIONS;
    this.cleanupInterval = options?.cleanupInterval ?? DEFAULT_CLEANUP_INTERVAL;

    if (options?.backend) {
      this.backend = options.backend;
    } else {
      this.backend = createPersistenceBackend({
        type: "file",
        path: options?.sessionDir,
      });
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /**
   * Start the periodic cleanup timer.
   */
  startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanup(), this.cleanupInterval);
    // Prevent the timer from keeping the process alive
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Stop the periodic cleanup timer.
   */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  // ── CRUD ─────────────────────────────────────────────────────────────

  /**
   * Create a new session. Enforces per-API-key session limits.
   * Returns the new SessionData or throws if the limit is exceeded.
   * Awaits persistence — callers should await to ensure backend errors propagate.
   */
  async createSession(
    apiKey: string,
    options?: CreateSessionOptions,
  ): Promise<SessionData>;
  async createSession(
    apiKey: string,
    provider?: string,
    model?: string,
  ): Promise<SessionData>;
  async createSession(
    apiKey: string,
    optsOrProvider?: string | CreateSessionOptions,
    modelArg?: string,
  ): Promise<SessionData> {
    const keyHash =
      typeof optsOrProvider === "object" && optsOrProvider?.apiKeyHash
        ? optsOrProvider.apiKeyHash
        : hashKey(apiKey);

    // Enforce per-key limit. W154g: concurrent createSession calls on one
    // key both counted against the cap only after their sessions landed in
    // the map — hold a per-key in-flight counter for the whole call.
    const existing = this.getSessionsByKey(keyHash);
    const inFlightCreates = this.inFlightCreatesPerKey.get(keyHash) ?? 0;
    if (existing.length + inFlightCreates >= this.maxSessionsPerKey) {
      throw new Error(
        `Maximum concurrent sessions (${this.maxSessionsPerKey}) reached for this API key.`,
      );
    }
    this.inFlightCreatesPerKey.set(keyHash, inFlightCreates + 1);

    try {
      return await this.createSessionInner(apiKey, optsOrProvider, modelArg, keyHash);
    } finally {
      const current = this.inFlightCreatesPerKey.get(keyHash) ?? 1;
      if (current <= 1) this.inFlightCreatesPerKey.delete(keyHash);
      else this.inFlightCreatesPerKey.set(keyHash, current - 1);
    }
  }

  private async createSessionInner(
    apiKey: string,
    optsOrProvider?: string | CreateSessionOptions,
    modelArg?: string,
    keyHashOverride?: string,
  ): Promise<SessionData> {
    const keyHash = keyHashOverride ?? (typeof optsOrProvider === "object" && optsOrProvider?.apiKeyHash
      ? optsOrProvider.apiKeyHash
      : hashKey(apiKey));

    let id: string | undefined;
    let provider: string | undefined;
    let model: string | undefined;

    if (typeof optsOrProvider === "object" && optsOrProvider !== null) {
      id = optsOrProvider.id;
      provider = optsOrProvider.provider;
      model = optsOrProvider.model;
    } else {
      provider = optsOrProvider;
      model = modelArg;
    }

    const finalId = id ?? crypto.randomUUID();
    const explicitId = id;
    if (explicitId !== undefined) {
      if (!SESSION_ID_RE.test(finalId) || finalId.length > MAX_SESSION_ID_LENGTH) {
        throw new Error(
          `Invalid session ID format: must match ${SESSION_ID_RE} (max ${MAX_SESSION_ID_LENGTH} characters)`,
        );
      }
      if (this.sessions.has(finalId) || this.inFlightCreations.has(finalId)) {
        const err = new Error(`SESSION_ALREADY_EXISTS: Session "${finalId}" already exists`);
        (err as any).code = "SESSION_ALREADY_EXISTS";
        throw err;
      }
      this.inFlightCreations.add(finalId);
    }

    try {
      if (explicitId !== undefined && (await this.loadSessionFromBackend(finalId)) !== null) {
        const err = new Error(`SESSION_ALREADY_EXISTS: Session "${finalId}" already exists`);
        (err as any).code = "SESSION_ALREADY_EXISTS";
        throw err;
      }

      const now = Date.now();

      const session: TrackedSession = {
        id: finalId,
        messages: [],
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
        apiKeyHash: keyHash,
        provider,
        model,
      };

      this.sessions.set(finalId, session);
      try {
        await this.persistSessionAsync(session);
      } catch (err) {
        this.sessions.delete(finalId);
        throw err;
      }

      return {
        id: session.id,
        messages: session.messages,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        provider: session.provider,
        model: session.model,
      };
    } finally {
      if (explicitId !== undefined) {
        this.inFlightCreations.delete(finalId);
      }
    }
  }

  /**
   * Get a session by its ID, verifying ownership via API key hash.
   * Returns null if the session does not exist, has expired, or is not owned
   * by the provided API key.
   */
  async getSession(id: string, apiKeyHash: string): Promise<SessionData | null> {
    let session: TrackedSession | null | undefined = this.sessions.get(id);

    if (!session) {
      // Try loading from persistence backend. W153: do NOT cache into the
      // resident map yet — a denied probe must not pin the victim's session
      // in memory until TTL.
      session = await this.loadSessionFromBackend(id);
      if (!session) return null;
    }

    // W152/W153: ownership is verified BEFORE expiry handling so a foreign
    // probe can never trigger (or observe) deletion of a session it does
    // not own, and only an owned session is cached.
    // Ownership verification — constant-time comparison to prevent timing attacks
    if (!this.verifyOwnership(session, apiKeyHash)) {
      return null;
    }

    // Check expiration (W152: an in-flight turn defers the absolute TTL)
    if (this.isExpired(session)) {
      this.deleteSession(id);
      return null;
    }

    this.sessions.set(id, session);

    return {
      id: session.id,
      messages: session.messages,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      provider: session.provider,
      model: session.model,
    };
  }

  /**
   * Resolve a dangling failed-turn draft before a new user turn is appended
   * (021-4 review F1). If the session's last message is an un-answered user
   * prompt — a draft left by a failed turn (0.6.1 crash-recovery design) —
   * it is popped from the session and the new user message supersedes it:
   * identical text dedupes to one fresh copy, different text replaces the
   * stale question. Keeps the stored history, the REST/WS API views, and the
   * model input in sync instead of filtering prompts at send time.
   *
   * Callers must hold the session's turn lock. No-op when the last message
   * was answered (assistant) or the session is empty.
   */
  resolveTrailingDraft(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const last = session.messages[session.messages.length - 1];
    if (!last || last.role !== "user") return;
    session.messages.pop();
    session.updatedAt = Date.now();
    session.lastActivityAt = Date.now();
    this.persistSession(session);
  }

  /**
   * Add a message to an existing session.
   * Updates the last-activity timestamp.
   */
  addMessage(sessionId: string, message: Message): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found.`);
    }

    session.messages.push(message);
    session.updatedAt = Date.now();
    session.lastActivityAt = Date.now();

    this.persistSession(session);
  }

  /**
   * Delete a session by ID.
   * W152: refuses while a turn is in flight — deleting a live session would
   * clear its writer lock and let a second writer start mid-stream.
   */
  deleteSession(id: string): void {
    if (this.inFlightTurns.has(id)) {
      return;
    }
    this.sessions.delete(id);
    this.inFlightTurns.delete(id);
    this.backend.delete(id).catch(() => {
      // Best-effort — don't crash on delete errors
    });
  }

  /**
   * Get all active (non-expired) sessions.
   */
  getActiveSessions(): SessionData[] {
    const active: SessionData[] = [];
    for (const [id, session] of this.sessions) {
      if (!this.isExpired(session)) {
        active.push({
          id: session.id,
          messages: session.messages,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          provider: session.provider,
          model: session.model,
        });
      }
    }
    return active;
  }

  /**
   * Remove expired sessions from memory and backend.
   */
  cleanup(): void {
    for (const [id, session] of this.sessions) {
      if (this.isExpired(session)) {
        this.deleteSession(id);
      }
    }
    for (const id of this.inFlightTurns) {
      if (!this.sessions.has(id)) {
        this.inFlightTurns.delete(id);
      }
    }
  }

  /**
   * Get active sessions for a specific API key hash.
   */
  getSessionsByKey(keyHash: string): SessionSummary[] {
    const result: SessionSummary[] = [];
    for (const session of this.sessions.values()) {
      if (session.apiKeyHash === keyHash && !this.isExpired(session)) {
        result.push({
          id: session.id,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          provider: session.provider,
          model: session.model,
          messageCount: session.messages.length,
        });
      }
    }
    return result;
  }

  // ── Internal helpers ─────────────────────────────────────────────────

  private isExpired(session: TrackedSession): boolean {
    const now = Date.now();

    // Absolute TTL — W152: an in-flight turn defers expiry, otherwise any
    // cleanup pass (or getSession probe) could evict a session mid-stream.
    if (now - session.createdAt > this.sessionTTL) {
      if (this.isTurnInFlight(session.id)) {
        return false;
      }
      return true;
    }

    // Inactivity timeout
    if (now - session.lastActivityAt > this.inactivityTimeout) {
      if (this.isTurnInFlight(session.id)) {
        return false;
      }
      return true;
    }

    return false;
  }

  private persistSession(session: TrackedSession): void {
    const data: SessionData = {
      id: session.id,
      messages: session.messages,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      provider: session.provider,
      model: session.model,
      metadata: {
        apiKeyHash: session.apiKeyHash,
        lastActivityAt: session.lastActivityAt,
      },
    };
    this.backend.save(session.id, data).catch((err: unknown) => {
      // Best-effort persistence — don't crash on write errors
      logTransportEvent({
        level: "error",
        event: "persist_error",
        requestId: crypto.randomUUID(),
        apiKeyHashPrefix: session.apiKeyHash ? session.apiKeyHash.slice(0, 8) : undefined,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private async persistSessionAsync(session: TrackedSession): Promise<void> {
    const data: SessionData = {
      id: session.id,
      messages: session.messages,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      provider: session.provider,
      model: session.model,
      metadata: {
        apiKeyHash: session.apiKeyHash,
        lastActivityAt: session.lastActivityAt,
      },
    };
    await this.backend.save(session.id, data);
  }

  private async loadSessionFromBackend(id: string): Promise<TrackedSession | null> {
    try {
      const data = await this.backend.load(id);
      if (!data) return null;

      const metadata = data.metadata ?? {};
      return {
        id: data.id,
        messages: data.messages,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        provider: data.provider,
        model: data.model,
        apiKeyHash: (metadata.apiKeyHash as string) ?? "",
        lastActivityAt: (metadata.lastActivityAt as number) ?? data.updatedAt,
      };
    } catch (err) {
      console.warn(`[session-store] Failed to load session ${id} from backend:`, err);
      return null;
    }
  }

  private verifyOwnership(session: TrackedSession, apiKeyHash: string): boolean {
    if (!session.apiKeyHash || session.apiKeyHash.length === 16) {
      const err = new Error(
        "session has no server owner; SDK-persisted sessions are not server-resumable",
      );
      (err as any).code = "NOT_FOUND";
      (err as any).statusCode = 404;
      throw err;
    }
    const a = Buffer.from(session.apiKeyHash, "utf-8");
    const b = Buffer.from(apiKeyHash, "utf-8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
}
