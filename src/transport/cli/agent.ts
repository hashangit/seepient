import chalk from 'chalk';
import ora from 'ora';
import * as path from 'path';
import { getAllToolDefinitions } from '../../domain/tool-executor.js';
import { buildSystemPrompt } from '../../domain/prompts/system-prompts.js';
import { LLMProvider, ProviderMessage } from '../../foundations/contracts/llm.js';
import { initializeSkillRegistry, getSkillRegistry } from '../../capabilities/skills/index.js';
import type { SkillRegistry } from '../../capabilities/skills/types.js';
import { runAgentLoop } from '../../domain/agent-loop.js';
import { now } from '../../domain/context/message-convert.js';
import { generateId } from '../../foundations/id.js';
import { createHookExecutor } from '../../domain/hooks.js';
import { buildSkillCatalog } from '../../domain/skills/skill-catalog.js';
import { DEFAULT_MODELS } from '../../foundations/models-catalog.js';
import type { Message, StepResult, Usage, ToolCall, ApproveToolFn, PermissionLevel, ProviderType, PersistenceBackend } from '../../foundations/types.js';
import { persistSession } from '../../domain/sessions/session-store.js';
import type { GrantStore } from '../../domain/grants.js';
import type { Middleware } from '../../foundations/contracts/middleware.js';
import type { Capability, CapabilitySet } from '../../foundations/contracts/permission-policy.js';
import type { PolicyStore } from '../../foundations/contracts/execution-brokers.js';
import type { PolicySnapshot } from '../../foundations/contracts/execution-brokers.js';

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
  /** Context-window fill level (prompt tokens of the last request = full conversation size). */
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
  // Spec 008 protected policy store + pending proposals (T307).
  private _policyStore: PolicyStore | null = null;
  private _workspaceId: string | null = null;
  private _policyProposals: Array<{ id: string; capability: Capability }> = [];
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

  /** The skill catalog string appended to the system message (empty if none). */
  getSkillCatalog(): string {
    return this.skillCatalog;
  }

  /** Active provider type (for tokenizer accuracy display). */
  getProviderType(): ProviderType | undefined {
    return this.providerType;
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

  // The spec-008 wired pipeline (built lazily by enablePermissionPipeline()).
  private _wiredPipeline: import("../../domain/permissions/action-lifecycle-factory.js").WiredActionLifecycle | null = null;

  /**
   * Opt into the spec-008 pipeline for this agent. After this call, every
   * chat()/chatStream() routes tool calls through PolicyEngine → broker →
   * boundary → audit, bypassing the legacy matrix/grant/autoConfirm path.
   *
   * The broker consults the current `approveTool` at decision time — set it
   * via `setPipelineApproveTool()` before each chat() (the REPL/TUI construct
   * their approveTool per-session, after bootstrap).
   */
  async enablePermissionPipeline(opts: {
    workspaceRoot?: string;
    modelProviderClass?: string;
    auditRoot?: string;
  }): Promise<void> {
    const { buildActionLifecycle } = await import("../../domain/permissions/action-lifecycle-factory.js");
    const { legacyApproveToolToBroker } = await import("../legacy-adapter.js");
    // Use a mutable holder so the broker picks up the per-session approveTool
    // when chat() is called (REPL/TUI wire approveTool after bootstrap).
    this._pipelineApproveTool = undefined;
    const broker = legacyApproveToolToBroker(undefined);
    // The CLI surface is interactive-capable: REPL/TUI wire `approveTool`
    // per chat() after bootstrap, so `mode` reports `inline` to keep the
    // policy engine from short-circuiting on `approval-unavailable`. The
    // dynamic consultation happens in `request()` at decision time. If no
    // approveTool is wired when a prompt is actually needed, `request()`
    // throws — `ActionLifecycle` catches that and records the correct
    // `approval-unavailable` deny reason (rather than mislabeling a
    // `NoneApprovalBroker` auto-deny as `user-denied`).
    const liveBroker = {
      mode: "inline" as const,
      request: async (req: any, opts2: any) => {
        if (this._pipelineApproveTool) {
          const lb = legacyApproveToolToBroker(this._pipelineApproveTool);
          return lb.request(req, opts2);
        }
        throw new Error("approval-unavailable: no approveTool wired for this chat()");
      },
    };
    // Build the REAL typed-executor boundary — NOT the legacy handler.
    // Writes go through FileCommitBroker; shell through ProcessExecutor.
    const { buildLocalBoundary } = await import("../../capabilities/execution/build-local-boundary.js");
    const { boundary: realBoundary, artifacts: sharedArtifacts } = await buildLocalBoundary();
    this._wiredPipeline = await buildActionLifecycle({
      principalId: "cli-user",
      runId: this.sessionId,
      workspaceRoot: opts.workspaceRoot ?? process.cwd(),
      modelProviderClass: opts.modelProviderClass ?? "openai",
      approvalBroker: liveBroker,
      executionBoundary: realBoundary,
      policyStore: this._policyStore ?? undefined,
      auditRoot: opts.auditRoot,
      artifacts: sharedArtifacts,
    });
    // Spec 008 FR-014: run crash-recovery on startup. Marks any `dispatched`
    // actions without a terminal record as `indeterminate` (never re-executed).
    // Also starts a background outbox-flush timer for failed terminal appends.
    try {
      const { recoverIndeterminateActions } = await import(
        "../../domain/permissions/audit-recorder.js"
      );
      const auditStore = this._wiredPipeline!.auditStore as import("../../domain/permissions/audit-recorder.js").LocalAuditStore;
      const recovered = await recoverIndeterminateActions(auditStore, this._wiredPipeline!.terminalOutbox);
      if (recovered.length > 0) {
        console.warn(
          chalk.yellow(
            `[permissions] ${recovered.length} action(s) recovered as indeterminate from a prior crash. They will NOT be re-executed.`,
          ),
        );
      }
    } catch {
      // Recovery is best-effort on surfaces without a local audit store.
    }
    if (this._wiredPipeline!.terminalOutbox) {
      const outbox = this._wiredPipeline!.terminalOutbox;
      this._outboxTimer = setInterval(() => {
        outbox.flush().catch(() => {
          /* retry on next tick */
        });
      }, 5_000);
      this._outboxTimer.unref?.();
    }
  }

  private _outboxTimer?: ReturnType<typeof setInterval>;

  /** Update the approveTool the pipeline consults (called by REPL/TUI per chat). */
  setPipelineApproveTool(approveTool: ApproveToolFn | undefined): void {
    this._pipelineApproveTool = approveTool;
  }

  private _pipelineApproveTool: ApproveToolFn | undefined;

  /** Whether the spec-008 pipeline is active for this agent. */
  isPermissionPipelineEnabled(): boolean {
    return this._wiredPipeline !== null;
  }

  // ── Spec 008 protected policy store accessors (T307) ─────────────────
  // These route active-policy mutations exclusively through
  // PolicyStore.compareAndSet — the trusted administrative flow. Proposals
  // are inert until /permissions approve writes them outside executor roots.

  /** Attach the protected PolicyStore (composition root wires LocalPolicyStore). */
  setPolicyStore(store: PolicyStore, workspaceId: string): void {
    this._policyStore = store;
    this._workspaceId = workspaceId;
  }

  getPolicyStore(): PolicyStore | null {
    return this._policyStore;
  }

  /** Stage an inert capability proposal (does NOT touch active policy). */
  async stagePolicyProposal(capability: Capability): Promise<string> {
    const id = generateId().slice(0, 8);
    this._policyProposals.push({ id, capability });
    return id;
  }

  /** All pending proposals (inert). */
  listPolicyProposals(): Array<{ id: string; capability: Capability }> {
    return this._policyProposals;
  }

  /** Approve a proposal → writes active policy via compare-and-set. */
  async approvePolicyProposal(id: string): Promise<PolicySnapshot> {
    if (!this._policyStore || !this._workspaceId) {
      throw new Error('Protected policy store not configured');
    }
    const idx = this._policyProposals.findIndex((p) => p.id === id);
    if (idx === -1) throw new Error(`No proposal "${id}"`);
    const proposal = this._policyProposals[idx];
    const current = await this._policyStore.read(this._workspaceId);
    const next: CapabilitySet = {
      version: 1,
      capabilities: [...current.policy.capabilities, proposal.capability],
    };
    const snap = await this._policyStore.compareAndSet(
      this._workspaceId,
      current.version,
      next,
      { kind: 'human', authorityId: 'operator', authenticatedBy: 'cli' },
    );
    this._policyProposals.splice(idx, 1);
    return snap;
  }

  /** Revoke the capability at an index in the active policy. */
  async revokePolicyCapability(index: number): Promise<PolicySnapshot> {
    if (!this._policyStore || !this._workspaceId) {
      throw new Error('Protected policy store not configured');
    }
    const current = await this._policyStore.read(this._workspaceId);
    if (index < 0 || index >= current.policy.capabilities.length) {
      throw new Error(`Index ${index} out of range (0..${current.policy.capabilities.length - 1})`);
    }
    const next: CapabilitySet = {
      version: 1,
      capabilities: current.policy.capabilities.filter((_, i) => i !== index),
    };
    return this._policyStore.compareAndSet(
      this._workspaceId,
      current.version,
      next,
      { kind: 'human', authorityId: 'operator', authenticatedBy: 'cli' },
    );
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
        // Spec 008: when enablePermissionPipeline() was called, route through
        // the new Domain pipeline instead of the legacy matrix/grant branches.
        wiredPipeline: this._wiredPipeline ?? undefined,
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


