/**
 * 013 M1 — ProviderManagerApi: the single semantic core every surface talks to
 * (TUI dock/wizard via props, CLI handlers, SDK methods; server handlers mirror
 * its semantics). Contracts: Implementation-Specs/013-provider-management-tui/
 * contracts/provider-manager-api.md. Binding rules R1–R15 in plan.md.
 */

import type { ProviderRuntime } from "../../domain/providers/provider-runtime.js";
import type { AvailableModel } from "../../domain/providers/model-catalog.js";
export type { AvailableModel };
import type {
  CredentialRef,
} from "../../foundations/schemas/credential-store.js";
import type {
  PurposeModelMap,
  ProviderEntry,
  ProviderEntryPatch,
} from "../../foundations/schemas/provider-config.js";
import type { ThinkingLevel } from "../../foundations/schemas/inference.js";
import { redactString, redactUrlCredentials, isSensitiveKey } from "../../foundations/security/redact.js";
import { SeepientError } from "../../foundations/errors.js";
import { validateEndpointUrl } from "../http/ssrf-validator.js";
import { getCanonicalOAuthFlowId } from "../../domain/providers/oauth-service.js";

// ── Vocabulary types (data-model.md §2.1) ───────────────────────────────────

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
  models: AvailableModel[];
  purposes: PurposeDef[];
}

export interface UiError {
  code: string;
  message: string;
  hint?: string;
  retried?: boolean;
  cause?: string;
}

export interface AccountInput {
  accountId: string;
  upstreamProvider: string;
  credential:
    | { mode: "paste"; keyValue?: string; keyText?: string }
    | { mode: "env"; varName: string }
    | { mode: "none" }
    | { mode: "preserve" };
  baseUrl?: string;
  compat?: "openai" | "anthropic" | "google" | "openai-responses";
  /** Explicit local-endpoint affordance (R5): only set when the UI confirmed. */
  allowPrivate?: boolean;
}

export interface AssignmentTarget {
  providerAccount: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
  fallback?: Array<{ providerAccount: string; model: string }>;
}

export type SaveResult = { ok: true; state: ManagerState } | { ok: false; error: UiError };
export type DeleteResult =
  | SaveResult
  | { ok: false; blocked: true; referencingSlots: string[] };

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
  onBrowserOpen?(url: string): void;
  onWaiting?(): void;
  onPrompt?(prompt: { type: string; message: string }): Promise<string>;
}

/** Structural — the TUI/REPL Agent satisfies this without importing its type here. */
export interface SessionSwitcher {
  switchProvider(accountOrModel: string, model?: string): unknown;
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

// ── Purpose derivation (schema truth — R1/D15; the UI consumes, never re-lists) ──

const TIERED: Array<{ id: Extract<PurposeId, string>; label: string; requires: PurposeDef["requires"] }> = [
  { id: "plan", label: "Planning & reasoning", requires: ["toolUse"] },
  { id: "text", label: "Text (writing)", requires: ["toolUse", "streaming"] },
  { id: "coding", label: "Coding", requires: ["toolUse", "streaming"] },
  { id: "vision", label: "Vision analysis", requires: ["toolUse", "streaming", "vision"] },
  { id: "commit", label: "Commit messages", requires: ["toolUse"] },
];

const MEDIA: Array<{ id: PurposeId; label: string; requires: PurposeDef["requires"] }> = [
  { id: "media.image", label: "Image generation", requires: ["imageGenerate"] },
  { id: "media.speech", label: "Speech synthesis", requires: ["tts"] },
  { id: "media.transcription", label: "Transcription", requires: ["stt"] },
  { id: "media.video", label: "Video generation", requires: ["video"] },
];

export function derivePurposes(): PurposeDef[] {
  return [
    ...TIERED.map((p) => ({ ...p, tiered: true })),
    ...MEDIA.map((p) => ({ ...p, tiered: false })),
  ];
}

const PURPOSE_BY_ID = new Map(derivePurposes().map((p) => [p.id, p]));

// ── Error mapping (contract §5) ──────────────────────────────────────────────

function isConflictError(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return (
    e?.code === "PRECONDITION_FAILED" ||
    e?.code === "CONFLICT" ||
    (typeof e?.message === "string" && /(mismatch|stale)/i.test(e.message))
  );
}

export function mapError(err: unknown, retried = false): UiError {
  const e = err as { code?: string; message?: string; retryable?: boolean };
  const raw = typeof e?.message === "string" ? e.message : String(err);
  const message = redactString(raw);
  const code = e?.code;
  if (code === "PRECONDITION_FAILED" || code === "CONFLICT" || isConflictError(err)) {
    return {
      code: "conflict",
      message: retried
        ? "Configuration changed elsewhere. Latest state reloaded — review and retry."
        : "Configuration changed elsewhere.",
      hint: "The manager reloads the latest state automatically once.",
      retried,
    };
  }
  if (code === "unconfigured_provider") return { code: "unconfigured_provider", message };
  if (code === "unknown_model") return { code: "unknown_model", message };
  if (code === "unconfigured_purpose" || code === "unknown_purpose") {
    return {
      code: "unconfigured_purpose",
      message,
      hint: "Assign a model to this purpose slot first with setAssignment",
    };
  }
  if (code === "oauth_expired") return { code: "oauth_expired", message, hint: "Sign in again to re-authenticate." };
  if (code === "unsupported_capability" || code === "unsupported_thinking_level") {
    return { code, message, hint: "Select a model that supports this capability or thinking level." };
  }
  if (code === "blocked") return { code: "blocked", message };
  if (code === "account_not_found") return { code: "unconfigured_provider", message };
  if (code === "CONFIG_VIOLATION" || code === "invalid_request") {
    return { code: "validation_failed", message };
  }
  if (/credential|keychain|auth storage/i.test(raw)) {
    return { code: "credential_unavailable", message, hint: "The key was not saved; nothing was created." };
  }
  return { code: "storage_error", message };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function sanitizeBaseUrl(url: string): string {
  const redacted = redactUrlCredentials(url);
  try {
    const parsed = new URL(redacted);
    if (parsed.search) {
      for (const param of Array.from(parsed.searchParams.keys())) {
        if (isSensitiveKey(param) || /key|token|secret|auth|password/i.test(param)) {
          parsed.searchParams.set(param, "[REDACTED]");
        }
      }
      return parsed.toString();
    }
  } catch {}
  return redactString(redacted);
}

function capabilityLabel(req: PurposeDef["requires"][number]): string {
  switch (req) {
    case "imageGenerate": return "image generation";
    case "tts": return "speech synthesis";
    case "stt": return "transcription";
    case "video": return "video generation";
    case "vision": return "image understanding";
    default: return req;
  }
}

function closestIds(want: string, models: AvailableModel[], n = 3): string[] {
  const lower = want.toLowerCase();
  const scored = models
    .map((m) => {
      const id = m.id.toLowerCase();
      let score = 0;
      if (id.includes(lower)) score = 2;
      else {
        for (let i = 0; i < lower.length && i < id.length; i++) {
          if (lower[i] === id[i]) score += 0.1; else break;
        }
      }
      return { id: m.id, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, n).map((s) => s.id);
}

function slotKey(purpose: PurposeId, tier: Tier | null): string {
  return tier ? `${purpose}·${tier}` : purpose;
}

/** All slots (incl. fallback lists) referencing an account, as display keys. */
function referencingSlots(assignments: PurposeModelMap, accountId: string): string[] {
  const keys: string[] = [];
  const visit = (key: string, a: any): void => {
    if (!a || typeof a !== "object") return;
    if (a.providerAccount === accountId) keys.push(key);
    if (Array.isArray(a.fallback)) {
      for (const f of a.fallback) if (f?.providerAccount === accountId) keys.push(`${key} (fallback)`);
    }
  };
  for (const p of TIERED) {
    for (const tier of ["standard", "efficient", "complex"] as const) {
      visit(slotKey(p.id as PurposeId, tier), (assignments as any)?.[p.id]?.[tier]);
    }
  }
  const media = (assignments as any)?.media ?? {};
  for (const m of MEDIA) visit(m.id, media[m.id.slice("media.".length)]);
  return [...new Set(keys)];
}

// ── Implementation ───────────────────────────────────────────────────────────

export function createOAuthInteractionShim(callbacks: OAuthFlowCallbacks, signal: AbortSignal) {
  return {
    signal,
    openUrl: (url: string) => {
      callbacks.onBrowserOpen?.(url);
    },
    prompt: async (p: any) => {
      if (callbacks.onPrompt) {
        return callbacks.onPrompt(p);
      }
      if (p?.type === "select" && Array.isArray(p.options) && p.options.length > 0) {
        const first = p.options[0];
        return typeof first === "object" && first ? (first.value ?? first.id ?? first) : first;
      }
      if (
        p?.type === "manual_code" ||
        p?.type === "code" ||
        /code|auth_code|manual/i.test(p?.name ?? p?.id ?? "")
      ) {
        // Manual code prompt races with the local callback server in browser flows.
        // Never settle with empty string immediately as that cancels the callback wait!
        return new Promise<string>((_, reject) => {
          if (signal.aborted) {
            reject(new Error("OAuth aborted"));
            return;
          }
          signal.addEventListener("abort", () => reject(new Error("OAuth aborted")), { once: true });
        });
      }
      if (p?.default !== undefined && p?.default !== "") {
        return String(p.default);
      }
      return "";
    },
    notify: (event: any) => {
      if (event.type === "device_code") {
        callbacks.onDeviceCode?.({
          userCode: event.userCode,
          verificationUrl: event.verificationUri,
          expiresInMs: (event.expiresInSeconds ?? 600) * 1000,
        });
      } else if (event.type === "auth_url") {
        callbacks.onBrowserOpen?.(event.url);
      } else if (event.type === "progress") {
        callbacks.onWaiting?.();
      }
    },
  };
}

export function createProviderManagerApi(
  runtime: ProviderRuntime,
  sessionSwitcher?: SessionSwitcher,
): ProviderManagerApi {
  const store = () => runtime.getConfigStore();
  const creds = () => runtime.credentialStore;

  type MutationBuilder = (state: ManagerState) => Promise<Record<string, unknown> | { error: UiError }>;
  type MutationResult =
    | { ok: true; state: ManagerState }
    | { ok: false; error: UiError; attemptedWrite?: boolean; committed?: boolean };

  /** OCC mutate: read state → build & validate patch → write → retry once on conflict (B1 / R3). */
  async function occMutate(
    builder: MutationBuilder,
    expectedRevision?: number,
  ): Promise<MutationResult> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      let state: ManagerState;
      try {
        state = await getState();
      } catch (err) {
        return { ok: false, error: mapError(err), attemptedWrite: false, committed: false };
      }
      if (expectedRevision !== undefined && state.revision !== expectedRevision) {
        return {
          ok: false,
          error: {
            code: "conflict",
            message: `Optimistic concurrency violation: expected revision ${expectedRevision}, but current revision is ${state.revision}.`,
          },
          attemptedWrite: false,
          committed: false,
        };
      }
      let built: Record<string, unknown> | { error: UiError };
      try {
        built = await builder(state);
      } catch (err) {
        return { ok: false, error: mapError(err), attemptedWrite: false, committed: false };
      }
      if ("error" in built) {
        return { ok: false, error: built.error as UiError, attemptedWrite: false, committed: false };
      }
      try {
        await store().updateOverlay(built as any, state.revision);
      } catch (err) {
        lastErr = err;
        if (isConflictError(err) && attempt === 0 && expectedRevision === undefined) {
          continue;
        }
        return { ok: false, error: mapError(err, attempt > 0), attemptedWrite: true, committed: false };
      }
      try {
        return { ok: true, state: await getState() };
      } catch (err) {
        return { ok: false, error: mapError(err), attemptedWrite: true, committed: true };
      }
    }
    return { ok: false, error: mapError(lastErr, true), attemptedWrite: true, committed: false };
  }

  async function healthFor(
    ref: CredentialRef,
  ): Promise<{ health: AccountHealth; credentialKind: CredentialKind }> {
    if (ref.kind === "none" || ref.kind === "externalsecret") {
      return { health: "unverified", credentialKind: ref.kind };
    }
    try {
      if (ref.kind === "seepient" || ref.kind === "keychain") {
        const id = ref.kind === "seepient" ? ref.id : ref.account;
        const raw = creds().getRecord ? await creds().getRecord!(id).catch(() => undefined) : undefined;
        const rec = await creds().get(id).catch(() => undefined);
        const isOAuth = raw?.kind === "oauth" || rec?.materialKind === "oauth";
        const handle = await creds().resolve(ref);
        const resolvable = await handle.isResolvable();
        if (!resolvable) {
          return { health: "missing", credentialKind: isOAuth ? "oauth" : ref.kind };
        }
        if (isOAuth) {
          if (raw && raw.kind === "oauth" && raw.expires && raw.expires < Date.now()) {
            return { health: "expired", credentialKind: "oauth" };
          }
          return { health: "ok", credentialKind: "oauth" };
        }
        return { health: "ok", credentialKind: ref.kind };
      }
      const handle = await creds().resolve(ref);
      return {
        health: (await handle.isResolvable()) ? "ok" : "missing",
        credentialKind: ref.kind,
      };
    } catch {
      return { health: "missing", credentialKind: ref.kind };
    }
  }

  async function getState(): Promise<ManagerState> {
    const snapshot = await runtime.createTurnSnapshot();
    const config = snapshot.config;
    // Reachability comes from the runtime's catalog instance — never a fresh
    // ModelCatalog (its discovery cache would be empty) and never snapshot.catalog
    // (no reachableVia). Scrutinize F1 rule.
    const models = await runtime.modelCatalog.listAvailableModels(config);
    const accounts: AccountView[] = [];
    for (const [id, entry] of Object.entries(config.providers ?? {})) {
      const ref = (entry.credential as CredentialRef) ?? { kind: "none" };
      const h = await healthFor(ref);
      accounts.push({
        id,
        upstreamProvider: entry.upstreamProvider,
        ...(entry.baseUrl ? { baseUrl: sanitizeBaseUrl(entry.baseUrl) } : {}),
        credentialKind: h.credentialKind,
        ...(ref?.kind === "env" ? { credentialDetail: ref.name } : {}),
        health: h.health,
        modelCount: models.filter((m) => m.reachableVia.includes(id)).length,
      });
    }
    return {
      revision: snapshot.revision,
      accounts,
      assignments: (snapshot.assignments ?? {}) as PurposeModelMap,
      models,
      purposes: derivePurposes(),
    };
  }

  async function saveAccount(input: AccountInput, expectedRevision?: number): Promise<SaveResult> {
    if (input.baseUrl) {
      if (input.baseUrl.includes("[REDACTED]")) {
        return {
          ok: false,
          error: { code: "validation_failed", message: "Cannot save redacted baseUrl into configuration." },
        };
      }
      const check = await validateEndpointUrl(input.baseUrl, {
        ssrfAllowPrivate: input.allowPrivate === true,
      });
      if (!check.valid) {
        return {
          ok: false,
          error: { code: "invalid_endpoint", message: check.error ?? "Endpoint URL rejected." },
        };
      }
    }

    const snapshot = await runtime.createTurnSnapshot();
    const existingEntry = snapshot.config.providers?.[input.accountId];
    const preExisting = await creds().get(input.accountId).catch(() => undefined);

    if (input.credential.mode === "paste" && (!input.credential.keyValue || input.credential.keyValue.trim() === "")) {
      return {
        ok: false,
        error: { code: "validation_failed", message: "API key cannot be empty." },
      };
    }

    if (input.credential.mode === "env" && (!input.credential.varName || input.credential.varName.trim() === "")) {
      return {
        ok: false,
        error: { code: "validation_failed", message: "Environment variable name cannot be empty." },
      };
    }

    let ref: CredentialRef;
    if (input.credential.mode === "paste") {
      ref = { kind: "seepient", id: input.accountId };
      try {
        await creds().put(
          input.accountId,
          { kind: "api_key", keyValue: input.credential.keyValue! },
          { source: "disk", description: `Configured via seepient manager` },
        );
      } catch (err) {
        return { ok: false, error: mapError(err) };
      }
    } else if (input.credential.mode === "env") {
      ref = { kind: "env", name: input.credential.varName };
    } else if (input.credential.mode === "none") {
      ref = { kind: "none" };
    } else if (input.credential.mode === "preserve") {
      const resolvedRef =
        (existingEntry?.credential as CredentialRef) ??
        (preExisting ? { kind: "seepient", id: input.accountId } : undefined);
      if (!resolvedRef) {
        return {
          ok: false,
          error: {
            code: "validation_failed",
            message: `Cannot preserve credential: no existing entry for "${input.accountId}".`,
          },
        };
      }
      ref = resolvedRef;
    } else {
      return {
        ok: false,
        error: { code: "validation_failed", message: `Unknown credential mode.` },
      };
    }

    const entry: ProviderEntryPatch = {
      adapter: "pi-ai",
      upstreamProvider: input.upstreamProvider,
      credential: ref,
      baseUrl: input.baseUrl ? input.baseUrl : (existingEntry?.baseUrl ? null : undefined),
      compat: input.compat ? input.compat : (existingEntry?.compat ? null : undefined),
      ssrfAllowPrivate: input.allowPrivate ? true : (existingEntry?.ssrfAllowPrivate ? null : undefined),
    };

    const res = await occMutate(async () => {
      return { providers: { [input.accountId]: entry } };
    }, expectedRevision);

    if (!res.ok) {
      // Roll back a credential we just created (R4): never leave an orphan.
      // Skip rollback when overlay write committed (res.committed === true) or when no write was attempted
      // so client retry with fresh revision succeeds without re-pasting.
      if (input.credential.mode === "paste" && !preExisting && !res.committed && (res as any).attemptedWrite !== false) {
        try {
          await creds().delete(input.accountId);
        } catch (rollbackErr: any) {
          return {
            ok: false,
            error: {
              code: "storage_error",
              message: `Failed to save account "${input.accountId}" to config overlay. Cleanup error: ${redactString(rollbackErr?.message)}`,
            },
          };
        }
      }
    }
    return res;
  }

  async function deleteAccount(
    accountId: string,
    opts?: { force?: boolean; expectedRevision?: number },
  ): Promise<DeleteResult> {
    let capturedEntry: ProviderEntry | undefined;

    const res = await occMutate(async () => {
      const snapshot = await runtime.createTurnSnapshot();
      const entry = snapshot.config.providers?.[accountId];
      if (!entry) {
        return { error: { code: "unconfigured_provider", message: `Account "${accountId}" not found.` } };
      }
      const slots = referencingSlots(snapshot.assignments ?? ({} as PurposeModelMap), accountId);
      if (slots.length > 0 && !opts?.force) {
        return { error: { code: "blocked", message: "Account is referenced by slots.", referencingSlots: slots } as any };
      }
      capturedEntry = entry;
      return { providers: { [accountId]: null } };
    }, opts?.expectedRevision);

    if (!res.ok) {
      if ((res.error as any).referencingSlots) {
        return { ok: false, blocked: true, referencingSlots: (res.error as any).referencingSlots };
      }
      return res;
    }

    if (capturedEntry?.credential?.kind === "seepient") {
      const credId = (capturedEntry.credential as any).id ?? accountId;
      const snapshot = await runtime.createTurnSnapshot();
      const otherShares = Object.entries(snapshot.config.providers ?? {}).some(
        ([id, p]) =>
          id !== accountId &&
          p.credential?.kind === "seepient" &&
          (p.credential as any).id === credId,
      );
      if (!otherShares) {
        try {
          await creds().delete(credId);
        } catch (credErr: any) {
          console.warn(`[ProviderManagerApi] Failed to delete credential "${credId}" for "${accountId}": ${credErr?.message}`);
        }
      }
    }
    return res;
  }

  async function setAssignment(
    purpose: PurposeId,
    tier: Tier | null,
    target: AssignmentTarget,
    expectedRevision?: number,
  ): Promise<SaveResult> {
    const def = PURPOSE_BY_ID.get(purpose);
    if (!def) {
      return { ok: false, error: { code: "validation_failed", message: `Unknown purpose "${purpose}".` } };
    }
    if (def.tiered !== (tier !== null)) {
      return {
        ok: false,
        error: {
          code: "validation_failed",
          message: def.tiered
            ? `Purpose "${purpose}" requires a tier (efficient/standard/complex).`
            : `Purpose "${purpose}" is a single slot — no tier.`,
        },
      };
    }

    return occMutate(async (state) => {
      const account = state.accounts.find((a) => a.id === target.providerAccount);
      if (!account) {
        return {
          error: { code: "validation_failed", message: `Account "${target.providerAccount}" is not configured.` },
        };
      }
      const model = state.models.find(
        (m) => m.id === target.model && m.reachableVia.includes(target.providerAccount),
      );
      if (!model) {
        const anywhere = state.models.find((m) => m.id === target.model);
        const suggestions = closestIds(target.model, state.models);
        return {
          error: {
            code: "unknown_model",
            message: anywhere
              ? `Model "${target.model}" exists but is not reachable via account "${target.providerAccount}".`
              : `Model "${target.model}" is not in the catalog. Closest: ${suggestions.join(", ")}.`,
          },
        };
      }
      for (const req of def.requires) {
        if (!model.capabilities[req]) {
          return {
            error: {
              code: "validation_failed",
              message: `Purpose "${def.label.toLowerCase()}" requires ${capabilityLabel(req)}, which ${model.id} does not provide.`,
            },
          };
        }
      }
      const levels = model.supportedReasoningLevels ?? ["none"];
      if (target.thinkingLevel && !levels.includes(target.thinkingLevel)) {
        return {
          error: {
            code: "validation_failed",
            message: `Thinking level "${target.thinkingLevel}" is not supported by ${model.id}. Supported: ${levels.join(", ")}.`,
          },
        };
      }

      if (Array.isArray(target.fallback)) {
        for (const fb of target.fallback) {
          if (!fb || typeof fb !== "object") continue;
          const fbAcct = state.accounts.find((a) => a.id === fb.providerAccount);
          if (!fbAcct) {
            return {
              error: {
                code: "validation_failed",
                message: `Fallback account "${fb.providerAccount}" is not configured.`,
              },
            };
          }
          const fbModel = state.models.find(
            (m) => m.id === fb.model && m.reachableVia.includes(fb.providerAccount),
          );
          if (!fbModel) {
            const anywhere = state.models.find((m) => m.id === fb.model);
            const suggestions = closestIds(fb.model, state.models);
            return {
              error: {
                code: "unknown_model",
                message: anywhere
                  ? `Fallback model "${fb.model}" exists but is not reachable via account "${fb.providerAccount}".`
                  : `Fallback model "${fb.model}" is not in the catalog. Closest: ${suggestions.join(", ")}.`,
              },
            };
          }
        }
      }

      const value = {
        providerAccount: target.providerAccount,
        model: target.model,
        ...(target.thinkingLevel ? { thinkingLevel: target.thinkingLevel } : {}),
        ...(target.fallback && target.fallback.length > 0 ? { fallback: target.fallback } : {}),
      };
      return def.tiered
        ? { modelAssignments: { [purpose]: { [tier as Tier]: value } } }
        : { modelAssignments: { media: { [purpose.slice("media.".length)]: value } } };
    }, expectedRevision);
  }

  async function clearAssignment(
    purpose: PurposeId,
    tier: Tier | null,
    expectedRevision?: number,
  ): Promise<SaveResult> {
    const def = PURPOSE_BY_ID.get(purpose);
    if (!def) return { ok: false, error: { code: "validation_failed", message: `Unknown purpose "${purpose}".` } };
    return occMutate(async () => {
      return def.tiered
        ? { modelAssignments: { [purpose]: { [tier as Tier]: null } } }
        : { modelAssignments: { media: { [purpose.slice("media.".length)]: null } } };
    }, expectedRevision);
  }

  async function resolvePreview(
    purpose: PurposeId,
    tier: Tier = "standard",
    override?: { providerAccount?: string; model?: string; thinkingLevel?: ThinkingLevel },
  ): Promise<ResolutionPreview | (UiError & { ok: false })> {
    try {
      const snapshot = await runtime.createTurnSnapshot();
      let resolverPurpose: string = purpose;
      if (purpose === "media.image") resolverPurpose = "image-generation";
      else if (purpose === "media.speech") resolverPurpose = "tts";
      else if (purpose === "media.transcription") resolverPurpose = "stt";
      else if (purpose === "media.video") resolverPurpose = "video-generation";

      const plan = await runtime.resolvePlan(snapshot, resolverPurpose as any, tier as any, override);
      const def = PURPOSE_BY_ID.get(purpose);
      const assignments = snapshot.assignments as any;
      const direct = override?.model
        ? true
        : def?.tiered
          ? assignments?.[purpose]?.[tier]
          : assignments?.media?.[purpose.slice("media.".length)];
      return {
        selectedTarget: {
          providerAccount: plan.selectedTarget.providerAccount,
          model: plan.selectedTarget.model,
          ...(plan.selectedTarget.thinkingLevel ? { thinkingLevel: plan.selectedTarget.thinkingLevel } : {}),
        },
        via: direct ? "requested" : "fallback-chain",
        failureTargets: (plan.failureTargets ?? []).map((t: any) => ({
          providerAccount: t.providerAccount,
          model: t.model,
        })),
      };
    } catch (err) {
      return { ok: false, ...mapError(err) };
    }
  }

  async function probeAccount(accountId: string): Promise<ProbeResult> {
    const snapshot = await runtime.createTurnSnapshot();
    const entry = snapshot.config.providers?.[accountId];
    if (!entry) {
      return { accountId, authValid: false, error: { code: "unconfigured_provider", message: `Account "${accountId}" not found.` } };
    }
    let authValid = false;
    try {
      const handle = await creds().resolve(entry.credential as CredentialRef);
      authValid = await handle.isResolvable();
    } catch {
      authValid = false;
    }
    let reachable: boolean | undefined;
    if (entry.baseUrl) {
      const check = await validateEndpointUrl(entry.baseUrl, { ssrfAllowPrivate: entry.ssrfAllowPrivate === true });
      reachable = check.valid;
    }
    return { accountId, authValid, ...(reachable !== undefined ? { reachable } : {}) };
  }

  async function refreshModels(accountId: string): Promise<RefreshResult> {
    try {
      const discovered = await runtime.refreshModels(accountId);
      return { ok: true, discovered, state: await getState() };
    } catch (err) {
      return { ok: false, error: mapError(err) };
    }
  }

  function switchSessionModel(accountId: string, modelId: string): void {
    if (!sessionSwitcher) {
      throw new SeepientError(
        "Session switching is unavailable here (no active conversation).",
        "SESSION_SWITCH_UNAVAILABLE",
        false,
      );
    }
    sessionSwitcher.switchProvider(accountId, modelId);
  }

  async function signInWithProvider(
    upstream: string,
    callbacks: OAuthFlowCallbacks,
  ): Promise<SaveResult> {
    const { getOAuthFlow, isOAuthSupported } = await import(
      "../../domain/providers/oauth-service.js"
    );
    if (!isOAuthSupported(upstream)) {
      return {
        ok: false,
        error: {
          code: "oauth_flow_failed",
          message: `OAuth sign-in is not supported for "${upstream}".`,
        },
      };
    }

    const isHeadless =
      !process.stdin.isTTY &&
      !callbacks.onPrompt &&
      !callbacks.onDeviceCode &&
      !callbacks.onBrowserOpen;
    if (isHeadless) {
      return {
        ok: false,
        error: {
          code: "oauth_flow_failed",
          message: `OAuth sign-in requires an interactive terminal. Configure ${upstream.toUpperCase()}_API_KEY or use --key.`,
        },
      };
    }

    const flow = await getOAuthFlow(upstream);
    if (!flow) {
      return {
        ok: false,
        error: {
          code: "oauth_flow_failed",
          message: `Could not load OAuth flow for "${upstream}".`,
        },
      };
    }

    const abortController = callbacks.signal ? undefined : new AbortController();
    const signal = callbacks.signal ?? abortController!.signal;
    const interaction = createOAuthInteractionShim(callbacks, signal);

    let credResult: any;
    try {
      credResult = await flow.login(interaction as any);
    } catch (err: any) {
      if (signal.aborted) {
        return {
          ok: false,
          error: {
            code: "oauth_flow_failed",
            message: "OAuth sign-in was cancelled.",
          },
        };
      }
      const msg = typeof err?.message === "string" ? err.message : String(err);
      return {
        ok: false,
        error: {
          code: "oauth_flow_failed",
          message: redactString(msg),
        },
      };
    }

    if (signal.aborted) {
      return {
        ok: false,
        error: {
          code: "oauth_flow_failed",
          message: "OAuth sign-in was cancelled.",
        },
      };
    }

    if (!credResult || credResult.type !== "oauth" || !credResult.access) {
      return {
        ok: false,
        error: {
          code: "oauth_flow_failed",
          message: "OAuth flow did not return valid credentials.",
        },
      };
    }

    return completeOAuthSignIn(
      upstream,
      {
        access: credResult.access,
        refresh: credResult.refresh,
        expires: credResult.expires,
      },
      {
        preferredAccountId: callbacks.preferredAccountId,
        description: flow.name,
      },
    );
  }

  async function completeOAuthSignIn(
    upstream: string,
    credentials: { access: string; refresh?: string; expires?: number },
    opts?: { preferredAccountId?: string; description?: string },
  ): Promise<SaveResult> {
    if (!credentials || !credentials.access) {
      return {
        ok: false,
        error: {
          code: "oauth_flow_failed",
          message: "OAuth authorization did not return valid tokens.",
        },
      };
    }

    const canonicalUpstream = getCanonicalOAuthFlowId(upstream);
    let existingAccounts: string[] = [];
    try {
      const snapshot = await runtime.createTurnSnapshot();
      existingAccounts = Object.keys(snapshot.config.providers ?? {});
    } catch (err: any) {
      return { ok: false, error: mapError(err) };
    }

    let accountId = opts?.preferredAccountId?.trim() || upstream;
    if (opts?.preferredAccountId && existingAccounts.includes(accountId)) {
      console.warn(`[notice] Overwriting existing provider account "${accountId}" with new OAuth login.`);
    } else if (!opts?.preferredAccountId) {
      let seq = 2;
      while (existingAccounts.includes(accountId)) {
        accountId = `${upstream}-${seq++}`;
      }
    }

    const preExistingCred = await creds().get(accountId).catch(() => undefined);

    // Persist OAuth credential in credential store (keychain-first/primary store)
    try {
      await creds().put(
        accountId,
        {
          kind: "oauth",
          access: credentials.access,
          refresh: credentials.refresh ?? "",
          expires: credentials.expires ?? Date.now() + 3600_000,
        },
        {
          source: "keychain",
          description: opts?.description ?? `OAuth login for ${upstream}`,
          providerAccountHint: canonicalUpstream,
        },
      );
    } catch (err: any) {
      return {
        ok: false,
        error: {
          code: "credential_unavailable",
          message: `Failed to persist OAuth tokens: ${redactString(err?.message ?? "")}`,
        },
      };
    }

    // Add account to overlay with required adapter and upstreamProvider fields
    const saveRes = await occMutate(async () => ({
      providers: {
        [accountId]: {
          adapter: "pi-ai",
          upstreamProvider: canonicalUpstream,
          credential: { kind: "seepient", id: accountId },
        },
      },
    }));

    if (!saveRes.ok) {
      if (!preExistingCred) {
        try {
          await creds().delete(accountId);
        } catch {}
      }
      if (!existingAccounts.includes(accountId)) {
        try {
          await occMutate(async () => ({
            providers: { [accountId]: null },
          }));
        } catch {}
      }
      return saveRes;
    }

    return { ok: true, state: await getState() };
  }

  async function logoutAccount(accountId: string): Promise<SaveResult> {
    const snapshot = await runtime.createTurnSnapshot();
    const entry = snapshot.config.providers?.[accountId];
    if (!entry) {
      return {
        ok: false,
        error: {
          code: "unconfigured_provider",
          message: `Account "${accountId}" not found.`,
        },
      };
    }
    if (entry.credential?.kind === "seepient") {
      const seepId = (entry.credential as any).id;
      const rec = typeof creds().get === "function" ? await creds().get(seepId) : undefined;
      const otherShares = Object.entries(snapshot.config.providers ?? {}).some(
        ([id, p]) =>
          id !== accountId &&
          p.credential?.kind === "seepient" &&
          (p.credential as any).id === seepId,
      );
      if (rec?.materialKind === "oauth" && !otherShares) {
        try {
          await creds().delete(seepId);
        } catch (err: any) {
          return { ok: false, error: mapError(err) };
        }
      }
    }
    return { ok: true, state: await getState() };
  }

  async function getAvailableOAuthFlows(): Promise<readonly string[]> {
    const { AVAILABLE_OAUTH_FLOWS } = await import(
      "../../domain/providers/oauth-service.js"
    );
    return AVAILABLE_OAUTH_FLOWS;
  }

  return {
    getState,
    saveAccount,
    deleteAccount,
    setAssignment,
    clearAssignment,
    resolvePreview,
    probeAccount,
    refreshModels,
    switchSessionModel,
    signInWithProvider,
    completeOAuthSignIn,
    logoutAccount,
    getAvailableOAuthFlows,
  };
}
