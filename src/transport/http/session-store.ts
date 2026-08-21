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
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
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
    provider?: string,
    model?: string,
  ): Promise<SessionData> {
    const keyHash = hashKey(apiKey);

    // Enforce per-key limit
    const existing = this.getSessionsByKey(keyHash);
    if (existing.length >= this.maxSessionsPerKey) {
      throw new Error(
        `Maximum concurrent sessions (${this.maxSessionsPerKey}) reached for this API key.`,
      );
    }

    const id = crypto.randomUUID();
    const now = Date.now();

    const session: TrackedSession = {
      id,
      messages: [],
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      apiKeyHash: keyHash,
      provider,
      model,
    };

    this.sessions.set(id, session);
    await this.persistSessionAsync(session);

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
   * Get a session by its ID, verifying ownership via API key hash.
   * Returns null if the session does not exist, has expired, or is not owned
   * by the provided API key.
   */
  async getSession(id: string, apiKeyHash: string): Promise<SessionData | null> {
    let session: TrackedSession | null | undefined = this.sessions.get(id);

    if (!session) {
      // Try loading from persistence backend
      session = await this.loadSessionFromBackend(id);
      if (!session) return null;
      this.sessions.set(id, session);
    }

    // Check expiration
    if (this.isExpired(session)) {
      this.deleteSession(id);
      return null;
    }

    // Ownership verification — constant-time comparison to prevent timing attacks
    if (!this.verifyOwnership(session, apiKeyHash)) {
      return null;
    }

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
   * Add a message to an existing session.
   * Updates the last-activity timestamp.
   */
  addMessage(sessionId: string, message: Message): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.messages.push(message);
    session.updatedAt = Date.now();
    session.lastActivityAt = Date.now();

    this.persistSession(session);
  }

  /**
   * Delete a session by ID.
   */
  deleteSession(id: string): void {
    this.sessions.delete(id);
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
  }

  // ── Internal helpers ─────────────────────────────────────────────────

  private getSessionsByKey(keyHash: string): TrackedSession[] {
    const result: TrackedSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.apiKeyHash === keyHash && !this.isExpired(session)) {
        result.push(session);
      }
    }
    return result;
  }

  private isExpired(session: TrackedSession): boolean {
    const now = Date.now();

    // Absolute TTL
    if (now - session.createdAt > this.sessionTTL) {
      return true;
    }

    // Inactivity timeout
    if (now - session.lastActivityAt > this.inactivityTimeout) {
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
    this.backend.save(session.id, data).catch(() => {
      // Best-effort persistence — don't crash on write errors
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
    const a = Buffer.from(session.apiKeyHash, "utf-8");
    const b = Buffer.from(apiKeyHash, "utf-8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
}
