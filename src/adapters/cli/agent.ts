import chalk from 'chalk';
import ora from 'ora';
import * as path from 'path';
import { getAllToolDefinitions } from '../../core/tool-executor.js';
import { buildSystemPrompt } from './system-prompts.js';
import { LLMProvider, ProviderMessage } from '../../providers/types.js';
import { initializeSkillRegistry, getSkillRegistry } from '../../skills/index.js';
import type { SkillRegistry } from '../../skills/types.js';
import { runAgentLoop } from '../../core/agent-loop.js';
import { generateId, now } from '../../core/message-convert.js';
import { createHookExecutor } from '../../core/hooks.js';
import { buildSkillCatalog } from '../../core/skill-catalog.js';
import { DEFAULT_MODELS } from '../../models-catalog.js';
import type { Message, StepResult, Usage, ToolCall, ApproveToolFn, PermissionLevel, ProviderType, PersistenceBackend } from '../../core/types.js';
import { persistSession } from '../../core/session-store.js';
import type { GrantStore } from '../../core/grants.js';
import type { Middleware } from '../../core/middleware.js';

/**
 * Outcome of a single `Agent.chat()` turn. Returned so non-readline callers
 * (the TUI) can render terminal states (aborted / max-steps / error) instead
 * of relying on chalk stdout. The readline path ignores it and prints the
 * same chalk messages as before.
 */
export interface ChatResult {
  finishReason: string;
  error?: string;
  usage?: Usage;
  /** Prompt tokens of the last provider request — for context-window display. */
  contextTokens?: number;
}

export class Agent {
  private provider: LLMProvider;
  private messages: Message[];
  private model: string;
  private config: any;
  private autoConfirm: boolean;
  private skillRegistry: SkillRegistry | null = null;
  private skillCatalog: string = '';
  private abortController: AbortController | null = null;
  private _middleware: Middleware[] = [];
  private readonly systemPrompt: string;
  private readonly providerType: ProviderType | undefined;
  private readonly persistence: PersistenceBackend | null;
  private _grantStore: GrantStore | null = null;
  private sessionId: string;

  constructor(
    provider: LLMProvider,
    model: string = DEFAULT_MODELS['openai-compatible'],
    config: any = {},
    systemPrompt?: string,
    persistence: PersistenceBackend | null = null,
    providerType?: ProviderType,
  ) {
    this.provider = provider;
    this.model = model;
    this.config = config;
    this.autoConfirm = !!config?.autoConfirm;
    // Default to the headless/Docker prompt; the caller (repl.ts) selects the
    // interactive prompt when launching in a TTY. Kept mode-agnostic here so
    // Core's runAgentLoop never needs to know about launch mode.
    this.systemPrompt = systemPrompt ?? buildSystemPrompt();
    this.providerType = providerType;
    this.persistence = persistence;
    this.sessionId = generateId();

    this.messages = [{
      id: generateId(),
      role: "system",
      content: this.systemPrompt,
      timestamp: now(),
    }];
  }

  /**
   * Compose the full system message content: base prompt + skill catalog (if any).
   * The catalog is appended exactly once here — callers that re-seed the system
   * message (clearConversation, loadSession) use this so the catalog never
   * accumulates across turns or survives a clear with duplicates.
   */
  private composeSystemContent(): string {
    return this.skillCatalog
      ? this.systemPrompt + '\n\n' + this.skillCatalog
      : this.systemPrompt;
  }

  async initializeSkills(): Promise<void> {
    try {
      this.skillRegistry = await initializeSkillRegistry(process.cwd());
      const metadata = this.skillRegistry.getMetadata();

      if (metadata.length > 0) {
        // Build and store skill catalog — injected into the system message
        // exactly once here (not on every runAgentLoop call, which would
        // accumulate duplicates across turns).
        this.skillCatalog = buildSkillCatalog(metadata);
        const sysIdx = this.messages.findIndex(m => m.role === 'system');
        if (sysIdx >= 0) {
          this.messages[sysIdx] = {
            ...this.messages[sysIdx],
            content: this.composeSystemContent(),
          };
        }
        console.log(chalk.green(`Loaded ${metadata.length} skill(s):`));
        for (const s of metadata) {
          console.log(chalk.dim(`  - ${s.name}`));
        }
      }
    } catch (error: any) {
      console.warn(chalk.yellow(`Warning: Skills initialization failed: ${error.message}`));
    }
  }

  getSkillRegistry(): SkillRegistry | null {
    return this.skillRegistry;
  }

  /** Set middleware pipeline (e.g., gateway semantic injection). */
  setMiddleware(middleware: Middleware[]): void {
    this._middleware = middleware;
  }

  /** Attach the persisted-grant store (used by the loop + /permissions). */
  setGrantStore(store: GrantStore): void {
    this._grantStore = store;
  }

  getGrantStore(): GrantStore | null {
    return this._grantStore;
  }

  async chat(
    userInput: string,
    signal?: AbortSignal,
    approveTool?: ApproveToolFn,
    permissionLevel?: PermissionLevel,
    onStep?: (step: StepResult) => void,
  ): Promise<ChatResult> {
    // @path references are resolved by the caller (repl.ts / use-agent.ts),
    // not here — one resolution site per caller (T022).
    this.messages.push({ id: generateId(), role: "user", content: userInput, timestamp: now() });

    // When a custom onStep is supplied (TUI mode), the caller owns rendering:
    // skip the ora spinner and chalk finish messages, and return the loop
    // result so the caller renders terminal states. The readline path passes
    // no onStep and stays byte-identical.
    const customSteps = !!onStep;
    const spinner = customSteps ? null : ora('Thinking...').start();

    let wrappedApproveTool = approveTool;
    if (!customSteps && approveTool && spinner) {
      wrappedApproveTool = async (call: Parameters<ApproveToolFn>[0]) => {
        spinner.stop();
        try {
          return await approveTool(call);
        } finally {
          spinner.start();
        }
      };
    }

    const defaultOnStep = (step: StepResult) => {
      if (!spinner) return;
      if (step.type === "text" && step.content) {
        spinner.stop();
        console.log(chalk.blue("Seepient: ") + step.content);
        spinner.start();
      } else if (step.type === "tool_call" && step.toolCall) {
        spinner.stop();
        console.log(chalk.gray(`Executing tool: ${step.toolCall.name}...`));
        spinner.start();
      }
    };

    try {
      const result = await runAgentLoop({
        provider: this.provider,
        model: this.model,
        messages: this.messages,
        toolDefs: getAllToolDefinitions(),
        maxSteps: 30,
        hooks: createHookExecutor(),
        config: { ...this.config, agentName: 'cli' },
        signal,
        approveTool: wrappedApproveTool,
        permissionLevel,
        autoConfirm: this.autoConfirm,
        grantStore: this._grantStore ?? undefined,
        middleware: this._middleware.length > 0 ? this._middleware : undefined,
        onStep: onStep ?? defaultOnStep,
        // Stream only when the caller supplies its own onStep (TUI mode) — the
        // readline default handler prints complete 'text' steps, not deltas.
        stream: customSteps,
      });

      spinner?.stop();

      if (!customSteps) {
        if (result.finishReason === "aborted") {
          console.log(chalk.yellow("\n(Interrupted)"));
        } else if (result.finishReason === "max_steps") {
          console.log(chalk.yellow("\n(Max steps reached — the agent needed more iterations to complete. Try increasing maxSteps or asking a more specific question.)"));
        } else if (result.error) {
          console.error(chalk.red(`Error: ${result.error.message}`));
        }
      }

      return { finishReason: result.finishReason, error: result.error?.message, usage: result.usage, contextTokens: result.contextTokens };
    } catch (error: any) {
      spinner?.stop();
      if (error.name === 'AbortError' || signal?.aborted) {
        if (!customSteps) console.log(chalk.yellow("\n(Interrupted)"));
        return { finishReason: 'aborted' };
      }
      if (!customSteps) console.error(chalk.red(error.message));
      return { finishReason: 'error', error: error.message };
    } finally {
      // Persist after every turn (success, abort, or error) so partial output
      // survives a restart. Save is best-effort: a persistence failure must
      // never crash the chat path. (Mirrors SDK agent.ts error handling.)
      if (this.persistence) {
        try {
          await persistSession(this.persistence, this.sessionId, this.messages, {
            provider: this.providerType,
            model: this.model,
          });
        } catch { /* persistence is best-effort */ }
      }
    }
  }

  /**
   * Load a previously persisted session by id, replacing the in-memory history.
   * Re-seeds the system message if the loaded set has none. No-op when no
   * backend is configured.
   */
  async loadSession(sessionId: string): Promise<boolean> {
    if (!this.persistence) return false;
    const data = await this.persistence.load(sessionId);
    if (!data) return false;
    this.sessionId = sessionId;
    const hasSystem = data.messages.some(m => m.role === 'system');
    this.messages = hasSystem
      ? data.messages
      : [{ id: generateId(), role: 'system', content: this.composeSystemContent(), timestamp: now() }, ...data.messages];
    return true;
  }

  /** Active session id (rotated by `clearConversation` when persistence is on). */
  getSessionId(): string {
    return this.sessionId;
  }

  /** Configured persistence backend, or null when persistence is disabled. */
  getPersistence(): PersistenceBackend | null {
    return this.persistence;
  }

  clearConversation(): void {
    // Re-seed with base prompt + catalog (one copy) — never carry over a
    // possibly-accumulated system message from prior turns.
    this.messages = [{
      id: generateId(),
      role: 'system',
      content: this.composeSystemContent(),
      timestamp: now(),
    }];
    // Rotate the session id so the next save writes a new file instead of
    // overwriting the prior (now-superseded) session — it survives for resume.
    if (this.persistence) {
      this.sessionId = generateId();
    }
  }

  /** Public accessor for the current message history. */
  getMessages(): Message[] {
    return this.messages;
  }

  /** Replace the message history (e.g., after compaction). */
  setMessages(messages: Message[]): void {
    this.messages = messages;
  }

  /** Public accessor for the active LLM provider. */
  getProvider(): LLMProvider {
    return this.provider;
  }

  /** Public accessor for the active model name. */
  getModel(): string {
    return this.model;
  }

  switchProvider(provider: LLMProvider, model: string) {
    this.provider = provider;
    this.model = model;
  }

  abort(): void {
    this.abortController?.abort();
  }

  createAbortSignal(): AbortSignal {
    this.abortController = new AbortController();
    return this.abortController.signal;
  }

  clearAbortController(): void {
    this.abortController = null;
  }
}


