---
title: MCP Gateway
description: Connect Model Context Protocol (MCP) servers and external REST tools into the Seepient SDK.
---

# MCP Gateway

The Seepient SDK exports an MCP Gateway integration (`gateway`) that allows applications to connect Model Context Protocol (MCP) servers and external REST endpoints directly into the Seepient tool execution loop.

External tools discovered via the gateway are dynamically converted into proxy tools and registered in Seepient's tool registry.

## Import

```typescript
import { gateway } from "seepient";
```

## Quick Example

```typescript
import { gateway, createSeepient } from "seepient";

// 1. Initialize the gateway with configuration
const mcpGateway = await gateway.createGateway({
  enabled: true,
  semanticTopK: 5,
  defaultRateLimitPerMin: 60,
  maxAuditLogsInMemory: 1000,
});

// 2. Create an agent instance — it automatically receives registered MCP tools
const agent = await createSeepient();
const response = await agent.chat("Check database connection using our MCP tool");
console.log(response.text);
```

---

## Configuration

The gateway accepts a `GatewayConfig` object:

```typescript
interface GatewayConfig {
  /** Master switch to enable or disable the gateway. */
  enabled: boolean;
  /** Maximum number of tools to select via semantic scoring for each turn. */
  semanticTopK: number;
  /** Default rate limit per minute per target server. */
  defaultRateLimitPerMin: number;
  /** Maximum audit log entries kept in memory. */
  maxAuditLogsInMemory: number;
}
```

By default, the gateway looks for target configurations in `~/.seepient/gateway.json` (or the directory specified by `process.env.SEEPIENT_GATEWAY_DIR`). You can also inject a custom `GatewaySettingsAdapter`:

```typescript
import { gateway } from "seepient";
import { GatewaySettingsAdapter } from "seepient/gateway"; // or custom adapter

const customAdapter = new GatewaySettingsAdapter("./custom-gateway-dir");
await customAdapter.initialize();

const mcpGateway = await gateway.createGateway(
  {
    enabled: true,
    semanticTopK: 10,
    defaultRateLimitPerMin: 120,
    maxAuditLogsInMemory: 500,
  },
  customAdapter,
);
```

---

## Supported Target Types

The gateway supports both Model Context Protocol (MCP) servers and OpenAPI/REST targets:

### 1. MCP Targets (`kind: 'mcp'`)

Supports `stdio`, `sse`, and `http` transports:

```json
{
  "targets": [
    {
      "kind": "mcp",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"],
      "description": "PostgreSQL database tools",
      "tags": ["database", "postgres"],
      "enabled": true
    },
    {
      "kind": "mcp",
      "transport": "sse",
      "url": "http://localhost:3001/sse",
      "description": "Remote microservice MCP server",
      "tags": ["microservice"],
      "enabled": true
    }
  ]
}
```

### 2. REST Targets (`kind: 'rest'`)

Maps OpenAPI specifications or REST endpoints into callable tools:

```json
{
  "targets": [
    {
      "kind": "rest",
      "baseUrl": "https://api.github.com",
      "description": "GitHub API integration",
      "auth": {
        "type": "bearer",
        "credentialRef": "GITHUB_TOKEN"
      },
      "operations": [
        {
          "opId": "getRepo",
          "method": "GET",
          "path": "/repos/{owner}/{repo}",
          "summary": "Get repository details"
        }
      ],
      "tags": ["vcs", "github"],
      "enabled": true
    }
  ]
}
```

---

## Tool Governance & Audit

All tool calls made through the gateway route through Seepient's unified execution boundary:
- **Audit Logging**: Target, operation, duration, and success/failure are captured.
- **SSRF Protection**: Remote SSE and HTTP targets validate endpoints through `safeSsrfFetch` with socket IP pinning to prevent DNS rebinding attacks.
- **Rate Limiting**: Enforced per-target according to `defaultRateLimitPerMin`.

---

## Related APIs

- [Custom Tools](/sdk/custom-tools) — Native `preparedTool`, `brokerConnector`, and `trustedHostTool`
- [createSeepient()](/sdk/create-seepient) — Agent initialization
- [Types Reference](/sdk/types) — Gateway and tool types
