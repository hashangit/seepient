/**
 * WebSocket Provider Mutation Handlers
 */

import * as crypto from "node:crypto";
import type {
  WebSocket,
  SwitchProviderMessage,
  ListProvidersMessage,
  SetProviderMessage,
  RemoveProviderMessage,
  WebSocketHandlerContext,
  ConnectionState,
} from "./ws-types.js";
import type { SettingsHandlerContext } from "../http/settings-handlers.js";
import { safeSend } from "./connection-registry.js";
import { redactString } from "../../foundations/security/redact.js";
import { requireWsScope } from "./session-control.js";

export function handleSwitchProvider(
  ws: WebSocket,
  msg: SwitchProviderMessage,
  state: ConnectionState,
): void {
  state.activeProvider = msg.provider;
  if (msg.model) {
    state.activeModel = msg.model;
  }

  safeSend(ws, {
    type: "ack",
    clientMsgId: "",
    serverMsgId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  });
}

export function handleListModels(
  ws: WebSocket,
  ctx: WebSocketHandlerContext,
): void {
  safeSend(ws, {
    type: "models_list",
    models: ctx.listModels(),
  });
}

export async function handleWsListProviders(
  msg: ListProvidersMessage,
  ws: WebSocket,
  state: ConnectionState,
  _ctx: SettingsHandlerContext,
): Promise<void> {
  if (!requireWsScope(state, "provider:read")) {
    safeSend(ws, { type: "providers_list", id: msg.id, providers: {}, error: { code: "FORBIDDEN", message: "Requires provider:read scope" } } as any);
    return;
  }

  const providers: Record<string, any> = {};

  try {
    const { getDefaultProviderRuntime } = await import("../../domain/providers/provider-runtime.js");
    const { createProviderManagerApi } = await import("../cli/provider-manager-api.js");
    const runtime = getDefaultProviderRuntime();
    const api = createProviderManagerApi(runtime);
    const apiState = await api.getState();
    for (const acc of apiState.accounts) {
      providers[acc.id] = {
        type: acc.upstreamProvider,
        upstreamProvider: acc.upstreamProvider,
        baseUrl: acc.baseUrl,
        credentialKind: acc.credentialKind,
        credentialDetail: acc.credentialDetail,
        health: acc.health,
        modelCount: acc.modelCount,
      };
    }
  } catch (err: any) {
    safeSend(ws, { type: "providers_list", id: msg.id, providers: {}, error: { code: "STORAGE_ERROR", message: redactString(err?.message || "Failed to list providers") } } as any);
    return;
  }

  safeSend(ws, { type: "providers_list", id: msg.id, providers } as any);
}

export async function handleWsSetProvider(
  msg: SetProviderMessage,
  ws: WebSocket,
  state: ConnectionState,
  _ctx: SettingsHandlerContext,
): Promise<void> {
  if (!requireWsScope(state, "provider:admin")) {
    safeSend(ws, { type: "settings_updated", id: msg.id, error: { code: "FORBIDDEN", message: "Requires provider:admin scope" } } as any);
    return;
  }

  const { type: providerType, apiKey, baseUrl, model } = msg.provider;
  const allowPrivate = (msg.provider as any).allowPrivate ?? (msg.provider as any).ssrfAllowPrivate;
  if (!providerType) {
    safeSend(ws, { type: "settings_updated", id: msg.id, error: { code: "VALIDATION_ERROR", message: "Invalid provider type" } } as any);
    return;
  }

  try {
    const { getDefaultProviderRuntime } = await import("../../domain/providers/provider-runtime.js");
    const { createProviderManagerApi } = await import("../cli/provider-manager-api.js");
    const runtime = getDefaultProviderRuntime();
    const api = createProviderManagerApi(runtime);

    const isAllowPrivate = Boolean(allowPrivate);
    const saveRes = await api.saveAccount({
      accountId: providerType,
      upstreamProvider: providerType,
      credential: apiKey ? { mode: "paste", keyValue: apiKey } : { mode: "none" },
      baseUrl,
      allowPrivate: isAllowPrivate,
    });

    if (!saveRes.ok) {
      safeSend(ws, { type: "settings_updated", id: msg.id, error: { code: saveRes.error.code.toUpperCase(), message: redactString(saveRes.error.message) } } as any);
      return;
    }

    if (model) {
      const assignRes = await api.setAssignment("text", "standard", {
        providerAccount: providerType,
        model,
      });
      if (!assignRes.ok) {
        safeSend(ws, { type: "settings_updated", id: msg.id, error: { code: assignRes.error.code.toUpperCase(), message: redactString(`Provider saved, but assignment failed: ${assignRes.error.message}`) } } as any);
        return;
      }
    }
  } catch (e: any) {
    safeSend(ws, { type: "settings_updated", id: msg.id, error: { code: "STORAGE_ERROR", message: redactString(e.message) } } as any);
    return;
  }

  safeSend(ws, { type: "settings_updated", id: msg.id, applied: { [providerType]: true }, requiresRestart: false, restartAffected: [] } as any);
}

export async function handleWsRemoveProvider(
  msg: RemoveProviderMessage,
  ws: WebSocket,
  state: ConnectionState,
  _ctx: SettingsHandlerContext,
): Promise<void> {
  if (!requireWsScope(state, "provider:admin")) {
    safeSend(ws, { type: "settings_updated", id: msg.id, error: { code: "FORBIDDEN", message: "Requires provider:admin scope" } } as any);
    return;
  }

  if (!msg.providerType) {
    safeSend(ws, { type: "settings_updated", id: msg.id, error: { code: "VALIDATION_ERROR", message: "Invalid provider type" } } as any);
    return;
  }

  try {
    const { getDefaultProviderRuntime } = await import("../../domain/providers/provider-runtime.js");
    const { createProviderManagerApi } = await import("../cli/provider-manager-api.js");
    const runtime = getDefaultProviderRuntime();
    const api = createProviderManagerApi(runtime);
    const delRes = await api.deleteAccount(msg.providerType, { force: (msg as any).force === true });
    if (!delRes.ok) {
      safeSend(ws, {
        type: "settings_updated",
        id: msg.id,
        error: {
          code: "blocked" in delRes ? "BLOCKED" : delRes.error.code.toUpperCase(),
          message: "blocked" in delRes ? `Account referenced by slots: ${delRes.referencingSlots.join(", ")}` : redactString(delRes.error.message),
          referencingSlots: "blocked" in delRes ? delRes.referencingSlots : undefined,
        },
      } as any);
      return;
    }
  } catch (e: any) {
    safeSend(ws, { type: "settings_updated", id: msg.id, error: { code: "STORAGE_ERROR", message: redactString(e.message) } } as any);
    return;
  }

  safeSend(ws, { type: "settings_updated", id: msg.id, applied: { removed: msg.providerType }, requiresRestart: false, restartAffected: [] } as any);
}
