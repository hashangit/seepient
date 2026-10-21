/**
 * Application Runtime Translation Contracts — Foundations (spec 029, M02 S05, FR-010/FR-015).
 *
 * Neutral, renderer-safe mirror of the verified upstream runtime surface
 * (research E8–E12: `@rakazo/adapter-kit` `types.ts:444-581` at pin `40ee8548`)
 * that the S08 adapter translates onto the one Seepient Domain loop.
 *
 * Every upstream request field and event variant has a mapping row below or an
 * explicit not-in-this-spec note. This module is the CONTRACT; the adapter owns
 * the actual conversion. Settlement behavior is M09 — only the vocabulary and
 * shapes land here.
 *
 * ## Field map — AppRunRequest ⇄ upstream AgentRunRequest (E9, types.ts:444-495)
 *
 * | App field                | Upstream field          | Semantics carried over |
 * |--------------------------|-------------------------|------------------------|
 * | botId                    | botId                   | assistant principal context (→ AssistantId) |
 * | threadId                 | threadId                | preserved thread ID (→ SessionId) |
 * | runId                    | runId                   | preserved run ID (→ RunId) |
 * | sourceMessageId          | sourceMessageId         | nullable provenance link |
 * | prompt                   | prompt                  | current user prompt |
 * | instructions             | instructions            | system-side instructions |
 * | history                  | history                 | per-message `images?` hydrated ONLY for recent user turns |
 * | currentTurnImages        | currentTurnImages       | current-turn attachments |
 * | tools                    | tools                   | ConnectorTool list; empty stays empty end-to-end (FR-032) |
 * | model                    | model                   | primary model connection |
 * | fallbackModels           | fallbackModels          | ordered user-selected backups |
 * | resolveFallbackModel     | resolveFallbackModel    | lazy backup resolution — healthy primary turns do no extra auth work |
 * | onModelChange            | onModelChange           | persist the backup BEFORE the replacement request (persist-before-replacement) |
 * | resolveModel             | resolveModel            | explicit helper-model resolution inside active principal/space scope |
 * | resumeFromCheckpoint     | resumeFromCheckpoint    | opaque pass-through — NO compatibility promise (see CHECKPOINT disclaimer) |
 * | script                   | script                  | scripted turns (dev/verification only; production selection is S18/M10, E16) |
 * | allowSilentEmpty         | allowSilentEmpty        | skip synthetic empty-turn fallbacks (bot wakes, routines) |
 * | emptyResponseText        | emptyResponseText       | contextual fallback for non-silent empty runs |
 * | executeTool              | executeTool             | pre-execution callback with executionId + route + observer |
 * | onToolCompleted          | onToolCompleted         | post-tool hook; MUST NOT persist raw result contents |
 * | claimSteering            | claimSteering           | atomic durable-steering claim at the next safe turn boundary |
 * | onUsage                  | onUsage                 | awaited producer-side usage accounting, independent of consumer cancellation |
 * | contextStrategy          | contextStrategy         | per-call context strategy (FR-039 seam) |
 * | usageOperationKind       | usageOperationKind      | exclusive cost bucket for the whole workflow |
 *
 * ## Event map — AppRuntimeEvent ⇄ upstream AgentRuntimeEvent (E10, types.ts:538-574)
 *
 * `text` | `progress` (+`activity` provider-status marker) | `tool` (name/args/executionId) |
 * `ask` (text/detail/actions) | `takeover` (reason) | `usage` (+`accounted`, provider/model/callId/
 * operationKind/agentId) | `checkpoint` (⚠ disclaimer below) | `subagent` (status/progress/result) |
 * `done`. Typed control outcomes are `ask`/`takeover` only.
 *
 * ## CHECKPOINT DISCLAIMER (E11, FR-015)
 *
 * The `checkpoint` event and `resumeFromCheckpoint` request field pass through
 * as OPAQUE strings. There is NO Pi-snapshot compatibility promise: production
 * Pi never reads these values, and no persistence, migration, or cross-version
 * semantics are claimed or implemented by this contract. Any future checkpoint
 * behavior must be derived from observed source, never from this type.
 */

import type {
  AssistantId,
  RunId,
  SessionId,
} from "./identity.js";

/** Per-call context strategy (E9; consumed by the FR-039 neutral context seam). */
export type AppContextStrategy = "current" | "retrieval" | "snapshots" | "cache-aware";
export const DEFAULT_APP_CONTEXT_STRATEGY: AppContextStrategy = "retrieval";

/** Exclusive workflow cost bucket; retrieval tool turns are detected for answer calls (E9). */
export type UsageOperationKind = "answer" | "setup" | "retrieval" | "subagent" | "compaction";

/** Image input as delivered to conversion (M02 S09 adds ownership provenance on the adapter path). */
export interface AppInputImage {
  readonly name: string;
  readonly mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  readonly data: Uint8Array;
}

/** In-process tool routing metadata; never exposed to the model (E9-era upstream shape). */
export interface AppConnectorRoute {
  readonly connectorId: string;
  readonly toolName: string;
  readonly resourceId?: string;
  readonly resourceRevision?: string | number;
  readonly catalogGroup?: string;
}

/** Model-callable tool descriptor (E9 `ConnectorTool`). */
export interface AppConnectorTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** Declared effect: `false` forces approval; `true` never relaxes the name-based gate. */
  readonly readOnly?: boolean;
  readonly route?: AppConnectorRoute;
}

/** Observer for tool calls that can report output before returning (E9). */
export interface AppToolExecutionObserver {
  readonly onShellStillRunning?: (
    completion: Promise<{ stdout: string; stderr: string; code: number }>,
  ) => void;
}

/**
 * Ephemeral tool-completion data for audit hooks (E9 `AgentToolCompletion`).
 * Result contents MUST be redacted before persistence.
 */
export interface AppToolCompletion {
  readonly name: string;
  readonly executionId: string;
  readonly durationMs: number;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly paused?: boolean;
}

/** Durable steering message claimed at a safe turn boundary (E9). */
export interface AppSteeringMessage {
  readonly id: string;
  readonly messageId: string;
  readonly text: string;
  /** Persisted history text before attachment paths are appended. */
  readonly historyText?: string;
  readonly images?: AppInputImage[];
}

/**
 * Provider-neutral per-call usage. NULL MEANS UNKNOWN — never zero, never free
 * (E12). Input excludes cache buckets; reasoning is already included in output.
 */
export interface AppUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens?: number | null;
  readonly cacheWriteTokens?: number | null;
  readonly cacheWrite1hTokens?: number | null;
  readonly reasoningTokens?: number | null;
  readonly totalTokens?: number | null;
  readonly costUsd?: number | null;
  readonly costSource?: string | null;
  readonly pricingVersion?: string | null;
  readonly usageSource?: string | null;
}

/** Reservation protocol for producer-side usage accounting (E12). Settlement is M09. */
export interface AppModelCallObserver {
  beforeCall(call: {
    readonly provider: string;
    readonly modelId: string;
    readonly inputTokensEstimate: number;
    readonly maxOutputTokens: number;
    /** Explicit adapter-known write bucket required by this request, not a billing prediction. */
    readonly cacheWriteRetention?: "1h";
  }): string | Promise<string>;
  afterCall(reservationId: string, usage: AppUsage | null): void | Promise<void>;
}

/** Model connection descriptor (E9 `AgentRunModel`). Credentials ride the normal Seepient provider runtime (D7) — no env-key synthesis. */
export interface AppRunModel {
  readonly provider: string;
  readonly id: string;
  readonly apiKey?: string;
  /** Cloudflare account id stored with a gateway BYOK credential. */
  readonly accountId?: string;
  /** Cloudflare AI Gateway id stored with a gateway BYOK credential. */
  readonly gatewayId?: string;
  readonly baseUrl?: string;
  readonly reasoning?: boolean;
  readonly acceptsImages?: boolean;
  readonly maxImagesPerPrompt?: number;
  readonly maxTokens?: number;
  readonly contextWindow?: number;
}

/**
 * Scripted turn (E9 `ScriptedTurn`) — dev/verification mechanism only.
 * Production removal of the env-selection path is S18/M10 (E16); this contract
 * neither enables nor unblocks it (FR-031).
 */
export interface AppScriptedTurn {
  readonly assistant?: string;
  readonly toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  readonly ask?: { text: string; detail?: string; actions?: Array<{ id: string; label: string }> };
  readonly takeover?: { reason: string };
  readonly files?: Array<{ path: string; content: string }>;
  readonly memory?: Array<{ scope: "bot" | "user"; path: string; content: string }>;
  readonly complete?: boolean;
}

/** History message (E9). `images` are hydrated ONLY for recent user turns. */
export interface AppHistoryMessage {
  readonly id?: string;
  readonly createdAt?: string;
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
  readonly images?: AppInputImage[];
}

/**
 * Neutral run request (FR-010). Field-for-field map of the verified upstream
 * `AgentRunRequest` — see the module-level table for carried-over semantics.
 * Callbacks are part of the contract: their SEMANTICS (persist-before-
 * replacement, redaction, atomicity) bind implementations, not just signatures.
 */
export interface AppRunRequest {
  /** Awaited producer-side accounting, independent of event-consumer cancellation. */
  readonly onUsage?: (event: AppUsageEvent) => void | Promise<void>;
  readonly contextStrategy?: AppContextStrategy;
  /** Exclusive cost bucket for the whole workflow. */
  readonly usageOperationKind?: UsageOperationKind;
  /** Assistant principal context for the run. */
  readonly botId: AssistantId;
  /** Preserved thread ID (session). */
  readonly threadId: SessionId;
  /** Preserved run ID. */
  readonly runId: RunId;
  readonly sourceMessageId?: string | null;
  readonly prompt: string;
  readonly instructions: string;
  /** Recent-user-turn image hydration is the caller's rule; the engine sees hydrated history exactly once (FR-034). */
  readonly history: ReadonlyArray<AppHistoryMessage>;
  readonly currentTurnImages?: ReadonlyArray<AppInputImage>;
  /** Empty stays empty end-to-end (FR-032). */
  readonly tools: ReadonlyArray<AppConnectorTool>;
  readonly model: AppRunModel;
  /** Ordered, user-selected models eligible after provider unavailability. */
  readonly fallbackModels?: ReadonlyArray<{ provider: string; id: string }>;
  /** Resolve one configured backup lazily so healthy primary turns do no extra auth work. */
  readonly resolveFallbackModel?: (provider: string, modelId: string) => Promise<AppRunModel>;
  /** Persist the selected backup against the active run lease BEFORE requesting it. */
  readonly onModelChange?: (provider: string, modelId: string) => Promise<void>;
  /** Resolve an explicitly requested helper model within the active principal and space scope. */
  readonly resolveModel?: (provider: string, modelId: string) => Promise<AppRunModel>;
  /** Opaque pass-through — NO snapshot-compatibility promise (module disclaimer, E11/FR-015). */
  readonly resumeFromCheckpoint?: string;
  readonly script?: ReadonlyArray<AppScriptedTurn>;
  /** When set, skip synthetic empty-turn fallbacks (including after tools). */
  readonly allowSilentEmpty?: boolean;
  /** Contextual fallback when a non-silent run produces no written response. */
  readonly emptyResponseText?: string;
  /** Pre-execution callback carrying executionId, route and observer. */
  readonly executeTool?: (
    name: string,
    args: Record<string, unknown>,
    executionId: string,
    route?: AppConnectorRoute,
    observer?: AppToolExecutionObserver,
  ) => Promise<unknown>;
  /** Post-tool hook; implementations MUST NOT persist raw result contents. */
  readonly onToolCompleted?: (completion: AppToolCompletion) => Promise<void> | void;
  /** Atomically claim durable user steering at the runtime's next safe turn boundary. */
  readonly claimSteering?: (seenIds: string[]) => Promise<AppSteeringMessage[]>;
}

/** Usage event variant of the runtime event union (carries the one-settlement protocol). */
export type AppUsageEvent = {
  readonly type: "usage";
  /** Producer-side onUsage completed; consumers MUST NOT account it again. */
  readonly accounted?: boolean;
  readonly provider: string;
  readonly model: string;
  readonly callId?: string;
  readonly operationKind?: UsageOperationKind;
  readonly agentId?: string;
} & AppUsage;

/**
 * Neutral runtime event union (FR-010). Variant-for-variant map of the
 * verified upstream `AgentRuntimeEvent` — see the module-level event map.
 * `checkpoint` is opaque with no compatibility promise.
 */
export type AppRuntimeEvent =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "progress";
      readonly text: string;
      /** Provider-generated tool status rather than assistant-authored narration. */
      readonly activity?: true;
    }
  | { readonly type: "tool"; readonly name: string; readonly args: Record<string, unknown>; readonly executionId: string }
  | {
      readonly type: "ask";
      readonly text: string;
      readonly detail?: string;
      readonly actions?: ReadonlyArray<{ id: string; label: string }>;
    }
  | { readonly type: "takeover"; readonly reason: string }
  | AppUsageEvent
  | { readonly type: "checkpoint"; readonly blob: string }
  | {
      readonly type: "subagent";
      readonly agentId: string;
      readonly name: string;
      readonly task: string;
      readonly status: "running" | "completed" | "failed";
      readonly progress?: string;
      readonly result?: string;
    }
  | { readonly type: "done"; readonly text?: string };

/** Adapter capability flags (E10 `AgentRuntimeCapabilities`). */
export interface AppRuntimeCapabilities {
  readonly streaming: boolean;
  readonly compaction: boolean;
  readonly tools: boolean;
  readonly scripted: boolean;
}
