/**
 * Context-window breakdown helper.
 *
 * Splits the LLM request into named parts and estimates token counts for each,
 * so the `/context` command can show where context budget is being spent.
 * Token counts come from BPE (see `tokenizer.ts`) — exact for OpenAI-family,
 * corrected (×1.2 / ×1.15) for Anthropic / GLM.
 */

import type { Message, ProviderType } from './types.js';
import type { ToolDefinition } from '../tools/interface.js';
import { countTokens } from './tokenizer.js';

export interface ContextBreakdownPart {
  /** Display label, e.g. "System Prompt". */
  label: string;
  /** Token count for this part (corrected for the active model family). */
  tokens: number;
  /** Sub-detail string, e.g. "15 tools", "8 messages". */
  detail: string;
}

export interface ContextBreakdown {
  parts: ContextBreakdownPart[];
  /** Sum of all part token counts. */
  total: number;
  /** Active model's max context window, if known. */
  contextWindow?: number;
  /** Active model name (for display). */
  model: string;
  /** Provider type (for display). */
  providerType?: ProviderType;
}

/**
 * Build a context-window breakdown from the live agent state.
 *
 * Parts:
 * - **System Prompt** — everything in the system message that isn't the skill
 *   catalog: the base prompt, system info block, tool rules, output rules, etc.
 * - **Tools** — the JSON-serialized tool definitions sent as the `tools` param.
 * - **Skills** — the catalog string appended to the system message.
 * - **Messages** — user + assistant conversation messages (the chat itself).
 * - **Tool Results** — `role: "tool"` messages (file contents, command output,
 *   etc.) — separated from chat because they're often the largest consumers.
 */
export function buildContextBreakdown(opts: {
  messages: Message[];
  toolDefs: ToolDefinition[];
  /** The catalog string appended to the system message (empty if no skills). */
  skillCatalog: string;
  model: string;
  contextWindow?: number;
  providerType?: string;
}): ContextBreakdown {
  const { messages, toolDefs, skillCatalog, model, contextWindow, providerType } = opts;
  const pt = providerType as ProviderType | undefined;

  const sysMessage = messages.find((m) => m.role === 'system');
  // System prompt = the full system message content MINUS the skill catalog
  // (the catalog is reported as its own "Skills" part). This captures the base
  // prompt, system info block, tool rules, output formatting rules — everything
  // static that isn't skills, tools, or conversation.
  const fullSystem = sysMessage?.content ?? '';
  const systemContent = skillCatalog && fullSystem.endsWith(skillCatalog)
    ? fullSystem.slice(0, fullSystem.length - skillCatalog.length).replace(/\n\n$/, '')
    : fullSystem;

  const chatMessages = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  const toolResultMessages = messages.filter((m) => m.role === 'tool');

  const parts: ContextBreakdownPart[] = [
    {
      label: 'System Prompt',
      tokens: countTokens(systemContent, pt),
      detail: 'identity + rules',
    },
    {
      label: 'Tools',
      tokens: countTokens(JSON.stringify(toolDefs), pt),
      detail: `${toolDefs.length} tool${toolDefs.length === 1 ? '' : 's'}`,
    },
    {
      label: 'Skills',
      tokens: countTokens(skillCatalog, pt),
      detail: skillCatalog ? 'catalog' : 'none loaded',
    },
    {
      label: 'Messages',
      tokens: chatMessages.reduce((sum, m) => sum + countTokens(m.content ?? '', pt), 0),
      detail: `${chatMessages.length} message${chatMessages.length === 1 ? '' : 's'}`,
    },
    {
      label: 'Tool Results',
      tokens: toolResultMessages.reduce((sum, m) => sum + countTokens(m.content ?? '', pt), 0),
      detail: `${toolResultMessages.length} result${toolResultMessages.length === 1 ? '' : 's'}`,
    },
  ];

  const total = parts.reduce((sum, p) => sum + p.tokens, 0);

  return {
    parts,
    total,
    contextWindow,
    model,
    providerType: pt,
  };
}
