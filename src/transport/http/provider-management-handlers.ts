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

function sendJSON(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJSON(res, status, { error: { code, message } });
}

async function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
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

function parseIfMatch(req: IncomingMessage, res: ServerResponse): number | null {
  const ifMatch = req.headers["if-match"];
  if (!ifMatch) {
    sendError(res, 428, "PRECONDITION_REQUIRED", "Header 'If-Match: <revision>' is required for mutations");
    return null;
  }
  const rev = parseInt(ifMatch, 10);
  if (isNaN(rev)) {
    sendError(res, 400, "BAD_REQUEST", "Invalid If-Match header value (must be an integer revision)");
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
  sendJSON(res, 200, {
    revision: snapshot.revision,
    updatedAt: new Date().toISOString(),
    health: {},
    sources: {
      compiledDefault: true,
      overlay: true,
    },
  });
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

  const expectedRev = parseIfMatch(req, res);
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
    sendJSON(res, 200, { revision: result.revision, assignment: body });
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

  const expectedRev = parseIfMatch(req, res);
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
    sendJSON(res, 200, { revision: result.revision, deleted: true });
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
    sendJSON(res, 200, sanitized);
    return;
  }

  if (!sanitized[providerId]) {
    sendError(res, 404, "NOT_FOUND", `Provider account "${providerId}" not found`);
    return;
  }

  sendJSON(res, 200, sanitized[providerId]);
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

  const expectedRev = parseIfMatch(req, res);
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
    sendJSON(res, 200, { revision: result.revision, provider: { ...body, credential: { kind: "redacted" } } });
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

  const expectedRev = parseIfMatch(req, res);
  if (expectedRev === null) return;

  try {
    const patch = {
      providers: {
        [providerId]: null,
      } as any,
    };
    const result = await runtime.updateOverlay(patch, expectedRev);
    sendJSON(res, 200, { revision: result.revision, deleted: true });
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
  sendJSON(res, 200, snapshot.catalog);
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
    });
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

  try {
    const handle = await runtime.credentialStore.resolve(acc.credential);
    authValid = await handle.isResolvable();
  } catch {
    authValid = false;
  }

  if (acc.baseUrl) {
    const { validateEndpointUrl } = await import("./ssrf-validator.js");
    const val = await validateEndpointUrl(acc.baseUrl, { ssrfAllowPrivate: acc.ssrfAllowPrivate });
    if (!val.valid) {
      reachable = false;
    }
  }

  sendJSON(res, 200, {
    providerId,
    reachable,
    authValid,
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

  const snapshot = await runtime.createTurnSnapshot();
  const acc = snapshot.config?.providers?.[providerId];
  if (!acc) {
    sendError(res, 404, "NOT_FOUND", `Provider "${providerId}" not configured`);
    return;
  }

  const models = snapshot.catalog.filter(
    (m: any) => m.provider === providerId || m.upstreamProvider === providerId,
  );

  sendJSON(res, 200, {
    providerId,
    refreshedAt: new Date().toISOString(),
    discoveredModelsCount: models.length,
    models: models.map((m) => m.id),
  });
}
