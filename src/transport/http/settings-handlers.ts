/**
 * Seepient Server — Settings REST & WebSocket Handlers
 *
 * REST endpoints and WS message handlers for settings management.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { SettingsManager, SettingsError } from '../../domain/settings/settings-manager.js';
import { SETTINGS_MAP, SETTINGS_SCHEMA, SETTINGS_CATEGORIES } from '../../foundations/settings-schema.js';
import type { WebSocket, ConnectionState } from '../ws/ws-types.js';
import type { ApiKeyEntry, KeyScope } from '../auth/auth.js';
import { hasScope } from '../auth/auth.js';

// ── Types ─────────────────────────────────────────────────────────────────

export interface SettingsHandlerContext {
  settingsManager: SettingsManager;
  /** Get all connected WS clients (excluding sender) */
  getOtherClients: (excludeWs?: WebSocket) => Array<{ ws: WebSocket; state: ConnectionState }>;
}

// ── Mutex ─────────────────────────────────────────────────────────────────

class AsyncMutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const tryAcquire = () => {
        if (!this.locked) {
          this.locked = true;
          resolve(() => {
            this.locked = false;
            if (this.queue.length > 0) this.queue.shift()!();
          });
        } else {
          this.queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  }
}

const writeMutex = new AsyncMutex();

// ── Helpers ───────────────────────────────────────────────────────────────

function sendJSON(res: ServerResponse, statusCode: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res: ServerResponse, statusCode: number, code: string, message: string): void {
  sendJSON(res, statusCode, { error: { code, message } });
}

function requireScope(res: ServerResponse, apiKey: ApiKeyEntry | undefined, scope: KeyScope): boolean {
  if (!apiKey || !hasScope(apiKey, scope)) {
    sendError(res, 403, 'FORBIDDEN', `Requires ${scope} scope`);
    return false;
  }
  return true;
}

function requireWsScope(state: ConnectionState, scope: KeyScope): boolean {
  const apiKey = state.apiKey;
  return !!apiKey && hasScope(apiKey, scope);
}

async function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const VALID_CATEGORIES: Set<string> = new Set(SETTINGS_CATEGORIES.map(c => c.key));
const VALID_PROVIDER_TYPES = new Set(['openai', 'anthropic', 'glm', 'openai-compatible']);

// ── REST Handlers ─────────────────────────────────────────────────────────

export async function handleGetSettings(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SettingsHandlerContext,
  category?: string,
): Promise<void> {
  const apiKey = (req as any).apiKey as ApiKeyEntry | undefined;
  if (!requireScope(res, apiKey, 'agent:read')) return;

  if (category) {
    if (!VALID_CATEGORIES.has(category)) {
      sendError(res, 404, 'NOT_FOUND', `Unknown category: ${category}`);
      return;
    }
    const all = ctx.settingsManager.listByCategory();
    sendJSON(res, 200, { [category]: all[category] ?? [] });
    return;
  }

  const all = ctx.settingsManager.listByCategory();
  sendJSON(res, 200, all);
}

export async function handlePatchSettings(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SettingsHandlerContext,
  category?: string,
): Promise<void> {
  const apiKey = (req as any).apiKey as ApiKeyEntry | undefined;
  if (!requireScope(res, apiKey, 'admin')) return;

  const body = await readBody(req);
  const updates = category ? { [category]: body } : body;
  const applied: Record<string, any> = {};
  const errors: Array<{ field: string; message: string }> = [];
  let requiresRestart = false;
  const restartAffected: string[] = [];

  const release = await writeMutex.acquire();
  try {
    for (const [cat, fields] of Object.entries(updates)) {
      if (typeof fields !== 'object' || fields === null) continue;
      applied[cat] = {};
      for (const [key, value] of Object.entries(fields as Record<string, any>)) {
        const dotKey = category ? `${category}.${key}` : `${cat}.${key}`;
        try {
          await ctx.settingsManager.set(dotKey, String(value));
          applied[cat][key] = ctx.settingsManager.get(dotKey).value;
          // Check restart requirement via schema
          const schema = SETTINGS_SCHEMA.get(dotKey);
          if (schema?.restartRequired) {
            requiresRestart = true;
            restartAffected.push(dotKey);
          }
        } catch (e: any) {
          errors.push({ field: dotKey, message: e.message });
        }
      }
    }
  } finally {
    release();
  }

  if (errors.length > 0) {
    sendJSON(res, 422, {
      error: { code: 'VALIDATION_ERROR', message: `${errors.length} field(s) failed validation`, details: errors },
    });
    return;
  }

  // Broadcast change notification
  broadcastSettingsChange(ctx, Object.keys(updates), requiresRestart, restartAffected);

  sendJSON(res, 200, { applied, requiresRestart, restartAffected });
}

export async function handleGetSettingsSchema(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SettingsHandlerContext,
): Promise<void> {
  const apiKey = (req as any).apiKey as ApiKeyEntry | undefined;
  if (!requireScope(res, apiKey, 'agent:read')) return;

  // Build a simple JSON schema from SETTINGS_SCHEMA
  const properties: Record<string, any> = {};
  for (const [dotKey, schema] of SETTINGS_SCHEMA) {
    const prop: any = {};
    if (schema.type === 'number') prop.type = 'integer';
    else if (schema.type === 'boolean') prop.type = 'boolean';
    else if (schema.type === 'enum') { prop.type = 'string'; prop.enum = schema.enumValues; }
    else prop.type = 'string';
    if (schema.secret) prop.writeOnly = true;
    if (schema.default !== undefined) prop.default = schema.default;
    properties[dotKey] = prop;
  }

  sendJSON(res, 200, {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Seepient Agent Settings',
    type: 'object',
    properties,
  });
}

export async function handlePostProvider(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SettingsHandlerContext,
): Promise<void> {
  const apiKey = (req as any).apiKey as ApiKeyEntry | undefined;
  if (!requireScope(res, apiKey, 'admin')) return;

  const body = await readBody(req);
  const providerType = body.type;
  if (!providerType || !VALID_PROVIDER_TYPES.has(providerType)) {
    sendError(res, 422, 'VALIDATION_ERROR', 'Invalid or missing provider type');
    return;
  }

  // Check if already exists
  const existingKey = `providers.${providerType === 'openai-compatible' ? 'openai-compat' : providerType}.apiKey`;
  const existing = ctx.settingsManager.get(existingKey);
  if (existing.value != null) {
    sendError(res, 409, 'CONFLICT', `Provider "${providerType}" is already configured. Use PATCH to update.`);
    return;
  }

  if (!body.apiKey) {
    sendError(res, 422, 'VALIDATION_ERROR', 'apiKey is required');
    return;
  }
  if (providerType === 'openai-compatible' && !body.baseUrl) {
    sendError(res, 422, 'VALIDATION_ERROR', 'baseUrl is required for openai-compatible');
    return;
  }

  if (body.baseUrl && providerType === 'openai-compatible') {
    const { validateEndpointUrl } = await import("./ssrf-validator.js");
    const val = await validateEndpointUrl(body.baseUrl, { ssrfAllowPrivate: body.ssrfAllowPrivate });
    if (!val.valid) {
      sendError(res, 400, "SSRF_BLOCKED", val.error || "SSRF validation failed");
      return;
    }
  }

  const release = await writeMutex.acquire();
  try {
    await ctx.settingsManager.set(existingKey, body.apiKey);
    if (body.model) {
      const modelKey = `providers.${providerType === 'openai-compatible' ? 'openai-compat' : providerType}.model`;
      await ctx.settingsManager.set(modelKey, body.model);
    }
    if (body.baseUrl && providerType === 'openai-compatible') {
      await ctx.settingsManager.set('providers.openai-compat.baseUrl', body.baseUrl);
    }
  } finally {
    release();
  }

  broadcastSettingsChange(ctx, ['providers'], false, []);

  sendJSON(res, 201, {
    provider: { type: providerType, apiKey: ctx.settingsManager.get(existingKey).value },
    requiresRestart: false,
    restartAffected: [],
  });
}

export async function handlePatchProvider(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SettingsHandlerContext,
  providerType: string,
): Promise<void> {
  const apiKey = (req as any).apiKey as ApiKeyEntry | undefined;
  if (!requireScope(res, apiKey, 'admin')) return;

  if (!VALID_PROVIDER_TYPES.has(providerType)) {
    sendError(res, 404, 'NOT_FOUND', `Unknown provider type: ${providerType}`);
    return;
  }

  const body = await readBody(req);
  const prefix = `providers.${providerType === 'openai-compatible' ? 'openai-compat' : providerType}`;

  if (body.baseUrl && providerType === 'openai-compatible') {
    const { validateEndpointUrl } = await import("./ssrf-validator.js");
    const val = await validateEndpointUrl(body.baseUrl, { ssrfAllowPrivate: body.ssrfAllowPrivate });
    if (!val.valid) {
      sendError(res, 400, "SSRF_BLOCKED", val.error || "SSRF validation failed");
      return;
    }
  }

  const release = await writeMutex.acquire();
  try {
    if (body.apiKey) await ctx.settingsManager.set(`${prefix}.apiKey`, body.apiKey);
    if (body.model) await ctx.settingsManager.set(`${prefix}.model`, body.model);
    if (body.baseUrl && providerType === 'openai-compatible') await ctx.settingsManager.set(`${prefix}.baseUrl`, body.baseUrl);
  } finally {
    release();
  }

  broadcastSettingsChange(ctx, ['providers'], false, []);

  const result: Record<string, any> = { type: providerType };
  result.apiKey = ctx.settingsManager.get(`${prefix}.apiKey`).value;
  if (providerType === 'openai-compatible') result.baseUrl = ctx.settingsManager.get(`${prefix}.baseUrl`).value;
  if (body.model) result.model = body.model;

  sendJSON(res, 200, { provider: result, requiresRestart: false, restartAffected: [] });
}

export async function handleDeleteProvider(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SettingsHandlerContext,
  providerType: string,
): Promise<void> {
  const apiKey = (req as any).apiKey as ApiKeyEntry | undefined;
  if (!requireScope(res, apiKey, 'admin')) return;

  if (!VALID_PROVIDER_TYPES.has(providerType)) {
    sendError(res, 404, 'NOT_FOUND', `Unknown provider type: ${providerType}`);
    return;
  }

  const prefix = `providers.${providerType === 'openai-compatible' ? 'openai-compat' : providerType}`;

  // Check how many providers have keys configured
  let configuredCount = 0;
  for (const pType of ['openai', 'anthropic', 'glm', 'openai-compatible']) {
    const p = `providers.${pType === 'openai-compatible' ? 'openai-compat' : pType}.apiKey`;
    const val = ctx.settingsManager.get(p);
    if (val.value != null) configuredCount++;
  }

  if (configuredCount <= 1) {
    sendError(res, 422, 'VALIDATION_ERROR', 'Cannot remove the last configured provider.');
    return;
  }

  const release = await writeMutex.acquire();
  try {
    await ctx.settingsManager.reset(`${prefix}.apiKey`);
    try { await ctx.settingsManager.reset(`${prefix}.model`); } catch { /* may not exist */ }
    try { await ctx.settingsManager.reset(`${prefix}.baseUrl`); } catch { /* may not exist */ }
  } finally {
    release();
  }

  broadcastSettingsChange(ctx, ['providers'], false, []);

  sendJSON(res, 200, { removed: providerType, requiresRestart: false, restartAffected: [] });
}

// ── WS Handlers ───────────────────────────────────────────────────────────

export function handleWsGetSettings(
  msg: any,
  ws: WebSocket,
  state: ConnectionState,
  ctx: SettingsHandlerContext,
): void {
  if (!requireWsScope(state, 'agent:read')) {
    ws.send(JSON.stringify({ type: 'settings', id: msg.id, error: { code: 'FORBIDDEN', message: 'Requires agent:read scope' } }));
    return;
  }

  const all = ctx.settingsManager.listByCategory();
  const filtered = msg.category ? { [msg.category]: all[msg.category] ?? [] } : all;

  ws.send(JSON.stringify({ type: 'settings', id: msg.id, settings: filtered }));
}

export async function handleWsUpdateSettings(
  msg: any,
  ws: WebSocket,
  state: ConnectionState,
  ctx: SettingsHandlerContext,
): Promise<void> {
  if (!requireWsScope(state, 'admin')) {
    ws.send(JSON.stringify({ type: 'settings_updated', id: msg.id, error: { code: 'FORBIDDEN', message: 'Requires admin scope' } }));
    return;
  }

  const settings = msg.settings ?? {};
  const applied: Record<string, any> = {};
  const changedFields: string[] = [];
  const errors: Array<{ field: string; message: string }> = [];
  let requiresRestart = false;
  const restartAffected: string[] = [];

  const release = await writeMutex.acquire();
  try {
    for (const [cat, fields] of Object.entries(settings)) {
      if (typeof fields !== 'object' || fields === null) continue;
      applied[cat] = {};
      for (const [key, value] of Object.entries(fields as Record<string, any>)) {
        const dotKey = `${cat}.${key}`;
        try {
          await ctx.settingsManager.set(dotKey, String(value));
          applied[cat][key] = ctx.settingsManager.get(dotKey).value;
          changedFields.push(dotKey);
          const schema = SETTINGS_SCHEMA.get(dotKey);
          if (schema?.restartRequired) {
            requiresRestart = true;
            restartAffected.push(dotKey);
          }
        } catch (e: any) {
          errors.push({ field: dotKey, message: e.message });
        }
      }
    }
  } finally {
    release();
  }

  if (errors.length > 0) {
    ws.send(JSON.stringify({
      type: 'settings_updated', id: msg.id,
      error: { code: 'VALIDATION_ERROR', message: `${errors.length} field(s) failed validation`, details: errors },
    }));
    return;
  }

  // Respond to sender
  ws.send(JSON.stringify({ type: 'settings_updated', id: msg.id, applied, requiresRestart, restartAffected }));

  // Broadcast to others
  broadcastSettingsChange(ctx, changedFields, requiresRestart, restartAffected, ws);
}

// ── Broadcast ─────────────────────────────────────────────────────────────

function broadcastSettingsChange(
  ctx: SettingsHandlerContext,
  changedFields: string[],
  requiresRestart: boolean,
  restartAffected: string[],
  excludeWs?: WebSocket,
): void {
  const categories = new Set(changedFields.map(f => f.split('.')[0]));
  const message = JSON.stringify({
    type: 'settings_changed',
    changedCategories: [...categories],
    changedFields,
    requiresRestart,
    restartAffected,
    timestamp: new Date().toISOString(),
  });

  for (const client of ctx.getOtherClients(excludeWs)) {
    try { client.ws.send(message); } catch { /* best-effort */ }
  }
}
