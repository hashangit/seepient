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
  AgentRuntime,
  AgentRuntimeCapabilities,
  AgentRuntimeEvent,
  AgentRunRequest,
} from "@seepients/adapter-kit";
import type {
  AskSeepientStreamResult,
  CreateSeepientOptions,
  Message,
  UserToolDefinition,
} from "seepient-engine/dist/foundations/types.js";
import { createSeepient } from "seepient-engine/dist/transport/sdk/seepient.js";
import { randomUUID } from "node:crypto";

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
 * rows are deliberately dropped. Images ride S09 (T033).
 */
export function hydrateHistory(history: AgentRunRequest["history"]): Message[] {
  return history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m, i) => ({
      id: m.id ?? `hydrated-${i}`,
      role: m.role,
      content: m.content,
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

      // Tool bridging: connector tools become engine user tools whose execute
      // routes to the request's governed callback. Empty stays empty end to
      // end (FR-032): `tools: []` resolves to zero engine tools.
      const tools: UserToolDefinition[] = request.tools.map((connectorTool) => ({
        name: connectorTool.name,
        description: connectorTool.description,
        parameters: connectorTool.inputSchema,
        execute: async (args: unknown) => {
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
            const execution = request.executeTool?.(
              connectorTool.name,
              args as Record<string, unknown>,
              executionId,
              connectorTool.route,
              undefined,
            );
            const aborted = new Promise<never>((_, reject) => {
              toolAbort.signal.addEventListener("abort", () => reject(new Error("ABORTED: tool wait cancelled")));
            });
            const result = await Promise.race([execution, aborted]);
            // Result contents are redacted by the app's hook, never here.
            await request.onToolCompleted?.({
              name: connectorTool.name,
              executionId,
              durationMs: Date.now() - startedAt,
              result,
            });
            return typeof result === "string" ? result : JSON.stringify(result ?? null);
          } finally {
            owned.delete(work);
          }
        },
      }));

      // Safe-boundary steering claim (upstream semantics: atomically claim
      // durable user steering before the turn runs); claimed text rides the
      // current turn as tagged context.
      let prompt = request.prompt;
      if (request.claimSteering) {
        const claimed = await request.claimSteering([]);
        if (claimed.length > 0) {
          const tagged = claimed.map((m) => `[steering] ${m.text}`).join("\n");
          prompt = `${tagged}\n\n${request.prompt}`;
        }
      }

      const agent = await createAgent({
        ...base,
        stateless: true,
        systemPrompt: request.instructions || base.systemPrompt,
        initialHistory,
        tools,
      });

      const providerWork: OwnedWork = {
        kind: "provider",
        label: `chat:${request.runId}:${attemptId}`,
        // The session's chatStream takes no signal (session aborts via
        // agent.abort()) — targeted cancellation goes through the agent.
        cancel: () => agent.abort(),
      };
      owned.add(providerWork);

      let settled:
        | { ok: true; result: AskSeepientStreamResult }
        | { ok: false; error: unknown }
        | undefined;
      const streamPromise = agent
        .chatStream(prompt, {
          onText: (delta: string) => queue.push({ type: "text", text: delta }),
          onStep: (step: { type: string }) => {
            if (step.type === "tool_progress") {
              queue.push({ type: "progress", text: "tool running", activity: true });
            }
          },
          // onToolCall: the bridged execute already emitted the tool event
          // with the governed executionId; the engine-side call identity adds
          // nothing to the app surface.
        })
        .then(
          (result) => {
            settled = { ok: true, result };
            queue.close();
          },
          (error: unknown) => {
            settled = { ok: false, error };
            queue.close();
          },
        );
      void streamPromise;

      // Drain callback-thread events while the turn runs; `close()` ends the
      // loop when the turn settles.
      for (;;) {
        const event = await queue.next();
        if (event === undefined) break;
        yield event;
      }

      owned.delete(providerWork);

      if (settled && !settled.ok) {
        throw settled.error;
      }

      const finalText = settled && settled.ok ? await settled.result.fullText : "";
      const usage = settled && settled.ok ? await settled.result.usage : null;

      // One-settlement protocol: producer-side accounting is awaited here,
      // and the emitted event is marked accounted so consumers never
      // double-account (E10/E12). Null means unknown — never zero.
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
      yield usageEvent;

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
