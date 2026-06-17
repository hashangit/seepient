/**
 * Zoe Gateway — Public API
 *
 * Barrel export for the gateway subsystem.
 */

export { ToolsGateway } from './gateway.js';
export { createGatewayTools } from './tool-factory.js';
export { importOpenApiSpec } from './openapi-importer.js';
export { GatewaySettingsAdapter } from './settings-adapter.js';
export { scoreRelevance } from './semantic-scorer.js';
export type {
  AuthType,
  McpTransportType,
  RestTarget,
  McpTarget,
  Target,
  AuditRecord,
  GatewayHooks,
  GatewayConfig,
} from './types.js';

import { ToolsGateway } from './gateway.js';
import { GatewaySettingsAdapter } from './settings-adapter.js';
import { createGatewayTools } from './tool-factory.js';
import { registerTool } from '../core/tool-executor.js';
import type { GatewayConfig, GatewayHooks } from './types.js';

/**
 * Create and initialize a gateway instance.
 * Returns null if gateway is disabled in settings.
 *
 * The caller creates and owns the GatewaySettingsAdapter.
 */
export async function createGateway(
  config: GatewayConfig,
  settingsAdapter: GatewaySettingsAdapter,
  hooks?: GatewayHooks,
): Promise<ToolsGateway | null> {
  if (!config.enabled) return null;

  const gateway = new ToolsGateway(settingsAdapter, config, hooks);
  await gateway.initialize();

  // Register proxy tools in static registry
  const tools = createGatewayTools(gateway);
  for (const tool of tools) {
    registerTool(tool);
  }

  return gateway;
}
