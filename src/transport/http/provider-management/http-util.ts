/**
 * HTTP utilities for Provider Management REST handlers
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProviderRuntime } from "../../../domain/providers/provider-runtime.js";

export function sendJSON(res: ServerResponse, status: number, body: unknown, revision?: number): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  if (revision !== undefined) {
    res.setHeader("ETag", `"${revision}"`);
  }
  res.end(JSON.stringify(body));
}

export function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJSON(res, status, { error: { code, message } });
}

export async function parseBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        req.destroy();
        reject(new Error("PAYLOAD_TOO_LARGE"));
        return;
      }
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export function checkDeploymentMode(res: ServerResponse): boolean {
  if (process.env.SEEPIENT_DEPLOYMENT_MODE === "multiprocess") {
    sendError(res, 503, "SERVICE_UNAVAILABLE", "Mutations are not supported in multi-process deployment mode in v1");
    return false;
  }
  return true;
}

export function isConflictError(err: any): boolean {
  return (
    err?.code === "CONFLICT" ||
    err?.code === "PRECONDITION_FAILED" ||
    err?.message?.includes("mismatch") ||
    err?.message?.includes("stale")
  );
}

export async function parseIfMatch(
  req: IncomingMessage,
  res: ServerResponse,
  runtime?: ProviderRuntime,
): Promise<number | null> {
  const ifMatch = req.headers["if-match"];
  if (!ifMatch) {
    sendError(res, 428, "PRECONDITION_REQUIRED", "Header 'If-Match: <revision>' is required for mutations");
    return null;
  }
  if (ifMatch === "*") {
    if (runtime) {
      const overlay = await runtime.configStore.getOverlay();
      return overlay.revision;
    }
    return 0;
  }
  const clean = ifMatch.replace(/^"|"$/g, "");
  const rev = parseInt(clean, 10);
  if (isNaN(rev)) {
    sendError(res, 400, "BAD_REQUEST", "Invalid If-Match header value (must be an integer revision or '*')");
    return null;
  }
  return rev;
}
