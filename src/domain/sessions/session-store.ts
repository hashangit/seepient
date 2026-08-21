/**
 * Seepient SDK — Session persistence
 *
 * Provides composable persistence backends for storing conversation history.
 * Built-in "file" and "memory" backends are registered by default. Custom
 * backends (Redis, SQLite, etc.) can be registered via `registerBackend()`.
 *
 * Legacy `SessionStore`-based API is preserved for backward compatibility.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  Message,
  PersistenceBackend,
  PersistenceConfig,
  SessionData,
  SessionStore,
} from "../../foundations/types.js";

// ── Session ID validation ───────────────────────────────────────────────

const SESSION_ID_RE = /^[a-zA-Z0-9-]+$/;

function validateSessionId(sessionId: string): void {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error(
      `Invalid session ID "${sessionId}". Only alphanumeric characters and dashes are allowed.`,
    );
  }
}

// ── Default path ────────────────────────────────────────────────────────

function defaultSessionPath(): string {
  return join(homedir(), ".seepient", "sessions");
}

// ── File-based PersistenceBackend ───────────────────────────────────────

/**
 * File-backed persistence backend. Each session is stored as a JSON file
 * at `{basePath}/{sessionId}.json`.
 */
export class FilePersistenceBackend implements PersistenceBackend {
  readonly __persistenceBackend = true as const;
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  private filePath(id: string): string {
    return join(this.basePath, `${id}.json`);
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.basePath, { recursive: true });
  }

  async save(id: string, data: SessionData): Promise<void> {
    validateSessionId(id);
    await this.ensureDir();

    const existing = await this.loadFromDisk(id);
    const now = Date.now();

    const full: SessionData = existing
      ? {
          id,
          messages: data.messages,
          createdAt: existing.createdAt,
          updatedAt: now,
          provider: data.provider ?? existing.provider,
          model: data.model ?? existing.model,
          metadata: data.metadata ?? existing.metadata,
        }
      : {
          id,
          messages: data.messages,
          createdAt: now,
          updatedAt: now,
          provider: data.provider,
          model: data.model,
          metadata: data.metadata,
        };

    const filePath = this.filePath(id);
    const tmpPath = filePath + ".tmp." + Date.now();

    try {
      await fs.writeFile(tmpPath, JSON.stringify(full, null, 2), "utf-8");
      await fs.rename(tmpPath, filePath);
    } catch (err) {
      // Clean up orphaned temp file on rename failure (e.g. cross-device move)
      try { await fs.unlink(tmpPath); } catch { /* best effort */ }
      throw err;
    }
  }

  async load(id: string): Promise<SessionData | null> {
    return this.loadFromDisk(id);
  }

  async delete(id: string): Promise<void> {
    validateSessionId(id);
    try {
      await fs.unlink(this.filePath(id));
    } catch {
      // File doesn't exist — nothing to delete
    }
  }

  async list(): Promise<string[]> {
    await this.ensureDir();
    const entries = await fs.readdir(this.basePath);
    return entries
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length));
  }

  private async loadFromDisk(id: string): Promise<SessionData | null> {
    try {
      const raw = await fs.readFile(this.filePath(id), "utf-8");
      return JSON.parse(raw) as SessionData;
    } catch {
      return null;
    }
  }
}

// ── In-memory PersistenceBackend ────────────────────────────────────────

/**
 * In-memory persistence backend backed by a Map. Useful for testing.
 */
export class MemoryPersistenceBackend implements PersistenceBackend {
  readonly __persistenceBackend = true as const;
  private store = new Map<string, SessionData>();

  async save(id: string, data: SessionData): Promise<void> {
    validateSessionId(id);
    const existing = this.store.get(id);
    const now = Date.now();

    this.store.set(id, {
      id,
      messages: data.messages,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      provider: data.provider ?? existing?.provider,
      model: data.model ?? existing?.model,
      metadata: data.metadata ?? existing?.metadata,
    });
  }

  async load(id: string): Promise<SessionData | null> {
    return this.store.get(id) ?? null;
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }

  async list(): Promise<string[]> {
    return Array.from(this.store.keys());
  }
}

// ── Backend factory / registry ──────────────────────────────────────────

export type BackendFactory = (config: PersistenceConfig) => PersistenceBackend;

const registry = new Map<string, BackendFactory>();

// Register built-in backends
registry.set("file", (config) => new FilePersistenceBackend((config.path as string) ?? defaultSessionPath()));
registry.set("memory", () => new MemoryPersistenceBackend());

/**
 * Register a custom persistence backend factory.
 *
 * @param type    Unique backend identifier (e.g., "redis", "sqlite")
 * @param factory Factory function that creates a `PersistenceBackend` from config
 */
export function registerBackend(type: string, factory: BackendFactory): void {
  registry.set(type, factory);
}

/**
 * Create a persistence backend from a config object.
 * Uses the `type` field to look up the registered factory.
 *
 * @throws Error if `type` is not registered
 */
export function createPersistenceBackend(config: PersistenceConfig): PersistenceBackend {
  const factory = registry.get(config.type);
  if (!factory) {
    throw new Error(
      `Unknown persistence backend type "${config.type}". Registered types: ${Array.from(registry.keys()).join(", ")}`,
    );
  }
  return factory(config);
}

// ── Save orchestration ──────────────────────────────────────────────────

/**
 * Persist a session's messages to the backend.
 *
 * Single source of truth for the save step shared by all adapters (SDK, CLI,
 * Server). The backend owns `createdAt` (assigns it on first save, preserves
 * it on overwrite — see FilePersistenceBackend / MemoryPersistenceBackend) and
 * merges optional `provider`/`model`/`metadata` fields, so callers only pass
 * what they know. Adapters that don't track provider/model (the SDK) omit them
 * and the persisted values are left untouched.
 */
export async function persistSession(
  backend: PersistenceBackend,
  sessionId: string,
  messages: Message[],
  opts?: { provider?: string; model?: string; metadata?: Record<string, unknown> },
): Promise<void> {
  await backend.save(sessionId, {
    id: sessionId,
    messages,
    // createdAt is required by the SessionData type but ignored by the
    // backends — they assign it on first save and preserve it on overwrite.
    updatedAt: Date.now(),
    provider: opts?.provider,
    model: opts?.model,
    metadata: opts?.metadata,
  } as SessionData);
}

// ── Deprecated legacy API ───────────────────────────────────────────────

/**
 * @deprecated Use `FilePersistenceBackend` or `createPersistenceBackend({ type: "file", path })` instead.
 */
class FileSessionStore implements SessionStore {
  private backend: FilePersistenceBackend;

  constructor(basePath: string) {
    this.backend = new FilePersistenceBackend(basePath);
  }

  async save(sessionId: string, messages: import("../../foundations/types.js").Message[]): Promise<void> {
    await this.backend.save(sessionId, { id: sessionId, messages, createdAt: Date.now(), updatedAt: Date.now() });
  }

  async load(sessionId: string): Promise<import("../../foundations/types.js").Message[] | null> {
    const data = await this.backend.load(sessionId);
    return data?.messages ?? null;
  }

  async delete(sessionId: string): Promise<void> {
    await this.backend.delete(sessionId);
  }

  async list(): Promise<string[]> {
    return this.backend.list();
  }
}

/**
 * @deprecated Use `MemoryPersistenceBackend` or `createPersistenceBackend({ type: "memory" })` instead.
 */
class MemorySessionStore implements SessionStore {
  private backend: MemoryPersistenceBackend;

  constructor() {
    this.backend = new MemoryPersistenceBackend();
  }

  async save(sessionId: string, messages: import("../../foundations/types.js").Message[]): Promise<void> {
    await this.backend.save(sessionId, { id: sessionId, messages, createdAt: Date.now(), updatedAt: Date.now() });
  }

  async load(sessionId: string): Promise<import("../../foundations/types.js").Message[] | null> {
    const data = await this.backend.load(sessionId);
    return data?.messages ?? null;
  }

  async delete(sessionId: string): Promise<void> {
    await this.backend.delete(sessionId);
  }

  async list(): Promise<string[]> {
    return this.backend.list();
  }
}

/**
 * @deprecated Use `createPersistenceBackend({ type: "file", path })` instead.
 */
export function createSessionStore(path?: string): SessionStore {
  return new FileSessionStore(path ?? defaultSessionPath());
}

/**
 * @deprecated Use `createPersistenceBackend({ type: "memory" })` instead.
 */
export function createMemoryStore(): SessionStore {
  return new MemorySessionStore();
}
