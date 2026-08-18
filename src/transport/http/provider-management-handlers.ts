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

  // Redact credentials
  const sanitized: Record<string, any> = {};
  for (const [id, acc] of Object.entries(accounts)) {
    sanitized[id] = {
      ...acc,
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
  sendJSON(res, 200, snapshot.catalog, snapshot.revision);
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
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const resp = await safeSsrfFetch(
          acc.baseUrl,
          { method: "HEAD", signal: controller.signal },
          { ssrfAllowPrivate: allowPrivate },
        );
        clearTimeout(timeout);
        probeLatencyMs = Date.now() - start;
        reachable = resp.ok || resp.status < 500;
      } catch (err: any) {
        reachable = false;
        if (err?.message?.includes("SSRF Blocked")) {
          ssrfBlocked = true;
        }
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
