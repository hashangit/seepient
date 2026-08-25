/**
 * WebSocket Connection Registry & Active Connection State
 */

import type {
  WebSocket,
  ServerMessage,
  ConnectionState,
} from "./ws-types.js";
import { DurableApprovalStore } from "../../domain/permissions/durable-approval-store.js";

// ── Active connections registry ──────────────────────────────────────

export const activeConnections = new Map<WebSocket, ConnectionState>();

// ── Pending tool approvals & durable store ───────────────────────────

export const durableApprovalStore = new DurableApprovalStore();
void durableApprovalStore.load();

export const pendingApprovals = new Map<string, {
  continuationId: string;
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  ws: WebSocket;
  toolName: string;
  createdAt: number;
}>();

/**
 * Get the number of currently active WebSocket connections.
 */
export function getActiveConnectionCount(): number {
  return activeConnections.size;
}

/**
 * Get all connected WS clients (excluding the given one).
 * Used by settings broadcast to notify other connections of changes.
 */
export function getOtherClients(
  excludeWs?: WebSocket,
): Array<{ ws: WebSocket; state: ConnectionState }> {
  const clients: Array<{ ws: WebSocket; state: ConnectionState }> = [];
  for (const [ws, state] of activeConnections) {
    if (ws !== excludeWs) {
      clients.push({ ws, state });
    }
  }
  return clients;
}

// ── Send helper ──────────────────────────────────────────────────────

export function safeSend(ws: WebSocket, message: ServerMessage): void {
  try {
    if (ws.readyState === 1 /* OPEN */) {
      ws.send(JSON.stringify(message));
    }
  } catch {
    // Connection may have closed
  }
}

// ── Active connections accessor (for closeWebSocket) ──────────────────

/**
 * Close all active connections and clear the registry.
 * Used by closeWebSocket() during shutdown.
 */
export function closeAllConnections(): void {
  for (const [ws] of activeConnections) {
    try {
      ws.close(1001, "Server shutting down");
    } catch {
      // Ignore errors during shutdown
    }
  }
  activeConnections.clear();
}
