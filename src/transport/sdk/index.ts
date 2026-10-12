/**
 * Seepient SDK — Public entry point (FULL package, spec 027).
 *
 * The engine surface (createSeepient, askSeepient, createChat, tools,
 * providers, stores, types) re-exports from `seepient-core`; this entry adds
 * the full-package-only surface: the MCP gateway, provider management API,
 * and the Profile-A settings helper. The built-in tool barrel, boundary
 * pipeline, media vendors, and discovery sources register into the engine
 * seams at import time.
 */

// Full-package registrations must run before any exported surface is used
// (spec 027): built-in tool barrel, boundary pipeline, media, discovery, PM API.
import "./full-registrations.js";

import * as path from 'path';
import { homedir } from 'os';

// ── Engine surface (seepient-core) ──────────────────────────────────────────

export * from "seepient-core/dist/transport/sdk/core.js";

// ── Full-package-only surface ───────────────────────────────────────────────

export { createProviderManagerApi, isOAuthSupported, getCanonicalOAuthFlowId } from "../cli/provider-manager-api.js";
/**
 * @warning Profile A only. Ambient configuration access reading from ~/.seepient/setting.json.
 * Do not use in multi-tenant environments.
 */
export { settings, SettingsError } from "./settings.js";
export { GatewaySettingsAdapter } from "../../capabilities/gateway/settings-adapter.js";
import type { GatewayConfig } from "../../capabilities/gateway/types.js";
import type { GatewaySettingsAdapter } from "../../capabilities/gateway/settings-adapter.js";

// Gateway (lazy — only loaded when used; Spec 022 returns { gateway, tools }, no global registration)
export const gateway = {
  async createGateway(
    config: GatewayConfig,
    settingsAdapter?: GatewaySettingsAdapter,
    options?: { tenancy?: import("seepient-core/dist/domain/tenancy/tenancy-mode.js").TenancyMode },
  ) {
    const { createGateway } = await import('../../capabilities/gateway/index.js');
    const { GatewaySettingsAdapter: Adapter } = await import('../../capabilities/gateway/settings-adapter.js');
    const mode = options?.tenancy ?? config.tenancy;
    if (mode === "multi" && !settingsAdapter) {
      const { TenancyAmbientIoError } = await import("seepient-core/dist/domain/tenancy/tenancy-mode.js");
      throw new TenancyAmbientIoError(
        path.join(homedir(), '.seepient'),
        'Ambient gateway adapter default at "~/.seepient" is forbidden in multi-tenant mode. Pass an explicit GatewaySettingsAdapter.',
      );
    }
    const storageDir = process.env.SEEPIENT_GATEWAY_DIR ?? path.join(homedir(), '.seepient');
    const adapter = settingsAdapter ?? new Adapter(storageDir);
    if (!settingsAdapter) await adapter.initialize();
    return createGateway(config, adapter);
  },
};
