/**
 * Seepient Server — API Key Authentication
 *
 * Generates, validates, and manages API keys for server access.
 * Keys are stored in ~/.seepient/server-keys.json with associated scopes.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { IncomingMessage } from "http";
import type { ProviderType } from "../../core/types.js";

// ── Types ──────────────────────────────────────────────────────────────

export type KeyScope = "agent:run" | "agent:read" | "admin";

export interface ApiKeyEntry {
  key: string;
  scopes: KeyScope[];
  created: string;
  label: string;
}

interface KeyStore {
  keys: ApiKeyEntry[];
}

// ── Defaults ───────────────────────────────────────────────────────────

const DEFAULT_KEY_PATH = path.join(os.homedir(), ".seepient", "server-keys.json");

// ── In-memory cache ────────────────────────────────────────────────────

let cachedKeys: Map<string, ApiKeyEntry> | null = null;
let cacheMtimeMs: number = 0;

// ── Key store I/O ──────────────────────────────────────────────────────

function readStore(filePath: string): KeyStore {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as KeyStore;
  } catch {
    return { keys: [] };
  }
}

function writeStore(store: KeyStore, filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2), {
    mode: 0o600,
  });
}

// ── Cache helpers ──────────────────────────────────────────────────────

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
    // File may not exist yet — rebuild cache
  }

  const store = readStore(filePath);
  const map = new Map<string, ApiKeyEntry>();
  for (const entry of store.keys) {
    map.set(entry.key, entry);
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
 * Optionally persist it to the key store file.
 */
export function generateApiKey(
  scopes: KeyScope[] = ["agent:run"],
  options?: { label?: string; filePath?: string },
): ApiKeyEntry {
  const random = crypto.randomBytes(32).toString("hex");
  const key = `sk_seepient_${random}`;

  const entry: ApiKeyEntry = {
    key,
    scopes,
    created: new Date().toISOString(),
    label: options?.label ?? "generated",
  };

  // Persist to disk
  const filePath = options?.filePath ?? DEFAULT_KEY_PATH;
  const store = readStore(filePath);
  store.keys.push(entry);
  writeStore(store, filePath);
  invalidateCache();

  return entry;
}

/**
 * Validate an API key string against the stored keys.
 * Returns the matching entry if valid, or null if not found.
 */
export function validateApiKey(
  key: string,
  options?: { filePath?: string },
): ApiKeyEntry | null {
  if (!key || !key.startsWith("sk_seepient_")) {
    return null;
  }

  const filePath = options?.filePath ?? DEFAULT_KEY_PATH;
  const cache = loadCache(filePath);
  return cache.get(key) ?? null;
}

/**
 * Extract and validate an API key from an incoming HTTP request.
 *
 * For REST requests: checks `X-Seepient-API-Key` header first,
 * then `Authorization: Bearer sk_seepient_...`.
 * For WebSocket upgrades: checks the `token` query parameter.
 *
 * Returns the ApiKeyEntry if valid, or null if authentication fails.
 */
export function authMiddleware(
  req: IncomingMessage,
): ApiKeyEntry | null {
  let key: string | undefined;

  // 1. Check X-Seepient-API-Key header
  key = req.headers["x-seepient-api-key"] as string | undefined;

  // 2. Check Authorization: Bearer sk_seepient_...
  if (!key) {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) {
      const token = auth.slice(7).trim();
      if (token.startsWith("sk_seepient_")) {
        key = token;
      }
    }
  }

  // 3. Check query parameter (for WebSocket upgrades)
  if (!key && req.url) {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
      const tokenParam = url.searchParams.get("token");
      if (tokenParam?.startsWith("sk_seepient_")) {
        key = tokenParam;
      }
    } catch {
      // Malformed URL — ignore
    }
  }

  if (!key) {
    return null;
  }

  return validateApiKey(key);
}

/**
 * Load all API keys from the key store file.
 * Returns an array of ApiKeyEntry objects.
 */
export function loadApiKeys(filePath?: string): ApiKeyEntry[] {
  const resolved = filePath ?? DEFAULT_KEY_PATH;
  const store = readStore(resolved);
  return store.keys;
}

/**
 * Delete an API key from the store.
 * Returns true if the key was found and removed.
 */
export function revokeApiKey(
  key: string,
  filePath?: string,
): boolean {
  const resolved = filePath ?? DEFAULT_KEY_PATH;
  const store = readStore(resolved);
  const index = store.keys.findIndex((e) => e.key === key);
  if (index === -1) return false;
  store.keys.splice(index, 1);
  writeStore(store, resolved);
  invalidateCache();
  return true;
}

/**
 * Check whether a given key entry has a specific scope.
 */
export function hasScope(entry: ApiKeyEntry, scope: KeyScope): boolean {
  return entry.scopes.includes(scope);
}
