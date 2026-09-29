/**
 * Credential sources invariant (spec 022-5, FR-005–FR-007).
 *
 * The demolition's core claim: no inference credential in Seepient resolves
 * from the environment, in single or multi mode, and no producer hands a
 * vendored SDK an undefined/empty key (the vendored layer falls back to host
 * env — ~40 names — whenever apiKey is undefined). The wire journey drives
 * the REAL vendored client against a loopback server and asserts the wire
 * Authorization header.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { PiLanguageRaw } from "../../../vendors/pi-ai/pi-language-raw.js";
import { OpenAIDiscoverySource } from "../../../vendors/openai/openai-discovery-source.js";
import { MemoryCredentialStore } from "../credentials/memory-credential-store.js";
import { CompositeCredentialStore, createAmbientCompositeCredentialStore } from "../credentials/composite-credential-store.js";
import { synthesizeBaseConfig } from "../config-store/provider-config-store.js";
import type { InferenceTarget } from "../../../foundations/contracts/backend-ports.js";

const PRODUCER_FILES = [
  "src/vendors/pi-ai/pi-language-raw.ts",
  "src/vendors/pi-ai/pi-image-raw.ts",
  "src/vendors/openai/openai-image-raw.ts",
  "src/vendors/google/google-image-raw.ts",
  "src/vendors/openai/openai-discovery-source.ts",
  "src/vendors/google/google-discovery-source.ts",
];

describe("022-5 US2: inference credentials, provider management only", () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.OPENAI_API_KEY = "sk-DECOY-host-operator-key";
    process.env.GEMINI_API_KEY = "sk-DECOY-gemini-host-key";
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it("producer enumeration: every vendored-client producer carries the tenancy-invariant gate (source pin)", () => {
    const repoRoot = join(import.meta.dirname, "../../../..");
    for (const rel of PRODUCER_FILES) {
      const src = readFileSync(join(repoRoot, rel), "utf-8");
      expect(src, `${rel} must carry the unconditional 022-5 FR-007 gate`).toContain("022-5 FR-00");
      expect(src, `${rel} must not gate the credential check on multi mode`).not.toMatch(
        /Multi-tenant (image )?inference requires/,
      );
    }
  });

  it("synthesis is gone: a fresh base config has zero providers even with decoy env keys", () => {
    const config = synthesizeBaseConfig();
    expect(Object.keys(config.providers ?? {})).toHaveLength(0);
  });

  it("single mode: a valueless api_key credential throws CREDENTIAL_REQUIRED (was: undefined to the vendored SDK)", async () => {
    const raw = new PiLanguageRaw();
    const target = {
      providerAccount: "acct",
      upstreamProvider: "openai",
      model: "gpt-4o",
      credential: {
        id: "cred-empty",
        ref: { kind: "seepient", id: "cred-empty" },
        activeLeaseCount: 0,
        isResolvable: async () => true,
        acquireLease: () => ({
          leaseId: "l1",
          isReleased: false,
          secret: async () => ({ kind: "api_key", value: undefined }),
          release: async () => {},
        }),
      },
    } as unknown as InferenceTarget;
    try {
      for await (const _ of raw.chatStream(
        target,
        { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } as never,
        { tenancyMode: "single" } as never,
      )) {
        /* no events expected */
      }
      expect.unreachable("valueless credential must not stream");
    } catch (err: unknown) {
      expect((err as Error).message).toMatch(/CREDENTIAL_REQUIRED/);
    }
  });

  it("wire journey: kind none reaches the real vendored client as the 'unused' sentinel — decoy env key never transmitted", async () => {
    const seen: { authorization?: string; url?: string } = {};
    const server: Server = createServer((req, res) => {
      seen.authorization = req.headers.authorization;
      seen.url = req.url;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "probe sink" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const raw = new PiLanguageRaw();
      const target = {
        providerAccount: "local-llm",
        upstreamProvider: "openai-compatible",
        model: "test-model",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        credential: {
          id: "cred-none",
          ref: { kind: "none" },
          activeLeaseCount: 0,
          isResolvable: async () => true,
          acquireLease: () => ({
            leaseId: "l1",
            isReleased: false,
            secret: async () => ({ kind: "none" }),
            release: async () => {},
          }),
        },
      } as unknown as InferenceTarget;
      try {
        for await (const _ of raw.chatStream(
          target,
          { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } as never,
          { tenancyMode: "single" } as never,
        )) {
          /* the sink 500s; stream errors */
        }
      } catch {
        /* expected — the sink rejects; the assertion is on the wire */
      }
      expect(seen.authorization).toBe("Bearer unused");
      expect(seen.authorization).not.toContain("sk-DECOY");
      expect(seen.url).toContain("/v1");
    } finally {
      server.close();
    }
  });

  it("discovery: a valueless api_key fails CREDENTIAL_REQUIRED before any vendor call", async () => {
    const store = new MemoryCredentialStore();
    const handle = await store.resolve({ kind: "seepient", id: "nope" });
    const source = new OpenAIDiscoverySource();
    const result = await source.discover({
      providerAccount: "acct",
      upstreamProvider: "openai",
      credential: {
        id: "x",
        ref: { kind: "seepient", id: "x" },
        activeLeaseCount: 0,
        isResolvable: async () => true,
        acquireLease: () => ({
          secret: async () => ({ kind: "api_key", value: undefined }),
          release: async () => {},
        }),
      },
      baseUrl: "http://127.0.0.1:9/v1",
    } as never);
    void handle;
    expect(result.modelIds).toHaveLength(0);
    expect(result.error).toMatch(/CREDENTIAL_REQUIRED/);
  });

  it("memory store: env-kind and valueless api_key records are rejected at put; resolveSecret never yields undefined", async () => {
    const store = new MemoryCredentialStore();
    await expect(store.put("env-cred", { kind: "env", name: "OPENAI_API_KEY" } as never)).rejects.toThrow(
      /environment-variable credentials are not supported/i,
    );
    await expect(store.put("empty-cred", { kind: "api_key", keyValue: "" })).rejects.toThrow(/keyValue/);
    await store.put("ok-cred", { kind: "api_key", keyValue: "sk-fine" });
    expect(store.resolveSecret("ok-cred")).toBe("sk-fine");
    expect(store.resolveSecret("missing")).toBeUndefined();
  });

  it.each([
    ["single", { tenancyMode: "single" }, "openai-compatible"],
    // Multi grants the loopback sink explicitly and uses a real upstream
    // (the openai-compatible synthetic fallback is multi-forbidden) — the
    // resolved key must be what reaches the wire.
    ["multi", { tenancyMode: "multi", capabilities: [{ kind: "network-destination", scheme: "http", host: "127.0.0.1" }] }, "openai"],
  ])("resolved-key wire journey (%s): the REAL stored key goes on the wire, decoys never do", async (_mode, opts, upstream) => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(String(req.headers.authorization ?? ""));
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "sink" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const store = new MemoryCredentialStore();
      await store.put("real-key-acct", { kind: "api_key", keyValue: "sk-real-resolved-key-123" });
      const raw = new PiLanguageRaw();
      const target = {
        providerAccount: "real-key-acct",
        upstreamProvider: upstream,
        model: "test-model",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        credential: {
          id: "real-key-acct",
          ref: { kind: "seepient", id: "real-key-acct" },
          activeLeaseCount: 0,
          isResolvable: async () => true,
          acquireLease: () => ({
            leaseId: "l",
            isReleased: false,
            secret: async () => ({ kind: "api_key", value: "sk-real-resolved-key-123" }),
            release: async () => {},
          }),
        },
      } as unknown as InferenceTarget;
      try {
        for await (const _ of raw.chatStream(target, { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } as never, opts as never)) {
          /* sink 500s; the wire is what is under test */
        }
      } catch {
        /* expected */
      }
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]).toBe("Bearer sk-real-resolved-key-123");
      expect(seen.join("\n")).not.toContain("sk-DECOY");
    } finally {
      server.close();
    }
  });

  it("google discovery decoy pin: the stored key rides x-goog-api-key, decoys never do (post-genai-major)", async () => {
    const headers: string[] = [];
    const server = createServer((req, res) => {
      headers.push(String(req.headers["x-goog-api-key"] ?? ""));
      res.writeHead(500);
      res.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const { GoogleDiscoverySource } = await import("../../../vendors/google/google-discovery-source.js");
      const source = new GoogleDiscoverySource();
      // The discovery URL is upstream-fixed for google — point the account at
      // nothing; the source builds its own URL, so assert via its returned
      // error path with a captured outbound? The source fetches google's
      // fixed URL, so this pin runs the REAL source against a decoy env and
      // asserts no decoy reaches any outbound request via the fetch spy.
      const fetchSpy2 = vi.spyOn(globalThis, "fetch");
      try {
        const store = new MemoryCredentialStore();
        await store.put("g", { kind: "api_key", keyValue: "sk-real-google-key" });
        const result = await source.discover({
          providerAccount: "g",
          upstreamProvider: "google",
          credential: {
            id: "g",
            ref: { kind: "seepient", id: "g" },
            activeLeaseCount: 0,
            isResolvable: async () => true,
            acquireLease: () => ({
              leaseId: "l",
              isReleased: false,
              secret: async () => ({ kind: "api_key", value: "sk-real-google-key" }),
              release: async () => {},
            }),
          } as never,
          baseUrl: `http://127.0.0.1:${port}`,
        } as never);
        void result;
        const outbound = fetchSpy2.mock.calls.map((c) => JSON.stringify(c[1] ?? {}));
        const combined = outbound.join("\n") + headers.join("\n");
        expect(combined).toContain("sk-real-google-key");
        expect(combined).not.toContain("sk-DECOY");
      } finally {
        fetchSpy2.mockRestore();
      }
    } finally {
      server.close();
    }
  });

  it("composite: env-kind refs fail closed in ambient mode too", async () => {
    process.env.COMPOSITE_AMBIENT_PROBE = "sk-ambient-should-never-resolve";
    const ambient = createAmbientCompositeCredentialStore();
    const handle = await ambient.resolve({ kind: "env", name: "COMPOSITE_AMBIENT_PROBE" });
    expect(await handle.isResolvable()).toBe(false);
    expect(() => handle.acquireLease()).toThrow(/CREDENTIAL_REQUIRED/);
    void CompositeCredentialStore;
  });
});
