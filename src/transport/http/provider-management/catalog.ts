/**
 * REST Handlers for Catalog, Model Resolution, Probing, and Model Refresh API
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProviderRuntime } from "../../../domain/providers/provider-runtime.js";
import type { ApiKeyEntry } from "../../auth/auth.js";
import { hasScope } from "../../auth/auth.js";
import { createProviderManagerApi } from "../../cli/provider-manager-api.js";
import { sendJSON, sendError, parseBody } from "./http-util.js";

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
    const { safeSsrfFetch, validateEndpointUrl } = await import("../ssrf-validator.js");
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

  const health = !authValid ? "missing" : !reachable ? "unverified" : "ok";

  sendJSON(res, 200, {
    providerId,
    health,
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
