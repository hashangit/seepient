/**
 * Shared capped request-body reader (021-4 W160).
 *
 * Every REST body read goes through here so the 10 MB / SEEPIENT_MAX_BODY_BYTES
 * cap (and the 413 PAYLOAD_TOO_LARGE envelope) applies uniformly — chat,
 * settings, gateway, and provider-management routes alike.
 * SEEPIENT_MAX_BODY_BYTES=0 disables the cap (unlimited).
 */

import type { IncomingMessage } from "http";
import type { RestHandlerContext } from "./rest.js";

export class PayloadTooLargeError extends Error {
  constructor(message = "Request payload exceeds maximum allowed size") {
    super(message);
    this.name = "PayloadTooLargeError";
  }
}

export function resolveMaxBodyBytes(ctx?: RestHandlerContext): number {
  if (process.env.SEEPIENT_MAX_BODY_BYTES !== undefined) {
    // 0 = unlimited (documented in docs/server/deployment.md)
    const parsed = parseInt(process.env.SEEPIENT_MAX_BODY_BYTES, 10);
    return isNaN(parsed) ? (ctx?.maxBodyBytes ?? 10 * 1024 * 1024) : parsed;
  }
  return ctx?.maxBodyBytes ?? 10 * 1024 * 1024;
}

export async function parseBody(req: IncomingMessage, ctx?: RestHandlerContext): Promise<string> {
  const maxBytes = resolveMaxBodyBytes(ctx);
  const clHeader = req.headers["content-length"];
  if (clHeader !== undefined) {
    const contentLength = parseInt(clHeader, 10);
    if (!isNaN(contentLength) && maxBytes > 0 && contentLength > maxBytes) {
      if (typeof req.pause === "function") {
        req.pause();
      }
      return Promise.reject(
        new PayloadTooLargeError(`Request body exceeded maximum limit of ${maxBytes} bytes`),
      );
    }
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (maxBytes > 0 && received > maxBytes) {
        if (typeof req.pause === "function") {
          req.pause();
        }
        reject(new PayloadTooLargeError(`Request body exceeded maximum limit of ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
