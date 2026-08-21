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
  upstreamProvider: string;
  credential:
    | { mode: "paste"; keyValue?: string; keyText?: string }
    | { mode: "env"; varName: string }
    | { mode: "none" }
    | { mode: "preserve" };
  baseUrl?: string;
  allowPrivate?: boolean;
  compat?: "openai" | "anthropic" | "google" | "openai-responses";
}

export interface AssignmentTarget {
  providerAccount: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
  fallback?: Array<{ providerAccount: string; model: string }>;
}
