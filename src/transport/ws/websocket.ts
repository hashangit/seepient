/**
 * Seepient Server — WebSocket Protocol Handler
 *
 * Re-export hub. Setup and teardown functions live here;
 * types and handlers are split into ws-types.ts and ws-handlers.ts.
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
import { closeAllConnections, getActiveConnectionCount } from "./connection-registry.js";

// Re-export types and helpers from sub-modules
export type { WebSocketHandlerContext } from "./ws-types.js";
export { getActiveConnectionCount } from "./connection-registry.js";

// ── Exported setup function ──────────────────────────────────────────

let wss: WSServer | null = null;

/**
 * Initialize the WebSocket server.
 *
 * Uses a dynamic import for the `ws` package. If it's not installed,
 * logs a warning and returns null.
 */
export async function setupWebSocket(
  server: import("http").Server,
  ctx: WebSocketHandlerContext,
): Promise<WSServer | null> {
  let wsModule: WS;
  try {
    // @ts-expect-error — ws is an optional peer dependency
    wsModule = (await import("ws")) as unknown as WS;
  } catch {
    console.warn(
      "[ws] The 'ws' package is not installed. WebSocket support is disabled.\n" +
        "       Install it with: npm install ws",
    );
    return null;
  }

  wss = new wsModule.WebSocketServer({ noServer: true, path: "/ws" });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    handleConnection(ws, req, ctx);
  });

  // Handle HTTP upgrade requests
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Only handle /ws upgrades
    const url = req.url?.split("?")[0];
    if (url !== "/ws") {
      return;
    }

    // Authenticate the upgrade request
    const key = authMiddleware(req);
    if (!key) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss!.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      wss!.emit("connection", ws, req);
    });
  });

  return wss;
}

/**
 * Close the WebSocket server and all active connections.
 */
export function closeWebSocket(): void {
  if (wss) {
    closeAllConnections();
    wss.close();
    wss = null;
  }
}
