/**
 * Seepient Core — Semantic Tool Injection Middleware
 *
 * Scores the user's last message against all gateway-discovered tools
 * and injects the top-K most relevant directly into ctx.toolDefs.
 * Falls through to proxy pattern when no matches found.
 */

import type { PipelineContext, Middleware } from '../middleware.js';
import type { ToolModule } from '../../tools/interface.js';
import type { MCPGateway } from '../../gateway/gateway.js';
import { scoreRelevance } from '../../gateway/semantic-scorer.js';

export function semanticToolInjectionMiddleware(
  gateway: MCPGateway,
  topK: number = 3,
): Middleware {
  return async (ctx: PipelineContext, next: () => Promise<void>) => {
    const lastMessage = [...ctx.messages].reverse().find(m => m.role === 'user');
    if (!lastMessage || typeof lastMessage.content !== 'string') { await next(); return; }

    const allGatewayTools = gateway.getInjectableTools();
    if (allGatewayTools.length === 0) { await next(); return; }

    const query = lastMessage.content.toLowerCase();
    const scored = allGatewayTools.map((tool) => ({
      tool,
      score: scoreRelevance(query, tool.definition.function.name + ' ' + (tool.definition.function.description ?? '')),
    }));

    scored.sort((a, b) => b.score - a.score);
    const selected = scored.filter((s) => s.score > 0).slice(0, topK).map((s) => s.tool);

    if (selected.length === 0) { await next(); return; }

    // Inject definitions (LLM sees these via ctx.toolDefs)
    ctx.toolDefs.push(...selected.map((t) => t.definition));

    // Store handlers (agent-loop bridge picks these up via config.injectedTools)
    if (!ctx.metadata.injectedTools) ctx.metadata.injectedTools = new Map();
    const injected = ctx.metadata.injectedTools as Map<string, ToolModule>;
    for (const tool of selected) {
      injected.set(tool.definition.function.name, tool);
    }

    await next();
  };
}
