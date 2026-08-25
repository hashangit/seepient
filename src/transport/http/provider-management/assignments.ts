/**
 * REST Handlers for Purpose-Model Slot Assignments API
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProviderRuntime } from "../../../domain/providers/provider-runtime.js";
import type { ApiKeyEntry } from "../../auth/auth.js";
import { hasScope } from "../../auth/auth.js";
import { createProviderManagerApi } from "../../cli/provider-manager-api.js";
import {
  sendJSON,
  sendError,
  parseBody,
  checkDeploymentMode,
  parseIfMatch,
} from "./http-util.js";

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
