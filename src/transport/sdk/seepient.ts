/**
 * Seepient SDK — Unified Headless Agent & Instance Implementation (Spec 021 Hardening).
 *
 * Consolidates the SDK around a single governed entry point. All tool execution
 * routes through the ActionLifecycle pipeline (PolicyEngine, ApprovalBroker,
 * ExecutionBoundary, AuditStore).
 */

import {
  getDefaultProviderRuntime,
  ProviderRuntime,
} from "../../domain/providers/provider-runtime.js";
import type { ProviderRuntimeContract } from "../../foundations/contracts/provider-runtime.js";
import { ProviderConfigStore } from "../../domain/providers/config-store/provider-config-store.js";
import { MemoryCredentialStore } from "../../domain/providers/credentials/memory-credential-store.js";
import { AggregateInferenceAdapter } from "../../capabilities/inference/aggregate-adapter.js";
import { runAgentLoop } from "../../domain/agent-loop.js";
import { createHookExecutor } from "../../domain/hooks.js";
import { resolveTools, getAllToolDefinitions } from "../../domain/tool-executor.js";
import {
  DEFAULT_TRUSTED_HOST_ALLOWLIST,
  extractHostCallbacks,
  extractRegistrations,
} from "./tools.js";
import { isLocalAuditStore } from "../../foundations/contracts/execution-brokers.js";
import { initializeSkillRegistry } from "../../capabilities/skills/index.js";
import { buildSkillCatalog } from "../../domain/skills/skill-catalog.js";
import { StreamManager } from "../../domain/streaming/stream-manager.js";
import {
  createPersistenceBackend,
} from "../../domain/sessions/session-store.js";
import type {
  CreateSeepientOptions,
  Seepient,
  AgentResponse,
  StreamTextOptions,
  StreamTextResult,
  Message,
  CumulativeUsage,
  PersistenceBackend,
  PersistenceConfig,
  SessionStore,
  SessionData,
  Purpose,
  Tier,
} from "../../foundations/types.js";
import type {
  AccountInput,
  SaveResult,
  DeleteResult,
  AssignmentTarget,
  PurposeId,
  ResolutionPreview,
} from "../../foundations/contracts/provider-manager-api.js";
import type { AvailableModel } from "../../foundations/schemas/inference.js";
import type { PurposeModelMap } from "../../foundations/schemas/provider-config.js";
import {
  now,
  toSeepientError,
} from "../../domain/context/message-convert.js";
import { generateId } from "../../foundations/id.js";
import { surfaceLoopError, extractLoopError } from "./error-surfacing.js";
import { SeepientError } from "../../foundations/errors.js";

// ── Session persistence helpers ──────────────────────────────────────────

const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;

function validateSessionId(sessionId: string): void {
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
    throw new Error(
      `Invalid session ID "${sessionId}". Only alphanumeric characters, dashes, and underscores are allowed.`,
    );
  }
}

async function persistSession(
  backend: PersistenceBackend,
  id: string,
  messages: Message[],
  options: {
    provider?: string;
    providerAccount?: string;
    model?: string;
    metadata?: Record<string, unknown>;
  },
  createdAt?: number,
): Promise<void> {
  const nowMs = Date.now();
  await backend.save(id, {
    id,
    messages,
    createdAt: createdAt ?? nowMs,
    updatedAt: nowMs,
    metadata: options.metadata,
    provider: options.provider,
    providerAccount: options.providerAccount,
    model: options.model,
  });
}

function wrapAsPersistenceBackend(store: SessionStore | PersistenceBackend): PersistenceBackend {
  if ("__persistenceBackend" in store && store.__persistenceBackend) {
    return store as PersistenceBackend;
  }
  const s = store as SessionStore;
  return {
    __persistenceBackend: true,
    async save(id: string, data: SessionData) {
      await s.save(id, data.messages);
    },
    async load(id: string): Promise<SessionData | null> {
      const messages = await s.load(id);
      if (!messages) return null;
      return { id, messages, createdAt: Date.now(), updatedAt: Date.now() };
    },
    async delete(id: string) {
      await s.delete(id);
    },
    async list() {
      return s.list();
    },
  };
}

function toCapabilitySet(
  cap:
    | import("../../foundations/contracts/permission-policy.js").CapabilitySet
    | import("../../foundations/contracts/permission-policy.js").Capability[]
    | undefined,
): import("../../foundations/contracts/permission-policy.js").CapabilitySet | undefined {
  if (!cap) return undefined;
  if (Array.isArray(cap)) {
    return { version: 1, capabilities: cap };
  }
  return cap;
}

/**
 * Warn when an embedder injects some but not all permission state stores.
 * Stateless workers require all stores to be injected; missing stores fall back to local disk.
 */
export function warnIfPartialStoreInjection(opts: {
  auditStore?: unknown;
  policyStore?: unknown;
  capabilityLedger?: unknown;
}): void {
  const injectedStores = {
    auditStore: Boolean(opts.auditStore),
    policyStore: Boolean(opts.policyStore),
    capabilityLedger: Boolean(opts.capabilityLedger),
  };
  const storeCount =
    Number(injectedStores.auditStore) +
    Number(injectedStores.policyStore) +
    Number(injectedStores.capabilityLedger);
  if (storeCount > 0 && storeCount < 3) {
    const missing = Object.entries(injectedStores)
      .filter(([_, present]) => !present)
      .map(([name]) => name);
    const present = Object.entries(injectedStores)
      .filter(([_, present]) => present)
      .map(([name]) => name);
    console.warn(
      `[seepient] WARNING: Partial state store injection detected. ` +
        `Injected: [${present.join(", ")}]. Missing: [${missing.join(", ")}]. ` +
        `Missing stores will fall back to local disk at ~/.seepient or ./.seepient. ` +
        `For fully stateless worker execution, all three permission stores (auditStore, policyStore, capabilityLedger) must be injected.`,
    );
  }
}

// ── Primary Factory: createSeepient ──────────────────────────────────────

/**
 * Create a governed Seepient agent instance.
 *
 * Supports single-turn chat, multi-turn conversations, streaming responses,
 * model switching, tool execution, session persistence, and provider management.
 */
export async function createSeepient(options?: CreateSeepientOptions): Promise<Seepient> {
  const opts = options ?? {};

  // If providers, modelAssignments, or overlay options are passed without an explicit runtime,
  // bootstrap a configured ProviderRuntime
  let bootstrapRuntime: ProviderRuntimeContract | ProviderRuntime | undefined = opts.runtime;
  if (!bootstrapRuntime) {
    if (opts.providers || opts.modelAssignments || opts.credentials || opts.overlayFile || opts.adapter) {
      const configStore = new ProviderConfigStore(opts.overlayFile ?? ":memory:");
      if (opts.providers || opts.modelAssignments) {
        const currentOverlay = await configStore.getOverlay();
        await configStore.updateOverlay(
          {
            providers: opts.providers as any,
            modelAssignments: opts.modelAssignments as any,
          },
          currentOverlay.revision,
        );
      }
      const credentialStore = opts.credentials ?? new MemoryCredentialStore();
      const adapter = opts.adapter ?? new AggregateInferenceAdapter(undefined, undefined, credentialStore);
      bootstrapRuntime = new ProviderRuntime({
        configStore,
        credentialStore,
        adapter,
      });
    } else {
      bootstrapRuntime = getDefaultProviderRuntime();
    }
  }
  const runtime: ProviderRuntimeContract | ProviderRuntime = bootstrapRuntime;

  const sessionId = opts.sessionId ?? generateId();
  validateSessionId(sessionId);

  let provider = opts.provider;
  let providerAccount = opts.providerAccount ?? opts.override?.providerAccount;
  let model = opts.model ?? opts.override?.model ?? "";
  let purpose = opts.purpose;
  let tier = opts.tier;
  let metadata = opts.metadata;

  // System prompt
  let systemPrompt = opts.systemPrompt ?? "You are a helpful assistant.";

  // Skills
  let skillCatalog = "";
  let skillRegistry: import("../../capabilities/skills/types.js").SkillRegistry | undefined;
  if (opts.skills !== false) {
    try {
      skillRegistry = await initializeSkillRegistry(opts.cwd ?? process.cwd());
      let meta = skillRegistry.getMetadata();
      if (Array.isArray(opts.skills)) {
        const wanted = new Set(opts.skills);
        meta = meta.filter((s) => wanted.has(s.name));
      }
      if (meta.length > 0) {
        skillCatalog = buildSkillCatalog(meta);
      }
    } catch {
      /* skill init is best-effort — don't block creation */
    }
  }

  const composeSystem = () =>
    skillCatalog ? systemPrompt + "\n\n" + skillCatalog : systemPrompt;

  // Tools
  let toolDefs = opts.tools ? resolveTools(opts.tools) : getAllToolDefinitions();
  const { callbacks: hostCallbacks, registrationIds } = extractHostCallbacks(opts.tools, {
    skills: skillRegistry,
  });
  const registrations = extractRegistrations(opts.tools);

  // Hooks
  const hookExecutor = createHookExecutor(opts.hooks);

  // State & session loading
  const messages: Message[] = [];
  let backend: PersistenceBackend | null = null;
  let sessionCreatedAt = Date.now();
  if (opts.persist) {
    if (typeof opts.persist === "string") {
      backend = createPersistenceBackend({ type: "file", path: opts.persist });
    } else if ("type" in opts.persist && typeof opts.persist.type === "string") {
      backend = createPersistenceBackend(opts.persist as PersistenceConfig);
    } else if ("save" in opts.persist && "load" in opts.persist) {
      backend = wrapAsPersistenceBackend(opts.persist as SessionStore | PersistenceBackend);
    }

    if (backend) {
      const existing = await backend.load(sessionId);
      if (existing) {
        messages.push(...existing.messages);
        if (existing.createdAt) sessionCreatedAt = existing.createdAt;
        if (!provider && existing.provider) provider = existing.provider;
        if (!providerAccount && existing.providerAccount) providerAccount = existing.providerAccount;
        if (!model && existing.model) model = existing.model;
        if (!metadata && existing.metadata) metadata = existing.metadata;
      }
    }
  }

  if (messages.length === 0 && systemPrompt) {
    messages.push({
      id: generateId(),
      role: "system",
      content: composeSystem(),
      timestamp: now(),
    });
  }

  // Action lifecycle pipeline
  const { buildActionLifecycle } = await import(
    "../../domain/permissions/action-lifecycle-factory.js"
  );
  const { legacyApproveToolToBroker } = await import("../legacy-adapter.js");
  const { buildLocalBoundary } = await import(
    "../../capabilities/execution/build-local-boundary.js"
  );
  const {
    LocalAuditStore,
    TerminalEventOutbox,
    recoverIndeterminateActions,
  } = await import("../../domain/permissions/audit-recorder.js");

  warnIfPartialStoreInjection(opts);

  let auditOutbox:
    | import("../../domain/permissions/audit-recorder.js").TerminalEventOutbox
    | undefined;
  const isLocalStore = !opts.auditStore || isLocalAuditStore(opts.auditStore);
  const auditStore = opts.auditStore ?? new LocalAuditStore();
  if (isLocalStore) {
    auditOutbox = new TerminalEventOutbox(
      auditStore as InstanceType<typeof LocalAuditStore>,
    );
    await auditOutbox.reload();
    await auditOutbox.flush().catch(() => {});
    await recoverIndeterminateActions(
      auditStore as InstanceType<typeof LocalAuditStore>,
      auditOutbox,
    ).catch(() => {});
  }

  const broker =
    opts.approvalBroker ?? legacyApproveToolToBroker(opts.approveTool);
  const { createSnapshotStore } = await import(
    "../../foundations/hashline/snapshot-store.js"
  );
  const { InMemoryArtifactStore } = await import(
    "../../capabilities/execution/in-memory-artifact-store.js"
  );
  const { createMediaVendorOperationHandler } = await import(
    "../../domain/media/vendor-operation-handler.js"
  );
  const snapshotStore = createSnapshotStore();
  const sharedArtifacts = new InMemoryArtifactStore();
  const vendorOperationHandler = createMediaVendorOperationHandler({
    runtime,
    artifacts: sharedArtifacts,
  });
  const { boundary } = await buildLocalBoundary({
    artifacts: sharedArtifacts,
    workspaceRoot: opts.cwd ?? process.cwd(),
    snapshotStore,
    hostCallbacks,
    vendorOperationHandler,
    commitHelper: opts.commitHelper,
    network: opts.network,
  });
  const approvalMode = opts.consentMode
    ? opts.consentMode === "autonomous"
      ? "autonomous"
      : opts.consentMode === "ask-everything"
      ? "manual"
      : "balanced"
    : opts.approvalBroker || opts.approveTool
    ? "manual"
    : "never";

  const wiredPipeline = await buildActionLifecycle({
    principalId: opts.principalId ?? "sdk-user",
    runId: sessionId,
    sessionId,
    workspaceRoot: opts.cwd ?? process.cwd(),
    modelProviderClass: (provider ?? "openai") as string,
    approvalBroker: broker,
    executionBoundary: boundary,
    approvalMode,
    deploymentCeiling: toCapabilitySet(opts.deploymentCeiling),
    principalPolicy: toCapabilitySet(opts.principalPolicy),
    artifacts: sharedArtifacts,
    snapshotStore,
    trustedHostAllowlist: [...DEFAULT_TRUSTED_HOST_ALLOWLIST, ...registrationIds],
    registrations,
    auditStore,
    policyStore: opts.policyStore,
    capabilityLedger: opts.capabilityLedger,
    terminalOutbox: auditOutbox,
  });

  let activeAbortController: AbortController = new AbortController();

  // Concurrency guard (Promise-chain mutex)
  let lock: Promise<void> = Promise.resolve();

  function acquire(): Promise<() => void> {
    const prev = lock;
    let myRelease!: () => void;
    lock = new Promise<void>((r) => {
      myRelease = r;
    });
    return prev.then(() => myRelease);
  }

  const cumulativeUsage: CumulativeUsage = {
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalCost: 0,
    requestCount: 0,
  };

  async function persistMessages(): Promise<void> {
    if (backend) {
      await persistSession(
        backend,
        sessionId,
        messages,
        {
          provider,
          providerAccount,
          model,
          metadata,
        },
        sessionCreatedAt,
      );
    }
  }

  function currentModelOverride(): { model?: string; providerAccount?: string } | undefined {
    return providerAccount || model
      ? { model: model || undefined, providerAccount }
      : undefined;
  }

  // ── chat() ──────────────────────────────────────────────────────────────

  async function chat(userMessage: string): Promise<AgentResponse> {
    const release = await acquire();
    try {
      activeAbortController = new AbortController();

      messages.push({
        id: generateId(),
        role: "user",
        content: userMessage,
        timestamp: now(),
      });

      const maxSteps = opts.maxSteps ?? 10;
      const snapshot = await runtime.createTurnSnapshot();

      const result = await runAgentLoop({
        runtime,
        turnSnapshot: snapshot,
        model,
        modelOverride: currentModelOverride(),
        purpose,
        tier,
        messages,
        toolDefs,
        systemPrompt: systemPrompt,
        maxSteps,
        hooks: hookExecutor,
        signal: activeAbortController.signal,
        config: { ...opts.config, runtime, skills: skillRegistry },
        metadata,
        middleware: opts.middleware,
        approveTool: opts.approveTool,
        wiredPipeline,
      });

      cumulativeUsage.totalPromptTokens += result.usage.promptTokens;
      cumulativeUsage.totalCompletionTokens += result.usage.completionTokens;
      cumulativeUsage.totalCost += result.usage.cost;
      cumulativeUsage.requestCount += 1;

      await persistMessages();
      surfaceLoopError(result);

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
    userMessage: string,
    streamOptions?: StreamTextOptions,
  ): Promise<StreamTextResult> {
    const release = await acquire();

    try {
      const streamAbort = new AbortController();
      activeAbortController = streamAbort;
      const mergedHooks = {
        ...opts.hooks,
      };
      const streamHookExecutor = createHookExecutor(mergedHooks);

      messages.push({
        id: generateId(),
        role: "user",
        content: userMessage,
        timestamp: now(),
      });

      const maxSteps = opts.maxSteps ?? 10;
      const stream = new StreamManager();

      (async () => {
        try {
          const snapshot = await runtime.createTurnSnapshot();

          const result = await runAgentLoop({
            runtime,
            turnSnapshot: snapshot,
            model,
            modelOverride: currentModelOverride(),
            purpose: streamOptions?.purpose ?? purpose,
            tier: streamOptions?.tier ?? tier,
            messages,
            toolDefs,
            systemPrompt: systemPrompt,
            maxSteps,
            hooks: streamHookExecutor,
            signal: streamAbort.signal,
            config: { ...opts.config, runtime, skills: skillRegistry },
            metadata,
            middleware: opts.middleware,
            approveTool: opts.approveTool,
            wiredPipeline,
            onStep: (step) => {
              if (streamOptions?.onStep) streamOptions.onStep(step);
              if (
                (step.type === "text" || step.type === "text_delta") &&
                step.content
              ) {
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
                  const output = step.toolCall.result;
                  const success =
                    typeof output === "string"
                      ? !output.startsWith("Error:")
                      : true;
                  streamOptions.onToolResult({
                    callId: step.toolCall.id,
                    output,
                    success,
                  });
                }
              }
              stream.enqueueStep(step);
            },
          });

          cumulativeUsage.totalPromptTokens += result.usage.promptTokens;
          cumulativeUsage.totalCompletionTokens += result.usage.completionTokens;
          cumulativeUsage.totalCost += result.usage.cost;
          cumulativeUsage.requestCount += 1;

          const lastAssistant = [...messages]
            .reverse()
            .find((m) => m.role === "assistant" && m.content);
          const finalText = lastAssistant?.content ?? "";

          stream.resolveText(finalText);
          stream.resolveUsage(result.usage);
          const loopErr = extractLoopError(result);
          if (loopErr) {
            if (streamOptions?.onError) streamOptions.onError(loopErr);
            stream.resolveFinish("error");
          } else {
            stream.resolveFinish(result.finishReason);
          }
        } catch (err) {
          const seepientErr = toSeepientError(err, "PROVIDER_ERROR");
          if (streamOptions?.onError) streamOptions.onError(seepientErr);
          stream.resolveText("");
          stream.resolveUsage({
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            cost: 0,
          });
          stream.resolveFinish("error");
        } finally {
          stream.complete();
          try {
            await persistMessages();
          } catch (persistErr) {
            console.error("[seepient] chatStream persistence failed:", persistErr);
            const seepientErr = toSeepientError(persistErr, "PERSISTENCE_ERROR");
            if (streamOptions?.onError) streamOptions.onError(seepientErr);
            stream.resolveFinish("error");
          } finally {
            release();
          }
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

  async function switchProvider(
    accountOrModel: string,
    newModel?: string,
  ): Promise<void> {
    if (newModel) {
      providerAccount = accountOrModel || undefined;
      model = newModel;
    } else {
      providerAccount = undefined;
      model = accountOrModel;
    }
  }

  function setSystemPrompt(prompt: string): void {
    systemPrompt = prompt;
    const content = composeSystem();
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

  function setTools(tools: string[]): void {
    toolDefs = resolveTools(tools);
  }

  function abort(): void {
    activeAbortController.abort();
  }

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

  function getHistory(): Message[] {
    return [...messages];
  }

  function getUsage(): CumulativeUsage {
    return { ...cumulativeUsage };
  }

  async function flushAudit(): Promise<number> {
    if (auditOutbox) {
      return auditOutbox.flush();
    }
    return 0;
  }

  async function close(): Promise<void> {
    abort();
    await flushAudit();
  }

  // ── Provider Management Methods ─────────────────────────────────────────

  const { createProviderManagerApi } = await import("../cli/provider-manager-api.js");
  const managerApi = typeof runtime.getConfigStore === "function"
    ? createProviderManagerApi(runtime as ProviderRuntime)
    : null;
  let latestState = managerApi ? await managerApi.getState() : { revision: 0, assignments: {} as PurposeModelMap };

  async function addProvider(input: AccountInput): Promise<SaveResult> {
    if (!managerApi) {
      throw new SeepientError("Injected provider runtime does not support configuration mutations", "NOT_IMPLEMENTED", false);
    }
    const res = await managerApi.saveAccount(input);
    if (res.ok) latestState = await managerApi.getState();
    return res;
  }

  async function removeProvider(id: string, opts?: { force?: boolean }): Promise<DeleteResult> {
    if (!managerApi) {
      throw new SeepientError("Injected provider runtime does not support configuration mutations", "NOT_IMPLEMENTED", false);
    }
    const res = await managerApi.deleteAccount(id, opts);
    if (res.ok) latestState = await managerApi.getState();
    return res;
  }

  async function setAssignment(purpose: Purpose, tier: Tier | undefined, target: AssignmentTarget): Promise<SaveResult> {
    if (!managerApi) {
      throw new SeepientError("Injected provider runtime does not support configuration mutations", "NOT_IMPLEMENTED", false);
    }
    const res = await managerApi.setAssignment(purpose as PurposeId, tier ?? null, target);
    if (res.ok) latestState = await managerApi.getState();
    return res;
  }

  async function clearAssignment(purpose: Purpose, tier?: Tier): Promise<SaveResult> {
    if (!managerApi) {
      throw new SeepientError("Injected provider runtime does not support configuration mutations", "NOT_IMPLEMENTED", false);
    }
    const res = await managerApi.clearAssignment(purpose as PurposeId, tier ?? null);
    if (res.ok) latestState = await managerApi.getState();
    return res;
  }

  async function getCatalog(): Promise<readonly AvailableModel[]> {
    const snapshot = await runtime.createTurnSnapshot();
    if (runtime.modelCatalog) {
      return await runtime.modelCatalog.listAvailableModels(snapshot.config);
    }
    return (snapshot.catalog as unknown as readonly AvailableModel[]) ?? [];
  }

  function getAssignments(): PurposeModelMap {
    return latestState.assignments ?? {};
  }

  async function listProviders(): Promise<string[]> {
    const catalog = await getCatalog();
    return Array.from(new Set(catalog.map((m) => m.upstreamProvider))).sort();
  }

  async function reload(): Promise<{ revision: number }> {
    if (managerApi) {
      latestState = await managerApi.getState();
      return { revision: latestState.revision };
    }
    const snap = await runtime.createTurnSnapshot();
    return { revision: snap.revision };
  }

  async function resolve(resolveOpts: { purpose: Purpose; tier?: Tier; override?: any }): Promise<any> {
    if (managerApi) {
      const res = await managerApi.resolvePreview(resolveOpts.purpose as PurposeId, resolveOpts.tier, resolveOpts.override);
      if ("ok" in res && res.ok === false) {
        throw new SeepientError(res.message || "Resolution failed", res.code, false);
      }
      const preview = res as ResolutionPreview;
      const snapshot = await runtime.createTurnSnapshot();
      const availableModels = await getCatalog();
      const targetModelId = preview.selectedTarget.model;
      const targetAcct = preview.selectedTarget.providerAccount;

      const foundModel =
        availableModels.find((m) => m.id === targetModelId && m.reachableVia.includes(targetAcct)) ??
        availableModels.find((m) => m.id === targetModelId);

      const resolvedModel: AvailableModel = foundModel ?? {
        id: targetModelId,
        displayName: targetModelId,
        upstreamProvider: targetAcct,
        contextWindow: 0,
        capabilities: {
          toolUse: false,
          streaming: false,
          vision: false,
        },
        provenance: "user-declared",
        reachableVia: [targetAcct],
      };

      return {
        model: resolvedModel,
        providerAccount: preview.selectedTarget.providerAccount,
        thinkingLevel: (preview.selectedTarget as any).thinkingLevel,
        via: preview.via,
        failureTargets: [...(preview.failureTargets ?? [])],
      };
    }
    const snapshot = await runtime.createTurnSnapshot();
    const plan = await runtime.resolvePlan(
      snapshot,
      resolveOpts.purpose,
      resolveOpts.tier,
      resolveOpts.override,
    );
    const catalog = await getCatalog();
    const targetModelId = plan.selectedTarget.model;
    const targetAcct = plan.selectedTarget.providerAccount;
    const foundModel =
      catalog.find((m) => m.id === targetModelId && m.reachableVia.includes(targetAcct)) ??
      catalog.find((m) => m.id === targetModelId) ?? {
        id: targetModelId,
        displayName: targetModelId,
        upstreamProvider: targetAcct,
        contextWindow: 0,
        capabilities: { toolUse: false, streaming: false, vision: false },
        provenance: "user-declared",
        reachableVia: [targetAcct],
      };

    return {
      model: foundModel,
      providerAccount: plan.selectedTarget.providerAccount,
      thinkingLevel: plan.selectedTarget.thinkingLevel,
      via: plan.failureTargets?.length ? "fallback-chain" : "requested",
      failureTargets: plan.failureTargets ?? [],
    };
  }

  async function dispose(): Promise<void> {
    await close();
    if (typeof runtime.removeAllListeners === "function") {
      runtime.removeAllListeners();
    }
  }

  return {
    sessionId,
    chat,
    chatStream,
    switchProvider,
    setSystemPrompt,
    setTools,
    abort,
    clear,
    getHistory,
    getUsage,
    flushAudit,
    close,

    // Provider management
    addProvider,
    removeProvider,
    setAssignment,
    clearAssignment,
    getCatalog,
    getAssignments,
    listProviders,
    reload,
    resolve,
    dispose,
  };
}
