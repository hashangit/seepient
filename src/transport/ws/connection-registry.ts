/**
 * WebSocket Connection Registry & Active Connection State (W131).
 *
 * Registries are per-server-instance objects created via
 * `createConnectionRegistry()` — never module globals — so multiple
 * `runSeepientServer` instances can coexist in one process.
 */

import type {
  WebSocket,
  ServerMessage,
  ConnectionState,
  WsConnectionRegistry,
} from "./ws-types.js";
import { DurableApprovalStore } from "../../domain/permissions/durable-approval-store.js";

/**
 * Create a per-instance registry holding active connections, pending tool
 * approvals, and the durable approval store.
 */
export function createConnectionRegistry(): WsConnectionRegistry {
  const activeConnections = new Map<WebSocket, ConnectionState>();
  const pendingApprovals = new Map<string, {
    continuationId: string;
    resolve: (approved: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
    ws: WebSocket;
    toolName: string;
    createdAt: number;
  }>();
  const durableApprovalStore = new DurableApprovalStore();
  void durableApprovalStore.load();

  return {
    activeConnections,
    pendingApprovals,
    durableApprovalStore,

    getOtherClients(excludeWs?: WebSocket): Array<{ ws: WebSocket; state: ConnectionState }> {
      const clients: Array<{ ws: WebSocket; state: ConnectionState }> = [];
      for (const [ws, state] of activeConnections) {
        if (ws !== excludeWs) {
          clients.push({ ws, state });
        }
      }
      return clients;
    },

    getActiveConnectionCount(): number {
      return activeConnections.size;
    },

    closeAllConnections(): void {
      for (const [ws] of activeConnections) {
        try {
          ws.close(1001, "Server shutting down");
        } catch {
          // Ignore errors during shutdown
        }
      }
      activeConnections.clear();
    },
  };
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
