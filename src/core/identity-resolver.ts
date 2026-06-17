/**
 * Zoe Core — Identity Resolver (Track 2 "C", spec 002 §4.7)
 *
 * Maps platform-scoped senders (`wa:447700900123`, `tg:12345`) → one canonical
 * `userId`, resolves permissions, and checks the per-channel allowlist. Channel
 * adapters call `resolve()` on every inbound message.
 *
 * - Built-in `AllowlistIdentityResolver` covers the Hermes/OpenClaw baseline
 *   (home channel + allowlist) and is richer (typed role + canonical id).
 * - Pluggable via `registerIdentityResolver(name, factory)` — same registry
 *   pattern as `PersistenceBackend`. Operators can swap in an SSO-backed or
 *   Slack-org resolver.
 * - Idempotent + cacheable: the same `(platform, platformSenderId)` always
 *   resolves to the same canonical `userId`. Cache keyed by that pair with a
 *   TTL so the future memory layer can re-index without thrashing external
 *   lookups (spec §4.2 decision #4).
 */

import type { AuthorRole, ChannelPlatform, ConversationType } from "./types.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface ResolveInput {
  platform: ChannelPlatform;
  /** Raw platform-scoped sender id (e.g. "447700900123", "U012ABCD"). */
  platformSenderId: string;
  /** Platform-native chat id. */
  conversationId: string;
  conversationType: ConversationType;
  /** Display name if the platform provides it. */
  senderName?: string;
  /** Which bot account received this (multi-bot deploys). */
  botId: string;
}

export interface ResolvedIdentity {
  authorized: boolean;
  /** Canonical, stable across platforms — the memory-layer join key. */
  userId: string;
  role: AuthorRole;
  displayName: string;
  /** Why access was denied, when `authorized` is false. */
  reason?: string;
}

export interface IdentityResolver {
  resolve(input: ResolveInput): Promise<ResolvedIdentity>;
}

// ── Resolver registry + factory (same pattern as PersistenceBackend) ───

export type IdentityResolverFactory = (config: IdentityResolverConfig) => IdentityResolver;

export interface IdentityResolverConfig {
  type: string;
  [key: string]: unknown;
}

const resolverRegistry = new Map<string, IdentityResolverFactory>();

/**
 * Register a custom identity resolver factory.
 * @param type Unique resolver identifier (e.g. "allowlist", "sso")
 * @param factory Factory that builds an `IdentityResolver` from config
 */
export function registerIdentityResolver(type: string, factory: IdentityResolverFactory): void {
  resolverRegistry.set(type, factory);
}

/**
 * Create an identity resolver from a config object. The `type` field selects
 * the registered factory (default: "allowlist").
 * @throws Error if `type` is not registered
 */
export function createIdentityResolver(config: IdentityResolverConfig): IdentityResolver {
  const type = config.type ?? "allowlist";
  const factory = resolverRegistry.get(type);
  if (!factory) {
    throw new Error(
      `Unknown identity resolver type "${type}". Registered types: ${Array.from(resolverRegistry.keys()).join(", ")}`,
    );
  }
  return factory(config);
}

// ── AllowlistIdentityResolver (built-in) ───────────────────────────────

/**
 * Per-platform allowlist configuration, sourced from settings
 * (`channels.<platform>.allowlist` / `channels.<platform>.admins`).
 *
 * `userIdMapping` is optional — when omitted, the canonical userId is the
 * opaque `${platform}:${senderId}` (stable, not human-meaningful). Operators
 * who want a richer mapping (SSO, external directory) register a custom
 * resolver via `registerIdentityResolver`.
 */
export interface AllowlistResolverConfig {
  /**
   * Map of platform → { allowlist: sender ids permitted; admins: sender ids
   * promoted to the "admin" role }.
   */
  platforms: Partial<Record<ChannelPlatform, {
    allowlist: string[];
    admins?: string[];
  }>>;
  /** Optional display-name overrides keyed by `${platform}:${senderId}`. */
  displayNames?: Record<string, string>;
  /** Cache TTL in milliseconds (default 5 minutes). */
  cacheTtlMs?: number;
}

interface CacheEntry {
  resolved: ResolvedIdentity;
  expiresAt: number;
}

export class AllowlistIdentityResolver implements IdentityResolver {
  private platforms: AllowlistResolverConfig["platforms"];
  private displayNames: Record<string, string>;
  private cacheTtlMs: number;
  private cache = new Map<string, CacheEntry>();

  constructor(config: AllowlistResolverConfig) {
    this.platforms = config.platforms ?? {};
    this.displayNames = config.displayNames ?? {};
    this.cacheTtlMs = config.cacheTtlMs ?? 5 * 60 * 1000;
  }

  async resolve(input: ResolveInput): Promise<ResolvedIdentity> {
    const cacheKey = `${input.platform}:${input.platformSenderId}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.resolved;
    }

    const resolved = this.resolveUncached(input);
    this.cache.set(cacheKey, { resolved, expiresAt: Date.now() + this.cacheTtlMs });
    return resolved;
  }

  private resolveUncached(input: ResolveInput): ResolvedIdentity {
    const platformCfg = this.platforms[input.platform];
    const senderId = input.platformSenderId;
    const canonicalUserId = `${input.platform}:${senderId}`;

    // Deny by default when no allowlist is configured for the platform.
    if (!platformCfg || platformCfg.allowlist.length === 0) {
      return {
        authorized: false,
        userId: canonicalUserId,
        role: "guest",
        displayName: input.senderName ?? senderId,
        reason: `No allowlist configured for platform "${input.platform}"`,
      };
    }

    const isAdmin = (platformCfg.admins ?? []).includes(senderId);
    const isAllowed = platformCfg.allowlist.includes(senderId) || isAdmin;

    if (!isAllowed) {
      return {
        authorized: false,
        userId: canonicalUserId,
        role: "guest",
        displayName: input.senderName ?? senderId,
        reason: `Sender ${senderId} is not on the allowlist for "${input.platform}"`,
      };
    }

    const displayName =
      this.displayNames[canonicalUserId] ??
      input.senderName ??
      senderId;

    return {
      authorized: true,
      userId: canonicalUserId,
      role: isAdmin ? "admin" : "member",
      displayName,
    };
  }
}

// Register the built-in resolver.
registerIdentityResolver("allowlist", (config) => {
  const allowlistCfg: AllowlistResolverConfig = {
    platforms: (config.platforms ?? {}) as AllowlistResolverConfig["platforms"],
    displayNames: config.displayNames as Record<string, string> | undefined,
    cacheTtlMs: config.cacheTtlMs as number | undefined,
  };
  return new AllowlistIdentityResolver(allowlistCfg);
});
