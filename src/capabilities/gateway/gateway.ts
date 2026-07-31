/**
 * Seepient Gateway — MCPGateway engine
 *
 * Core engine that manages MCP and REST targets, routes requests,
 * and exposes injectable tools for the agent loop.
 */

import { Client, StdioClientTransport, SSEClientTransport, CreateMessageRequestSchema } from '../../vendors/mcp.js';

import { GatewayError } from '../../foundations/errors.js';
import type { ToolModule } from '../../foundations/contracts/tool.js';
import { GatewaySettingsAdapter } from './settings-adapter.js';
import { scoreRelevance } from './semantic-scorer.js';
import type {
  AuditRecord,
  GatewayConfig,
  GatewayHooks,
  McpTarget,
  Target,
} from './types.js';

type Route = { pattern: string; target: string; priority: number };

export class MCPGateway {
  private targets = new Map<string, Target>();
  private mcpClients = new Map<string, Client>();
  private auditLogs: AuditRecord[] = [];
  private routes: Route[] = [];
  private adminTargets = new Set<string>();
  private injectableToolsCache: ToolModule[] | null = null;

  private invalidateToolsCache(): void {
    this.injectableToolsCache = null;
  }

  private settings: GatewaySettingsAdapter;
  private config: GatewayConfig;
  private hooks: GatewayHooks;

  constructor(
    settings: GatewaySettingsAdapter,
    config: GatewayConfig,
    hooks: GatewayHooks = {},
  ) {
    this.settings = settings;
    this.config = config;
    this.hooks = hooks;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    const stored = this.settings.getTargets();
    for (const [name, target] of Object.entries(stored)) {
      this.targets.set(name, target);
    }

    // Restore admin target status from persistence
    const adminNames = this.settings.getAdminTargets();
    let pruned = false;
    for (const name of adminNames) {
      if (this.targets.has(name)) {
        this.adminTargets.add(name);
      } else {
        await this.settings.removeAdminTarget(name);
        pruned = true;
      }
    }

    this.routes = this.settings.getRoutes();

    for (const [name, target] of this.targets) {
      if (!target.enabled || target.kind !== 'mcp') continue;
      try {
        await this.connectMcpClient(name, target);
      } catch {
        // Non-fatal: target fails to connect at startup
      }
    }
  }

  async shutdown(): Promise<void> {
    for (const [, client] of this.mcpClients) {
      try {
        await client.close();
      } catch {
        // Best-effort close
      }
    }
    this.mcpClients.clear();
  }

  // ── Audit ────────────────────────────────────────────────────────────

  private audit(
    agent: string,
    target: string,
    operation: string,
    status: string,
    durationMs: number,
    success: boolean,
  ): void {
    const record: AuditRecord = {
      timestamp: Date.now(),
      agent,
      target,
      operation,
      status,
      durationMs,
      success,
    };

    this.auditLogs.push(record);
    if (this.auditLogs.length > this.config.maxAuditLogsInMemory) {
      this.auditLogs.shift();
    }

    if (this.hooks.onAudit) {
      try {
        const result = this.hooks.onAudit(record);
        if (result instanceof Promise) {
          result.catch(() => {});
        }
      } catch {
        // Non-fatal hook error
      }
    }
  }

  getAuditLogs(targetFilter?: string, limit?: number): AuditRecord[] {
    let logs = this.auditLogs;
    if (targetFilter) {
      logs = logs.filter((r) => r.target === targetFilter);
    }
    if (limit !== undefined && limit < logs.length) {
      logs = logs.slice(-limit);
    }
    return logs;
  }

  getUsageSummary(): Record<string, { calls: number; errors: number }> {
    const summary: Record<string, { calls: number; errors: number }> = {};
    for (const [name] of this.targets) {
      summary[name] = { calls: 0, errors: 0 };
    }
    for (const log of this.auditLogs) {
      if (!summary[log.target]) {
        summary[log.target] = { calls: 0, errors: 0 };
      }
      summary[log.target].calls++;
      if (!log.success) {
        summary[log.target].errors++;
      }
    }
    return summary;
  }

  // ── Target management ────────────────────────────────────────────────

  async registerTarget(name: string, target: Target, isAdmin = false): Promise<void> {
    if (!target || !['mcp', 'rest'].includes(target.kind)) {
      throw new GatewayError(
        `Invalid target: kind must be 'mcp' or 'rest'`,
        name,
        false,
      );
    }
    if (isAdmin) {
      this.adminTargets.add(name);
      await this.settings.addAdminTarget(name);
    }
    this.targets.set(name, target);
    await this.settings.saveTarget(name, target);
    this.invalidateToolsCache();
  }

  async unregisterTarget(name: string): Promise<boolean> {
    const client = this.mcpClients.get(name);
    if (client) {
      try {
        await client.close();
      } catch {
        // Best-effort
      }
      this.mcpClients.delete(name);
    }

    this.routes = this.routes.filter((r) => r.target !== name);
    await this.settings.saveRoutes(this.routes);

    const deleted = this.targets.delete(name);
    if (deleted) {
      await this.settings.deleteTarget(name);
      this.invalidateToolsCache();
    }
    this.adminTargets.delete(name);
    await this.settings.removeAdminTarget(name);
    return deleted;
  }

  async toggleTarget(name: string, enabled: boolean): Promise<boolean> {
    const target = this.targets.get(name);
    if (!target) return false;
    target.enabled = enabled;
    await this.settings.saveTarget(name, target);
    this.invalidateToolsCache();
    return true;
  }

  getTargets(): Record<string, Target> {
    return Object.fromEntries(this.targets);
  }

  // ── Routes ───────────────────────────────────────────────────────────

  async addRoute(pattern: string, target: string, priority: number): Promise<void> {
    const dupe = this.routes.find(
      (r) => r.pattern === pattern && r.target === target,
    );
    if (dupe) return;

    this.routes.push({ pattern, target, priority });
    this.routes.sort((a, b) => b.priority - a.priority);
    await this.settings.saveRoutes(this.routes);
  }

  async removeRoute(pattern: string, target: string): Promise<void> {
    this.routes = this.routes.filter(
      (r) => !(r.pattern === pattern && r.target === target),
    );
    await this.settings.saveRoutes(this.routes);
  }

  routeRequest(request: string): string {
    const lower = request.toLowerCase();

    for (const route of this.routes) {
      if (lower.includes(route.pattern.toLowerCase())) {
        return `-> ${route.target} (route: '${route.pattern}')`;
      }
    }

    let bestTarget: string | null = null;
    let bestScore = 0;
    for (const [name, target] of this.targets) {
      if (!target.enabled) continue;
      const text = [target.description, ...target.tags].join(' ');
      const score = scoreRelevance(request, text);
      if (score > bestScore) {
        bestScore = score;
        bestTarget = name;
      }
    }

    if (bestTarget && bestScore > 0) {
      return `-> ${bestTarget} (tag match)`;
    }

    const available = Array.from(this.targets.keys());
    return available.length > 0
      ? `No route matched. Available: ${available.join(', ')}`
      : 'No targets registered.';
  }

  // ── MCP client connection ────────────────────────────────────────────

  private async connectMcpClient(targetName: string, target: McpTarget): Promise<Client> {
    const cached = this.mcpClients.get(targetName);
    if (cached) return cached;

    const client = new Client(
      { name: 'seepient-gateway', version: '0.1.0' },
      { capabilities: { sampling: {} } },
    );

    if (this.hooks.onSamplingRequest) {
      client.setRequestHandler(
        CreateMessageRequestSchema,
        (request: any) => this.hooks.onSamplingRequest!(request),
      );
    }

    // Resolve env with B3 credential trust guard
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    if (target.env) {
      for (const [k, v] of Object.entries(target.env)) {
        if (v.startsWith('credential:') && v.length > 11) {
          // B3: only resolve credential refs for admin targets
          if (this.adminTargets.has(targetName)) {
            const key = v.substring(11);
            const cred = this.settings.getCredential(key);
            if (cred) {
              env[k] = cred;
            }
          }
        } else {
          env[k] = v;
        }
      }
    }

    if (target.transport === 'stdio') {
      if (!target.command) {
        throw new GatewayError(
          `MCP target "${targetName}" missing command for stdio transport`,
          targetName,
          false,
        );
      }
      const transport = new StdioClientTransport({ command: target.command, args: target.args, env });
      await client.connect(transport);
    } else if (target.transport === 'sse' || target.transport === 'http') {
      if (!target.url) {
        throw new GatewayError(
          `MCP target "${targetName}" missing url for ${target.transport} transport`,
          targetName,
          false,
        );
      }

      // Resolve auth headers for SSE/HTTP transport
      // B3 trust guard: only resolve credentialRef for admin-registered targets
      const headers: Record<string, string> = {};
      if (target.auth?.credentialRef) {
        const cred = this.adminTargets.has(targetName) ? this.settings.getCredential(target.auth.credentialRef) : undefined;
        if (cred) {
          if (target.auth.type === 'bearer') headers['Authorization'] = `Bearer ${cred}`;
          else if (target.auth.type === 'header' && target.auth.name) headers[target.auth.name] = cred;
          else if (target.auth.type === 'basic') headers['Authorization'] = `Basic ${Buffer.from(cred).toString('base64')}`;
        }
      }

      const transport = new SSEClientTransport(new URL(target.url), { requestInit: { headers } });
      await client.connect(transport);
    } else {
      throw new GatewayError(
        `MCP target "${targetName}" has unsupported transport: ${target.transport}`,
        targetName,
        false,
      );
    }

    // Auto-discover capabilities
    const capabilities = target.capabilities ?? {};
    try {
      const toolsResult = await client.listTools();
      capabilities.tools = toolsResult.tools as any[];
    } catch {
      capabilities.tools = [];
    }
    try {
      const resourcesResult = await client.listResources();
      capabilities.resources = resourcesResult.resources as any[];
    } catch {
      capabilities.resources = [];
    }
    try {
      const promptsResult = await client.listPrompts();
      capabilities.prompts = promptsResult.prompts as any[];
    } catch {
      capabilities.prompts = [];
    }

    target.capabilities = capabilities;
    this.mcpClients.set(targetName, client);
    return client;
  }

  // ── MCP tool call ────────────────────────────────────────────────────

  async callMcpTool(
    agent: string,
    targetName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<any> {
    const target = this.targets.get(targetName);
    if (!target) {
      throw new GatewayError(`Target not found: ${targetName}`, targetName, false);
    }
    if (!target.enabled) {
      throw new GatewayError(`Target is disabled: ${targetName}`, targetName, false);
    }
    if (target.kind !== 'mcp') {
      throw new GatewayError(
        `Target "${targetName}" is not an MCP target`,
        targetName,
        false,
      );
    }

    const start = Date.now();
    try {
      const client = await this.connectMcpClient(targetName, target);
      const result = await client.callTool({ name: toolName, arguments: args });
      this.audit(agent, targetName, `tool:${toolName}`, 'success', Date.now() - start, true);
      return result;
    } catch (err) {
      // Evict cached client for lazy reconnect
      this.mcpClients.delete(targetName);
      this.audit(agent, targetName, `tool:${toolName}`, 'error', Date.now() - start, false);
      if (err instanceof GatewayError) throw err;
      throw new GatewayError(
        err instanceof Error ? err.message : String(err),
        targetName,
        true,
      );
    }
  }

  // ── REST proxy ───────────────────────────────────────────────────────

  async callRest(
    agent: string,
    targetName: string,
    reqPath: string,
    method: string,
    query?: Record<string, string>,
    body?: unknown,
  ): Promise<any> {
    const target = this.targets.get(targetName);
    if (!target) {
      throw new GatewayError(`Target not found: ${targetName}`, targetName, false);
    }
    if (!target.enabled) {
      throw new GatewayError(`Target is disabled: ${targetName}`, targetName, false);
    }
    if (target.kind !== 'rest') {
      throw new GatewayError(
        `Target "${targetName}" is not a REST target`,
        targetName,
        false,
      );
    }

    const url = new URL(reqPath, target.baseUrl);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        url.searchParams.set(k, v);
      }
    }

    const headers: Record<string, string> = { ...target.defaultHeaders };

    // B3 trust guard: only resolve credentialRef for admin-registered targets
    if (target.auth.type !== 'none' && target.auth.credentialRef) {
      const cred = this.adminTargets.has(targetName) ? this.settings.getCredential(target.auth.credentialRef) : undefined;
      if (cred) {
        switch (target.auth.type) {
          case 'bearer':
            headers['Authorization'] = `Bearer ${cred}`;
            break;
          case 'header':
            headers[target.auth.name ?? 'X-API-Key'] = cred;
            break;
          case 'query':
            url.searchParams.set(target.auth.name ?? 'api_key', cred);
            break;
          case 'basic':
            headers['Authorization'] = `Basic ${Buffer.from(cred).toString('base64')}`;
            break;
        }
      }
    }

    const start = Date.now();
    try {
      const response = await fetch(url.toString(), {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });

      const text = await response.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }

      this.audit(
        agent,
        targetName,
        `${method} ${reqPath}`,
        response.ok ? 'success' : `http:${response.status}`,
        Date.now() - start,
        response.ok,
      );

      if (!response.ok) {
        throw new GatewayError(
          `REST call to ${targetName} failed: ${response.status} ${text}`,
          targetName,
          response.status >= 500,
        );
      }

      return data;
    } catch (err) {
      if (err instanceof GatewayError) throw err;
      this.audit(agent, targetName, `${method} ${reqPath}`, 'error', Date.now() - start, false);
      throw new GatewayError(
        err instanceof Error ? err.message : String(err),
        targetName,
        true,
      );
    }
  }

  // ── MCP resource read ────────────────────────────────────────────────

  async readResource(agent: string, targetName: string, uri: string): Promise<any> {
    const target = this.targets.get(targetName);
    if (!target) {
      throw new GatewayError(`Target not found: ${targetName}`, targetName, false);
    }
    if (!target.enabled) {
      throw new GatewayError(`Target is disabled: ${targetName}`, targetName, false);
    }
    if (target.kind !== 'mcp') {
      throw new GatewayError(
        `Target "${targetName}" is not an MCP target`,
        targetName,
        false,
      );
    }

    const start = Date.now();
    try {
      const client = await this.connectMcpClient(targetName, target);
      const result = await client.readResource({ uri });
      this.audit(agent, targetName, `resource:${uri}`, 'success', Date.now() - start, true);
      return result;
    } catch (err) {
      this.mcpClients.delete(targetName);
      this.audit(agent, targetName, `resource:${uri}`, 'error', Date.now() - start, false);
      if (err instanceof GatewayError) throw err;
      throw new GatewayError(
        err instanceof Error ? err.message : String(err),
        targetName,
        true,
      );
    }
  }

  // ── MCP prompt get ───────────────────────────────────────────────────

  async getPrompt(
    agent: string,
    targetName: string,
    name: string,
    args?: Record<string, string>,
  ): Promise<any> {
    const target = this.targets.get(targetName);
    if (!target) {
      throw new GatewayError(`Target not found: ${targetName}`, targetName, false);
    }
    if (!target.enabled) {
      throw new GatewayError(`Target is disabled: ${targetName}`, targetName, false);
    }
    if (target.kind !== 'mcp') {
      throw new GatewayError(
        `Target "${targetName}" is not an MCP target`,
        targetName,
        false,
      );
    }

    const start = Date.now();
    try {
      const client = await this.connectMcpClient(targetName, target);
      const result = await client.getPrompt({ name, arguments: args });
      this.audit(agent, targetName, `prompt:${name}`, 'success', Date.now() - start, true);
      return result;
    } catch (err) {
      this.mcpClients.delete(targetName);
      this.audit(agent, targetName, `prompt:${name}`, 'error', Date.now() - start, false);
      if (err instanceof GatewayError) throw err;
      throw new GatewayError(
        err instanceof Error ? err.message : String(err),
        targetName,
        true,
      );
    }
  }

  // ── Injectable tools ─────────────────────────────────────────────────

  getRoutes(): Array<{ pattern: string; target: string; priority: number }> {
    return [...this.routes];
  }

  listCredentialKeys(): string[] {
    return this.settings.listCredentialKeys();
  }

  async setCredential(key: string, value: string): Promise<void> {
    return this.settings.setCredential(key, value);
  }

  async deleteCredential(key: string): Promise<void> {
    return this.settings.deleteCredential(key);
  }

  getInjectableTools(): ToolModule[] {
    if (this.injectableToolsCache) return this.injectableToolsCache;
    const tools = this.buildInjectableTools();
    this.injectableToolsCache = tools;
    return tools;
  }

  private buildInjectableTools(): ToolModule[] {
    const tools: ToolModule[] = [];
    for (const [targetName, target] of this.targets) {
      if (!target.enabled) continue;

      if (target.kind === 'mcp') {
        const mcpTools = target.capabilities?.tools ?? [];
        for (const tool of mcpTools) {
          const toolDef = tool as { name: string; description?: string; inputSchema?: any };
          const prefixedName = `${targetName}__${toolDef.name}`;
          tools.push({
            name: prefixedName,
            risk: 'communications',
            definition: {
              type: 'function',
              function: {
                name: prefixedName,
                description: toolDef.description ?? `MCP tool ${toolDef.name} on ${targetName}`,
                parameters: toolDef.inputSchema ?? {
                  type: 'object',
                  properties: {},
                  required: [],
                },
              },
            },
            handler: async (args: any, config?: any) => {
              const agent = config?.agentName ?? 'seepient';
              const result = await this.callMcpTool(agent, targetName, toolDef.name, args);
              return typeof result === 'string' ? result : JSON.stringify(result);
            },
          });
        }
      }

      if (target.kind === 'rest') {
        for (const op of target.operations) {
          const prefixedName = `${targetName}__${op.opId}`;
          tools.push({
            name: prefixedName,
            risk: 'communications',
            definition: {
              type: 'function',
              function: {
                name: prefixedName,
                description: op.summary ?? `${op.method} ${op.path} on ${targetName}`,
                parameters: {
                  type: 'object',
                  properties: {
                    path: { type: 'string', description: 'Request path' },
                    query: {
                      type: 'object',
                      description: 'Query parameters',
                      additionalProperties: { type: 'string' },
                    },
                    body: { type: 'object', description: 'Request body' },
                  },
                  required: ['path'],
                },
              },
            },
            handler: async (args: any, config?: any) => {
              const agent = config?.agentName ?? 'seepient';
              const result = await this.callRest(
                agent,
                targetName,
                args.path ?? op.path,
                op.method,
                args.query,
                args.body,
              );
              return typeof result === 'string' ? result : JSON.stringify(result);
            },
          });
        }
      }
    }

    return tools;
  }
}
