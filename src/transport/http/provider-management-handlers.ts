/**
 * REST Handlers for Provider Management v2 API
 *
 * Implements endpoints defined in `contracts/server-management-api.md`.
 */

import type { IncomingMessage, ServerResponse } from "http";
import type { ProviderRuntime } from "../../domain/providers/provider-runtime.js";
import type { ApiKeyEntry } from "../auth/auth.js";
import { hasScope } from "../auth/auth.js";
import { validateEndpointUrl } from "./ssrf-validator.js";
import { redactUrlCredentials, redactString } from "../../foundations/security/redact.js";
import { createOAuthInteractionShim, createProviderManagerApi, sanitizeBaseUrl } from "../cli/provider-manager-api.js";

function sendJSON(res: ServerResponse, status: number, body: unknown, revision?: number): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  if (revision !== undefined) {
    res.setHeader("ETag", `"${revision}"`);
  }
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJSON(res, status, { error: { code, message } });
}

async function parseBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        req.destroy();
        reject(new Error("PAYLOAD_TOO_LARGE"));
        return;
      }
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function checkDeploymentMode(res: ServerResponse): boolean {
  if (process.env.SEEPIENT_DEPLOYMENT_MODE === "multiprocess") {
    sendError(res, 503, "SERVICE_UNAVAILABLE", "Mutations are not supported in multi-process deployment mode in v1");
    return false;
  }
  return true;
}

function isConflictError(err: any): boolean {
  return (
    err?.code === "CONFLICT" ||
    err?.code === "PRECONDITION_FAILED" ||
    err?.message?.includes("mismatch") ||
    err?.message?.includes("stale")
  );
}

async function parseIfMatch(
  req: IncomingMessage,
  res: ServerResponse,
  runtime?: ProviderRuntime,
): Promise<number | null> {
  const ifMatch = req.headers["if-match"];
  if (!ifMatch) {
    sendError(res, 428, "PRECONDITION_REQUIRED", "Header 'If-Match: <revision>' is required for mutations");
    return null;
  }
  if (ifMatch === "*") {
    if (runtime) {
      const overlay = await runtime.configStore.getOverlay();
      return overlay.revision;
    }
    return 0;
  }
  const clean = ifMatch.replace(/^"|"$/g, "");
  const rev = parseInt(clean, 10);
  if (isNaN(rev)) {
    sendError(res, 400, "BAD_REQUEST", "Invalid If-Match header value (must be an integer revision or '*')");
    return null;
  }
  return rev;
}

export async function handleGetProviderRuntime(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: ProviderRuntime,
  key: ApiKeyEntry,
): Promise<void> {
  if (!hasScope(key, "provider:read")) {
    sendError(res, 403, "FORBIDDEN", "API key lacks 'provider:read' scope");
    return;
  }

  const snapshot = await runtime.createTurnSnapshot();
  sendJSON(
    res,
    200,
    {
      revision: snapshot.revision,
      updatedAt: new Date().toISOString(),
      health: {},
      sources: {
        compiledDefault: true,
        overlay: true,
      },
    },
    snapshot.revision,
  );
}

export async function handleGetAssignments(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: ProviderRuntime,
  key: ApiKeyEntry,
  purpose?: string,
  tier?: string,
): Promise<void> {
  if (!hasScope(key, "provider:read")) {
    sendError(res, 403, "FORBIDDEN", "API key lacks 'provider:read' scope");
    return;
  }

  const snapshot = await runtime.createTurnSnapshot();
  const assignments = snapshot.assignments;

  if (!purpose) {
    sendJSON(res, 200, assignments);
    return;
  }

  let purposeEntry = (assignments as any)[purpose];
  if (!purposeEntry && purpose.includes(".")) {
    const [pGroup, pSub] = purpose.split(".");
    purposeEntry = (assignments as any)[pGroup]?.[pSub];
  }
  if (!purposeEntry) {
    sendError(res, 404, "NOT_FOUND", `Purpose "${purpose}" not found`);
    return;
  }

  if (!tier) {
    sendJSON(res, 200, purposeEntry);
    return;
  }

  const tierEntry = purposeEntry[tier];
  if (!tierEntry) {
    sendError(res, 404, "NOT_FOUND", `Tier "${tier}" for purpose "${purpose}" not found`);
    return;
  }

  sendJSON(res, 200, tierEntry);
}

export async function handlePutAssignment(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: ProviderRuntime,
  key: ApiKeyEntry,
  purpose: string,
  tier: string,
): Promise<void> {
  if (!checkDeploymentMode(res)) return;
  if (!hasScope(key, "provider:admin")) {
    sendError(res, 403, "FORBIDDEN", "API key lacks 'provider:admin' scope");
    return;
  }

  const expectedRev = await parseIfMatch(req, res, runtime);
  if (expectedRev === null) return;

  let bodyText: string;
  try {
    bodyText = await parseBody(req);
  } catch {
    sendError(res, 400, "BAD_REQUEST", "Failed to read request body");
    return;
  }

  let body: any;
  try {
    body = JSON.parse(bodyText);
  } catch {
    sendError(res, 400, "BAD_REQUEST", "Invalid JSON in request body");
    return;
  }

  const { createProviderManagerApi } = await import("../cli/provider-manager-api.js");
  const api = createProviderManagerApi(runtime);
  const saveRes = await api.setAssignment(purpose as any, tier ? (tier as any) : null, body, expectedRev);
  if (!saveRes.ok) {
    if (saveRes.error.code === "conflict") {
      const snap = await runtime.createTurnSnapshot();
      sendJSON(res, 409, { error: { code: "CONFLICT", message: saveRes.error.message }, revision: snap.revision }, snap.revision);
      return;
    }
    sendError(res, 400, saveRes.error.code.toUpperCase(), saveRes.error.message);
    return;
  }
  sendJSON(res, 200, { revision: saveRes.state.revision, assignment: body }, saveRes.state.revision);
}

export async function handleDeleteAssignment(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: ProviderRuntime,
  key: ApiKeyEntry,
  purpose: string,
  tier: string,
): Promise<void> {
  if (!checkDeploymentMode(res)) return;
  if (!hasScope(key, "provider:admin")) {
    sendError(res, 403, "FORBIDDEN", "API key lacks 'provider:admin' scope");
    return;
  }

  const expectedRev = await parseIfMatch(req, res, runtime);
  if (expectedRev === null) return;

  const { createProviderManagerApi } = await import("../cli/provider-manager-api.js");
  const api = createProviderManagerApi(runtime);
  const clearRes = await api.clearAssignment(purpose as any, tier ? (tier as any) : null, expectedRev);
  if (!clearRes.ok) {
    if (clearRes.error.code === "conflict") {
      const snap = await runtime.createTurnSnapshot();
      sendJSON(res, 409, { error: { code: "CONFLICT", message: clearRes.error.message }, revision: snap.revision }, snap.revision);
      return;
    }
    sendError(res, 400, clearRes.error.code.toUpperCase(), clearRes.error.message);
    return;
  }
  sendJSON(res, 200, { revision: clearRes.state.revision, deleted: true }, clearRes.state.revision);
}

export async function handleGetProviders(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: ProviderRuntime,
  key: ApiKeyEntry,
  providerId?: string,
): Promise<void> {
  if (!hasScope(key, "provider:read")) {
    sendError(res, 403, "FORBIDDEN", "API key lacks 'provider:read' scope");
    return;
  }

  const snapshot = await runtime.createTurnSnapshot();
  const accounts = snapshot.config?.providers || {};

  // Redact credentials and sensitive headers
  const sanitized: Record<string, any> = {};
  for (const [id, acc] of Object.entries(accounts)) {
    sanitized[id] = {
      adapter: acc.adapter,
      upstreamProvider: acc.upstreamProvider,
      ...(acc.baseUrl ? { baseUrl: sanitizeBaseUrl(acc.baseUrl) } : {}),
      ...(acc.proxy ? { proxy: redactUrlCredentials(acc.proxy) } : {}),
      ...(acc.compat ? { compat: acc.compat } : {}),
      ...(acc.ssrfAllowPrivate !== undefined ? { ssrfAllowPrivate: acc.ssrfAllowPrivate } : {}),
      credential: {
        kind: acc.credential?.kind ?? "none",
        ...(acc.credential?.kind === "env" ? { name: (acc.credential as any).name } : {}),
      },
    };
  }

  if (!providerId) {
    sendJSON(res, 200, sanitized, snapshot.revision);
    return;
  }

  if (!sanitized[providerId]) {
    sendError(res, 404, "NOT_FOUND", `Provider account "${providerId}" not found`);
    return;
  }

  sendJSON(res, 200, sanitized[providerId], snapshot.revision);
}

export async function handlePutProvider(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: ProviderRuntime,
  key: ApiKeyEntry,
  providerId: string,
): Promise<void> {
  if (!checkDeploymentMode(res)) return;
  if (!hasScope(key, "provider:admin")) {
    sendError(res, 403, "FORBIDDEN", "API key lacks 'provider:admin' scope");
    return;
  }

  const expectedRev = await parseIfMatch(req, res, runtime);
  if (expectedRev === null) return;

  let bodyText = "";
  try {
    bodyText = await parseBody(req);
  } catch {
    sendError(res, 400, "BAD_REQUEST", "Failed to read request body");
    return;
  }

  let body: any;
  try {
    body = JSON.parse(bodyText);
  } catch {
    sendError(res, 400, "BAD_REQUEST", "Invalid JSON in request body");
    return;
  }

  const { createProviderManagerApi } = await import("../cli/provider-manager-api.js");
  const api = createProviderManagerApi(runtime);
  let credInput: any = { mode: "preserve" };
  if (body.credential) {
    if (body.credential.kind === "env" || body.credential.mode === "env") {
      credInput = { mode: "env", varName: body.credential.name ?? body.credential.varName ?? body.credential.envVar };
    } else if (body.credential.kind === "none" || body.credential.mode === "none") {
      credInput = { mode: "none" };
    } else if (body.credential.kind === "api_key" || body.credential.mode === "paste" || body.credential.keyValue || body.credential.key) {
      credInput = { mode: "paste", keyValue: body.credential.keyValue ?? body.credential.key ?? body.credential.value };
    }
  }

  const saveRes = await api.saveAccount(
    {
      accountId: providerId,
      upstreamProvider: body.upstreamProvider ?? providerId,
      credential: credInput,
      baseUrl: body.baseUrl,
      compat: body.compat,
      allowPrivate: body.ssrfAllowPrivate === true || body.allowPrivate === true,
    },
    expectedRev,
  );

  if (!saveRes.ok) {
    if (saveRes.error.code === "conflict") {
      const snap = await runtime.createTurnSnapshot();
      sendJSON(res, 409, { error: { code: "CONFLICT", message: saveRes.error.message }, revision: snap.revision }, snap.revision);
    } else if (saveRes.error.code === "invalid_endpoint") {
      sendError(res, 400, "INVALID_ENDPOINT", saveRes.error.message);
    } else {
      sendError(res, 400, "BAD_REQUEST", saveRes.error.message);
    }
    return;
  }

  const account = saveRes.state.accounts.find((a) => a.id === providerId);
  sendJSON(
    res,
    200,
    {
      revision: saveRes.state.revision,
      provider: {
        id: providerId,
        upstreamProvider: account?.upstreamProvider ?? body.upstreamProvider ?? providerId,
        baseUrl: account?.baseUrl,
        credential: { kind: account?.credentialKind ?? "none" },
      },
    },
    saveRes.state.revision,
  );
}

export async function handleDeleteProvider(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: ProviderRuntime,
  key: ApiKeyEntry,
  providerId: string,
): Promise<void> {
  if (!checkDeploymentMode(res)) return;
  if (!hasScope(key, "provider:admin")) {
    sendError(res, 403, "FORBIDDEN", "API key lacks 'provider:admin' scope");
    return;
  }

  const expectedRev = await parseIfMatch(req, res, runtime);
  if (expectedRev === null) return;

  const url = new URL(req.url ?? "", "http://localhost");
  const force = url.searchParams.get("force") === "true";

  const { createProviderManagerApi } = await import("../cli/provider-manager-api.js");
  const api = createProviderManagerApi(runtime);
  const result = await api.deleteAccount(providerId, { force, expectedRevision: expectedRev });

  if (!result.ok) {
    if ("blocked" in result && result.blocked) {
      sendJSON(res, 409, {
        error: {
          code: "BLOCKED",
          message: `Cannot delete account "${providerId}" referenced by active slots. Pass ?force=true to delete anyway.`,
          referencingSlots: result.referencingSlots,
        },
      });
      return;
    }
    const errObj = "error" in result ? result.error : undefined;
    if (errObj?.code === "conflict") {
      const snap = await runtime.createTurnSnapshot();
      sendJSON(res, 409, { error: { code: "CONFLICT", message: errObj.message }, revision: snap.revision }, snap.revision);
      return;
    }
    sendError(res, 400, (errObj?.code || "BAD_REQUEST").toUpperCase(), errObj?.message || "Delete failed");
    return;
  }

  sendJSON(res, 200, { revision: result.state.revision, deleted: true }, result.state.revision);
}

export async function handleGetCatalog(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: ProviderRuntime,
  key: ApiKeyEntry,
): Promise<void> {
  if (!hasScope(key, "provider:read")) {
    sendError(res, 403, "FORBIDDEN", "API key lacks 'provider:read' scope");
    return;
  }

  const snapshot = await runtime.createTurnSnapshot();
  const availableModels = await runtime.modelCatalog.listAvailableModels(snapshot.config);
  sendJSON(res, 200, availableModels, snapshot.revision);
}

interface PendingOAuthAttempt {
  attemptId: string;
  providerId: string;
  upstream: string;
  createdAt: number;
  expiresAt: number;
  userCode?: string;
  verificationUrl?: string;
  loginPromise?: Promise<any>;
  abortController?: AbortController;
}

const pendingOAuthAttempts = new Map<string, PendingOAuthAttempt>();

function cleanExpiredAttempts(): void {
  const now = Date.now();
  for (const [id, att] of pendingOAuthAttempts.entries()) {
    if (now > att.expiresAt) {
      pendingOAuthAttempts.delete(id);
    }
  }
}

export async function handleOAuthStart(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: ProviderRuntime,
  key: ApiKeyEntry,
  providerId: string,
): Promise<void> {
  if (!checkDeploymentMode(res)) return;
  if (!hasScope(key, "provider:admin")) {
    sendError(res, 403, "FORBIDDEN", "API key lacks 'provider:admin' scope");
    return;
  }

  cleanExpiredAttempts();

  const { isOAuthSupported, getOAuthFlow } = await import(
    "../../domain/providers/oauth-service.js"
  );

  const snapshot = await runtime.createTurnSnapshot();
  const existing = snapshot.config.providers?.[providerId];
  const upstream = existing?.upstreamProvider ?? providerId;

  if (!isOAuthSupported(upstream)) {
    sendError(res, 400, "OAUTH_UNSUPPORTED", `OAuth is not supported for provider "${upstream}"`);
    return;
  }

  const flow = await getOAuthFlow(upstream);
  if (!flow) {
    sendError(res, 500, "OAUTH_FLOW_ERROR", `Could not initialize OAuth flow for "${upstream}"`);
    return;
  }

  const attemptId = `oauth_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const abortController = new AbortController();
  let notifyResolve: (info: { userCode?: string; verificationUrl?: string; expiresInSeconds?: number }) => void;
  const notifyPromise = new Promise<{ userCode?: string; verificationUrl?: string; expiresInSeconds?: number }>(
    (resolve) => {
      notifyResolve = resolve;
    },
  );

  const interaction = createOAuthInteractionShim(
    {
      signal: abortController.signal,
      onBrowserOpen: (url) => {
        notifyResolve({
          verificationUrl: url,
          expiresInSeconds: 600,
        });
      },
      onDeviceCode: (info) => {
        notifyResolve({
          userCode: info.userCode,
          verificationUrl: info.verificationUrl,
          expiresInSeconds: Math.round(info.expiresInMs / 1000),
        });
      },
    },
    abortController.signal,
  );

  const loginPromise = flow.login(interaction as any);
  const loginErrorPromise = new Promise<{ userCode?: string; verificationUrl?: string; expiresInSeconds?: number }>(
    (_, reject) => {
      loginPromise.catch((err) => reject(err));
    },
  );
  // Attach a no-op handler so background rejection doesn't trigger unhandledRejection
  loginPromise.catch(() => {});

  // Wait for notify event (up to 15s) or early login failure
  const timeoutPromise = new Promise<{ userCode?: string; verificationUrl?: string; expiresInSeconds?: number }>(
    (resolve) => setTimeout(() => resolve({}), 15_000),
  );

  let notified: { userCode?: string; verificationUrl?: string; expiresInSeconds?: number };
  try {
    notified = await Promise.race([notifyPromise, loginErrorPromise, timeoutPromise]);
  } catch (err: any) {
    sendError(res, 400, "OAUTH_FLOW_ERROR", redactString(err?.message || "OAuth login flow initiation failed"));
    return;
  }

  const expiresInMs = (notified?.expiresInSeconds ?? 600) * 1000;
  const userCode = notified?.userCode;
  const verificationUrl = notified?.verificationUrl;

  pendingOAuthAttempts.set(attemptId, {
    attemptId,
    providerId,
    upstream,
    createdAt: Date.now(),
    expiresAt: Date.now() + expiresInMs,
    userCode,
    verificationUrl,
    loginPromise,
    abortController,
  });

  sendJSON(res, 200, {
    attemptId,
    userCode,
    verificationUrl,
    expiresInMs,
  });
}

export async function handleOAuthComplete(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: ProviderRuntime,
  key: ApiKeyEntry,
  providerId: string,
): Promise<void> {
  if (!checkDeploymentMode(res)) return;
  if (!hasScope(key, "provider:admin")) {
    sendError(res, 403, "FORBIDDEN", "API key lacks 'provider:admin' scope");
    return;
  }

  let bodyText: string;
  try {
    bodyText = await parseBody(req);
  } catch {
    sendError(res, 400, "BAD_REQUEST", "Failed to read request body");
    return;
  }

  let body: any;
  try {
    body = JSON.parse(bodyText);
  } catch {
    sendError(res, 400, "BAD_REQUEST", "Invalid JSON in request body");
    return;
  }

  const { attemptId } = body;
  if (!attemptId || !pendingOAuthAttempts.has(attemptId)) {
    sendError(res, 400, "OAUTH_ATTEMPT_NOT_FOUND", "OAuth attempt expired or not found");
    return;
  }

  const attempt = pendingOAuthAttempts.get(attemptId)!;
  if (attempt.providerId !== providerId) {
    sendError(res, 400, "OAUTH_PROVIDER_MISMATCH", `Attempt was initiated for "${attempt.providerId}", not "${providerId}"`);
    return;
  }

  if (Date.now() > attempt.expiresAt) {
    attempt.abortController?.abort();
    pendingOAuthAttempts.delete(attemptId);
    sendError(res, 400, "OAUTH_EXPIRED", "OAuth authorization expired");
    return;
  }

  try {
    let timerId: any;
    const timeoutPromise = new Promise((_, reject) => {
      timerId = setTimeout(() => reject(new Error("OAUTH_PENDING")), 5000);
    });
    const credResult: any = await Promise.race([attempt.loginPromise, timeoutPromise]).finally(() => {
      if (timerId) clearTimeout(timerId);
    });

    const api = createProviderManagerApi(runtime);
    const saveRes = await api.completeOAuthSignIn(
      attempt.upstream,
      {
        access: credResult.access,
        refresh: credResult.refresh,
        expires: credResult.expires,
      },
      {
        preferredAccountId: providerId,
        description: `OAuth login for ${attempt.upstream}`,
      },
    );

    pendingOAuthAttempts.delete(attemptId);
    if (!saveRes.ok) {
      sendError(res, 400, saveRes.error.code.toUpperCase(), saveRes.error.message);
      return;
    }

    sendJSON(
      res,
      200,
      {
        revision: saveRes.state.revision,
        provider: {
          id: providerId,
          adapter: "pi-ai",
          upstreamProvider: attempt.upstream,
          credential: { kind: "redacted" },
        },
      },
      saveRes.state.revision,
    );
  } catch (err: any) {
    if (err.message === "OAUTH_PENDING") {
      sendError(res, 202, "OAUTH_PENDING", "Authorization still pending in browser");
      return;
    }
    pendingOAuthAttempts.delete(attemptId);
    sendError(res, 400, "OAUTH_FAILED", redactString(err?.message || "OAuth login failed"));
  }
}

export async function handleResolveModel(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: ProviderRuntime,
  key: ApiKeyEntry,
): Promise<void> {
  if (!hasScope(key, "provider:read")) {
    sendError(res, 403, "FORBIDDEN", "API key lacks 'provider:read' scope");
    return;
  }

  let bodyText: string;
  try {
    bodyText = await parseBody(req);
  } catch {
    sendError(res, 400, "BAD_REQUEST", "Failed to read request body");
    return;
  }

  let body: any;
  try {
    body = JSON.parse(bodyText);
  } catch {
    sendError(res, 400, "BAD_REQUEST", "Invalid JSON in request body");
    return;
  }

  try {
    const { createProviderManagerApi } = await import("../cli/provider-manager-api.js");
    const api = createProviderManagerApi(runtime);
    const resPreview = await api.resolvePreview(body.purpose, body.tier, body.override);
    if ("ok" in resPreview && (resPreview as any).ok === false) {
      sendError(res, 400, "RESOLUTION_FAILED", (resPreview as any).message);
      return;
    }
    const preview = resPreview as any;
    const snapshot = await runtime.createTurnSnapshot();
    sendJSON(
      res,
      200,
      {
        selectedTarget: preview.selectedTarget,
        via: preview.via,
        failureTargets: preview.failureTargets,
      },
      snapshot.revision,
    );
  } catch (err: any) {
    sendError(res, 400, "RESOLUTION_FAILED", err.message);
  }
}

export async function handleProbeProvider(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: ProviderRuntime,
  key: ApiKeyEntry,
  providerId: string,
  full: boolean,
): Promise<void> {
  const requiredScope = full ? "provider:admin" : "provider:read";
  if (!hasScope(key, requiredScope)) {
    sendError(res, 403, "FORBIDDEN", `API key lacks '${requiredScope}' scope for probe`);
    return;
  }

  const snapshot = await runtime.createTurnSnapshot();
  const acc = snapshot.config?.providers?.[providerId];
  if (!acc) {
    sendError(res, 404, "NOT_FOUND", `Provider "${providerId}" not configured`);
    return;
  }

  let authValid = false;
  let reachable = true;
  let ssrfBlocked = false;
  let probeLatencyMs: number | undefined;

  try {
    const handle = await runtime.credentialStore.resolve(acc.credential);
    authValid = await handle.isResolvable();
  } catch {
    authValid = false;
  }

  if (acc.baseUrl) {
    const { safeSsrfFetch, validateEndpointUrl } = await import("./ssrf-validator.js");
    const allowPrivate = acc.ssrfAllowPrivate === true || process.env.SEEPIENT_SSRF_ALLOW_PRIVATE === "1";
    if (full) {
      const start = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      try {
        const resp = await safeSsrfFetch(
          acc.baseUrl,
          { method: "HEAD", signal: controller.signal },
          { ssrfAllowPrivate: allowPrivate },
        );
        probeLatencyMs = Date.now() - start;
        reachable = resp.ok || resp.status < 500;
      } catch (err: any) {
        reachable = false;
        if (err?.message?.includes("SSRF Blocked")) {
          ssrfBlocked = true;
        }
      } finally {
        clearTimeout(timeout);
      }
    } else {
      const val = await validateEndpointUrl(acc.baseUrl, { ssrfAllowPrivate: allowPrivate });
      if (!val.valid) {
        reachable = false;
        ssrfBlocked = true;
      }
    }
  }

  sendJSON(res, 200, {
    providerId,
    reachable,
    authValid,
    blocked: ssrfBlocked ? "ssrf" : undefined,
    latencyMs: probeLatencyMs,
    probedAt: new Date().toISOString(),
    mode: full ? "full" : "shallow",
  });
}

export async function handleRefreshModels(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: ProviderRuntime,
  key: ApiKeyEntry,
  providerId: string,
): Promise<void> {
  if (!hasScope(key, "provider:admin")) {
    sendError(res, 403, "FORBIDDEN", "API key lacks 'provider:admin' scope");
    return;
  }

  try {
    const modelIds = await runtime.refreshModels(providerId);
    sendJSON(res, 200, {
      providerId,
      refreshedAt: new Date().toISOString(),
      discoveredModelsCount: modelIds.length,
      models: modelIds,
    });
  } catch (err: any) {
    if (err?.code === "unconfigured_provider") {
      sendError(res, 404, "NOT_FOUND", `Provider "${providerId}" not configured`);
    } else {
      sendError(res, 400, "BAD_REQUEST", err?.message || "Model discovery failed");
    }
  }
}
