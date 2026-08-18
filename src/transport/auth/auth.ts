/**
 * Seepient Server — API Key Authentication & Scopes
 *
 * Generates, validates, and manages API keys for server access.
 * Keys are stored in ~/.seepient/server-keys.json hashed with SHA-256.
 * Implements Scope union: agent:run | agent:read | provider:read | provider:admin | admin.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { IncomingMessage } from "http";

// ── Types ──────────────────────────────────────────────────────────────

export type KeyScope =
  | "agent:run"
  | "agent:read"
  | "provider:read"
  | "provider:admin"
  | "admin";

export interface ApiKeyEntry {
  keyHash: string;
  key?: string; // Legacy plaintext (migrated on read)
  scopes: KeyScope[];
  created: string;
  label: string;
  rawKey?: string; // Only populated during initial issuance for display
}

interface KeyStore {
  keys: ApiKeyEntry[];
}

function getKeyPath(customPath?: string): string {
  return customPath ?? process.env.SEEPIENT_API_KEYS_FILE ?? path.join(os.homedir(), ".seepient", "server-keys.json");
}

export function hashKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

// ── In-memory cache ────────────────────────────────────────────────────

let cachedKeys: Map<string, ApiKeyEntry> | null = null;
let cacheMtimeMs: number = 0;

// ── Key store I/O ──────────────────────────────────────────────────────

function readStore(filePath: string): KeyStore {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const store = JSON.parse(raw) as KeyStore;
    let needsMigration = false;

    // Migrate any legacy plaintext keys to keyHash
    for (const k of store.keys || []) {
      if (!k.keyHash && k.key) {
        k.keyHash = hashKey(k.key);
        delete k.key;
        needsMigration = true;
      }
    }

    if (needsMigration) {
      writeStore(store, filePath);
    }
    return store;
  } catch {
    return { keys: [] };
  }
}

function writeStore(store: KeyStore, filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const tmp = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  const data = Buffer.from(JSON.stringify(store, null, 2), "utf8");
  const fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_TRUNC, 0o600);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

function invalidateCache(): void {
  cachedKeys = null;
  cacheMtimeMs = 0;
}

function loadCache(filePath: string): Map<string, ApiKeyEntry> {
  try {
    const stat = fs.statSync(filePath);
    if (cachedKeys && stat.mtimeMs === cacheMtimeMs) {
      return cachedKeys;
    }
  } catch {
    // File may not exist yet
  }

  const store = readStore(filePath);
  const map = new Map<string, ApiKeyEntry>();
  for (const entry of store.keys) {
    if (entry.keyHash) {
      map.set(entry.keyHash, entry);
    }
  }
  cachedKeys = map;

  try {
    cacheMtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    cacheMtimeMs = 0;
  }

  return map;
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Generate a new API key with the format `sk_seepient_{random}`.
 * Persists only the SHA-256 hash to disk and returns the raw key.
 */
export function generateApiKey(
  scopes: KeyScope[] = ["agent:run"],
  options?: { label?: string; filePath?: string },
): ApiKeyEntry & { rawKey: string } {
  const random = crypto.randomBytes(32).toString("hex");
  const rawKey = `sk_seepient_${random}`;
  const keyHash = hashKey(rawKey);

  const entry: ApiKeyEntry = {
    keyHash,
    scopes,
    created: new Date().toISOString(),
    label: options?.label ?? "generated",
  };

  const filePath = getKeyPath(options?.filePath);
  const store = readStore(filePath);
  store.keys.push(entry);
  writeStore(store, filePath);
  invalidateCache();

  return { ...entry, rawKey };
}

/**
 * Validate an API key string against the stored keys by SHA-256 hash.
 */
export function validateApiKey(
  key: string,
  options?: { filePath?: string },
): ApiKeyEntry | null {
  if (!key || !key.startsWith("sk_seepient_")) {
    return null;
  }

  const filePath = getKeyPath(options?.filePath);
  const cache = loadCache(filePath);
  const h = hashKey(key);
  return cache.get(h) ?? null;
}

/**
 * Check if an ApiKeyEntry has the requested scope (handling legacy scope migrations).
 */
export function hasScope(entry: ApiKeyEntry, requiredScope: KeyScope): boolean {
  if (!entry || !entry.scopes) return false;
  if (entry.scopes.includes(requiredScope)) return true;

  // Legacy 'admin' satisfies 'provider:admin', 'provider:read', 'agent:run', 'agent:read'
  if (entry.scopes.includes("admin")) return true;

  // 'provider:admin' satisfies 'provider:read'
  if (requiredScope === "provider:read" && entry.scopes.includes("provider:admin")) {
    return true;
  }

  return false;
}

/**
 * Extract API token from Authorization header, X-Seepient-API-Key / x-api-key, or ?token= / ?apiKey= query param.
 */
export function extractBearerToken(req: IncomingMessage): string | null {
  // 1. Authorization: Bearer <token>
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const parts = authHeader.split(" ");
    if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
      return parts[1];
    }
  }

  // 2. X-Seepient-API-Key / x-api-key headers
  const xApiKey = req.headers["x-seepient-api-key"] ?? req.headers["x-api-key"];
  if (typeof xApiKey === "string" && xApiKey.trim()) {
    return xApiKey.trim();
  }

  // 3. Query params ?token= or ?apiKey= (strictly for WebSocket browser upgrades)
  const isWsUpgrade = typeof req.headers.upgrade === "string" && req.headers.upgrade.toLowerCase() === "websocket";
  if (isWsUpgrade && req.url && (req.url.includes("token=") || req.url.includes("apiKey="))) {
    try {
      const parsed = new URL(req.url, "http://localhost");
      const queryToken = parsed.searchParams.get("token") ?? parsed.searchParams.get("apiKey");
      if (queryToken) return queryToken;
    } catch {
      // Ignore URL parsing errors
    }
  }

  return null;
}

/**
 * Authentication middleware helper that extracts and validates the API key.
 */
export function authMiddleware(req: IncomingMessage): ApiKeyEntry | null {
  const token = extractBearerToken(req);
  if (!token) return null;
  return validateApiKey(token);
}

/**
 * Revoke an API key by matching raw key or hash.
 */
export function revokeApiKey(
  keyOrHash: string,
  options?: { filePath?: string },
): boolean {
  const filePath = getKeyPath(options?.filePath);
  const store = readStore(filePath);
  const targetHash = keyOrHash.startsWith("sk_seepient_") ? hashKey(keyOrHash) : keyOrHash;

  const initialLength = store.keys.length;
  store.keys = store.keys.filter((e) => e.keyHash !== targetHash);

  if (store.keys.length < initialLength) {
    writeStore(store, filePath);
    invalidateCache();
    return true;
  }

  return false;
}

/**
 * List all registered API keys (never exposing raw secrets).
 */
export function listApiKeys(
  options?: { filePath?: string },
): Array<Omit<ApiKeyEntry, "rawKey">> {
  const filePath = getKeyPath(options?.filePath);
  const store = readStore(filePath);
  return store.keys.map((k) => ({
    keyHash: k.keyHash,
    scopes: k.scopes,
    created: k.created,
    label: k.label,
  }));
}
