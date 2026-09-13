/**
 * Seepient SDK — Session persistence
 *
 * Provides composable persistence backends for storing conversation history.
 * Built-in "file" and "memory" backends are registered by default. Custom
 * backends (Redis, SQLite, etc.) can be registered via `registerBackend()`.
 *
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  Message,
  PersistenceBackend,
  PersistenceConfig,
  SessionData,
  SessionSummary,
} from "../../foundations/types.js";

// ── Session ID validation ───────────────────────────────────────────────

// W154a: `_` is allowed everywhere (transport + SDK already permitted it).
// W154b: length is capped so bounded bodies cannot inflate Maps and fs names.
// Extended to allow `:` and 256 chars for composite apiKeyHash:sessionId storage keys.
const SESSION_ID_RE = /^[a-zA-Z0-9_:-]+$/;
export const MAX_SESSION_ID_LENGTH = 256;

function validateSessionId(sessionId: string): void {
  if (!SESSION_ID_RE.test(sessionId) || sessionId.length > MAX_SESSION_ID_LENGTH) {
    throw new Error(
      `Invalid session ID "${sessionId}". Only alphanumeric characters, dashes, underscores, and colons are allowed (max ${MAX_SESSION_ID_LENGTH} characters).`,
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
    await fs.mkdir(this.basePath, { recursive: true, mode: 0o700 });
    try { await fs.chmod(this.basePath, 0o700); } catch { /* best effort */ }
  }

  async save(id: string, data: SessionData): Promise<void> {
    validateSessionId(id);
    await this.ensureDir();

    const existing = await this.loadFromDisk(id);
    const now = Date.now();
    const actualId = data.id ?? (id.includes(":") ? id.slice(id.indexOf(":") + 1) : id);

    const full: SessionData = existing
      ? {
          id: actualId,
          messages: data.messages,
          createdAt: existing.createdAt,
          updatedAt: now,
          provider: data.provider ?? existing.provider,
          providerAccount: data.providerAccount ?? existing.providerAccount,
          model: data.model ?? existing.model,
          principalId: data.principalId ?? existing.principalId,
          metadata: data.metadata ?? existing.metadata,
        }
      : {
          id: actualId,
          messages: data.messages,
          createdAt: now,
          updatedAt: now,
          provider: data.provider,
          providerAccount: data.providerAccount,
          model: data.model,
          principalId: data.principalId,
          metadata: data.metadata,
        };

    const filePath = this.filePath(id);
    const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;

    try {
      await fs.writeFile(tmpPath, JSON.stringify(full, null, 2), { encoding: "utf-8", mode: 0o600 });
      await fs.rename(tmpPath, filePath);
    } catch (err) {
      // Clean up orphaned temp file on rename failure (e.g. cross-device move)
      try { await fs.unlink(tmpPath); } catch { /* best effort */ }
      throw err;
    }
  }

  async load(id: string): Promise<SessionData | null> {
    validateSessionId(id);
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

  async list(): Promise<SessionSummary[]> {
    await this.ensureDir();
    const entries = await fs.readdir(this.basePath);
    const summaries: SessionSummary[] = [];
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const fileId = name.slice(0, -".json".length);
      try {
        const raw = await fs.readFile(this.filePath(fileId), "utf-8");
        const parsed = JSON.parse(raw);
        const colonIdx = fileId.indexOf(":");
        const apiKeyHash = parsed.metadata?.apiKeyHash ?? (colonIdx !== -1 ? fileId.slice(0, colonIdx) : undefined);
        const actualId = parsed.id ?? (colonIdx !== -1 ? fileId.slice(colonIdx + 1) : fileId);
        summaries.push({
          id: actualId,
          createdAt: parsed.createdAt,
          updatedAt: parsed.updatedAt ?? parsed.createdAt ?? Date.now(),
          provider: parsed.provider,
          model: parsed.model,
          messageCount: Array.isArray(parsed.messages) ? parsed.messages.length : 0,
          apiKeyHash,
          ...(parsed.title || parsed.metadata?.title ? { title: parsed.title ?? parsed.metadata?.title } : {}),
        });
      } catch {
        // Skip unreadable or corrupted files
      }
    }
    return summaries;
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
    const actualId = data.id ?? (id.includes(":") ? id.slice(id.indexOf(":") + 1) : id);

    this.store.set(id, {
      id: actualId,
      messages: data.messages,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      provider: data.provider ?? existing?.provider,
      providerAccount: data.providerAccount ?? existing?.providerAccount,
      model: data.model ?? existing?.model,
      principalId: data.principalId ?? existing?.principalId,
      metadata: data.metadata ?? existing?.metadata,
    });
  }

  async load(id: string): Promise<SessionData | null> {
    validateSessionId(id);
    return this.store.get(id) ?? null;
  }

  async delete(id: string): Promise<void> {
    validateSessionId(id);
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
  opts?: { provider?: string; providerAccount?: string; model?: string; metadata?: Record<string, unknown> },
): Promise<void> {
  await backend.save(sessionId, {
    id: sessionId,
    messages,
    // createdAt is required by the SessionData type but ignored by the
    // backends — they assign it on first save and preserve it on overwrite.
    updatedAt: Date.now(),
    provider: opts?.provider,
    providerAccount: opts?.providerAccount,
    model: opts?.model,
    metadata: opts?.metadata,
  } as SessionData);
}


