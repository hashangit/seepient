/**
 * Seepient Agent Runtime — the S08 Transport adapter (spec 029, M02, FR-030–FR-034).
 *
 * Implements the verified upstream `AgentRuntime` surface (E8 —
 * `describe`/`run`/`abort`) with types imported from `@seepients/adapter-kit`
 * (the single sanctioned Seepient-source → imported-package edge, D9;
 * enforced by the seepient-app-layering checker family). The engine is
 * consumed ONLY via `seepient-engine` dist specifiers (oneEmitRule) on the
 * existing core composition (E15) — one Domain loop, no nested Pi agent, no
 * second permission pipeline, no local-fallback unblocking (E16).
 *
 * Lifecycle invariants (contract §2):
 * - Abort registry keyed by run/attempt — never process-global. `abort(runId)`
 *   resolves exactly that run's owned work.
 * - Owned-work set `{ helper | provider | tool }` tracked from dispatch and
 *   drained on abort and on natural settle.
 * - Hydration is a pure once-per-run function of `request.history` (via the
 *   engine's `initialHistory` seam); the adapter NEVER touches a Seepient
 *   session store — product history is the single authority (contract §3).
 *
 * Truthful `describe`: streaming/compaction/tools yes; `scripted` reports
 * false — no test-scripted runtime is wired in this adapter (contract §2).
 */
import type {
  AdapterContext,
  AdapterDescriptor,
  AgentInputImage,
  AgentRuntime,
  AgentRuntimeCapabilities,
  AgentRuntimeEvent,
  AgentRunRequest,
  AgentToolSuspension,
  AgentToolExecutionObserver,
} from "@seepients/adapter-kit";
import { DEFAULT_CONTEXT_STRATEGY, describeToolActivity } from "@seepients/adapter-kit";
import { SeepientError, ToolSuspendedError } from "seepient-engine/dist/foundations/errors.js";
import type {
  CreateSeepientOptions,
  Message,
  MessageImage,
  ToolResult,
} from "seepient-engine/dist/foundations/types.js";
import type {
  TrustedHostToolRegistration,
  TrustedHostToolDeclaration,
} from "seepient-engine/dist/foundations/contracts/custom-tools.js";
import { governedDeclarationFor } from "@seepients/adapter-kit";
import { trustedHostTool } from "seepient-engine/dist/transport/sdk/custom-tools.js";
import { ALL_TOOLS } from "seepient-engine/dist/domain/tool-executor.js";
import { createSeepient } from "seepient-engine/dist/transport/sdk/seepient.js";
import { randomUUID } from "node:crypto";

/**
 * Typed rejection for content this run cannot carry (spec 029 FR-038):
 * unsupported MIME, a model that accepts no images, or an image count above
 * the model's per-prompt limit. Never a silent flatten to text.
 */
export class UnsupportedContentError extends SeepientError {
  constructor(detail: string) {
    super(`UNSUPPORTED_CONTENT: ${detail}`, "UNSUPPORTED_CONTENT", false);
    this.name = "UnsupportedContentError";
  }
}

/** MIME types the canonical inference layer accepts for image input. */
const SUPPORTED_IMAGE_MIME = /^image\/(png|jpeg|webp|gif)$/;

/** The provider-neutral tool-result shape the app executor may return (FR-037 source 4). */
type AgentToolResultShape = {
  kind: "agent_tool_result";
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
};

/** Type guard: checks only `kind`; content blocks validate at read time. */
function isAgentToolResult(value: unknown): value is AgentToolResultShape {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as AgentToolResultShape).kind === "agent_tool_result" &&
    Array.isArray((value as AgentToolResultShape).content)
  );
}

/** Convert one request-borne image to the engine message shape (base64 copy). */
function toMessageImage(image: AgentInputImage): MessageImage {
  if (!SUPPORTED_IMAGE_MIME.test(image.mimeType)) {
    throw new UnsupportedContentError(`image "${image.name}" has unsupported MIME "${image.mimeType}"`);
  }
  return { data: Buffer.from(image.data).toString("base64"), mimeType: image.mimeType };
}

/**
 * Enforce the model's image limits at conversion (contract §5). `total`
 * counts every image this call would carry; `where` names the source.
 */
function assertImageLimits(model: AgentRunRequest["model"], total: number): void {
  if (total === 0) return;
  if (model.acceptsImages === false) {
    throw new UnsupportedContentError(`model ${model.provider}/${model.id} accepts no image input`);
  }
  if (model.maxImagesPerPrompt !== undefined && total > model.maxImagesPerPrompt) {
    throw new UnsupportedContentError(
      `${total} images exceed the model limit of ${model.maxImagesPerPrompt} per prompt`,
    );
  }
}

/** Which component of the runtime owns in-flight work (contract §2). */
export type OwnedWorkKind = "helper" | "provider" | "tool";

interface OwnedWork {
  readonly kind: OwnedWorkKind;
  readonly label: string;
  cancel(): void;
}

interface AttemptEntry {
  readonly attemptId: string;
  readonly controller: AbortController;
  readonly owned: Set<OwnedWork>;
}

interface RunEntry {
  readonly runId: string;
  readonly attempts: Map<string, AttemptEntry>;
}

export interface SeepientAgentRuntimeOptions {
  /**
   * Resolve per-run engine options from the trusted run composition (T029).
   * D7: providers/credentials come from the normal provider runtime — never
   * env keys, never ambient fallback. The factory receives the full request
   * so it can map model/accounts; an explicitly empty tool list stays empty
   * because this adapter always overrides `tools` itself (below).
   */
  resolveEngineOptions: (request: AgentRunRequest) => Promise<CreateSeepientOptions> | CreateSeepientOptions;
  /**
   * Test/embedder seam for the engine construction itself (DI boundary — the
   * abort unit test installs a controllable fake; production leaves default).
   */
  createAgentImpl?: typeof createSeepient;
}

/**
 * Hydration (FR-034): pure once-per-run conversion of product history into
 * engine messages. Only user/assistant rows map — the engine composes its own
 * instructions (request.instructions ride `systemPrompt`), so upstream system
 * rows are deliberately dropped. History images (recent-user-turn hydration
 * rule is the caller's) convert with MIME/data preserved (FR-037).
 */
export function hydrateHistory(history: AgentRunRequest["history"]): Message[] {
  return history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m, i) => ({
      id: m.id ?? `hydrated-${i}`,
      role: m.role,
      content: m.content,
      ...(m.images?.length ? { images: m.images.map(toMessageImage) } : {}),
      timestamp: m.createdAt ? Date.parse(m.createdAt) || Date.now() : Date.now(),
    }));
}

/**
 * Async event queue bridging engine-callback-thread events into the
 * generator. `close()` releases waiters once the turn settles; post-settle
 * emissions (usage/done) are yielded directly by the generator.
 */
class EventQueue {
  #pending: AgentRuntimeEvent[] = [];
  #resolvers: Array<() => void> = [];
  #closed = false;

  push(event: AgentRuntimeEvent): void {
    if (this.#closed) return;
    this.#pending.push(event);
    this.#resolvers.shift()?.();
  }

  close(): void {
    this.#closed = true;
    while (this.#resolvers.length > 0) this.#resolvers.shift()?.();
  }

  hasPending(): boolean {
    return this.#pending.length > 0;
  }

  async next(): Promise<AgentRuntimeEvent | undefined> {
    if (this.#pending.length > 0) return this.#pending.shift();
    if (this.#closed) return undefined;
    await new Promise<void>((resolve) => this.#resolvers.push(resolve));
    return this.#pending.shift();
  }
}

export class SeepientAgentRuntime implements AgentRuntime {
  readonly #options: SeepientAgentRuntimeOptions;
  /** Abort registry keyed by run → per-attempt entries (contract §2). */
  readonly #runs = new Map<string, RunEntry>();

  constructor(options: SeepientAgentRuntimeOptions) {
    this.#options = options;
  }

  describe(): AdapterDescriptor<AgentRuntimeCapabilities> {
    return {
      id: "seepient-agent-runtime",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        streaming: true,
        compaction: true,
        tools: true,
        // Truthful: no scripted test runtime is wired in this adapter.
        scripted: false,
      },
    };
  }

  async *run(request: AgentRunRequest, context?: Partial<AdapterContext>): AsyncIterable<AgentRuntimeEvent> {
    const attemptId = context?.operationId ?? randomUUID();
    const queue = new EventQueue();
    const controller = new AbortController();
    const owned = new Set<OwnedWork>();
    const entry: AttemptEntry = { attemptId, controller, owned };

    let runEntry = this.#runs.get(request.runId);
    if (!runEntry) {
      runEntry = { runId: request.runId, attempts: new Map() };
      this.#runs.set(request.runId, runEntry);
    }
    runEntry.attempts.set(attemptId, entry);

    const drainOwned = (): void => {
      for (const work of owned) {
        try {
          work.cancel();
        } catch {
          // draining never throws into the loop — cleanup is best-effort
        }
      }
      owned.clear();
    };

    try {
      // Hydration: exactly once, at the boundary (FR-034). Pure function of
      // the request — no session store, no second transcript.
      const initialHistory = hydrateHistory(request.history);

      const base = await this.#options.resolveEngineOptions(request);
      const createAgent = this.#options.createAgentImpl ?? createSeepient;

      // Tool bridging: connector tools become trusted-host registrations whose
      // execute routes to the request's governed callback. The app executes;
      // the engine treats the bridge as host authority with model egress —
      // the explicit trust model the engine requires (legacy plain tools fail
      // closed at execution). Names that collide with engine built-ins are
      // namespaced (`app_`) for the model surface — the registration map
      // rejects shadowing, and the governed executor still receives the real
      // name. Empty stays empty end to end (FR-032): a summary or empty-tools
      // run resolves to zero engine tools.
      const tools: TrustedHostToolRegistration[] = request.tools.map((connectorTool) => {
        const engineName = ALL_TOOLS.includes(connectorTool.name) ? `app_${connectorTool.name}` : connectorTool.name;
        // Declared governed operation (T014–T016): static retained tools ship
        // their class-typed declaration so the analyzer/policy/audit see real
        // effects and risk. Dynamic connector tools have no static entry and
        // stay on the ambient fallback — the dynamic class (network-egress
        // "dynamic") is T016's live-catalog scope, not a static row.
        const governed = governedDeclarationFor(connectorTool.name);
        return trustedHostTool({
          // The adapter-kit declaration mirrors the engine contract
          // structurally; the runtime validator accepts its widened risk set.
          declaration: governed?.declaration as TrustedHostToolDeclaration | undefined,
          definition: {
            type: "function",
            function: {
              name: engineName,
              description: connectorTool.description,
              parameters: {
                type: "object",
                properties: (connectorTool.inputSchema.properties as Record<string, unknown> | undefined) ?? {},
                required: Array.isArray(connectorTool.inputSchema.required)
                  ? (connectorTool.inputSchema.required as string[])
                  : [],
              },
            },
          },
          execute: async (args: unknown): Promise<string | ToolResult> => {
            const executionId = randomUUID();
            queue.push({ type: "tool", name: connectorTool.name, args: args as Record<string, unknown>, executionId });
            const startedAt = Date.now();
            // The adapter owns the WAIT on the app's governed executor — the
            // upstream executeTool signature carries no signal, so cancellation
            // resolves the wait (the app-side op terminates on its own terms;
            // recorded in bridge-inventory.md).
            const toolAbort = new AbortController();
            const work: OwnedWork = {
              kind: "tool",
              label: `${connectorTool.name}:${executionId}`,
              cancel: () => toolAbort.abort(),
            };
            owned.add(work);
            try {
              // 029 S15/T035 (FR-028/029): bind the deferred-shell observer
              // to THIS run's delivery queue — the final output reaches the
              // active run as a correlated progress event; after the run
              // settles (queue closed) the push is a no-op and the executor's
              // own computer-command record stays the durable late-completion
              // attach. The owned-work drain cancels the live wait on abort.
              const observer: AgentToolExecutionObserver = {
                onShellStillRunning: (completion) => {
                  void completion
                    .then((final) => {
                      const tail = [
                        final.stdout.length > 0 ? final.stdout.slice(-2000) : "",
                        final.stderr.length > 0 ? final.stderr.slice(-2000) : "",
                      ]
                        .filter(Boolean)
                        .join("\n");
                      queue.push({
                        type: "progress",
                        text: `[shell ${executionId} finished] ${tail || "(no output)"}`,
                      });
                    })
                    .catch(() => undefined);
                },
              };
              const execution = request.executeTool?.(
                connectorTool.name,
                args as Record<string, unknown>,
                executionId,
                connectorTool.route,
                observer,
              );
              const aborted = new Promise<never>((_, reject) => {
                toolAbort.signal.addEventListener("abort", () => reject(new Error("ABORTED: tool wait cancelled")));
              });
              const result = await Promise.race([execution, aborted]);
              // 029 S13: a governed pause is a control outcome, never a tool
              // result — translate the app sentinel into the engine's typed
              // suspension so the loop ends the turn without a model-visible
              // result or a further provider call (no onToolCompleted: the
              // action did not complete; T023's terminal record is denied/
              // suspended upstream, not succeeded).
              if (
                typeof result === "object" &&
                result !== null &&
                (result as { kind?: string }).kind === "agent_tool_suspended"
              ) {
                const suspension = result as unknown as AgentToolSuspension;
                lastSuspensionRequest = suspension.request;
                throw new ToolSuspendedError(
                  suspension.pauseClass,
                  suspension.pauseToken,
                  `tool "${connectorTool.name}" suspended for ${suspension.pauseClass} pause`,
                );
              }
              // Result contents are redacted by the app's hook, never here.
              await request.onToolCompleted?.({
                name: connectorTool.name,
                executionId,
                durationMs: Date.now() - startedAt,
                result,
              });
              // Image-bearing tool results (FR-037): provider-neutral content
              // maps text blocks to the output and image blocks ride through —
              // never flattened into the text channel.
              if (isAgentToolResult(result)) {
                const text = result.content
                  .filter((c) => c.type === "text")
                  .map((c) => c.text ?? "")
                  .join("\n");
                const images = result.content
                  .filter((c) => c.type === "image" && typeof c.data === "string" && typeof c.mimeType === "string")
                  .map((c) => {
                    if (!SUPPORTED_IMAGE_MIME.test(c.mimeType as string)) {
                      throw new UnsupportedContentError(
                        `tool "${connectorTool.name}" returned an image with unsupported MIME "${c.mimeType}"`,
                      );
                    }
                    return { data: c.data as string, mimeType: c.mimeType as string };
                  });
                return { output: text, success: true, ...(images.length ? { images } : {}) };
              }
              return typeof result === "string" ? result : JSON.stringify(result ?? null);
            } finally {
              owned.delete(work);
            }
          },
        });
      });

      // 029 S15/T034 (B-3 closes): steering claiming moved INTO the loop —
      // claimSteering runs at EVERY safe model-turn boundary (per-step), not
      // once at run start. The request's durable claim rides the engine
      // config; the loop injects claimed items as tagged user content with
      // images at the next boundary (seen-ID suppressed by the store).
      const prompt = request.prompt;
      const turnImages: AgentInputImage[] = [...(request.currentTurnImages ?? [])];

      // Model image limits are enforced here, at conversion (contract §5):
      // the total covers current turn + steering attachments + hydrated
      // history rows — everything this model call would carry.
      const historyImageCount = request.history.reduce((n, m) => n + (m.images?.length ?? 0), 0);
      assertImageLimits(request.model, turnImages.length + historyImageCount);
      const promptImages = turnImages.map(toMessageImage);

      const agent = await createAgent({
        ...base,
        stateless: true,
        systemPrompt: request.instructions || base.systemPrompt,
        initialHistory,
        tools,
        // 029 S15/T034: the per-step steering claim rides the engine config
        // (the session forwards it into the loop's per-step boundary claim).
        config: {
          ...base.config,
          claimSteering: request.claimSteering,
          // 029 S17/T041 (B-2/D10): the fallback chain rides the config into
          // the loop's per-step handoff seam — onModelChange is ALREADY
          // lease-fenced upstream (persisted on the run row before the
          // replacement request).
          modelHandoff:
            request.fallbackModels && request.fallbackModels.length > 0
              ? {
                  fallbacks: request.fallbackModels.map((m) => ({ provider: m.provider, id: m.id })),
                  onModelChange: async (provider: string, id: string) => {
                    await request.onModelChange?.(provider, id);
                  },
                }
              : undefined,
        },
      });

      const providerWork: OwnedWork = {
        kind: "provider",
        label: `chat:${request.runId}:${attemptId}`,
        // The session's chatStream takes no signal (session aborts via
        // agent.abort()) — targeted cancellation goes through the agent.
        cancel: () => agent.abort(),
      };
      owned.add(providerWork);

      // chatStream resolves immediately with a handle; the turn itself streams
      // through result.textStream and settles when fullText/usage resolve.
      // Closing the queue on handle resolution would drop every delta.
      const stream = await agent.chatStream(prompt, {
        // Current-turn + steering-attachment images ride THIS turn (FR-037
        // sources 1+3); history images already sit on the hydrated rows.
        ...(promptImages.length ? { images: promptImages } : {}),
        // Per-call context seam (FR-039/040): the request's strategy applies
        // to this call only; the model's configured window is the budget and
        // overflow throws the typed error instead of truncating.
        context: {
          strategy: request.contextStrategy ?? DEFAULT_CONTEXT_STRATEGY,
          ...(request.model.contextWindow !== undefined ? { maxInputTokens: request.model.contextWindow } : {}),
        },
        onStep: (step: { type: string; name?: string; args?: unknown }) => {
          if (step.type === "tool_progress") {
            // 029 T011: the activity line carries the tool's redacted
            // description, not a static placeholder.
            queue.push({
              type: "progress",
              text: describeToolActivity(step.name ?? "tool", step.args),
              activity: true,
            });
          }
        },
        // onToolCall: the bridged execute already emitted the tool event
        // with the governed executionId; the engine-side call identity adds
        // nothing to the app surface.
      });

      const pump = (async () => {
        for await (const delta of stream.textStream) {
          queue.push({ type: "text", text: delta });
        }
      })();
      void pump;

      const settle = stream.fullText.then(
        (fullText) => ({ ok: true as const, fullText }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      // 029 T042 (FR-036): producer-side settlement is bound to the TURN's
      // finish chain — it runs exactly once even when the stream consumer
      // disconnects (a closed queue cannot strand the accounting). The
      // usage event still yields to connected consumers (accounted flag).
      const runIdForLog = request.runId;
      const settleUsage = async (): Promise<Extract<AgentRuntimeEvent, { type: "usage" }> | null> => {
        if (settledUsageEvent) return settledUsageEvent;
        const usage = await stream.usage.catch(() => null);
        const usageEvent: Extract<AgentRuntimeEvent, { type: "usage" }> = {
          type: "usage",
          accounted: true,
          provider: request.model.provider,
          model: request.model.id,
          operationKind: request.usageOperationKind ?? "answer",
          inputTokens: usage?.promptTokens ?? null,
          outputTokens: usage?.completionTokens ?? null,
          totalTokens: usage?.totalTokens ?? null,
          costUsd: usage?.cost ?? null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          reasoningTokens: null,
        };
        await request.onUsage?.(usageEvent);
        settledUsageEvent = usageEvent;
        void runIdForLog;
        return usageEvent;
      };
      let settledUsageEvent: Extract<AgentRuntimeEvent, { type: "usage" }> | null = null;
      const finish = settle.then(async (outcome) => {
        await pump.catch(() => undefined);
        try {
          settledUsageEvent = await settleUsage();
        } catch {
          // Producer settlement failure must not wedge the queue: the
          // emitted usage (below) carries null tokens (unknown — never zero)
          // and the caller's onUsage receives exactly that.
          settledUsageEvent = {
            type: "usage",
            accounted: true,
            provider: request.model.provider,
            model: request.model.id,
            operationKind: request.usageOperationKind ?? "answer",
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
            costUsd: null,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            reasoningTokens: null,
          };
        }
        // The settled usage event is yielded post-drain for connected
        // consumers; a disconnected consumer needs only the onUsage side
        // effect (already awaited above — durable either way).
        queue.close();
        return outcome;
      });
      /** 029 T028: the typed card payload of the latest suspension (the
       * executor parks on it; at most one live suspension per attempt). */
      let lastSuspensionRequest: AgentToolSuspension["request"] | undefined;

      // Drain callback-thread events while the turn runs; `close()` ends the
      // loop when the turn settles.
      for (;;) {
        const event = await queue.next();
        if (event === undefined) break;
        yield event;
      }

      owned.delete(providerWork);

      const outcome = await finish;
      if (!outcome.ok) {
        throw outcome.error;
      }

      const finalText = outcome.fullText;
      // One-settlement protocol: the usage event was computed + settled in
      // the finish chain (above) — emitted here for connected consumers,
      // marked accounted so consumers never double-account (E10/E12).
      // The event was settled in the finish chain (exactly once — even when
      // the consumer disconnected); yield it here for connected consumers.
      const usageEvent =
        settledUsageEvent ??
        (await settleUsage());
      if (usageEvent) yield usageEvent;

      // 029 S13: a suspended turn yields the typed pause event instead of a
      // fabricated done — the provider call that produced the tool call was
      // real (usage settled above), but the turn has no final text and the
      // consumer parks the run at waiting_input.
      const finishReason = await stream.finishReason.catch(() => "error");
      if (finishReason === "suspended") {
        const suspension = (await stream.suspension) as
          | { pauseClass: "permission" | "choice" | "secret" | "takeover"; pauseToken: string }
          | null;
        yield {
          type: "suspended",
          pauseClass: suspension?.pauseClass ?? "permission",
          pauseToken: suspension?.pauseToken ?? "",
          request: lastSuspensionRequest,
        };
        return;
      }

      // Empty-turn semantics (E9): silent runs allowed for bot wakes and
      // scheduled routines; otherwise the contextual fallback applies.
      let doneText = finalText;
      if (!doneText && !request.allowSilentEmpty) {
        doneText = request.emptyResponseText ?? "";
      }
      yield { type: "done", text: doneText || undefined };
    } finally {
      drainOwned();
      const current = this.#runs.get(request.runId);
      if (current) {
        current.attempts.delete(attemptId);
        if (current.attempts.size === 0) this.#runs.delete(request.runId);
      }
    }
  }

  /** Targeted abort (RT01): resolves exactly `runId`'s owned work. */
  async abort(runId: string): Promise<void> {
    const entry = this.#runs.get(runId);
    if (!entry) return;
    for (const attempt of entry.attempts.values()) {
      attempt.controller.abort();
      for (const work of attempt.owned) {
        try {
          work.cancel();
        } catch {
          // best-effort drain
        }
      }
      attempt.owned.clear();
    }
  }
}
