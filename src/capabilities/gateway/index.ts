/**
 * Seepient Gateway — Public API
 *
 * Barrel export for the gateway subsystem.
 */

export { MCPGateway } from './gateway.js';
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

import { MCPGateway } from './gateway.js';
import { GatewaySettingsAdapter } from './settings-adapter.js';
import { createGatewayTools } from './tool-factory.js';
import type { ToolModule } from '../../foundations/contracts/tool.js';
import type { GatewayConfig, GatewayHooks } from './types.js';

/**
 * Create and initialize a gateway instance and its proxy tools.
 * Returns null if gateway is disabled in settings.
 *
 * Inverted (Spec 022): returns { gateway, tools }, leaving registration
 * to the composition root's per-agent ToolRegistry.
 */
export async function createGateway(
  config: GatewayConfig,
  settingsAdapter: GatewaySettingsAdapter,
  hooks?: GatewayHooks,
): Promise<{ gateway: MCPGateway; tools: ToolModule[] } | null> {
  if (!config.enabled) return null;

  const gateway = new MCPGateway(settingsAdapter, config, hooks);
  await gateway.initialize();

  const tools = createGatewayTools(gateway);
  return { gateway, tools };
}
