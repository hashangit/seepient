/**
 * Zoe Channels — `zoe-channels` binary entry (spec 002 §8)
 *
 * A single process runs all enabled messaging platforms concurrently, sharing
 * one SessionRegistry, one IdentityResolver, one PersistenceBackend, one
 * outbox. A fourth sibling binary alongside `zoe` (CLI) and `zoe-server`.
 *
 * Reuses all existing bootstrap: loadMergedConfig, getProvider, the file
 * persistence backend, the SessionRegistry + AllowlistIdentityResolver from
 * Phase 2, and the ChannelGateway from Phase 3. Delegates to runAgentLoop
 * (constitution I) — the binary itself contains no loop logic.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { ChannelPlatform } from "../../core/types.js";
import { getProvider } from "../../core/provider-resolver.js";
import { loadMergedConfig } from "../cli/config-loader.js";
import { createPersistenceBackend } from "../../core/session-store.js";
import { createSessionRegistry } from "../../core/session-registry.js";
import { AllowlistIdentityResolver } from "../../core/identity-resolver.js";
import { ChannelGateway } from "./gateway.js";
import { Outbox, MemoryOutboxStorage } from "./outbox.js";
import type { ChannelAdapter } from "./types.js";

const PLATFORM_BINARIES: Record<string, (cfg: ChannelsPlatformConfig) => ChannelAdapter> = {};

// Lazily register the Telegram adapter factory so grammY is only imported when
// channels mode is active (keeps it out of headless/server builds — T047).
export function registerPlatformBinary(platform: string, factory: (cfg: ChannelsPlatformConfig) => ChannelAdapter): void {
  PLATFORM_BINARIES[platform] = factory;
}

export interface ChannelsPlatformConfig {
  token?: string;
  webhookUrl?: string | null;
  allowlist?: string[];
  admins?: string[];
  systemPromptOverride?: string;
  [key: string]: unknown;
}

export interface ChannelsBinaryOptions {
  /** Override the config source (tests). */
  config?: Record<string, unknown>;
  /** Override the persistence backend (tests). */
  backend?: ReturnType<typeof createPersistenceBackend>;
  /** Disable starting a health HTTP listener. */
  healthPort?: number | null;
}

/**
 * Build and start the channels gateway from merged config. Returns the running
 * gateway + a `stop()` for graceful shutdown.
 */
export async function startChannelsBinary(options: ChannelsBinaryOptions = {}): Promise<{
  gateway: ChannelGateway;
  stop: () => Promise<void>;
}> {
  const merged = options.config ?? loadMergedConfig();
  const channelsRoot = ((merged as any).channels ?? {}) as {
    enabled?: string | string[];
    outbox?: { enabled?: boolean; pollIntervalMs?: number };
    [platform: string]: unknown;
  };

  const enabled = parseEnabled(channelsRoot.enabled);
  if (enabled.length === 0) {
    throw new Error(
      "No channels enabled. Set channels.enabled (comma-separated platform names) in config or ZOE_CHANNELS_ENABLED.",
    );
  }

  // Resolve the LLM provider/model (reuse the existing resolver).
  const providerType = ((merged as any).provider ?? (merged as any).llmProvider) as string | undefined;
  const modelOverride = (merged as any).model as string | undefined;
  const { provider, model } = await getProvider(providerType as any, modelOverride);

  // Shared infrastructure — one each per process.
  const backend = options.backend ?? createPersistenceBackend({ type: "file" });
  const registry = createSessionRegistry(backend);

  // Build the resolver config from the per-platform allowlist/admins.
  const resolver = new AllowlistIdentityResolver({
    platforms: collectPlatformPolicies(channelsRoot, enabled),
  });

  const outbox = new Outbox({
    storage: new MemoryOutboxStorage(),
    pollIntervalMs: channelsRoot.outbox?.pollIntervalMs ?? 5_000,
  });

  // Instantiate enabled adapters lazily.
  const adapters: ChannelAdapter[] = [];
  for (const platform of enabled) {
    const factory = PLATFORM_BINARIES[platform];
    if (!factory) {
      throw new Error(`No adapter factory registered for platform "${platform}".`);
    }
    const platformCfg = (channelsRoot[platform] ?? {}) as ChannelsPlatformConfig;
    if (!platformCfg.token) {
      throw new Error(`Platform "${platform}" is enabled but no token is configured.`);
    }
    adapters.push(factory(platformCfg));
  }

  const gateway = new ChannelGateway({
    provider,
    model,
    registry,
    resolver,
    adapters,
    outbox,
    streamMode: "single",
    maxSteps: 10,
  });

  await gateway.start();

  // Optional health endpoint.
  let healthServer: ReturnType<typeof createServer> | null = null;
  if (options.healthPort !== null) {
    const port = options.healthPort ?? Number(process.env.ZOE_CHANNELS_HEALTH_PORT ?? 0);
    if (port) {
      healthServer = createServer((req, res) => {
        if (req.url === "/_health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, platforms: enabled }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      healthServer.listen(port);
    }
  }

  const stop = async () => {
    if (healthServer) await new Promise<void>((r) => healthServer!.close(() => r()));
    await gateway.stop();
  };

  return { gateway, stop };
}

/** CLI entrypoint. */
export async function runChannelsBinary(): Promise<void> {
  // Register the built-in Telegram adapter.
  const { TelegramChannelAdapter } = await import("./telegram/adapter.js");
  registerPlatformBinary("telegram", (cfg) =>
    new TelegramChannelAdapter({
      token: cfg.token!,
      webhookUrl: cfg.webhookUrl ?? null,
      ...(cfg.systemPromptOverride ? { systemPromptOverride: cfg.systemPromptOverride } : {}),
    }),
  );

  const { stop } = await startChannelsBinary();

  // Graceful shutdown on SIGINT/SIGTERM.
  let stopping = false;
  const handle = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.error(`[zoe-channels] received ${signal}, shutting down...`);
    try {
      await stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void handle("SIGINT"));
  process.on("SIGTERM", () => void handle("SIGTERM"));

  console.error("[zoe-channels] running. Press Ctrl+C to stop.");
}

// ── Helpers ───────────────────────────────────────────────────────────

function parseEnabled(enabled: unknown): ChannelPlatform[] {
  if (!enabled) return [];
  if (Array.isArray(enabled)) return enabled as ChannelPlatform[];
  return String(enabled)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as ChannelPlatform[];
}

/** Collect { allowlist, admins } per platform for the identity resolver. */
function collectPlatformPolicies(
  root: { [platform: string]: unknown },
  enabled: string[],
): Partial<Record<ChannelPlatform, { allowlist: string[]; admins?: string[] }>> {
  const out: Partial<Record<ChannelPlatform, { allowlist: string[]; admins?: string[] }>> = {};
  for (const platform of enabled) {
    const cfg = (root[platform] ?? {}) as {
      allowlist?: string[] | string;
      admins?: string[] | string;
    };
    const allowlist = Array.isArray(cfg.allowlist)
      ? cfg.allowlist
      : String(cfg.allowlist ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
    const admins = Array.isArray(cfg.admins)
      ? cfg.admins
      : String(cfg.admins ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
    out[platform as ChannelPlatform] = {
      allowlist,
      ...(admins.length > 0 ? { admins } : {}),
    };
  }
  return out;
}

// Re-export so the standalone wrapper can find a sensible default docs dir.
export const DEFAULT_SESSIONS_DIR = join(homedir(), ".zoe", "sessions");
