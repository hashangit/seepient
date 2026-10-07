/**
 * Spec 027 seam gates — RED-first (T003).
 *
 * One gate per seam. Each gate fails on the unsplit tree by construction and
 * flips green when its seam lands (T004 tools, T005 tokenizer, T006 media,
 * T007 provider dedupe, T008 execution-pipeline injection).
 *
 * This file deliberately imports engine files DIRECTLY (not via the full SDK
 * entry) so no full-side registration module runs — it observes the CORE
 * defaults: zero built-in tools, heuristic tokenizer, unregistered media,
 * single provider-SDK majors, and a light execution pipeline.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Gate (a): zero built-in tool exposure without injection (T004) ─────────

describe("027 seam (a): tools injection", () => {
  it("loop defaults expose no built-in tool definitions and unknown built-ins name seepient", async () => {
    const { ToolRegistry, resolveTools, getToolGroup } = await import(
      "../domain/tool-executor.js"
    );

    const reg = new ToolRegistry();
    expect(reg.definitions()).toEqual([]);

    // Group expansion with no injected modules exposes nothing either.
    expect(getToolGroup("all")).toEqual([]);

    // Registering/asking for an unavailable built-in fails closed naming seepient.
    expect(() => resolveTools(["read_file"], reg)).toThrow(/seepient/);
  });
});

// ── Gate (b): tokenizer heuristic fallback (T005) ───────────────────────────

// The vendor IS resolvable in-repo; the mock simulates a core-only install
// where the exact-BPE package is absent (factory throw = unresolvable module).
vi.mock("../vendors/gpt-tokenizer.js", () => {
  throw new Error("simulated: exact-BPE vendor unresolvable (core-only install)");
});

describe("027 seam (b): tokenizer fallback", () => {
  it("estimateMode is heuristic when the BPE vendor is unresolvable", async () => {
    const tokenizer = await import("../capabilities/tokenizer/tokenizer.js");
    const mode =
      (tokenizer as { currentEstimateMode?: () => string }).currentEstimateMode?.();
    expect(mode).toBe("heuristic");
    expect(tokenizer.countTokens("hello world, estimating without BPE")).toBeGreaterThan(0);
  });
});

// ── Gate (c): media/image registration denial (T006) ────────────────────────

describe("027 seam (c): media registration", () => {
  it("media handler and direct-SDK image backends are unregistered by default and deny typed", async () => {
    const seams = (await import("../domain/injection-seams.js")) as {
      getMediaVendorOperationHandlerFactory?: () => unknown;
    };
    expect(seams.getMediaVendorOperationHandlerFactory?.()).toBeUndefined();

    const { AggregateInferenceAdapter } = await import(
      "../capabilities/inference/aggregate-adapter.js"
    );
    const adapter = new AggregateInferenceAdapter(undefined, [], undefined);
    const target = {
      providerAccount: "acct",
      model: "gpt-image-1",
      upstreamProvider: "openai",
    } as never;
    const bound = await adapter.bind(
      target,
      [
        {
          id: "gpt-image-1",
          upstreamProvider: "openai",
          displayName: "gpt-image-1",
          contextWindow: 4096,
          capabilities: { toolUse: false, streaming: false, vision: false, imageGenerate: true },
          provenance: "seepient-curated",
          reachableVia: ["acct"],
        } as never,
      ],
    );
    expect(bound.images).toBeDefined();
    await expect(
      bound.images!.generate({ prompt: "a cup of coffee", n: 1 } as never),
    ).rejects.toThrow(/seepient-core/);
  });
});

// ── Gate (d): one version of each provider SDK (T007) ───────────────────────

describe("027 seam (d): provider-SDK dedupe", () => {
  it("pnpm-lock.yaml carries exactly pi-ai's single version of each provider SDK", async () => {
    const { readFileSync } = await import("node:fs");
    const lock = readFileSync(new URL("../../pnpm-lock.yaml", import.meta.url), "utf8");
    const piAiPkg = JSON.parse(
      readFileSync(
        new URL("../../node_modules/@earendil-works/pi-ai/package.json", import.meta.url),
        "utf8",
      ),
    ) as { dependencies?: Record<string, string> };

    const sdks = ["openai", "@google/genai", "@anthropic-ai/sdk"];
    for (const sdk of sdks) {
      const expectedPin = piAiPkg.dependencies?.[sdk];
      expect(expectedPin, `pi-ai must pin ${sdk}`).toBeTruthy();
      const versions = new Set<string>();
      // Lockfile keys carry peer-suffixes (openai@7.19.0(ws@8.22.0)(zod@…)) —
      // dedupe on the BASE version.
      for (const match of lock.matchAll(new RegExp(`'?${sdk}@([0-9][^'(:\\s]*)'?:`, "g"))) {
        versions.add(match[1]);
      }
      expect(
        [...versions],
        `${sdk} must resolve to exactly pi-ai's pin ${expectedPin}`,
      ).toEqual([expectedPin]);
    }
  });
});

// ── Gate (e): light default pipeline — no full-side module loads (T008) ─────

const { loadedFullModules } = vi.hoisted(() => ({
  loadedFullModules: [] as string[],
}));

vi.mock("../capabilities/execution/build-local-boundary.js", () => {
  loadedFullModules.push("build-local-boundary");
  return { buildLocalBoundary: async () => ({ boundary: {}, artifacts: {} }) };
});
vi.mock("../capabilities/execution/effect-broker.js", () => {
  loadedFullModules.push("effect-broker");
  return { EffectBroker: class {}, NodeNetworkAdapter: class {} };
});
vi.mock("../vendors/sandbox-runtime/index.js", () => {
  loadedFullModules.push("sandbox-runtime");
  return { createNativeProcessSandbox: async () => ({ probe: { backend: "none" } }), UncontainedSandbox: class {} };
});

describe("027 seam (e): light default pipeline", () => {
  it("a stateless createSeepient turn with a trustedHostTool completes without loading full-side modules", async () => {
    const { createSeepient } = await import("../transport/sdk/seepient.js");
    const { trustedHostTool } = await import("../transport/sdk/custom-tools.js");
    const { createMockRuntime } = await import("../domain/__tests__/test-doubles.js");

    const executed: string[] = [];
    const echo = trustedHostTool({
      name: "echo",
      description: "echoes its input",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      trust: "host",
      execute: async (args: { text: string }) => {
        executed.push(args.text);
        return `echo:${args.text}`;
      },
    } as never);

    const runtime = createMockRuntime([
      { toolCalls: [{ id: "tc1", name: "echo", args: { text: "hi" } }] },
      { content: "turn complete" },
    ]);

    const dir = mkdtempSync(join(tmpdir(), "seepient-027-gate-e-"));
    try {
      const agent = await createSeepient({
        stateless: true,
        tenancy: "single",
        runtime: runtime as never,
        tools: [echo],
        cwd: dir,
        approveTool: async () => true,
      } as never);

      const res = await agent.chat("say hi using the echo tool");
      expect(res.text).toBe("turn complete");
      expect(executed).toEqual(["hi"]);
      expect(loadedFullModules).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
