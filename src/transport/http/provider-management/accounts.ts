/**
 * REST Handlers for Provider Accounts and Runtime API
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProviderRuntime } from "../../../domain/providers/provider-runtime.js";
import type { ApiKeyEntry } from "../../auth/auth.js";
import { hasScope } from "../../auth/auth.js";
import { redactUrlCredentials } from "../../../foundations/security/redact.js";
import { createProviderManagerApi, sanitizeBaseUrl } from "../../cli/provider-manager-api.js";
import {
  sendJSON,
  sendError,
  parseBody,
  checkDeploymentMode,
  parseIfMatch,
} from "./http-util.js";

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

  const api = createProviderManagerApi(runtime);
  const state = await api.getState();

  const healthMap: Record<string, string> = {};
  for (const acc of state.accounts) {
    healthMap[acc.id] = acc.health;
  }

  sendJSON(
    res,
    200,
    {
      revision: state.revision,
      updatedAt: new Date().toISOString(),
      health: healthMap,
      sources: {
        compiledDefault: true,
        overlay: true,
      },
    },
    state.revision,
  );
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
      upstreamProvider: body.upstreamProvider,
      credential: credInput,
      baseUrl: body.baseUrl,
      compat: body.compat,
      allowPrivate:
        body.ssrfAllowPrivate !== undefined || body.allowPrivate !== undefined
          ? body.ssrfAllowPrivate === true || body.allowPrivate === true
          : undefined,
    },
    expectedRev,
  );

  if (!saveRes.ok) {
    if (saveRes.error.code === "conflict") {
      const snap = await runtime.createTurnSnapshot();
      sendJSON(res, 409, { error: { code: "CONFLICT", message: saveRes.error.message }, revision: snap.revision }, snap.revision);
    } else {
      sendError(res, 400, (saveRes.error.code || "BAD_REQUEST").toUpperCase(), saveRes.error.message);
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
