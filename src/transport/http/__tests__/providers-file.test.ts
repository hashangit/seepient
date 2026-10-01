/**
 * Operator provider channel (pass-10 P1-4 / OQ-I): the standalone server can
 * durably configure providers via an operator-owned file loaded once at boot
 * into an ISOLATED runtime — no ambient discovery, no host env fallback, and
 * the file is never written back to.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

describe("Operator providers file channel (R3-D, OQ-I)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("createRuntimeFromProvidersFile loads the overlay into an isolated runtime", async () => {
    const { createRuntimeFromProvidersFile } = await import("../../../domain/providers/provider-runtime.js");

    const dir = mkdtempSync(join(tmpdir(), "seepient-providers-file-"));
    dirs.push(dir);
    const providersFile = join(dir, "providers.json");
    writeFileSync(
      providersFile,
      JSON.stringify({
        providers: {
          "openai-main": {
            adapter: "pi-ai",
            upstreamProvider: "openai",
            credential: { kind: "seepient", id: "openai-main-key" },
          },
        },
        modelAssignments: {},
        credentials: {
          "openai-main-key": { kind: "api_key", keyValue: "sk-operator-file-key" },
        },
      }),
      "utf-8",
    );

    const runtime = await createRuntimeFromProvidersFile(providersFile);
    expect(runtime.isIsolated).toBe(true);
    expect((runtime as any).configStore.isIsolated).toBe(true);

    const config = await runtime.getConfig();
    expect(Object.keys(config.providers ?? {})).toContain("openai-main");

    // The file's credential seeds the isolated store; ambient host env keys
    // are never consulted.
    process.env.OPENAI_API_KEY = "sk-host-decoy-should-not-appear";
    const handle = await (runtime as any).credentialStore.resolve({ kind: "seepient", id: "openai-main-key" });
    const lease = handle.acquireLease();
    const secret = await lease.secret();
    const resolved = (secret as any)?.keyValue ?? (secret as any)?.value;
    expect(resolved).toBe("sk-operator-file-key");
  });

  it("missing or malformed file fails closed with a typed InferenceError", async () => {
    const { createRuntimeFromProvidersFile } = await import("../../../domain/providers/provider-runtime.js");
    const dir = mkdtempSync(join(tmpdir(), "seepient-providers-file-missing-"));
    dirs.push(dir);

    await expect(createRuntimeFromProvidersFile(join(dir, "nope.json"))).rejects.toMatchObject({
      name: "InferenceError",
    });
    const badFile = join(dir, "bad.json");
    writeFileSync(badFile, "{not json", "utf-8");
    await expect(createRuntimeFromProvidersFile(badFile)).rejects.toMatchObject({
      name: "InferenceError",
    });
  });

  it("runSeepientServer boots the file channel when providersFile is set (isolated stamp intact)", async () => {
    const { runSeepientServer } = await import("../index.js");
    const dir = mkdtempSync(join(tmpdir(), "seepient-providers-boot-"));
    dirs.push(dir);
    const providersFile = join(dir, "providers.json");
    writeFileSync(
      providersFile,
      JSON.stringify({
        providers: {
          "anthropic-main": {
            adapter: "pi-ai",
            upstreamProvider: "anthropic",
            credential: { kind: "seepient", id: "anthropic-key" },
          },
        },
        credentials: { "anthropic-key": { kind: "api_key", keyValue: "sk-ant-file" } },
      }),
      "utf-8",
    );

    let server: (Server & { runtime?: any }) | null = null;
    try {
      server = (await runSeepientServer({ port: 0, host: "127.0.0.1", providersFile })) as never;
      const runtime = (server as any).runtime ?? (server as any).getRuntime?.();
      expect(runtime).toBeDefined();
      expect(runtime.isIsolated).toBe(true);
      const config = await runtime.getConfig();
      expect(Object.keys(config.providers ?? {})).toContain("anthropic-main");
    } finally {
      if (server) await new Promise<void>((resolve) => (server as never as Server).close(() => resolve()));
    }
  });
});
