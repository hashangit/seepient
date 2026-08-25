/**
 * Foundation contract types for ProviderManagerApi
 *
 * Layer 0 Foundation contract (importable by any layer).
 */

import type { PurposeModelMap } from "../schemas/provider-config.js";
import type { ThinkingLevel } from "../schemas/inference.js";

export type Tier = "efficient" | "standard" | "complex";
export type PurposeId =
  | "plan" | "text" | "coding" | "vision" | "commit"
  | "media.image" | "media.speech" | "media.transcription" | "media.video";

export type CredentialKind = "env" | "seepient" | "keychain" | "externalsecret" | "none" | "oauth";
export type AccountHealth = "ok" | "missing" | "unverified" | "expired";

export interface AccountView {
  id: string;
  upstreamProvider: string;
  baseUrl?: string;
  credentialKind: CredentialKind;
  credentialDetail?: string;
  health: AccountHealth;
  modelCount: number;
}

export interface PurposeDef {
  id: PurposeId;
  label: string;
  tiered: boolean;
  requires: Array<"toolUse" | "vision" | "streaming" | "imageGenerate" | "tts" | "stt" | "video">;
}

export interface ManagerState {
  revision: number;
  accounts: AccountView[];
  assignments: PurposeModelMap;
  models: any[];
  purposes: PurposeDef[];
}

export interface UiError {
  code: string;
  message: string;
  hint?: string;
  retried?: boolean;
  cause?: string;
}

export type SaveResult = { ok: true; state: ManagerState } | { ok: false; error: UiError };
export type DeleteResult =
  | SaveResult
  | { ok: false; blocked: true; referencingSlots: string[] };

export interface AccountInput {
  accountId: string;
  upstreamProvider?: string;
  credential:
    | { mode: "paste"; keyValue?: string; keyText?: string }
    | { mode: "env"; varName: string }
    | { mode: "none" }
    | { mode: "preserve" };
  baseUrl?: string | null;
  allowPrivate?: boolean | null;
  compat?: "openai" | "anthropic" | "google" | "openai-responses" | null;
}

export interface AssignmentTarget {
  providerAccount: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
  fallback?: Array<{ providerAccount: string; model: string }>;
}

export interface ProbeResult {
  accountId: string;
  authValid: boolean;
  reachable?: boolean;
  latencyMs?: number;
  error?: UiError;
}

export interface RefreshResult {
  ok: boolean;
  discovered?: string[];
  state?: ManagerState;
  error?: UiError;
}

export interface ResolutionPreview {
  selectedTarget: { providerAccount: string; model: string };
  via: "requested" | "fallback-chain";
  failureTargets: Array<{ providerAccount: string; model: string }>;
}

export interface OAuthFlowCallbacks {
  preferredAccountId?: string;
  signal?: AbortSignal;
  onDeviceCode?(info: { userCode: string; verificationUrl: string; expiresInMs: number }): void;
  onBrowserOpen?(url: string, instructions?: string): void;
  onWaiting?(): void;
  onPrompt?(prompt: { type: string; message: string }): Promise<string>;
}

export interface ProviderManagerApi {
  getState(): Promise<ManagerState>;
  saveAccount(input: AccountInput, expectedRevision?: number): Promise<SaveResult>;
  deleteAccount(accountId: string, opts?: { force?: boolean; expectedRevision?: number }): Promise<DeleteResult>;
  setAssignment(purpose: PurposeId, tier: Tier | null, target: AssignmentTarget, expectedRevision?: number): Promise<SaveResult>;
  clearAssignment(purpose: PurposeId, tier: Tier | null, expectedRevision?: number): Promise<SaveResult>;
  resolvePreview(
    purpose: PurposeId,
    tier?: Tier,
    override?: { providerAccount?: string; model?: string; thinkingLevel?: ThinkingLevel },
  ): Promise<ResolutionPreview | UiError & { ok: false }>;
  probeAccount(accountId: string): Promise<ProbeResult>;
  refreshModels(accountId: string): Promise<RefreshResult>;
  switchSessionModel(accountId: string, modelId: string): void;
  signInWithProvider(upstream: string, callbacks: OAuthFlowCallbacks): Promise<SaveResult>;
  completeOAuthSignIn(
    upstream: string,
    credentials: { access: string; refresh?: string; expires?: number },
    opts?: { preferredAccountId?: string; description?: string },
  ): Promise<SaveResult>;
  logoutAccount(accountId: string): Promise<SaveResult>;
  getAvailableOAuthFlows(): Promise<readonly string[]>;
}
