import type {
  CanonicalMessage,
  ThinkingLevel,
  StreamEvent,
  InferenceResponse,
  ImageRequest,
  ImageResult,
  UpstreamModel,
} from "../schemas/inference.js";
import type { ToolDefinition } from "./tool.js";
import type { CredentialHandle } from "./credential-store.js";

export interface LanguageRequest {
  messages: CanonicalMessage[];
  thinkingLevel?: ThinkingLevel;
  maxOutputTokens?: number;
  tools?: ToolDefinition[];
}

export interface InferenceOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface InferenceTarget {
  providerAccount: string;
  upstreamProvider: string;
  model: string;
  credential: CredentialHandle;
  baseUrl?: string;
  compat?: "openai" | "anthropic" | "google" | "openai-responses";
  timeoutMs?: number;
}

export interface ProviderAccountContext {
  providerAccount: string;
  upstreamProvider: string;
  credential: CredentialHandle;
  baseUrl?: string;
  compat?: "openai" | "anthropic" | "google" | "openai-responses";
}

export interface LanguageBackend {
  chatStream(target: InferenceTarget, req: LanguageRequest, opts?: InferenceOptions): AsyncIterable<StreamEvent>;
  chat(target: InferenceTarget, req: LanguageRequest, opts?: InferenceOptions): Promise<InferenceResponse>;
}

export interface ImageBackend {
  generate(target: InferenceTarget, req: ImageRequest, opts?: InferenceOptions): Promise<ImageResult>;
}

export interface CatalogSource {
  list(): Promise<readonly UpstreamModel[]>;
}

export interface DiscoveryResult {
  readonly modelIds: readonly string[];
  readonly error?: string;
}

export interface DiscoverySource {
  discover(account: ProviderAccountContext): Promise<DiscoveryResult>;
}

export interface RawBackend {
  language?: LanguageBackend;
  images?: ImageBackend;
  catalog?: CatalogSource;
  discovery?: DiscoverySource;
}

export interface BoundLanguageExecutor {
  stream(req: LanguageRequest, opts?: InferenceOptions): AsyncIterable<StreamEvent>;
  chat(req: LanguageRequest, opts?: InferenceOptions): Promise<InferenceResponse>;
}

export interface BoundImageExecutor {
  generate(req: ImageRequest, opts?: InferenceOptions): Promise<ImageResult>;
}

export interface BoundAdapter {
  readonly target: InferenceTarget;
  language?: BoundLanguageExecutor;
  images?: BoundImageExecutor;
}

export type ImageOperation = "generate" | "variation" | "edit" | "mask";

export type ImageBackendResolver = (
  target: InferenceTarget,
  op: ImageOperation,
  req: ImageRequest,
) => ImageBackend | undefined;
