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

export interface ConnectionRegistryOptions {
  durableApprovalStore?: DurableApprovalStore;
  inMemory?: boolean;
}

/**
 * Create a per-instance registry holding active connections, pending tool
 * approvals, and the durable approval store.
 */
export function createConnectionRegistry(opts?: ConnectionRegistryOptions): WsConnectionRegistry {
  const activeConnections = new Map<WebSocket, ConnectionState>();
  const pendingApprovals = new Map<string, {
    continuationId: string;
    resolve: (approved: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
    ws: WebSocket;
    toolName: string;
    createdAt: number;
  }>();
  const durableApprovalStore =
    opts?.durableApprovalStore ??
    new DurableApprovalStore({ inMemory: opts?.inMemory ?? true });
  void durableApprovalStore.load().catch(() => {});

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

/** Egress backpressure cap: a tenant that stops reading while answering
 * pings would otherwise buffer unbounded stream data in the shared process
 * (pass-10 P2-1). Over the cap the connection is terminated, not paused, so
 * the client sees a clean close instead of a server OOM. */
const MAX_BUFFERED_SEND_BYTES = 4 * 1024 * 1024;

export function safeSend(ws: WebSocket, message: ServerMessage | Record<string, any>): void {
  try {
    if (ws.readyState === 1 /* OPEN */) {
      if (ws.bufferedAmount > MAX_BUFFERED_SEND_BYTES) {
        ws.close(1013, "Send buffer overflow: client not reading");
        return;
      }
      ws.send(JSON.stringify(message));
    }
  } catch {
    // Connection may have closed
  }
}
