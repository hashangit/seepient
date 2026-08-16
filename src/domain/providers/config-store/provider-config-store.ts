import * as fs from "node:fs";
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
 * Manages the runtime provider configuration store with optimistic concurrency locking
 * and deep-patch overlay persistence.
 */
export class ProviderConfigStore {
  private overlayPath?: string;
  private currentOverlay: OverlayDocument;

  constructor(customOverlayPath?: string) {
    this.overlayPath = customOverlayPath;
    this.currentOverlay = {
      revision: 0,
      updatedAt: new Date().toISOString(),
      patch: {},
    };

    if (this.overlayPath && fs.existsSync(this.overlayPath)) {
      try {
        const raw = fs.readFileSync(this.overlayPath, "utf-8");
        this.currentOverlay = JSON.parse(raw);
      } catch {
        // Fall back to empty revision 0 overlay
      }
    }
  }

  private reloadFromDisk(): void {
    if (this.overlayPath && fs.existsSync(this.overlayPath)) {
      try {
        const raw = fs.readFileSync(this.overlayPath, "utf-8");
        this.currentOverlay = JSON.parse(raw);
      } catch {
        // Retain in-memory copy
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

  /**
   * Applies a deep patch to the overlay document with optimistic concurrency check.
   */
  async updateOverlay(
    patch: ProviderLayerPatch,
    expectedRevision?: number,
  ): Promise<OverlayDocument> {
    this.reloadFromDisk();
    if (expectedRevision !== undefined && expectedRevision !== this.currentOverlay.revision) {
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
      const dir = path.dirname(this.overlayPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      const tmp = `${this.overlayPath}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(updatedOverlay, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.overlayPath);
    }

    this.currentOverlay = updatedOverlay;
    return JSON.parse(JSON.stringify(this.currentOverlay));
  }

  /**
   * Computes the effective config from the merged overlay and default policies.
   */
  async getEffectiveConfig(baseDefaults?: Partial<ProviderEffectiveConfig>): Promise<ProviderEffectiveConfig> {
    const patch = this.currentOverlay.patch || {};
    const mergedProviders = applyDeepPatch(baseDefaults?.providers || {}, patch.providers || {}) || {};
    const mergedAssignments = applyDeepPatch(baseDefaults?.modelAssignments || { text: { standard: { providerAccount: "openai", model: "gpt-4o" } } }, patch.modelAssignments || {}) || {};
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
