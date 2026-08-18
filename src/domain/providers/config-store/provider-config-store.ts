import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  OverlayDocument,
  ProviderLayerPatch,
  ProviderEffectiveConfig,
} from "../../../foundations/schemas/provider-config.js";
import { DEFAULT_RETRY_POLICY } from "../../../foundations/schemas/provider-config.js";
import { SeepientError } from "../../../foundations/errors.js";
import { loadMergedConfig } from "../../../foundations/config.js";
import { migrateV1ToV2 } from "../migration.js";
import { CompositeCredentialStore } from "../credentials/composite-credential-store.js";
import { applyDeepPatch, mergePatches } from "./deep-patch.js";

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
        this.currentOverlay = JSON.parse(raw);
        if (typeof this.currentOverlay?.revision !== "number") {
          throw new Error("Invalid overlay document: missing numeric revision");
        }
      } catch (err: any) {
        throw new SeepientError(
          `Failed to load provider configuration overlay from ${this.overlayPath}: ${err.message}`,
          "CORRUPT_STORAGE",
          false,
        );
      }
    }
  }

  private reloadFromDisk(): void {
    if (this.overlayPath && fs.existsSync(this.overlayPath)) {
      try {
        const raw = fs.readFileSync(this.overlayPath, "utf-8");
        const parsed = JSON.parse(raw);
        if (typeof parsed?.revision === "number") {
          this.currentOverlay = parsed;
        }
      } catch (err: any) {
        throw new SeepientError(
          `Failed to reload provider configuration overlay from ${this.overlayPath}: ${err.message}`,
          "CORRUPT_STORAGE",
          false,
        );
      }
    }
  }

  /**
   * Retrieves the current overlay document.
   */
  async getOverlay(): Promise<OverlayDocument> {
    this.reloadFromDisk();
    return JSON.parse(JSON.stringify(this.currentOverlay));
  }

  private acquireLock(lockPath: string): number {
    const lockInfo = JSON.stringify({ pid: process.pid, createdAt: Date.now() });
    try {
      const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR, 0o600);
      fs.writeSync(fd, Buffer.from(lockInfo, "utf8"));
      fs.fsyncSync(fd);
      return fd;
    } catch (err: any) {
      if (err.code === "EEXIST") {
        try {
          const raw = fs.readFileSync(lockPath, "utf8");
          let isAlive = false;
          let isStale = true;
          if (raw.trim().length > 0) {
            try {
              const existing = JSON.parse(raw);
              isAlive = Boolean(existing?.pid && this.isPidAlive(existing.pid));
              isStale = Date.now() - (existing?.createdAt || 0) > 300_000;
            } catch {
              // Corrupt lock file is treated as stale/abandoned
              isAlive = false;
              isStale = true;
            }
          }

          if (!isAlive || isStale) {
            const staleTmp = `${lockPath}.stale.${Date.now()}.${Math.random().toString(36).slice(2)}`;
            try {
              fs.renameSync(lockPath, staleTmp);
            } catch {
              throw new SeepientError(
                `Configuration store locked by concurrent process: ${lockPath}`,
                "LOCKED",
                true,
              );
            }

            // Verify the renamed lock matches what we inspected (prevent stealing a fresh lock)
            try {
              const renamedRaw = fs.readFileSync(staleTmp, "utf8");
              if (raw.trim() !== renamedRaw.trim()) {
                // Lock was replaced with a new one before rename! Restore and abort
                try {
                  fs.renameSync(staleTmp, lockPath);
                } catch {
                  // Ignore
                }
                throw new SeepientError(
                  `Configuration store locked by concurrent process: ${lockPath}`,
                  "LOCKED",
                  true,
                );
              }
              fs.unlinkSync(staleTmp);
            } catch (vErr: any) {
              if (vErr instanceof SeepientError) throw vErr;
              try {
                fs.unlinkSync(staleTmp);
              } catch {
                // Ignore
              }
            }

            const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR, 0o600);
            fs.writeSync(fd, Buffer.from(lockInfo, "utf8"));
            fs.fsyncSync(fd);
            return fd;
          }
        } catch (innerErr: any) {
          if (innerErr instanceof SeepientError) throw innerErr;
        }
        throw new SeepientError(
          `Configuration store locked by concurrent process: ${lockPath}`,
          "LOCKED",
          true,
        );
      }
      throw err;
    }
  }

  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Validates a patch against the ProviderLayerPatch schema.
   * Throws a ConfigViolation error if the patch is invalid.
   */
  validatePatch(patch: unknown): void {
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
        if (entry === null || entry === undefined) continue;
        if (typeof entry !== "object") {
          throw new SeepientError(
            `ConfigViolation: provider entry for "${providerId}" must be an object or null`,
            "CONFIG_VIOLATION",
            false,
          );
        }
        const e = entry as any;
        if (e.credential !== undefined && e.credential !== null) {
          const cred = e.credential;
          const validKinds = ["env", "seepient", "keychain", "externalsecret", "none"];
          if (!cred.kind || !validKinds.includes(cred.kind)) {
            throw new SeepientError(
              `ConfigViolation: invalid credential kind "${cred.kind}" for provider "${providerId}"`,
              "CONFIG_VIOLATION",
              false,
            );
          }
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

  /**
   * Applies a deep patch to the overlay document with mandatory optimistic concurrency check (If-Match).
   */
  async updateOverlay(
    patch: ProviderLayerPatch,
    expectedRevision: number,
  ): Promise<OverlayDocument> {
    if (expectedRevision === undefined || expectedRevision === null || typeof expectedRevision !== "number") {
      throw new SeepientError(
        "expectedRevision is required for overlay mutations (If-Match precondition requirement)",
        "PRECONDITION_FAILED",
        false,
      );
    }

    this.validatePatch(patch);

    let lockFd: number | undefined;
    let lockPath: string | undefined;

    if (this.overlayPath) {
      const dir = path.dirname(this.overlayPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      lockPath = `${this.overlayPath}.lock`;
      lockFd = this.acquireLock(lockPath);
    }

    try {
      this.reloadFromDisk();

      if (expectedRevision !== this.currentOverlay.revision) {
        throw new SeepientError(
          `Overlay revision mismatch: expected revision ${expectedRevision} but current revision is ${this.currentOverlay.revision}`,
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
        } catch {
          // Ignore
        }
      }
    }
  }

  /**
   * Computes the effective config from the merged overlay and default policies.
   * If baseDefaults is omitted, synthesizes defaults from environment and v1 config.
   */
  async getEffectiveConfig(baseDefaults?: Partial<ProviderEffectiveConfig>): Promise<ProviderEffectiveConfig> {
    this.reloadFromDisk();
    const defaults = baseDefaults ?? (await getDefaultBaseConfigAsync());
    const patch = this.currentOverlay.patch || {};
    const mergedProviders = applyDeepPatch(defaults.providers || {}, patch.providers || {}) || {};
    const mergedAssignments = applyDeepPatch(defaults.modelAssignments || {}, patch.modelAssignments || {}) || {};
    const mergedRetry = applyDeepPatch(defaults.retryPolicy || DEFAULT_RETRY_POLICY, patch.retryPolicy || {}) || DEFAULT_RETRY_POLICY;

    return {
      schemaVersion: 2,
      revision: this.currentOverlay.revision,
      updatedAt: this.currentOverlay.updatedAt,
      providers: mergedProviders,
      modelAssignments: mergedAssignments,
      retryPolicy: mergedRetry,
      ssrf: patch.ssrf === null ? undefined : (patch.ssrf !== undefined ? (patch.ssrf as any) : defaults.ssrf),
    };
  }
}

/**
 * Synthesizes default v2 configuration from environment variables and legacy v1 configuration.
 */
let cachedBaseConfig: ProviderEffectiveConfig | null = null;

export function clearBaseConfigCache(): void {
  cachedBaseConfig = null;
}

export async function getDefaultBaseConfigAsync(
  credentialStore?: { put: (id: string, record: any, meta?: any) => Promise<void> },
  customCwd?: string,
): Promise<ProviderEffectiveConfig> {
  if (cachedBaseConfig) {
    return cachedBaseConfig;
  }
  try {
    const v1Config = loadMergedConfig(customCwd);
    const migrationResult = migrateV1ToV2(v1Config);

    if (migrationResult.migratedCredentials && migrationResult.migratedCredentials.length > 0) {
      const store = credentialStore ?? new CompositeCredentialStore();
      await Promise.all(
        migrationResult.migratedCredentials.map((cred) =>
          store.put(
            cred.id,
            { kind: "api_key", keyValue: cred.keyValue },
            { source: "migration" },
          ),
        ),
      );
    }

    cachedBaseConfig = migrationResult.config;
    return cachedBaseConfig;
  } catch {
    return {
      schemaVersion: 2,
      revision: 0,
      updatedAt: new Date().toISOString(),
      providers: {
        openai: { adapter: "pi-ai", upstreamProvider: "openai", credential: { kind: "env", name: "OPENAI_API_KEY" } },
        anthropic: { adapter: "pi-ai", upstreamProvider: "anthropic", credential: { kind: "env", name: "ANTHROPIC_API_KEY" } },
        glm: { adapter: "pi-ai", upstreamProvider: "glm", credential: { kind: "env", name: "GLM_API_KEY" } },
      },
      modelAssignments: {
        text: { standard: { providerAccount: "openai", model: "gpt-4o" } },
        plan: { standard: { providerAccount: "openai", model: "gpt-4o" } },
        vision: { standard: { providerAccount: "openai", model: "gpt-4o" } },
        commit: { standard: { providerAccount: "openai", model: "gpt-4o" } },
        media: { image: { providerAccount: "openai", model: "dall-e-3" } },
      },
      retryPolicy: DEFAULT_RETRY_POLICY,
    };
  }
}

export function getDefaultBaseConfig(
  credentialStore?: { put: (id: string, record: any, meta?: any) => Promise<void> },
  customCwd?: string,
): ProviderEffectiveConfig {
  if (cachedBaseConfig) {
    return cachedBaseConfig;
  }
  try {
    const v1Config = loadMergedConfig(customCwd);
    const migrationResult = migrateV1ToV2(v1Config);

    if (migrationResult.migratedCredentials && migrationResult.migratedCredentials.length > 0) {
      const store = credentialStore ?? new CompositeCredentialStore();
      for (const cred of migrationResult.migratedCredentials) {
        store.put(
          cred.id,
          { kind: "api_key", keyValue: cred.keyValue },
          { source: "migration" },
        ).catch(() => {});
      }
    }

    cachedBaseConfig = migrationResult.config;
    return cachedBaseConfig;
  } catch {
    return {
      schemaVersion: 2,
      revision: 0,
      updatedAt: new Date().toISOString(),
      providers: {
        openai: { adapter: "pi-ai", upstreamProvider: "openai", credential: { kind: "env", name: "OPENAI_API_KEY" } },
        anthropic: { adapter: "pi-ai", upstreamProvider: "anthropic", credential: { kind: "env", name: "ANTHROPIC_API_KEY" } },
        glm: { adapter: "pi-ai", upstreamProvider: "glm", credential: { kind: "env", name: "GLM_API_KEY" } },
      },
      modelAssignments: {
        text: { standard: { providerAccount: "openai", model: "gpt-4o" } },
        plan: { standard: { providerAccount: "openai", model: "gpt-4o" } },
        vision: { standard: { providerAccount: "openai", model: "gpt-4o" } },
        commit: { standard: { providerAccount: "openai", model: "gpt-4o" } },
        media: { image: { providerAccount: "openai", model: "dall-e-3" } },
      },
      retryPolicy: DEFAULT_RETRY_POLICY,
    };
  }
}
