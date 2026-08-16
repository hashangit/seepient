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
import { applyDeepPatch } from "./deep-patch.js";

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
      return fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR, 0o600);
    } catch (err: any) {
      if (err.code === "EEXIST") {
        try {
          const raw = fs.readFileSync(lockPath, "utf8");
          const existing = JSON.parse(raw);
          const isAlive = existing?.pid && this.isPidAlive(existing.pid);
          const isStale = Date.now() - (existing?.createdAt || 0) > 10_000;

          if (!isAlive || isStale) {
            fs.unlinkSync(lockPath);
            return fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR, 0o600);
          }
        } catch {
          // Lock contention
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

      const newPatch = applyDeepPatch(this.currentOverlay.patch, patch) || {};
      const nextRevision = this.currentOverlay.revision + 1;
      const now = new Date().toISOString();

      const updatedOverlay: OverlayDocument = {
        revision: nextRevision,
        updatedAt: now,
        patch: newPatch,
      };

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
      return JSON.parse(JSON.stringify(this.currentOverlay));
    } finally {
      if (lockFd !== undefined && lockPath) {
        try {
          fs.closeSync(lockFd);
        } catch {
          // Ignore
        }
        try {
          if (fs.existsSync(lockPath)) {
            fs.unlinkSync(lockPath);
          }
        } catch {
          // Ignore
        }
      }
    }
  }

  /**
   * Computes the effective config from the merged overlay and default policies.
   */
  async getEffectiveConfig(baseDefaults?: Partial<ProviderEffectiveConfig>): Promise<ProviderEffectiveConfig> {
    const patch = this.currentOverlay.patch || {};
    const mergedProviders = applyDeepPatch(baseDefaults?.providers || {}, patch.providers || {}) || {};
    const mergedAssignments = applyDeepPatch(baseDefaults?.modelAssignments || {}, patch.modelAssignments || {}) || {};
    const mergedRetry = applyDeepPatch(baseDefaults?.retryPolicy || DEFAULT_RETRY_POLICY, patch.retryPolicy || {}) || DEFAULT_RETRY_POLICY;

    return {
      schemaVersion: 2,
      revision: this.currentOverlay.revision,
      updatedAt: this.currentOverlay.updatedAt,
      providers: mergedProviders,
      modelAssignments: mergedAssignments,
      retryPolicy: mergedRetry,
      ssrf: (patch.ssrf as any) || baseDefaults?.ssrf,
    };
  }
}
