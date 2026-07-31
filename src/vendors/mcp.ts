/**
 * Vendor quarantine — the only module allowed to import the MCP SDK.
 */
export { Client } from '@modelcontextprotocol/sdk/client/index.js';
export { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
export { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
export { CreateMessageRequestSchema } from '@modelcontextprotocol/sdk/types.js';
