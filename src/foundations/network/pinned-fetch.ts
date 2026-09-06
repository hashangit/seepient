/**
 * Pinned Fetch Mechanism — Domain Network (Spec 021-2 / FR-015, D11)
 *
 * Direct socket lookup-override mechanism. Connects only to caller-validated
 * IP addresses, never re-resolves DNS. Preserves original Host header and TLS SNI.
 * Contains NO policy, redirect logic, or range validation (those belong in the caller).
 */
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";

export interface PinnedFetchRequest {
  url: string; // original URL — source of Host header + TLS SNI
  ips: string[]; // caller-validated addresses; the ONLY addresses connected to
  method?: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxResponseBytes?: number;
  agent?: http.Agent | https.Agent;
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
  const rawHostname = parsedUrl.hostname;
  const hostname = rawHostname.startsWith("[") && rawHostname.endsWith("]")
    ? rawHostname.slice(1, -1)
    : rawHostname;
  const path = (parsedUrl.pathname || "/") + (parsedUrl.search || "");

  const pinnedIp = req.ips[0];
  const isV6 = pinnedIp.includes(":");
  const family = isV6 ? 6 : 4;
  const allAddresses = req.ips.map((ip) => ({
    address: ip,
    family: ip.includes(":") ? 6 : 4,
  }));

  const httpModule = isHttps ? https : http;

  const isHostnameIp = net.isIP(hostname) !== 0;

  return new Promise((resolvePromise, rejectPromise) => {
    // URL hostname wins over caller header — callers cannot pivot vhosts
    const headers: Record<string, string> = {};
    if (req.headers) {
      for (const [k, v] of Object.entries(req.headers)) {
        if (k.toLowerCase() !== "host") {
          headers[k] = v;
        }
      }
    }
    headers["host"] = parsedUrl.hostname;

    let timer: NodeJS.Timeout | undefined;
    let settled = false;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    const reject = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(err);
    };

    const resolve = (val: PinnedFetchResponse) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(val);
    };

    const reqOpts: https.RequestOptions = {
      method: (req.method ?? "GET").toUpperCase(),
      hostname: isHostnameIp ? pinnedIp : hostname,
      port,
      path,
      headers,
      servername: isHttps ? (isHostnameIp ? undefined : hostname) : undefined,
      agent: req.agent,
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

      // Post-flight effectiveIp ∈ resolvedIps rebinding re-check
      const normalizedSocketIp = socketIp.startsWith("::ffff:") ? socketIp.slice(7) : socketIp;
      if (!req.ips.includes(socketIp) && !req.ips.includes(normalizedSocketIp)) {
        clientReq.destroy();
        reject(new Error(`DNS rebinding detected: connection made to ${socketIp} not in validated IPs`));
        return;
      }

      const resHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers ?? {})) {
        if (typeof v === "string") resHeaders[k.toLowerCase()] = v;
        else if (Array.isArray(v)) resHeaders[k.toLowerCase()] = v.join(", ");
      }

      const chunks: Buffer[] = [];
      let receivedBytes = 0;

      res.on("data", (chunk: Buffer) => {
        receivedBytes += chunk.length;
        if (req.maxResponseBytes !== undefined && req.maxResponseBytes > 0 && receivedBytes > req.maxResponseBytes) {
          clientReq.destroy();
          reject(new Error(`Response size exceeded maximum limit of ${req.maxResponseBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });

      res.on("end", () => {
        const bytes = new Uint8Array(Buffer.concat(chunks));
        resolve({
          status: res.statusCode ?? 200,
          bytes,
          effectiveIp: socketIp,
          headers: resHeaders,
        });
      });

      res.on("error", (err) => {
        reject(err);
      });
    });

    if (req.timeoutMs !== undefined && req.timeoutMs > 0) {
      timer = setTimeout(() => {
        clientReq.destroy();
        reject(new Error(`Request timed out after ${req.timeoutMs}ms`));
      }, req.timeoutMs);
    }

    clientReq.on("error", (err) => {
      reject(err);
    });

    if (req.signal) {
      if (req.signal.aborted) {
        clientReq.destroy();
        reject(new Error("aborted"));
        return;
      }
      req.signal.addEventListener("abort", () => {
        clientReq.destroy();
        reject(new Error("aborted"));
      });
    }

    if (req.body && req.body.length > 0) {
      clientReq.write(Buffer.from(req.body));
    }
    clientReq.end();
  });
}
