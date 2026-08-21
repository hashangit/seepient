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
  ProviderEntryPatch,
} from "../../foundations/schemas/provider-config.js";
import type { ThinkingLevel } from "../../foundations/schemas/inference.js";
import { redactString, redactUrlCredentials } from "../../foundations/security/redact.js";
import { SeepientError } from "../../foundations/errors.js";
import { validateEndpointUrl } from "../http/ssrf-validator.js";

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
  saveAccount(input: AccountInput): Promise<SaveResult>;
  deleteAccount(accountId: string, opts?: { force?: boolean }): Promise<DeleteResult>;
  setAssignment(purpose: PurposeId, tier: Tier | null, target: AssignmentTarget): Promise<SaveResult>;
  clearAssignment(purpose: PurposeId, tier: Tier | null): Promise<SaveResult>;
  resolvePreview(purpose: PurposeId, tier?: Tier): Promise<ResolutionPreview | UiError & { ok: false }>;
  probeAccount(accountId: string): Promise<ProbeResult>;
  refreshModels(accountId: string): Promise<RefreshResult>;
  switchSessionModel(accountId: string, modelId: string): void;
  signInWithProvider(upstream: string, callbacks: OAuthFlowCallbacks): Promise<SaveResult>;
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

function mapError(err: unknown, retried = false): UiError {
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
  if (code === "CONFIG_VIOLATION" || code === "invalid_request") {
    return { code: "validation_failed", message };
  }
  if (/credential|keychain|auth storage/i.test(raw)) {
    return { code: "credential_unavailable", message, hint: "The key was not saved; nothing was created." };
  }
  return { code: "storage_error", message };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sanitizeBaseUrl(url: string): string {
  return redactUrlCredentials(url);
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

export function createProviderManagerApi(
  runtime: ProviderRuntime,
  sessionSwitcher?: SessionSwitcher,
): ProviderManagerApi {
  const store = () => runtime.getConfigStore();
  const creds = () => runtime.credentialStore;

  /** OCC write: read revision → mutate → retry once on conflict (R3). */
  async function occWrite(patch: Record<string, unknown>): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const overlay = await store().getOverlay();
      try {
        await store().updateOverlay(patch as any, overlay.revision);
        return;
      } catch (err) {
        lastErr = err;
        if (isConflictError(err) && attempt === 0) continue;
        throw mapError(err, attempt > 0);
      }
    }
    throw mapError(lastErr, true);
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
        if (!resolvable && !raw) {
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

  async function saveAccount(input: AccountInput): Promise<SaveResult> {
    if (input.baseUrl) {
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
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      ...(input.compat ? { compat: input.compat } : {}),
      ...(input.allowPrivate ? { ssrfAllowPrivate: true } : {}),
    };

    try {
      await occWrite({ providers: { [input.accountId]: entry } });
    } catch (err) {
      // Roll back a credential we just created (R4): never leave an orphan.
      if (input.credential.mode === "paste" && !preExisting) {
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
      const mapped = err as UiError;
      return { ok: false, error: mapped };
    }
    return { ok: true, state: await getState() };
  }

  async function deleteAccount(accountId: string, opts?: { force?: boolean }): Promise<DeleteResult> {
    const snapshot = await runtime.createTurnSnapshot();
    const entry = snapshot.config.providers?.[accountId];
    if (!entry) {
      return { ok: false, error: { code: "unconfigured_provider", message: `Account "${accountId}" not found.` } };
    }
    const slots = referencingSlots(snapshot.assignments ?? ({} as PurposeModelMap), accountId);
    if (slots.length > 0 && !opts?.force) {
      return { ok: false, blocked: true, referencingSlots: slots };
    }
    try {
      await occWrite({ providers: { [accountId]: null } });
    } catch (err) {
      return { ok: false, error: err as UiError };
    }
    if (entry.credential?.kind === "seepient") {
      const seepId = (entry.credential as any).id;
      const otherShares = Object.entries(snapshot.config.providers ?? {}).some(
        ([id, p]) =>
          id !== accountId &&
          p.credential?.kind === "seepient" &&
          (p.credential as any).id === seepId,
      );
      if (!otherShares) {
        try {
          await creds().delete(seepId);
        } catch (credErr: any) {
          console.warn(
            `[ProviderManagerApi] Failed to delete credential for "${accountId}": ${credErr?.message}`,
          );
        }
      }
    }
    return { ok: true, state: await getState() };
  }

  async function setAssignment(
    purpose: PurposeId,
    tier: Tier | null,
    target: AssignmentTarget,
  ): Promise<SaveResult> {
    const state = await getState();
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
    const account = state.accounts.find((a) => a.id === target.providerAccount);
    if (!account) {
      return {
        ok: false,
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
        ok: false,
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
          ok: false,
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
        ok: false,
        error: {
          code: "validation_failed",
          message: `Thinking level "${target.thinkingLevel}" is not supported by ${model.id}. Supported: ${levels.join(", ")}.`,
        },
      };
    }

    const value = {
      providerAccount: target.providerAccount,
      model: target.model,
      ...(target.thinkingLevel ? { thinkingLevel: target.thinkingLevel } : {}),
      ...(target.fallback && target.fallback.length > 0 ? { fallback: target.fallback } : {}),
    };
    const patch =
      def.tiered
        ? { modelAssignments: { [purpose]: { [tier as Tier]: value } } }
        : { modelAssignments: { media: { [purpose.slice("media.".length)]: value } } };
    try {
      await occWrite(patch);
    } catch (err) {
      return { ok: false, error: err as UiError };
    }
    return { ok: true, state: await getState() };
  }

  async function clearAssignment(purpose: PurposeId, tier: Tier | null): Promise<SaveResult> {
    const def = PURPOSE_BY_ID.get(purpose);
    if (!def) return { ok: false, error: { code: "validation_failed", message: `Unknown purpose "${purpose}".` } };
    const patch =
      def.tiered
        ? { modelAssignments: { [purpose]: { [tier as Tier]: null } } }
        : { modelAssignments: { media: { [purpose.slice("media.".length)]: null } } };
    try {
      await occWrite(patch);
    } catch (err) {
      return { ok: false, error: err as UiError };
    }
    return { ok: true, state: await getState() };
  }

  async function resolvePreview(
    purpose: PurposeId,
    tier: Tier = "standard",
  ): Promise<ResolutionPreview | UiError & { ok: false }> {
    try {
      const snapshot = await runtime.createTurnSnapshot();
      let resolverPurpose: string = purpose;
      if (purpose === "media.image") resolverPurpose = "image-generation";
      else if (purpose === "media.speech") resolverPurpose = "tts";
      else if (purpose === "media.transcription") resolverPurpose = "stt";
      else if (purpose === "media.video") resolverPurpose = "video-generation";

      const plan = await runtime.resolvePlan(snapshot, resolverPurpose as any, tier as any);
      const def = PURPOSE_BY_ID.get(purpose);
      const assignments = snapshot.assignments as any;
      const direct = def?.tiered ? assignments?.[purpose]?.[tier] : assignments?.media?.[purpose.slice("media.".length)];
      return {
        selectedTarget: {
          providerAccount: plan.selectedTarget.providerAccount,
          model: plan.selectedTarget.model,
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
    const interaction = {
      signal,
      prompt: async (p: any) => {
        if (callbacks.onPrompt) {
          return callbacks.onPrompt(p);
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

    // Determine accountId
    const snapshot = await runtime.createTurnSnapshot();
    const existingAccounts = Object.keys(snapshot.config.providers ?? {});
    let accountId = upstream;
    let seq = 2;
    while (existingAccounts.includes(accountId)) {
      accountId = `${upstream}-${seq++}`;
    }

    // Persist OAuth credential in credential store (keychain-first/primary store)
    try {
      await creds().put(
        accountId,
        {
          kind: "oauth",
          access: credResult.access,
          refresh: credResult.refresh ?? "",
          expires: credResult.expires ?? Date.now() + 3600_000,
        },
        { source: "keychain", description: flow.name },
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

    // Add account to overlay
    const entry: ProviderEntryPatch = {
      adapter: "pi-ai",
      upstreamProvider: upstream,
      credential: { kind: "seepient", id: accountId },
    };

    try {
      await occWrite({ providers: { [accountId]: entry } });
    } catch (err) {
      // Rollback credential on overlay failure (R4)
      try {
        await creds().delete(accountId);
      } catch (rollbackErr: any) {
        return {
          ok: false,
          error: {
            code: "storage_error",
            message: `Failed to save account "${accountId}" to config overlay. Cleanup error: ${redactString(rollbackErr?.message)}`,
          },
        };
      }
      return { ok: false, error: err as UiError };
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
          code: "account_not_found",
          message: `Account "${accountId}" not found.`,
        },
      };
    }
    if (entry.credential?.kind === "seepient") {
      const seepId = (entry.credential as any).id;
      const otherShares = Object.entries(snapshot.config.providers ?? {}).some(
        ([id, p]) =>
          id !== accountId &&
          p.credential?.kind === "seepient" &&
          (p.credential as any).id === seepId,
      );
      if (!otherShares) {
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
    logoutAccount,
    getAvailableOAuthFlows,
    ...( { mapErrorForTest: mapError } as any),
  };
}
