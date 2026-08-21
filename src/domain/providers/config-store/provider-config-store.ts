import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Value } from "typebox/value";
import type {
  OverlayDocument,
  ProviderLayerPatch,
  ProviderEffectiveConfig,
} from "../../../foundations/schemas/provider-config.js";
import {
  ProviderLayerPatchSchema,
  ProviderEffectiveConfigSchema,
  DEFAULT_RETRY_POLICY,
} from "../../../foundations/schemas/provider-config.js";
import { SeepientError } from "../../../foundations/errors.js";
import { applyDeepPatch, mergePatches } from "./deep-patch.js";
import { resolveDefaultModelForProvider } from "../../../foundations/models-catalog.js";
import { getSyncBuiltinCatalog } from "../model-catalog.js";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === "EPERM";
  }
}

export interface ConfigViolation {
  path: string;
  message: string;
  value?: unknown;
}

/**
 * Manages the runtime provider configuration store with optimistic concurrency locking (If-Match),
 * cross-process file locking (O_EXCL), fsync durability, and deep-patch overlay persistence.
 */
export class ProviderConfigStore {
  private overlayPath?: string;
  private currentOverlay: OverlayDocument;

  constructor(customOverlayPath?: string) {
    if (customOverlayPath === ":memory:") {
      this.overlayPath = undefined;
    } else {
      this.overlayPath =
        customOverlayPath ?? path.join(os.homedir(), ".seepient", "providers-overlay.json");
    }

    this.currentOverlay = {
      revision: 0,
      updatedAt: new Date().toISOString(),
      patch: {},
    };

    if (this.overlayPath && fs.existsSync(this.overlayPath)) {
      try {
        const raw = fs.readFileSync(this.overlayPath, "utf-8");
        const loaded = JSON.parse(raw);
        this.currentOverlay = {
          revision: loaded.revision ?? 0,
          updatedAt: loaded.updatedAt || new Date().toISOString(),
          patch: loaded.patch || {},
        };
      } catch (err: any) {
        throw new SeepientError(
          `Failed to load overlay from ${this.overlayPath}: ${err.message}`,
          "STORAGE_ERROR",
          false,
        );
      }
    }
  }

  /**
   * Acquires a file lock using O_CREAT | O_EXCL.
   */
  private async acquireLock(lockPath: string, timeoutMs = 2000): Promise<number> {
    const start = Date.now();
    const noFollow = fs.constants.O_NOFOLLOW !== undefined ? fs.constants.O_NOFOLLOW : 0;
    while (Date.now() - start < timeoutMs) {
      try {
        const fd = fs.openSync(
          lockPath,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollow,
          0o600,
        );
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
        return fd;
      } catch (err: any) {
        if (err.code === "EEXIST") {
          try {
            const raw = fs.readFileSync(lockPath, "utf-8");
            if (!raw.trim()) {
              fs.unlinkSync(lockPath);
              continue;
            }
            let data: any;
            try {
              data = JSON.parse(raw);
            } catch {
              fs.unlinkSync(lockPath);
              continue;
            }
            const isDeadPid = data.pid && !isProcessAlive(data.pid);
            const isOld = data.createdAt && Date.now() - data.createdAt > 300_000;
            if (isDeadPid || isOld) {
              const tmpStale = `${lockPath}.stale.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
              try {
                fs.renameSync(lockPath, tmpStale);
                fs.unlinkSync(tmpStale);
                continue;
              } catch {
                continue;
              }
            }
          } catch {
            continue;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        } else {
          throw new SeepientError(
            `Failed to acquire lock on ${lockPath}: ${err.message}`,
            "LOCK_FAILED",
            true,
          );
        }
      }
    }
    throw new SeepientError(
      `Configuration store locked by active process after ${timeoutMs}ms on ${lockPath}`,
      "LOCK_TIMEOUT",
      true,
    );
  }

  async getOverlay(): Promise<OverlayDocument> {
    if (this.overlayPath && fs.existsSync(this.overlayPath)) {
      try {
        const raw = fs.readFileSync(this.overlayPath, "utf-8");
        this.currentOverlay = JSON.parse(raw);
      } catch {}
    }
    return JSON.parse(JSON.stringify(this.currentOverlay));
  }

  /**
   * Validates a patch against the ProviderLayerPatch schema using TypeBox Value.Errors.
   * Throws a CONFIG_VIOLATION error with JSON-pointer paths if the patch is invalid.
   */
  validatePatch(patch: unknown): ConfigViolation[] {
    if (!patch || typeof patch !== "object") {
      throw new SeepientError(
        "ConfigViolation: patch must be a non-null object",
        "CONFIG_VIOLATION",
        false,
      );
    }
    const p = patch as any;
    if (p.providers && typeof p.providers === "object") {
      for (const [providerId, entry] of Object.entries(p.providers)) {
        if (entry && typeof entry === "object") {
          const e = entry as any;
          if (e.credential && typeof e.credential === "object") {
            const cred = e.credential;
            if (cred.kind === "seepient" && (!cred.id || typeof cred.id !== "string")) {
              throw new SeepientError(
                `ConfigViolation: credential of kind "seepient" requires string property "id" for provider "${providerId}"`,
                "CONFIG_VIOLATION",
                false,
              );
            }
            if (cred.kind === "env" && (!cred.name || typeof cred.name !== "string")) {
              throw new SeepientError(
                `ConfigViolation: credential of kind "env" requires string property "name" for provider "${providerId}"`,
                "CONFIG_VIOLATION",
                false,
              );
            }
            if (cred.kind === "keychain" && (!cred.account || typeof cred.account !== "string")) {
              throw new SeepientError(
                `ConfigViolation: credential of kind "keychain" requires string property "account" for provider "${providerId}"`,
                "CONFIG_VIOLATION",
                false,
              );
            }
          }
        }
      }
    }
    const errors = [...Value.Errors(ProviderLayerPatchSchema, patch)];
    if (errors.length > 0) {
      const violations: ConfigViolation[] = errors.map((e: any) => ({
        path: e.path ?? "",
        message: e.message ?? "Validation error",
        value: e.value,
      }));
      throw new SeepientError(
        `ConfigViolation: patch contains ${errors.length} validation violation(s): ${violations.map((v) => `${v.path}: ${v.message}`).join("; ")}`,
        "CONFIG_VIOLATION",
        false,
      );
    }
    return [];
  }

  /**
   * Validates an effective config against the ProviderEffectiveConfig schema.
   */
  validateEffective(config: unknown): ConfigViolation[] {
    if (!config || typeof config !== "object") {
      throw new SeepientError(
        "ConfigViolation: effective config must be a non-null object",
        "CONFIG_VIOLATION",
        false,
      );
    }
    const errors = [...Value.Errors(ProviderEffectiveConfigSchema, config)];
    if (errors.length > 0) {
      const violations: ConfigViolation[] = errors.map((e: any) => ({
        path: e.path ?? "",
        message: e.message ?? "Validation error",
        value: e.value,
      }));
      throw new SeepientError(
        `ConfigViolation: effective config contains ${errors.length} validation violation(s): ${violations.map((v) => `${v.path}: ${v.message}`).join("; ")}`,
        "CONFIG_VIOLATION",
        false,
      );
    }
    return [];
  }

  /**
   * Applies a deep patch to the overlay document with mandatory optimistic concurrency check (If-Match).
   */
  async updateOverlay(
    patch: ProviderLayerPatch,
    expectedRevision: number,
  ): Promise<OverlayDocument> {
    if (expectedRevision === undefined || expectedRevision === null || typeof expectedRevision !== "number") {
      throw new SeepientError(
        "expectedRevision is required for optimistic concurrency control (If-Match).",
        "PRECONDITION_FAILED",
        false,
      );
    }

    this.validatePatch(patch);

    let lockFd: number | undefined;
    let lockPath: string | undefined;

    try {
      if (this.overlayPath) {
        const dir = path.dirname(this.overlayPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
        lockPath = `${this.overlayPath}.lock`;
        lockFd = await this.acquireLock(lockPath);

        // Re-read latest overlay under lock
        if (fs.existsSync(this.overlayPath)) {
          const raw = fs.readFileSync(this.overlayPath, "utf-8");
          this.currentOverlay = JSON.parse(raw);
        }
      }

      if (expectedRevision !== this.currentOverlay.revision) {
        throw new SeepientError(
          `Optimistic concurrency violation: expected revision ${expectedRevision}, but current revision is ${this.currentOverlay.revision}.`,
          "PRECONDITION_FAILED",
          false,
        );
      }

      const newPatch = mergePatches(this.currentOverlay.patch, patch) || {};
      const nextRevision = this.currentOverlay.revision + 1;
      const now = new Date().toISOString();

      const updatedOverlay: OverlayDocument = {
        revision: nextRevision,
        updatedAt: now,
        patch: newPatch,
      };

      // 1. Record audit event BEFORE renaming overlay to active path
      const { recordProviderAuditEvent } = await import("../audit-log.js");
      recordProviderAuditEvent({
        timestamp: new Date().toISOString(),
        action: "update_overlay",
        revision: updatedOverlay.revision,
        details: patch,
      });

      // 2. Commit overlay document durably to disk
      if (this.overlayPath) {
        const tmp = `${this.overlayPath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
        const fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_TRUNC, 0o600);
        const data = Buffer.from(JSON.stringify(updatedOverlay, null, 2), "utf8");
        fs.writeSync(fd, data);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fs.renameSync(tmp, this.overlayPath);

        // Fsync parent directory for durability
        try {
          const dirFd = fs.openSync(path.dirname(this.overlayPath), fs.constants.O_RDONLY);
          fs.fsyncSync(dirFd);
          fs.closeSync(dirFd);
        } catch {}
      }

      this.currentOverlay = updatedOverlay;
      return this.currentOverlay;
    } finally {
      if (lockFd !== undefined) {
        try {
          fs.closeSync(lockFd);
          if (lockPath && fs.existsSync(lockPath)) {
            const raw = fs.readFileSync(lockPath, "utf8");
            if (raw) {
              const existing = JSON.parse(raw);
              if (existing?.pid === process.pid) {
                fs.unlinkSync(lockPath);
              }
            } else {
              fs.unlinkSync(lockPath);
            }
          }
        } catch {}
      }
    }
  }

  /**
   * Evaluates the effective runtime configuration by layering the overlay patch over defaults.
   */
  async getEffectiveConfig(
    baseDefaultsOrCreds?:
      | Partial<ProviderEffectiveConfig>
      | { put: (id: string, record: any, meta?: any) => Promise<void> },
    customCwd?: string,
  ): Promise<ProviderEffectiveConfig> {
    let defaults: ProviderEffectiveConfig;
    if (baseDefaultsOrCreds && "providers" in baseDefaultsOrCreds) {
      const standardDefaults = await getDefaultBaseConfigAsync(undefined, customCwd);
      defaults = {
        ...standardDefaults,
        ...baseDefaultsOrCreds,
        providers: baseDefaultsOrCreds.providers ?? standardDefaults.providers,
      };
    } else {
      defaults = await getDefaultBaseConfigAsync(
        baseDefaultsOrCreds as { put: (id: string, record: any, meta?: any) => Promise<void> } | undefined,
        customCwd,
      );
    }
    const overlay = await this.getOverlay();
    const patch = overlay.patch;

    if (!patch || Object.keys(patch).length === 0) {
      return defaults;
    }

    const mergedProviders = applyDeepPatch(defaults.providers, patch.providers || {});
    const mergedAssignments = applyDeepPatch(defaults.modelAssignments, patch.modelAssignments || {});
    const mergedRetry = applyDeepPatch(defaults.retryPolicy, patch.retryPolicy || {});

    const effective: ProviderEffectiveConfig = {
      schemaVersion: 2,
      revision: this.currentOverlay.revision,
      updatedAt: this.currentOverlay.updatedAt || new Date().toISOString(),
      providers: mergedProviders,
      modelAssignments: mergedAssignments,
      retryPolicy: mergedRetry,
      ssrf: patch.ssrf === null ? undefined : (patch.ssrf !== undefined ? (patch.ssrf as any) : defaults.ssrf),
    };

    this.validateEffective(effective);
    return JSON.parse(JSON.stringify(effective));
  }
}

/**
 * Synthesizes default v2 configuration from environment variables.
 */
const baseConfigCache = new Map<string, ProviderEffectiveConfig>();

export function clearBaseConfigCache(): void {
  baseConfigCache.clear();
}

export function synthesizeEnvProviders(): Record<string, any> {
  const providers: Record<string, any> = {};

  if (process.env.OPENAI_API_KEY) {
    providers["openai"] = {
      adapter: "pi-ai",
      upstreamProvider: "openai",
      credential: { kind: "env", name: "OPENAI_API_KEY" },
    };
  }

  if (process.env.ANTHROPIC_API_KEY) {
    providers["anthropic"] = {
      adapter: "pi-ai",
      upstreamProvider: "anthropic",
      credential: { kind: "env", name: "ANTHROPIC_API_KEY" },
    };
  }

  if (process.env.GLM_API_KEY) {
    providers["glm"] = {
      adapter: "pi-ai",
      upstreamProvider: "glm",
      credential: { kind: "env", name: "GLM_API_KEY" },
    };
  }

  if (process.env.OPENAI_COMPAT_API_KEY || process.env.OPENAI_COMPAT_BASE_URL) {
    providers["openai-compatible"] = {
      adapter: "pi-ai",
      upstreamProvider: "openai-compatible",
      baseUrl: process.env.OPENAI_COMPAT_BASE_URL || "https://api.openai.com/v1",
      credential: { kind: "env", name: "OPENAI_COMPAT_API_KEY" },
    };
  }

  return providers;
}

export function synthesizeBaseConfig(): ProviderEffectiveConfig {
  const providers = synthesizeEnvProviders();
  const modelAssignments: any = { text: {} };

  const catalog = getSyncBuiltinCatalog();
  const firstAccount = Object.keys(providers)[0];
  if (firstAccount) {
    try {
      const defaultModel = resolveDefaultModelForProvider(
        catalog,
        providers[firstAccount].upstreamProvider || firstAccount,
        "standard",
      );
      modelAssignments.text.standard = {
        providerAccount: firstAccount,
        model: defaultModel,
      };
    } catch {
      modelAssignments.text.standard = {
        providerAccount: firstAccount,
        model: "default",
      };
    }
  }

  return {
    schemaVersion: 2,
    revision: 0,
    updatedAt: new Date().toISOString(),
    providers,
    modelAssignments,
    retryPolicy: DEFAULT_RETRY_POLICY,
  };
}

export async function getDefaultBaseConfigAsync(
  _credentialStore?: { put: (id: string, record: any, meta?: any) => Promise<void> },
  customCwd?: string,
): Promise<ProviderEffectiveConfig> {
  const cacheKey = customCwd ?? "default";
  if (baseConfigCache.has(cacheKey)) {
    return baseConfigCache.get(cacheKey)!;
  }

  const baseConfig = synthesizeBaseConfig();
  baseConfigCache.set(cacheKey, baseConfig);

  // Proactively sanitize legacy audit log on startup
  try {
    const { scrubAuditLog } = await import("../audit-log.js");
    scrubAuditLog();
  } catch {}

  return baseConfig;
}

export function getDefaultBaseConfig(
  _credentialStore?: { put: (id: string, record: any, meta?: any) => Promise<void> },
  customCwd?: string,
): ProviderEffectiveConfig {
  const cacheKey = customCwd ?? "default";
  if (baseConfigCache.has(cacheKey)) {
    return baseConfigCache.get(cacheKey)!;
  }

  const baseConfig = synthesizeBaseConfig();
  baseConfigCache.set(cacheKey, baseConfig);
  return baseConfig;
}
