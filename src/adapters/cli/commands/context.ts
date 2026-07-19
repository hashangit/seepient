/**
 * Seepient CLI — /context Command Handler
 *
 * Shows a breakdown of the context window: token counts for the system prompt,
 * tools, skills catalog, and message history. Returns a structured `render`
 * payload so the TUI renders a dedicated panel with progress bars; the chalk
 * `output` string is the fallback for the readline REPL.
 */

import chalk from 'chalk';
import type { CommandHandler } from './registry.js';
import { getAllToolDefinitions } from '../../../core/tool-executor.js';
import { getModelMeta } from '../../../models-catalog.js';
import { buildContextBreakdown, type ContextBreakdown } from '../../../core/context-breakdown.js';

/** Format the breakdown as plain text for the readline REPL. */
function formatBreakdownAsText(b: ContextBreakdown): string {
  const lines = [chalk.bold.cyan(`Context — ${b.model}`)];
  const maxTokens = Math.max(...b.parts.map((p) => p.tokens), 1);
  for (const p of b.parts) {
    const barLen = 16;
    const filled = Math.round((p.tokens / maxTokens) * barLen);
    const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);
    lines.push(`${p.label.padEnd(14)} ${chalk.dim(bar)}  ${chalk.yellow(String(p.tokens))} ${chalk.dim(p.detail)}`);
  }
  lines.push(chalk.dim('─'.repeat(48)));
  lines.push(`Estimated total  ${chalk.yellow(String(b.total))} tok`);
  if (b.contextWindow) {
    const pct = Math.round((b.total / b.contextWindow) * 100);
    const fillBarLen = 24;
    const fillFilled = Math.min(fillBarLen, Math.round((b.total / b.contextWindow) * fillBarLen));
    const fillBar = '█'.repeat(fillFilled) + '░'.repeat(fillBarLen - fillFilled);
    lines.push(`${chalk.dim(fillBar)}  ${Math.round(b.total / 1000)}k/${Math.round(b.contextWindow / 1000)}k (${pct}%)`);
  }
  return lines.join('\n');
}

export const contextHandler: CommandHandler = async (ctx) => {
  const { agent } = ctx;
  const model = agent.getModel();
  const breakdown = buildContextBreakdown({
    messages: agent.getMessages(),
    toolDefs: getAllToolDefinitions(),
    skillCatalog: agent.getSkillCatalog(),
    model,
    contextWindow: getModelMeta(model)?.contextWindow,
    providerType: agent.getProviderType(),
  });
  return {
    output: formatBreakdownAsText(breakdown),
    render: { component: 'context', breakdown },
  };
};
