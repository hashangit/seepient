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
import { InferenceError } from "../../foundations/errors.js";

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

  const purposeEntry = (assignments as any)[purpose];
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

  try {
    const patch = {
      modelAssignments: {
        [purpose]: {
          [tier]: body,
        },
      } as any,
    };
    const result = await runtime.updateOverlay(patch, expectedRev);
    sendJSON(res, 200, { revision: result.revision, assignment: body }, result.revision);
  } catch (err: any) {
    if (isConflictError(err)) {
      sendError(res, 409, "CONFLICT", err.message);
    } else {
      sendError(res, 400, "BAD_REQUEST", err.message);
    }
  }
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

  try {
    const patch = {
      modelAssignments: {
        [purpose]: {
          [tier]: null,
        },
      } as any,
    };
    const result = await runtime.updateOverlay(patch, expectedRev);
    sendJSON(res, 200, { revision: result.revision, deleted: true }, result.revision);
  } catch (err: any) {
    if (isConflictError(err)) {
      sendError(res, 409, "CONFLICT", err.message);
    } else {
      sendError(res, 400, "BAD_REQUEST", err.message);
    }
  }
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
    const { headers: _h, ...rest } = acc as any;
    sanitized[id] = {
      ...rest,
      credential: { kind: acc.credential?.kind ?? "redacted" },
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

  if (body.baseUrl) {
    const allowPrivate = process.env.SEEPIENT_SSRF_ALLOW_PRIVATE === "1";
    const ssrfCheck = await validateEndpointUrl(body.baseUrl, { ssrfAllowPrivate: allowPrivate });
    if (!ssrfCheck.valid) {
      sendError(res, 400, "INVALID_ENDPOINT", ssrfCheck.error ?? "SSRF check failed");
      return;
    }
  }

  try {
    const patch = {
      providers: {
        [providerId]: body,
      } as any,
    };
    const result = await runtime.updateOverlay(patch, expectedRev);
    sendJSON(res, 200, { revision: result.revision, provider: { ...body, credential: { kind: "redacted" } } }, result.revision);
  } catch (err: any) {
    if (isConflictError(err)) {
      sendError(res, 409, "CONFLICT", err.message);
    } else {
      sendError(res, 400, "BAD_REQUEST", err.message);
    }
  }
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

  try {
    const patch = {
      providers: {
        [providerId]: null,
      } as any,
    };
    const result = await runtime.updateOverlay(patch, expectedRev);
    sendJSON(res, 200, { revision: result.revision, deleted: true }, result.revision);
  } catch (err: any) {
    if (isConflictError(err)) {
      sendError(res, 409, "CONFLICT", err.message);
    } else {
      sendError(res, 400, "BAD_REQUEST", err.message);
    }
  }
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
  let userCode: string | undefined;
  let verificationUrl: string | undefined;
  let expiresInMs = 600_000;

  const interaction = {
    prompt: async () => "",
    notify: (event: any) => {
      if (event.type === "device_code") {
        userCode = event.userCode;
        verificationUrl = event.verificationUri;
        if (event.expiresInSeconds) expiresInMs = event.expiresInSeconds * 1000;
      } else if (event.type === "auth_url") {
        verificationUrl = event.url;
      }
    },
  };

  const loginPromise = flow.login(interaction as any);
  // Attach a no-op handler so an abandoned/rejected background flow doesn't trigger unhandledRejection
  loginPromise.catch(() => {});

  // Wait a brief tick (50ms) to allow interaction.notify to populate device_code
  await new Promise((resolve) => setTimeout(resolve, 50));

  pendingOAuthAttempts.set(attemptId, {
    attemptId,
    providerId,
    upstream,
    createdAt: Date.now(),
    expiresAt: Date.now() + expiresInMs,
    userCode,
    verificationUrl,
    loginPromise,
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
  if (Date.now() > attempt.expiresAt) {
    pendingOAuthAttempts.delete(attemptId);
    sendError(res, 400, "OAUTH_EXPIRED", "OAuth authorization expired");
    return;
  }

  let credentialPersisted = false;
  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("OAUTH_PENDING")), 5000),
    );
    const credResult: any = await Promise.race([attempt.loginPromise, timeoutPromise]);

    if (!credResult || credResult.type !== "oauth" || !credResult.access) {
      pendingOAuthAttempts.delete(attemptId);
      sendError(res, 400, "OAUTH_FAILED", "OAuth authorization did not return valid tokens");
      return;
    }

    await runtime.credentialStore.put(providerId, {
      kind: "oauth",
      access: credResult.access,
      refresh: credResult.refresh ?? "",
      expires: credResult.expires ?? Date.now() + 3600_000,
    });
    credentialPersisted = true;

    const patch = {
      providers: {
        [providerId]: {
          adapter: "pi-ai",
          upstreamProvider: attempt.upstream,
          credential: { kind: "seepient", id: providerId },
        },
      } as any,
    };

    let result: any;
    for (let retry = 0; retry < 2; retry++) {
      try {
        const overlay = await runtime.configStore.getOverlay();
        result = await runtime.updateOverlay(patch, overlay.revision);
        break;
      } catch (err: any) {
        if (retry === 0) continue;
        throw err;
      }
    }

    pendingOAuthAttempts.delete(attemptId);
    sendJSON(
      res,
      200,
      {
        revision: result.revision,
        provider: {
          adapter: "pi-ai",
          upstreamProvider: attempt.upstream,
          credential: { kind: "redacted" },
        },
      },
      result.revision,
    );
  } catch (err: any) {
    if (credentialPersisted) {
      await runtime.credentialStore.delete(providerId).catch(() => {});
    }
    if (err.message === "OAUTH_PENDING") {
      sendError(res, 202, "OAUTH_PENDING", "Authorization still pending in browser");
      return;
    }
    pendingOAuthAttempts.delete(attemptId);
    sendError(res, 400, "OAUTH_FAILED", err.message || "OAuth login failed");
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
    const snapshot = await runtime.createTurnSnapshot();
    const plan = await runtime.resolvePlan(snapshot, body.purpose, body.tier, body.override);
    sendJSON(res, 200, {
      selectedTarget: plan.selectedTarget,
      failureTargets: plan.failureTargets,
    }, snapshot.revision);
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
    const allowPrivate = process.env.SEEPIENT_SSRF_ALLOW_PRIVATE === "1";
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
