/**
 * Seepient Gateway — Proxy tool factory
 *
 * Creates 10 gateway tools registered in the static tool registry.
 * Each tool delegates to MCPGateway methods.
 */

import type { MCPGateway } from './gateway.js';
import type { ToolModule } from '../tools/interface.js';

export function createGatewayTools(gateway: MCPGateway): ToolModule[] {
  return [
    // 1. gateway_route
    {
      name: 'gateway_route',
      risk: 'safe',
      definition: {
        type: 'function',
        function: {
          name: 'gateway_route',
          description:
            'Given a natural-language description of what you want to do, finds the best-matching external tool or API operation available through connected services (MCP servers or REST APIs). Returns which service and tool to use, or tells you what services are available if nothing matches. Use this when you need to interact with an external service but are not sure which tool to call.',
          parameters: {
            type: 'object',
            properties: {
              request: {
                type: 'string',
                description: 'Natural-language description of the request to route',
              },
            },
            required: ['request'],
          },
        },
      },
      handler: async (args: any) => {
        return gateway.routeRequest(args.request);
      },
    },

    // 2. gateway_call_tool
    {
      name: 'gateway_call_tool',
      risk: 'communications',
      definition: {
        type: 'function',
        function: {
          name: 'gateway_call_tool',
          description:
            'Call an MCP tool on a gateway target. Proxies the call through the gateway to the target MCP server.',
          parameters: {
            type: 'object',
            properties: {
              target: {
                type: 'string',
                description: 'Name of the registered MCP target',
              },
              tool: {
                type: 'string',
                description: 'Name of the tool to call on the target',
              },
              arguments: {
                type: 'object',
                description: 'Arguments to pass to the tool',
                properties: {},
              },
            },
            required: ['target', 'tool'],
          },
        },
      },
      handler: async (args: any, config?: any) => {
        const agent = config?.agentName ?? 'seepient';
        const result = await gateway.callMcpTool(
          agent,
          args.target,
          args.tool,
          args.arguments ?? {},
        );
        return typeof result === 'string' ? result : JSON.stringify(result);
      },
    },

    // 3. gateway_call_rest
    {
      name: 'gateway_call_rest',
      risk: 'communications',
      definition: {
        type: 'function',
        function: {
          name: 'gateway_call_rest',
          description:
            'Make a REST call through the gateway to a registered REST target.',
          parameters: {
            type: 'object',
            properties: {
              target: {
                type: 'string',
                description: 'Name of the registered REST target',
              },
              path: {
                type: 'string',
                description: 'Request path (appended to target baseUrl)',
              },
              method: {
                type: 'string',
                description: 'HTTP method (GET, POST, PUT, PATCH, DELETE)',
              },
              query: {
                type: 'object',
                description: 'Query parameters',
                properties: {},
                additionalProperties: { type: 'string' },
              },
              body: {
                type: 'object',
                description: 'Request body (JSON)',
                properties: {},
              },
            },
            required: ['target', 'method'],
          },
        },
      },
      handler: async (args: any, config?: any) => {
        const agent = config?.agentName ?? 'seepient';
        const result = await gateway.callRest(
          agent,
          args.target,
          args.path ?? '',
          args.method,
          args.query,
          args.body,
        );
        return typeof result === 'string' ? result : JSON.stringify(result);
      },
    },

    // 4. gateway_capabilities
    {
      name: 'gateway_capabilities',
      risk: 'safe',
      definition: {
        type: 'function',
        function: {
          name: 'gateway_capabilities',
          description:
            'List all registered gateway targets and their capabilities (tools, resources, prompts, operations).',
          parameters: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
      },
      handler: async () => {
        const targets = gateway.getTargets();
        const entries = Object.entries(targets);
        if (entries.length === 0) return 'No gateway targets registered.';

        const lines = entries.map(([name, t]) => {
          const enabled = t.enabled ? 'enabled' : 'disabled';
          if (t.kind === 'mcp') {
            const tools = t.capabilities?.tools?.length ?? 0;
            const resources = t.capabilities?.resources?.length ?? 0;
            const prompts = t.capabilities?.prompts?.length ?? 0;
            return `  ${name} (${enabled}, MCP/${t.transport}): ${tools} tools, ${resources} resources, ${prompts} prompts — ${t.description}`;
          }
          return `  ${name} (${enabled}, REST ${t.baseUrl}): ${t.operations.length} operations — ${t.description}`;
        });

        return `Gateway targets (${entries.length}):\n${lines.join('\n')}`;
      },
    },

    // 5. gateway_read_resource
    {
      name: 'gateway_read_resource',
      risk: 'safe',
      definition: {
        type: 'function',
        function: {
          name: 'gateway_read_resource',
          description:
            'Read an MCP resource from a gateway target.',
          parameters: {
            type: 'object',
            properties: {
              target: {
                type: 'string',
                description: 'Name of the registered MCP target',
              },
              uri: {
                type: 'string',
                description: 'URI of the resource to read',
              },
            },
            required: ['target', 'uri'],
          },
        },
      },
      handler: async (args: any, config?: any) => {
        const agent = config?.agentName ?? 'seepient';
        const result = await gateway.readResource(agent, args.target, args.uri);
        return typeof result === 'string' ? result : JSON.stringify(result);
      },
    },

    // 6. gateway_get_prompt
    {
      name: 'gateway_get_prompt',
      risk: 'safe',
      definition: {
        type: 'function',
        function: {
          name: 'gateway_get_prompt',
          description:
            'Get an MCP prompt template from a gateway target.',
          parameters: {
            type: 'object',
            properties: {
              target: {
                type: 'string',
                description: 'Name of the registered MCP target',
              },
              name: {
                type: 'string',
                description: 'Name of the prompt to retrieve',
              },
              arguments: {
                type: 'object',
                description: 'Arguments for the prompt template',
                properties: {},
              },
            },
            required: ['target', 'name'],
          },
        },
      },
      handler: async (args: any, config?: any) => {
        const agent = config?.agentName ?? 'seepient';
        const result = await gateway.getPrompt(
          agent,
          args.target,
          args.name,
          args.arguments,
        );
        return typeof result === 'string' ? result : JSON.stringify(result);
      },
    },

    // 7. gateway_import_openapi
    {
      name: 'gateway_import_openapi',
      risk: 'safe',
      definition: {
        type: 'function',
        function: {
          name: 'gateway_import_openapi',
          description:
            'Import an OpenAPI/Swagger spec as a REST target. Parses the spec, registers it, and returns the list of operations.',
          parameters: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Name for the registered target',
              },
              specUrl: {
                type: 'string',
                description: 'URL to the OpenAPI/Swagger spec (JSON or YAML)',
              },
              baseUrl: {
                type: 'string',
                description: 'Override base URL (defaults to spec servers[0].url)',
              },
            },
            required: ['name', 'specUrl'],
          },
        },
      },
      handler: async (args: any) => {
        const { importOpenApiSpec } = await import('./openapi-importer.js');
        const result = await importOpenApiSpec(gateway, args.name, args.specUrl, {
          baseUrl: args.baseUrl,
          isAdmin: false, // Agent tool — NOT admin-registered (B3 trust guard)
        });
        return `Imported ${result.imported} operations: ${result.operations.join(', ')}`;
      },
    },

    // 8. gateway_register_target
    {
      name: 'gateway_register_target',
      risk: 'communications',
      definition: {
        type: 'function',
        function: {
          name: 'gateway_register_target',
          description:
            'Register a new MCP or REST target on the gateway. Validates required fields before registration.',
          parameters: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Unique name for the target',
              },
              kind: {
                type: 'string',
                description: 'Target kind: "mcp" or "rest"',
              },
              transport: {
                type: 'string',
                description: 'MCP transport type: "stdio", "sse", or "http"',
              },
              command: {
                type: 'string',
                description: 'Command for MCP stdio transport',
              },
              url: {
                type: 'string',
                description: 'URL for MCP sse/http transport',
              },
              baseUrl: {
                type: 'string',
                description: 'Base URL for REST targets',
              },
              description: {
                type: 'string',
                description: 'Human-readable description of the target',
              },
              tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Tags for semantic routing',
              },
            },
            required: ['name', 'kind'],
          },
        },
      },
      handler: async (args: any) => {
        if (!['mcp', 'rest'].includes(args.kind)) {
          return `Error: kind must be "mcp" or "rest", got "${args.kind}"`;
        }

        if (args.kind === 'mcp') {
          const transport = args.transport;
          if (!transport || !['stdio', 'sse', 'http'].includes(transport)) {
            return 'Error: MCP targets require transport (stdio, sse, or http)';
          }
          if (transport === 'stdio' && !args.command) {
            return 'Error: MCP stdio targets require a command';
          }
          if ((transport === 'sse' || transport === 'http') && !args.url) {
            return `Error: MCP ${transport} targets require a url`;
          }
          const target = {
            kind: 'mcp' as const,
            transport: transport as 'stdio' | 'sse' | 'http',
            command: args.command,
            args: args.args,
            env: args.env,
            url: args.url,
            description: args.description ?? `MCP target ${args.name}`,
            tags: args.tags ?? [],
            enabled: true,
          };
          await gateway.registerTarget(args.name, target, false);
          return `Registered MCP target "${args.name}" (${transport})`;
        }

        if (!args.baseUrl) {
          return 'Error: REST targets require a baseUrl';
        }
        const target = {
          kind: 'rest' as const,
          baseUrl: args.baseUrl,
          description: args.description ?? `REST target ${args.name}`,
          auth: { type: 'none' as const },
          defaultHeaders: {},
          operations: [],
          tags: args.tags ?? [],
          enabled: true,
        };
        await gateway.registerTarget(args.name, target, false);
        return `Registered REST target "${args.name}" (${args.baseUrl})`;
      },
    },

    // 9. gateway_audit_log
    {
      name: 'gateway_audit_log',
      risk: 'safe',
      definition: {
        type: 'function',
        function: {
          name: 'gateway_audit_log',
          description:
            'Retrieve formatted audit logs from the gateway. Optionally filter by target and limit count.',
          parameters: {
            type: 'object',
            properties: {
              target: {
                type: 'string',
                description: 'Filter logs to this target name',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of log entries to return (default: 10)',
              },
            },
            required: [],
          },
        },
      },
      handler: async (args: any) => {
        const logs = gateway.getAuditLogs(args.target, args.limit || 10);
        if (logs.length === 0) return 'No audit logs found.';

        const lines = logs.map((log) => {
          const ts = new Date(log.timestamp).toISOString();
          const status = log.success ? 'OK' : 'FAIL';
          return `  [${ts}] ${log.agent} -> ${log.target} ${log.operation} (${status}, ${log.durationMs}ms)`;
        });

        return `Audit logs (${logs.length}):\n${lines.join('\n')}`;
      },
    },

    // 10. gateway_usage_stats
    {
      name: 'gateway_usage_stats',
      risk: 'safe',
      definition: {
        type: 'function',
        function: {
          name: 'gateway_usage_stats',
          description:
            'Return usage summary per target: total calls and error counts.',
          parameters: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
      },
      handler: async () => {
        const summary = gateway.getUsageSummary();
        const entries = Object.entries(summary);
        if (entries.length === 0) return 'No gateway usage recorded.';

        const lines = entries.map(
          ([target, stats]) => `  ${target}: ${stats.calls} calls, ${stats.errors} errors`,
        );

        return `Gateway usage:\n${lines.join('\n')}`;
      },
    },
  ];
}
