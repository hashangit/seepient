/**
 * Seepient Gateway — OpenAPI/Swagger spec importer
 *
 * Fetches an OpenAPI spec (JSON or YAML), extracts operations,
 * and registers the result as a REST target on the gateway.
 */

import * as yaml from 'js-yaml';
import type { MCPGateway } from './gateway.js';
import type { RestTarget } from './types.js';

export async function importOpenApiSpec(
  gateway: MCPGateway,
  name: string,
  specUrl: string,
  options?: { baseUrl?: string; tagFilter?: string[]; isAdmin?: boolean },
): Promise<{ imported: number; operations: string[] }> {
  const response = await fetch(specUrl);
  if (!response.ok) throw new Error(`Failed to fetch spec: HTTP ${response.status}`);
  const raw = await response.text();
  let spec: any;
  try { spec = JSON.parse(raw); } catch { spec = yaml.load(raw); }

  const baseUrl = options?.baseUrl ?? spec.servers?.[0]?.url ?? '';
  if (!baseUrl) throw new Error('No base URL found in spec and none provided');

  const operations: Array<{ opId: string; method: string; path: string; summary: string }> = [];
  const paths = spec.paths ?? {};
  for (const [routePath, methods] of Object.entries(paths as Record<string, any>)) {
    for (const [method, op] of Object.entries(methods as Record<string, any>)) {
      if (['get', 'post', 'put', 'patch', 'delete'].includes(method.toLowerCase())) {
        operations.push({
          opId: op.operationId ?? `${method}_${routePath.replace(/[/{}/]/g, '_')}`,
          method: method.toUpperCase(),
          path: routePath,
          summary: op.summary ?? `${method.toUpperCase()} ${routePath}`,
        });
      }
    }
  }

  const filtered = options?.tagFilter
    ? operations.filter(op => {
        const opData = (spec.paths?.[op.path]?.[op.method.toLowerCase()]) as any;
        const opTags: string[] = opData?.tags ?? [];
        return options.tagFilter!.some(t => opTags.includes(t));
      })
    : operations;

  const allTags: string[] = [];
  for (const [, methods] of Object.entries(paths as Record<string, any>)) {
    for (const [, op] of Object.entries(methods as Record<string, any>)) {
      if (op.tags) allTags.push(...op.tags);
    }
  }
  const tags = [...new Set(allTags)];

  const target: RestTarget = {
    kind: 'rest',
    baseUrl,
    description: spec.info?.title ?? name,
    auth: { type: 'none' },
    defaultHeaders: {},
    operations: filtered,
    tags,
    enabled: true,
  };

  // Register as admin only when called from REST/CLI (isAdmin param).
  // Agent tool calls pass isAdmin=false to prevent trust guard bypass.
  await gateway.registerTarget(name, target, options?.isAdmin ?? true);
  return { imported: filtered.length, operations: filtered.map(o => o.opId) };
}
