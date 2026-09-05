/**
 * Pinned Fetch Mechanism — Domain Network (Spec 021-2 / FR-015, D11)
 *
 * Direct socket lookup-override mechanism. Connects only to caller-validated
 * IP addresses, never re-resolves DNS. Preserves original Host header and TLS SNI.
 * Contains NO policy, redirect logic, or range validation (those belong in the caller).
 */
import * as http from "node:http";
import * as https from "node:https";

export interface PinnedFetchRequest {
  url: string; // original URL — source of Host header + TLS SNI
  ips: string[]; // caller-validated addresses; the ONLY addresses connected to
  method?: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
  signal?: AbortSignal;
}

export interface PinnedFetchResponse {
  status: number;
  headers: Record<string, string>;
  bytes: Uint8Array;
  effectiveIp: string;
}

export async function pinnedFetch(req: PinnedFetchRequest): Promise<PinnedFetchResponse> {
  if (!req.ips || req.ips.length === 0) {
    throw new Error("pinnedFetch requires at least one validated IP address");
  }

  const parsedUrl = new URL(req.url);
  const isHttps = parsedUrl.protocol === "https:";
  const port = parsedUrl.port ? parseInt(parsedUrl.port, 10) : (isHttps ? 443 : 80);
  const hostname = parsedUrl.hostname;
  const path = (parsedUrl.pathname || "/") + (parsedUrl.search || "");

  const pinnedIp = req.ips[0];
  const isV6 = pinnedIp.includes(":");
  const family = isV6 ? 6 : 4;
  const allAddresses = req.ips.map((ip) => ({
    address: ip,
    family: ip.includes(":") ? 6 : 4,
  }));

  const httpModule = isHttps ? https : http;

  return new Promise((resolvePromise, rejectPromise) => {
    const headers: Record<string, string> = {
      host: hostname,
      ...(req.headers ?? {}),
    };

    const reqOpts: https.RequestOptions = {
      method: (req.method ?? "GET").toUpperCase(),
      hostname,
      port,
      path,
      headers,
      servername: isHttps ? hostname : undefined,
      lookup: (
        _h: string,
        opts: { all?: boolean },
        cb: (
          err: Error | null,
          result: string | Array<{ address: string; family: number }>,
          family?: number,
        ) => void,
      ) => {
        if (opts?.all) cb(null, allAddresses);
        else cb(null, pinnedIp, family);
      },
    };

    const clientReq = httpModule.request(reqOpts, (res) => {
      const socketIp = res.socket?.remoteAddress || pinnedIp;
      const resHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers ?? {})) {
        if (typeof v === "string") resHeaders[k.toLowerCase()] = v;
        else if (Array.isArray(v)) resHeaders[k.toLowerCase()] = v.join(", ");
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const bytes = new Uint8Array(Buffer.concat(chunks));
        resolvePromise({
          status: res.statusCode ?? 200,
          bytes,
          effectiveIp: socketIp,
          headers: resHeaders,
        });
      });
      res.on("error", rejectPromise);
    });

    clientReq.on("error", rejectPromise);

    if (req.signal) {
      if (req.signal.aborted) {
        clientReq.destroy(new Error("aborted"));
        rejectPromise(new Error("aborted"));
        return;
      }
      req.signal.addEventListener("abort", () => {
        clientReq.destroy(new Error("aborted"));
        rejectPromise(new Error("aborted"));
      });
    }

    if (req.body && req.body.length > 0) {
      clientReq.write(Buffer.from(req.body));
    }
    clientReq.end();
  });
}
