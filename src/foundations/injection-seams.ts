/**
 * Package-boundary injection seams (spec 027).
 *
 * Core (seepient-core) carries the engine with zero built-in tools, no media
 * vendor wiring, no sandbox boundary, and no provider-SDK discovery sources.
 * The full `seepient` package registers its implementations here at its
 * composition roots (`src/transport/sdk/full-registrations.ts`), so engine
 * modules never hold a static or dynamic edge into full-package modules.
 *
 * Registration is process-wide module state holding factories/values only —
 * no per-tenant data — and is idempotent per import instance.
 */
import type { ToolModule } from "./contracts/tool.js";
import type { ImageBackend } from "./contracts/backend-ports.js";
import type { BrokeredEffectRequest } from "./contracts/prepared-action.js";
import type { BrokeredEffectResult } from "./contracts/execution-brokers.js";
import type { Capability } from "./contracts/permission-policy.js";

// ── Default tool modules (the full package's built-in barrel) ───────────────

let defaultToolModules: readonly ToolModule[] | undefined;

/**
 * Register the built-in tool barrel. Called by the full package; seepient-core
 * never registers, so engine defaults expose zero built-in tools (FR-003).
 */
export function registerDefaultToolModules(modules: readonly ToolModule[]): void {
  defaultToolModules = Object.freeze([...modules]);
}

/** The registered default, or undefined in seepient-core. */
export function getDefaultToolModules(): readonly ToolModule[] | undefined {
  return defaultToolModules;
}

// ── Media vendor-operation handler (spec 027 FR-009) ────────────────────────

export interface MediaVendorOperationHandlerOptions {
  /** Provider runtime (or lazy getter) — structurally typed at the seam. */
  runtime: unknown;
  /** Artifact store (structural at the seam; the full factory narrows it). */
  artifacts: unknown;
  signal?: AbortSignal;
  tenancyMode?: "single" | "multi";
  capabilities?: Capability[];
}

export type MediaVendorOperationHandler = (
  req: Extract<BrokeredEffectRequest, { kind: "vendor-operation" }>,
  capabilities?: Capability[],
) => Promise<BrokeredEffectResult>;

let mediaVendorOperationHandlerFactory:
  | ((opts: MediaVendorOperationHandlerOptions) => MediaVendorOperationHandler)
  | undefined;

/**
 * Register the media/image vendor-operation handler factory. Called by the
 * full package; unregistered (seepient-core) media turns deny typed (FR-009).
 */
export function registerMediaVendorOperationHandlerFactory(
  factory: (opts: MediaVendorOperationHandlerOptions) => MediaVendorOperationHandler,
): void {
  mediaVendorOperationHandlerFactory = factory;
}

export function getMediaVendorOperationHandlerFactory():
  | ((opts: MediaVendorOperationHandlerOptions) => MediaVendorOperationHandler)
  | undefined {
  return mediaVendorOperationHandlerFactory;
}

// ── Direct-SDK image backends (spec 027 FR-009) ─────────────────────────────

const imageBackendFactories: Partial<Record<"google" | "openai", () => ImageBackend>> = {};

/**
 * Register the direct-SDK image backends (google/openai image-raw vendors).
 * The aggregate adapter consults this instead of statically importing the
 * vendors; unregistered providers deny typed at first use.
 */
export function registerImageBackendFactories(factories: {
  google?: () => ImageBackend;
  openai?: () => ImageBackend;
}): void {
  Object.assign(imageBackendFactories, factories);
}

export function getImageBackendFactory(
  provider: "google" | "openai",
): (() => ImageBackend) | undefined {
  return imageBackendFactories[provider];
}

// ── Execution boundary (spec 027 FR-012) ────────────────────────────────────

import type { ExecutionBoundary } from "./contracts/execution-boundary.js";
import type { SnapshotStore } from "./hashline/snapshot-store.js";
import type { CommitHelper } from "./contracts/execution-brokers.js";

/** Options the engine passes when building a boundary for a turn/session. */
export interface ExecutionBoundaryBuildOptions {
  /** Artifact store (structural at the seam; the full factory narrows it). */
  artifacts: unknown;
  hostCallbacks?: Map<string, (args: unknown) => Promise<unknown>>;
  workspaceRoot?: string;
  snapshotStore?: SnapshotStore;
  commitHelper?: CommitHelper;
  vendorOperationHandler?: MediaVendorOperationHandler | undefined;
  /** Broker network adapter override (structural at the seam). */
  network?: unknown;
  secretResolver?: (ref: string) => string | undefined;
  tenancyMode?: "single" | "multi";
}

export type ExecutionBoundaryFactory = (
  opts: ExecutionBoundaryBuildOptions,
) => Promise<{ boundary: ExecutionBoundary }>;

let executionBoundaryFactory: ExecutionBoundaryFactory | undefined;

/**
 * Register the boundary-carrying pipeline factory (sandbox + effect broker +
 * native helper). Called by the full package; seepient-core defaults to the
 * light boundary (trusted-host/none only, FR-012).
 */
export function registerExecutionBoundaryFactory(factory: ExecutionBoundaryFactory): void {
  executionBoundaryFactory = factory;
}

export function getExecutionBoundaryFactory(): ExecutionBoundaryFactory | undefined {
  return executionBoundaryFactory;
}

// ── Provider management API (spec 027) ──────────────────────────────────────

import type { ProviderManagerApi } from "./contracts/provider-manager-api.js";

let providerManagerApiFactory:
  | ((runtime: unknown) => Promise<ProviderManagerApi>)
  | undefined;

/**
 * Register the provider-management API factory (a full-package CLI impl).
 * Unregistered (seepient-core) provider mutations deny typed naming seepient.
 */
export function registerProviderManagerApiFactory(
  factory: (runtime: unknown) => Promise<ProviderManagerApi>,
): void {
  providerManagerApiFactory = factory;
}

export function getProviderManagerApiFactory():
  | ((runtime: unknown) => Promise<ProviderManagerApi>)
  | undefined {
  return providerManagerApiFactory;
}

// ── Broker-connector evaluation (spec 027) ──────────────────────────────────

let brokerConnectorEvaluator:
  | ((registration: unknown, args: unknown, ctx: unknown) => Promise<unknown>)
  | undefined;

/**
 * Register the broker-connector evaluator (full-package machinery over the
 * MCP connector registry). Unregistered (seepient-core) broker-connector
 * tools deny typed at analysis time.
 */
export function registerBrokerConnectorEvaluator(
  evaluate: (registration: unknown, args: unknown, ctx: unknown) => Promise<unknown>,
): void {
  brokerConnectorEvaluator = evaluate;
}

export function getBrokerConnectorEvaluator():
  | ((registration: unknown, args: unknown, ctx: unknown) => Promise<unknown>)
  | undefined {
  return brokerConnectorEvaluator;
}

// ── Built-in tool analyzers (spec 027) ──────────────────────────────────────

import type { ToolAnalyzer } from "./contracts/tool-analyzer.js";
export type { ToolAnalyzer };

let builtInAnalyzers: Record<string, ToolAnalyzer> = {};

/**
 * Register the built-in tool analyzers (the prepared-action builders for the
 * built-in tools). Called by the full package; seepient-core runs with an
 * empty table — it has no built-in tools to analyze.
 */
export function registerBuiltInAnalyzers(analyzers: Record<string, ToolAnalyzer>): void {
  builtInAnalyzers = { ...builtInAnalyzers, ...analyzers };
}

export function getBuiltInAnalyzers(): Record<string, ToolAnalyzer> {
  return builtInAnalyzers;
}

// ── Provider discovery sources (spec 027) ───────────────────────────────────

export interface DiscoverySourceLoaders {
  /** Loader for the OpenAI/openai-compatible discovery source. */
  openai?: () => Promise<{ OpenAIDiscoverySource: new () => import("./contracts/backend-ports.js").DiscoverySource }>;
  /** Loader for the Google discovery source. */
  google?: () => Promise<{ GoogleDiscoverySource: new () => import("./contracts/backend-ports.js").DiscoverySource }>;
}

let discoverySourceLoaders: DiscoverySourceLoaders = {};

/**
 * Register the direct-SDK discovery-source loaders (lazy thunks owned by the
 * full package). Unregistered (seepient-core) refreshModels degrades with a
 * typed actionable message naming the absent full-side sources.
 */
export function registerDiscoverySourceLoaders(loaders: DiscoverySourceLoaders): void {
  discoverySourceLoaders = { ...discoverySourceLoaders, ...loaders };
}

export function getDiscoverySourceLoaders(): DiscoverySourceLoaders {
  return discoverySourceLoaders;
}

// ── Exact-BPE estimator loader (spec 027 FR-004) ────────────────────────────

type ExactEncodeFn = (text: string) => number[];

let exactEstimatorLoader: (() => Promise<{ encode: ExactEncodeFn }>) | undefined;

/**
 * Register the exact-BPE tokenizer loader (a full-package lazy thunk). 
 * Unregistered (seepient-core) token estimation stays on the chars÷4
 * heuristic with estimateMode "heuristic".
 */
export function registerExactEstimatorLoader(
  loader: () => Promise<{ encode: ExactEncodeFn }>,
): void {
  exactEstimatorLoader = loader;
}

export function getExactEstimatorLoader():
  | (() => Promise<{ encode: ExactEncodeFn }>)
  | undefined {
  return exactEstimatorLoader;
}
