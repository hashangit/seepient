/**
 * Seepient CLI — REPL Functions
 *
 * Interrupt handling, chat-with-interrupt, and the main runChat loop.
 * Extracted from index.ts for single-responsibility.
 */

import chalk from 'chalk';
import * as readline from 'node:readline/promises';
import inquirer from 'inquirer';

import { Agent } from '../../transport/cli/agent.js';
import { bootstrapCliSession } from '../../transport/cli/bootstrap.js';
import { buildCommandRegistry } from '../../transport/cli/commands/build-registry.js';
import type { ApproveToolFn, PermissionLevel } from '../../foundations/types.js';

// ── Interrupt handling ───────────────────────────────────────────────

export interface InterruptHandle {
  signal: AbortSignal;
  /** Temporarily disable ESC detection (e.g. during approval prompts) */
  suspend: () => void;
  /** Re-enable ESC detection after suspend */
  resume: () => void;
  /** Permanently clean up the interrupt handler */
  teardown: () => void;
}

export function setupInterrupt(agent: Agent): InterruptHandle {
  const signal = agent.createAbortSignal();
  const stdin = process.stdin;

  if (!stdin.isTTY) {
    return {
      signal,
      suspend: () => {},
      resume: () => {},
      teardown: () => agent.clearAbortController(),
    };
  }

  const ESC = '\x1b';
  let wasRaw = stdin.isRaw;

  const onData = (data: Buffer) => {
    if (data[0] === ESC.charCodeAt(0)) {
      agent.abort();
    }
  };

  // Start ESC detection
  stdin.setRawMode(true);
  stdin.resume();
  stdin.on('data', onData);

  return {
    signal,
    suspend: () => {
      stdin.removeListener('data', onData);
      if (stdin.isRaw) stdin.setRawMode(false);
    },
    resume: () => {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on('data', onData);
    },
    teardown: () => {
      stdin.removeListener('data', onData);
      if (!wasRaw && stdin.isRaw) {
        stdin.setRawMode(false);
      }
      agent.clearAbortController();
    },
  };
}

// ── Shell approval mode ──────────────────────────────────────────────

function getShellApprovalMode(config: any, newPermissionSystemActive?: boolean): 'auto' | 'prompt' | 'deny' {
  if (config?.autoConfirm) return 'auto';

  // When the new permission system is active, ignore the legacy SEEPIENT_SHELL_APPROVE env var
  // so it cannot bypass the permission matrix.
  if (!newPermissionSystemActive) {
    const envMode = process.env.SEEPIENT_SHELL_APPROVE;
    if (envMode === 'auto' || envMode === 'true' || envMode === '1') return 'auto';
    if (envMode === 'deny' || envMode === 'false' || envMode === '0') return 'deny';
  }

  if (process.stdin.isTTY) return 'prompt';

  return 'deny';
}

/** Build the adapter-level approveTool callback for the CLI. */
export function createCliApproveTool(
  config: any,
  handle: InterruptHandle,
  permissionLevel?: PermissionLevel,
): ApproveToolFn {
  // New permission system is active when an explicit permission level was resolved
  const newPermissionSystemActive = permissionLevel !== undefined;

  return async (call) => {
    // Display what the tool wants to do
    if (call.name === 'execute_shell_command') {
      const cmd = typeof call.args.command === 'string' ? call.args.command : JSON.stringify(call.args.command);
      const rationale = typeof call.args.rationale === 'string' ? call.args.rationale : '';
      console.log(chalk.yellow(`\nAI wants to execute: `) + chalk.bold(cmd));
      if (rationale) console.log(chalk.dim(`Reason: ${rationale}`));
    } else {
      console.log(chalk.yellow(`\nAI wants to use tool: `) + chalk.bold(call.name));
    }

    const mode = getShellApprovalMode(config, newPermissionSystemActive);

    if (mode === 'deny') {
      console.log(chalk.red('Command denied (non-interactive mode).'));
      console.log(chalk.dim('Set SEEPIENT_SHELL_APPROVE=auto to auto-approve, or use --yes flag.'));
      return false;
    }

    if (mode === 'prompt') {
      // Suspend ESC handler so inquirer can use stdin normally
      handle.suspend();
      try {
        const { confirm } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'confirm',
            message: 'Do you want to run this command?',
            default: false,
          },
        ]);
        return confirm;
      } catch {
        // Prompt cancelled (Ctrl+C or inquirer error)
        return false;
      } finally {
        handle.resume();
      }
    }

    // Auto-approved
    console.log(chalk.gray(`(Auto-approved: ${config?.autoConfirm ? '--yes flag' : 'SEEPIENT_SHELL_APPROVE=auto'})`));
    return true;
  };
}

export async function chatWithInterrupt(agent: Agent, input: string, config?: any, permissionLevel?: PermissionLevel): Promise<void> {
  const handle = setupInterrupt(agent);
  const approveTool = config ? createCliApproveTool(config, handle, permissionLevel) : undefined;
  // Spec 008: when the pipeline is enabled, the broker consults this approveTool.
  if (agent.isPermissionPipelineEnabled()) {
    agent.setPipelineApproveTool(approveTool);
  }
  try {
    await agent.chat(input, handle.signal, approveTool, permissionLevel);
  } finally {
    handle.teardown();
  }
}

// ── Main chat runner ─────────────────────────────────────────────────

export async function runChat(queryParts: string[], options: any) {
  if (options.interactive) {
    console.log(chalk.bold.cyan("Welcome to Seepient Agent CLI"));
  }

  const initialQuery = queryParts.join(' ');
  const ctx = await bootstrapCliSession(options);
  const { agent, fullConfig, activeProviderType, providerConfig, permissionLevel, gatewayInstance } = ctx;

  // Spec 008: enable the new policy pipeline when --permission-pipeline is set.
  // The REPL's approveTool (readline y/n) is wired per-chat below; the broker
  // wrapper consults it at decision time.
  if (options.permissionPipeline) {
    await agent.enablePermissionPipeline({
      modelProviderClass: activeProviderType,
    });
  }

  if (options.interactive) {
    console.log(chalk.green(`Agent initialized with ${activeProviderType} (${providerConfig.model})`));
    console.log(chalk.gray("Type /help for commands, /exit to leave."));
  }

  // @path resolver — hoisted so the initial query resolves at the caller,
  // not inside Agent.chat() (T022). The resolver is idempotent.
  const { resolveReferences } = await import('../../capabilities/skills/resolver.js');

  // Handle initial query if present
  if (initialQuery) {
    if (options.interactive) {
        console.log(chalk.blue("\nProcessing initial request: ") + chalk.bold(initialQuery));
    }
    let resolvedInitial = initialQuery;
    if (initialQuery.includes('@')) {
      try { resolvedInitial = await resolveReferences(initialQuery); } catch { /* resolver not available */ }
    }
    await chatWithInterrupt(agent, resolvedInitial, fullConfig, permissionLevel);

    // Headless mode exit
    if (!options.interactive) {
      process.exit(0);
    }
  }

  // Main chat loop
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true
  });

  // Build command registry
  const cmdRegistry = buildCommandRegistry(agent, fullConfig, activeProviderType, gatewayInstance);

  // Lazy-loaded modules (hoisted outside the loop to avoid repeated import overhead)
  const { invokeSkill, createRuntimeSkillProviderSwitcher } = await import('../../domain/skills/skill-invoker.js');

  try {
    while (true) {
      const userInput = await rl.question(chalk.green('?') + ' You > ');

      // Bare exit/quit (without /)
      if (userInput.toLowerCase() === 'exit' || userInput.toLowerCase() === 'quit') {
        console.log(chalk.cyan('Goodbye!'));
        break;
      }

      if (userInput.trim() === '') continue;

      // Slash commands — dispatch through registry
      if (userInput.startsWith('/')) {
        rl.pause();
        try {
          const { status, output } = await cmdRegistry.dispatch(
            userInput,
            { agent, args: '', config: fullConfig },
            agent.getSkillRegistry(),
          );

          if (output) console.log(output);
          if (status === 'exit') break;
          if (status === 'handled') continue;

          // 'fallthrough' — try skill invocation
          const skillResult = await invokeSkill({ input: userInput, registry: agent.getSkillRegistry()! });

          if (skillResult) {
            console.log(chalk.cyan(`Loading skill: ${skillResult.skill.name}`));
            const switcher = createRuntimeSkillProviderSwitcher(agent.getProviderRuntime());
            const switched = await switcher.switchIfNeeded(skillResult);

            if (switched && skillResult.preferredModel) {
              agent.switchProvider(skillResult.preferredProvider ?? "", skillResult.preferredModel);
            }

            try {
              await chatWithInterrupt(agent, skillResult.prompt, fullConfig, permissionLevel);
            } finally {
              if (switched) {
                switcher.restore();
              }
            }
            continue;
          }

          // No matching command or skill
          console.log(chalk.yellow(`Unknown command: ${userInput.split(' ')[0]}`));
          console.log(chalk.dim('Type /help for available commands.'));
        } finally {
          rl.resume();
        }
        continue;
      }

      // Resolve @path file references in user input
      let resolvedInput = userInput;
      if (userInput.includes('@')) {
        try {
          resolvedInput = await resolveReferences(userInput);
        } catch { /* resolver not available, use raw input */ }
      }

      rl.pause();
      try {
        await chatWithInterrupt(agent, resolvedInput, fullConfig, permissionLevel);
      } finally {
        rl.resume();
      }
    }
  } catch (err: any) {
    if (err.message && (err.message.includes('User force closed') || err.message.includes('Prompt was canceled'))) {
       console.log(chalk.cyan("\nGoodbye!"));
    } else {
       console.error(chalk.red("Error in chat loop:"), err);
    }
  } finally {
    rl.close();
  }
}
