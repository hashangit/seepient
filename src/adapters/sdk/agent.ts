/**
 * Seepient SDK — createAgent()
 *
 * A persistent agent with session memory, provider switching, and abort support.
 * Wraps the LLMProvider directly (not the CLI-oriented Agent class) so results
 * are structured rather than printed to the console.
 */

import type { LLMProvider } from "../../providers/types.js";
import type {
  AgentCreateOptions,
  AgentResponse,
  CumulativeUsage,
  Message,
  PersistenceBackend,
  PersistenceConfig,
  SessionData,
  SessionStore,
  SdkAgent,
  StreamTextOptions,
  StreamTextResult,
  StepResult,
  ToolCall,
  Usage,
  SeepientError,
} from "../../core/types.js";
import { getProvider } from "../../core/provider-resolver.js";
import { createHookExecutor } from "../../core/hooks.js";
import { StreamManager } from "../../core/stream-manager.js";
import { resolveTools, getAllToolDefinitions } from "./tools.js";
import { createPersistenceBackend, persistSession } from "../../core/session-store.js";
import { runAgentLoop } from "../../core/agent-loop.js";
import type { AgentLoopOptions } from "../../core/agent-loop.js";
import { createSessionGrantStore } from "../../core/grants.js";
import { initializeSkillRegistry } from "../../skills/index.js";
import { buildSkillCatalog } from "../../core/skill-catalog.js";
import {
  generateId,
  now,
  toSeepientError,
} from "../../core/message-convert.js";
import type { Middleware } from "../../core/middleware.js";

// ── Session persistence helpers ──────────────────────────────────────────

/**
 * Adapt a legacy `SessionStore` (save/load takes messages) to the
 * `PersistenceBackend` interface (save/load takes full SessionData).
 * If the object already has the `PersistenceBackend` signature, it passes through.
 */
function wrapAsPersistenceBackend(store: SessionStore | PersistenceBackend): PersistenceBackend {
  if ("__persistenceBackend" in store && store.__persistenceBackend === true) {
    return store as PersistenceBackend;
  }
  const s = store as SessionStore;
  return {
    __persistenceBackend: true as const,
    save: async (id, data) => {
      await s.save(id, data.messages);
    },
    load: async (id) => {
      const messages = await s.load(id);
      if (!messages) return null;
      return { id, messages, createdAt: Date.now(), updatedAt: Date.now() };
    },
    delete: s.delete.bind(s),
    list: s.list.bind(s),
  };
}

// ── createAgent ──────────────────────────────────────────────────────────

/**
 * Create a persistent agent with session memory, provider switching,
 * and abort support.
 *
 * @example
 * ```ts
 * const agent = await createAgent({ model: "gpt-4o" });
 * const result = await agent.chat("Hello!");
 * console.log(result.text);
 * ```
 */
export async function createAgent(options?: AgentCreateOptions): Promise<SdkAgent> {
  const opts = options ?? {};

  // Resolve provider
  let { provider: llmProvider, model } = await getProvider(opts.provider, opts.model);

  // System prompt
  let systemPrompt = opts.systemPrompt ?? "You are a helpful assistant.";

  // Skills — initialize the registry and append the catalog to the system
  // prompt (exactly once). `opts.skills` controls discovery: `false` disables;
  // `string[]` filters to named skills; `true`/undefined loads all. Without
  // this, `use_skill` returns "Skill system not initialized" and the model
  // never learns skills exist.
  let skillCatalog = '';
  if (opts.skills !== false) {
    try {
      const registry = await initializeSkillRegistry(opts.cwd ?? process.cwd());
      let metadata = registry.getMetadata();
      if (Array.isArray(opts.skills)) {
        const wanted = new Set(opts.skills);
        metadata = metadata.filter(s => wanted.has(s.name));
      }
      if (metadata.length > 0) {
        skillCatalog = buildSkillCatalog(metadata);
      }
    } catch { /* skill init is best-effort — don't block agent creation */ }
  }
  // Compose the full system content once; re-applied by clear()/setSystemPrompt().
  const composeSystem = () => skillCatalog ? systemPrompt + '\n\n' + skillCatalog : systemPrompt;

  // Tools
  let toolDefs = opts.tools ? resolveTools(opts.tools) : getAllToolDefinitions();

  // Hooks
  const hookExecutor = createHookExecutor(opts.hooks);

  // Pre-grants (session-scoped GrantStore built once from opts.grants).
  const grantStore = opts.grants?.length ? createSessionGrantStore(opts.grants) : undefined;

  // State
  const messages: Message[] = [];
  const sessionId = generateId();
  let activeAbortController: AbortController = new AbortController();

  // Concurrency guard — only one chat/chatStream at a time
  let lock: Promise<void> = Promise.resolve();
  let releaseLock: (() => void) | null = null;

  function acquire(): Promise<void> {
    const prev = lock;
    lock = new Promise<void>((r) => { releaseLock = r; });
    return prev;
  }

  function release(): void {
    releaseLock?.();
    releaseLock = null;
  }

  // Cumulative usage
  const cumulativeUsage: CumulativeUsage = {
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalCost: 0,
    requestCount: 0,
  };

  // Session store
  let backend: PersistenceBackend | null = null;
  if (opts.persist) {
    if (typeof opts.persist === "string") {
      // Legacy: string path → file backend
      backend = createPersistenceBackend({ type: "file", path: opts.persist });
    } else if ("type" in opts.persist && typeof opts.persist.type === "string") {
      // PersistenceConfig object
      backend = createPersistenceBackend(opts.persist as PersistenceConfig);
    } else if ("save" in opts.persist && "load" in opts.persist) {
      // Already a PersistenceBackend or legacy SessionStore — use directly
      backend = wrapAsPersistenceBackend(opts.persist as SessionStore | PersistenceBackend);
    }

    // Try loading existing session
    if (backend) {
      const existing = await backend.load(sessionId);
      if (existing) {
        messages.push(...existing.messages);
      }
    }
  }

  // Add initial system prompt if no messages exist
  if (messages.length === 0 && systemPrompt) {
    messages.push({
      id: generateId(),
      role: "system",
      content: composeSystem(),
      timestamp: now(),
    });
  }

  // ── Helper: persist messages ────────────────────────────────────────────
  async function persistMessages(): Promise<void> {
    if (backend) {
      await persistSession(backend, sessionId, messages);
    }
  }

  // ── chat() ──────────────────────────────────────────────────────────────

  async function chat(userMessage: string): Promise<AgentResponse> {
    await acquire();
    try {
    // Reset abort controller for this call
    activeAbortController = new AbortController();

    // Add user message
    messages.push({
      id: generateId(),
      role: "user",
      content: userMessage,
      timestamp: now(),
    });

    const maxSteps = opts.maxSteps ?? 10;

    const result = await runAgentLoop({
      provider: llmProvider,
      model: model,
      messages,
      toolDefs,
      systemPrompt: systemPrompt,
      maxSteps,
      hooks: hookExecutor,
      signal: activeAbortController.signal,
      config: opts.config,
      metadata: opts.metadata,
      middleware: opts.middleware,
      approveTool: opts.approveTool,
      permissionLevel: opts.permissionLevel,
      grantStore: grantStore,
    });

    // Update cumulative usage from result
    cumulativeUsage.totalPromptTokens += result.usage.promptTokens;
    cumulativeUsage.totalCompletionTokens += result.usage.completionTokens;
    cumulativeUsage.totalCost += result.usage.cost;
    cumulativeUsage.requestCount += 1;

    // Persist
    await persistMessages();

    // Get the final text
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant" && m.content);
    const text = lastAssistant?.content ?? "";

    return {
      text,
      toolCalls: result.toolCalls,
      usage: result.usage,
    };
    } finally {
      release();
    }
  }

  // ── chatStream() ────────────────────────────────────────────────────────

  async function chatStream(
    message: string,
    streamOptions?: StreamTextOptions,
  ): Promise<StreamTextResult> {
    await acquire();
    try {
    const streamAbort = new AbortController();
    activeAbortController = streamAbort;
    const mergedHooks = {
      ...opts.hooks,
      ...streamOptions,
    };
    const streamHookExecutor = createHookExecutor(mergedHooks);

    // Add user message
    messages.push({
      id: generateId(),
      role: "user",
      content: message,
      timestamp: now(),
    });

    const maxSteps = streamOptions?.maxSteps ?? opts.maxSteps ?? 10;

    // Stream manager handles queues, async iterables, and SSE
    const stream = new StreamManager();

    // Run the loop in the background — lock released in finally when done
    (async () => {
      try {
        const result = await runAgentLoop({
          provider: llmProvider,
          model: model,
          messages,
          toolDefs,
          systemPrompt: systemPrompt,
          maxSteps,
          hooks: streamHookExecutor,
          signal: streamAbort.signal,
          config: opts.config,
          metadata: opts.metadata,
          middleware: opts.middleware,
          approveTool: opts.approveTool,
          permissionLevel: opts.permissionLevel,
          grantStore: grantStore,
          stream: true,
          onStep: (step) => {
            if (streamOptions?.onStep) streamOptions.onStep(step);
            // Streaming emits text_delta; non-streaming emits one complete
            // 'text'. Both flow to consumers as text deltas via enqueueText.
            if ((step.type === "text" || step.type === "text_delta") && step.content) {
              if (streamOptions?.onText) streamOptions.onText(step.content);
              stream.enqueueText(step.content);
            }
            if (step.type === "tool_call" && step.toolCall) {
              if (streamOptions?.onToolCall) {
                streamOptions.onToolCall({
                  name: step.toolCall.name,
                  args: step.toolCall.args,
                  callId: step.toolCall.id,
                });
              }
              if (streamOptions?.onToolResult) {
                streamOptions.onToolResult({
                  callId: step.toolCall.id,
                  output: step.toolCall.result,
                  success: true,
                });
              }
            }
            stream.enqueueStep(step);
          },
        });

        // Update cumulative usage from result
        cumulativeUsage.totalPromptTokens += result.usage.promptTokens;
        cumulativeUsage.totalCompletionTokens += result.usage.completionTokens;
        cumulativeUsage.totalCost += result.usage.cost;
        cumulativeUsage.requestCount += 1;

        // Derive final text from the message history (robust to streaming,
        // where steps contain text_delta, not a complete 'text' step).
        const lastAssistant = [...messages]
          .reverse()
          .find((m) => m.role === "assistant" && m.content);
        const finalText = lastAssistant?.content ?? "";

        stream.resolveText(finalText);
        stream.resolveUsage(result.usage);
        stream.resolveFinish(result.finishReason);
      } catch (err) {
        const seepientErr = toSeepientError(err, "PROVIDER_ERROR");
        if (streamOptions?.onError) streamOptions.onError(seepientErr);
        stream.resolveText("");
        stream.resolveUsage({ promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 });
        stream.resolveFinish("error");
      } finally {
        stream.complete();
        await persistMessages();
        release();
      }
    })();

    return {
      textStream: stream.textStream,
      steps: stream.stepsStream,
      fullText: stream.fullText,
      usage: stream.usage,
      finishReason: stream.finishReason,
      abort: () => streamAbort.abort(),
      toResponse: () => stream.toResponse(),
      toSSEStream: () => stream.toSSEStream(),
    };
    } catch (_err) {
      release();
      throw _err;
    }
  }

  // ── switchProvider() ────────────────────────────────────────────────────

  async function switchProvider(providerType: string, newModel?: string): Promise<void> {
    const result = await getProvider(providerType as any, newModel);
    llmProvider = result.provider;
    model = result.model;
  }

  // ── setSystemPrompt() ───────────────────────────────────────────────────

  function setSystemPrompt(prompt: string): void {
    systemPrompt = prompt;
    const content = composeSystem();
    // Replace existing system message or add new one
    const sysIdx = messages.findIndex((m) => m.role === "system");
    if (sysIdx >= 0) {
      messages[sysIdx] = {
        id: messages[sysIdx].id,
        role: "system",
        content,
        timestamp: now(),
      };
    } else {
      messages.unshift({
        id: generateId(),
        role: "system",
        content,
        timestamp: now(),
      });
    }
  }

  // ── setTools() ──────────────────────────────────────────────────────────

  function setTools(tools: string[]): void {
    toolDefs = resolveTools(tools);
  }

  // ── abort() ─────────────────────────────────────────────────────────────

  function abort(): void {
    activeAbortController.abort();
  }

  // ── clear() ─────────────────────────────────────────────────────────────

  function clear(): void {
    messages.length = 0;
    if (systemPrompt) {
      messages.push({
        id: generateId(),
        role: "system",
        content: composeSystem(),
        timestamp: now(),
      });
    }
  }

  // ── getHistory() ────────────────────────────────────────────────────────

  function getHistory(): Message[] {
    return [...messages];
  }

  // ── getUsage() ──────────────────────────────────────────────────────────

  function getUsage(): CumulativeUsage {
    return { ...cumulativeUsage };
  }

  // ── Return the SdkAgent interface ───────────────────────────────────────

  return {
    chat,
    chatStream,
    switchProvider,
    setSystemPrompt,
    setTools,
    abort,
    clear,
    getHistory,
    getUsage,
  };
}
