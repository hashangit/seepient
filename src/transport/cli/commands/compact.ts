/**
 * /compact command handler for Seepient CLI.
 *
 * Summarizes the conversation to reduce token usage while preserving
 * key context needed to continue the session.
 *
 * Aliases: /compress
 *
 * Uses an `ora` spinner (stdout), so it is marked `interactive` and the TUI
 * defers it — run it in the readline REPL.
 */

import chalk from 'chalk';
import ora from 'ora';
import type { CommandHandler } from './registry.js';
import { runAgentLoop } from '../../../domain/agent-loop.js';
import { now } from '../../../domain/context/message-convert.js';
import { generateId } from '../../../foundations/id.js';
import { createHookExecutor } from '../../../domain/hooks.js';
import type { Message } from '../../../foundations/types.js';
import { buildSystemPrompt } from '../../../domain/prompts/system-prompts.js';

export const compactHandler: CommandHandler = async (ctx) => {
  const { agent, args } = ctx;
  const spinner = ora('Compacting...').start();

  try {
    const allMessages = agent.getMessages();

    // Separate system prompt from conversation messages
    const systemMessage = allMessages.find((m) => m.role === 'system');
    const conversationMessages = allMessages.filter((m) => m.role !== 'system');

    if (conversationMessages.length === 0) {
      return { output: chalk.yellow('Nothing to compact — conversation is empty.') };
    }

    // Build the summarization instruction
    const focusHint = args.trim();
    const summaryInstruction = `Summarize this conversation concisely. Preserve key decisions, code changes, and context needed to continue.${focusHint ? ` ${focusHint}` : ''}`;

    // Create a temporary messages array for the summarization call
    const summaryMessages: Message[] = [
      {
        id: generateId(),
        role: 'system',
        content: summaryInstruction,
        timestamp: now(),
      },
      // Flatten all non-system messages into a single user message for context
      {
        id: generateId(),
        role: 'user',
        content: conversationMessages
          .map((m) => `[${m.role}]: ${m.content}`)
          .join('\n\n'),
        timestamp: now(),
      },
    ];

    let result;
    try {
      result = await runAgentLoop({
        runtime: agent.getProviderRuntime(),
        model: agent.getModel(),
        messages: summaryMessages,
        toolDefs: [], // no tools during summarization
        maxSteps: 1,
        hooks: createHookExecutor(),
      });
    } catch (error: any) {
      return { output: chalk.red(`Compaction failed: ${error.message}`) };
    }

    if (result.error) {
      return { output: chalk.red(`Compaction failed: ${result.error.message}`) };
    }

    // Extract the summary text from the result messages
    const assistantMessage = result.messages.find((m) => m.role === 'assistant');
    const summaryText = assistantMessage?.content ?? 'Conversation history was compacted.';

    // Replace agent messages: [system_prompt, summary]
    const newMessages: Message[] = systemMessage
      ? [systemMessage]
      : [
          {
            id: generateId(),
            role: 'system',
            content: buildSystemPrompt(),
            timestamp: now(),
          },
        ];

    newMessages.push({
      id: generateId(),
      role: 'assistant',
      content: `[Conversation Summary]\n${summaryText}`,
      timestamp: now(),
    });

    agent.setMessages(newMessages);

    return { output: chalk.green('Conversation compacted. Token usage reduced.') };
  } catch (error: any) {
    return { output: chalk.red(`Compaction error: ${error.message}`) };
  } finally {
    spinner.stop();
  }
};
