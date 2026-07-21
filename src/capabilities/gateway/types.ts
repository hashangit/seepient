/**
 * Seepient Gateway — Type definitions
 *
 * Types for MCP targets, REST targets, audit records, and gateway config.
 * Reuses Seepient's existing ToolModule and ToolDefinition from src/tools/interface.ts.
 */

export type AuthType = 'none' | 'header' | 'bearer' | 'query' | 'basic';
export type McpTransportType = 'stdio' | 'sse' | 'http';

export interface RestTarget {
  kind: 'rest';
  baseUrl: string;
  description: string;
  auth: { type: AuthType; name?: string; credentialRef?: string };
  defaultHeaders: Record<string, string>;
  operations: Array<{ opId: string; method: string; path: string; summary: string }>;
  tags: string[];
  enabled: boolean;
}

export interface McpTarget {
  kind: 'mcp';
  transport: McpTransportType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  auth?: { type: AuthType; name?: string; credentialRef?: string };
  description: string;
  tags: string[];
  enabled: boolean;
  capabilities?: { tools?: any[]; resources?: any[]; prompts?: any[] };
}

export type Target = RestTarget | McpTarget;

export interface AuditRecord {
  timestamp: number;
  agent: string;
  target: string;
  operation: string;
  status: string;
  durationMs: number;
  success: boolean;
}

export interface GatewayHooks {
  onAudit?: (record: AuditRecord) => void | Promise<void>;
  onSamplingRequest?: (params: any) => Promise<any>;
}

export interface GatewayConfig {
  enabled: boolean;
  semanticTopK: number;
  defaultRateLimitPerMin: number;
  maxAuditLogsInMemory: number;
}
