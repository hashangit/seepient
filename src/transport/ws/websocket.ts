/**
 * Seepient Server — WebSocket Protocol Handler (W131: per-instance).
 *
 * `setupWebSocket` creates a per-instance WSS bound to the given HTTP server
 * and returns a handle with a scoped `close()`. No module-global state: two
 * servers in one process keep independent connections and upgrade handlers.
 *
 * NOTE: Requires the `ws` npm package for Node.js. Install it via:
 *   npm install ws
 *   npm install -D @types/ws
 *
 * The module uses a dynamic import so it fails gracefully if `ws` is missing.
 */

import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import { authMiddleware } from "../auth/auth.js";
import type { WS, WSServer, WebSocket, WebSocketHandlerContext } from "./ws-types.js";
import { handleConnection } from "./ws-handlers.js";
import { createConnectionRegistry } from "./connection-registry.js";

// Re-export types and helpers from sub-modules
export type { WebSocketHandlerContext, WsConnectionRegistry } from "./ws-types.js";
export { createConnectionRegistry, safeSend } from "./connection-registry.js";

// ── Handle returned by setupWebSocket ────────────────────────────────

export interface WsServerHandle {
  /** The per-instance WebSocketServer (null when the `ws` package is missing). */
  wss: WSServer | null;
  /** The per-instance registries used by this server's connections. */
  registry: WebSocketHandlerContext["registry"];
  /** Close this server's WebSocket connections and detach its upgrade handler. */
  close(): void;
}

// ── Exported setup function ──────────────────────────────────────────

/**
 * Initialize the WebSocket server for one HTTP server instance.
 *
 * Uses a dynamic import for the `ws` package. If it's not installed,
 * logs a warning and returns a handle with `wss: null`.
 */
export async function setupWebSocket(
  server: import("http").Server,
  ctx: WebSocketHandlerContext,
): Promise<WsServerHandle> {
  let wsModule: WS;
  try {
    // @ts-expect-error — ws is an optional peer dependency
    wsModule = (await import("ws")) as unknown as WS;
  } catch {
    console.warn(
      "[ws] The 'ws' package is not installed. WebSocket support is disabled.\n" +
        "       Install it with: npm install ws",
    );
    return { wss: null, registry: ctx.registry, close() {} };
  }

  const wss = new wsModule.WebSocketServer({ noServer: true, path: "/ws", maxPayload: 1 << 20 });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    handleConnection(ws, req, ctx);
  });

  // Handle HTTP upgrade requests — bound to THIS instance's wss
  const upgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // W146: non-/ws upgrades get an answer and a destroyed socket instead of
    // dangling forever.
    const url = req.url?.split("?")[0];
    if (url !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    // Authenticate the upgrade request
    const key = authMiddleware(req);
    if (!key) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    // W146: per-key connection cap (env-tunable, default 50).
    const keyHash = key.keyHash ?? "";
    const cap = parseInt(process.env.SEEPIENT_WS_MAX_CONNECTIONS_PER_KEY ?? "50", 10);
    if (!isNaN(cap) && cap > 0) {
      let current = 0;
      for (const state of ctx.registry.activeConnections.values()) {
        if (state.apiKeyHash === keyHash) current++;
      }
      if (current >= cap) {
        socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      wss.emit("connection", ws, req);
    });
  };
  server.on("upgrade", upgradeHandler);

  return {
    wss,
    registry: ctx.registry,
    close() {
      server.removeListener("upgrade", upgradeHandler);
      ctx.registry.closeAllConnections();
      wss.close();
    },
  };
}
