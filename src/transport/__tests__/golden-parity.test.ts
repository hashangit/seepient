import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { ProviderConfigStore } from "../../domain/providers/config-store/provider-config-store.js";
import { MemoryCredentialStore } from "../../domain/providers/credentials/memory-credential-store.js";
import { ProviderRuntime } from "../../domain/providers/provider-runtime.js";
import { AggregateInferenceAdapter } from "../../capabilities/inference/aggregate-adapter.js";
import { createProviderManagerApi } from "../cli/provider-manager-api.js";
import { createSeepient } from "../sdk/seepient.js";
import { createRestHandler } from "../http/rest.js";
import { generateApiKey } from "../auth/auth.js";
import { EventEmitter } from "events";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

import { Readable } from "stream";

function createMockReqRes(method: string, url: string, headers: Record<string, string> = {}, body?: string) {
  const req = Readable.from(body ? [Buffer.from(body)] : []) as any;
  req.method = method;
  req.url = url;
  req.headers = headers;

  const res = new EventEmitter() as any;
  res.statusCode = 200;
  res.headers = {};
  res.body = "";
  res.setHeader = function(k: string, v: string) {
    this.headers[k.toLowerCase()] = v;
  };
  res.writeHead = function(code: number, headers?: Record<string, string>) {
    this.statusCode = code;
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        this.headers[k.toLowerCase()] = v;
      }
    }
  };
  res.end = function(data?: string) {
    if (data) this.body += data;
    this.emit("finish");
  };

  return { req, res };
}

describe("013 Golden Cross-Surface Parity (FR-039 / T056)", () => {
  const tempKeyPath = path.join(
    os.tmpdir(),
    `golden-parity-keys-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  process.env.SEEPIENT_API_KEYS_FILE = tempKeyPath;
  process.env.OPENAI_API_KEY = "sk-test-golden-parity";
  const adminKey = generateApiKey(["provider:admin", "provider:read"], { label: "golden-admin", filePath: tempKeyPath });

  afterAll(() => {
    delete process.env.SEEPIENT_API_KEYS_FILE;
    delete process.env.OPENAI_API_KEY;
    if (fs.existsSync(tempKeyPath)) {
      try { fs.unlinkSync(tempKeyPath); } catch {}
    }
  });

  it("produces identical outcomes across Controller, SDK, and Server HTTP handlers", async () => {
    // Setup isolated instances for Controller, SDK, and Server
    const configStore1 = new ProviderConfigStore(":memory:");
    const credStore1 = new MemoryCredentialStore();
    const runtime1 = new ProviderRuntime({ configStore: configStore1, credentialStore: credStore1 });
    const controller = createProviderManagerApi(runtime1);

    const configStore2 = new ProviderConfigStore(":memory:");
    const credStore2 = new MemoryCredentialStore();
    const sdk = await createSeepient({ credentials: credStore2 });

    const configStore3 = new ProviderConfigStore(":memory:");
    const credStore3 = new MemoryCredentialStore();
    const runtime3 = new ProviderRuntime({ configStore: configStore3, credentialStore: credStore3 });
    const serverHandler = createRestHandler({
      version: "0.2.2",
      startTime: Date.now(),
      listModels: () => ({}),
      listSkills: () => [],
      generateText: vi.fn(),
      sessionManager: { getSession: vi.fn() } as any,
      providerRuntime: runtime3,
    });

    // ── Operation 1: Add Provider Account ──────────────────────────────
    // 1a. Controller
    const cAdd = await controller.saveAccount({
      accountId: "openai-main",
      upstreamProvider: "openai",
      credential: { mode: "env", varName: "OPENAI_API_KEY" },
    });
    expect(cAdd.ok).toBe(true);

    // 1b. SDK
    const sAdd = await sdk.addProvider({
      accountId: "openai-main",
      upstreamProvider: "openai",
      credential: { mode: "env", varName: "OPENAI_API_KEY" },
    });
    expect(sAdd.ok).toBe(true);

    // 1c. Server HTTP
    const { req: r1, res: res1 } = createMockReqRes(
      "PUT",
      "/v1/providers/openai-main",
      { authorization: `Bearer ${adminKey.rawKey}`, "if-match": "0" },
      JSON.stringify({
        adapter: "pi-ai",
        upstreamProvider: "openai",
        credential: { kind: "env", name: "OPENAI_API_KEY" },
      }),
    );
    await new Promise<void>((resolve) => { res1.on("finish", () => resolve()); serverHandler(r1, res1); });
    expect(res1.statusCode).toBe(200);

    // ── Operation 2: Assign Model Slot ─────────────────────────────────
    // 2a. Controller
    const cAssign = await controller.setAssignment("text", "standard", {
      providerAccount: "openai-main",
      model: "gpt-4o",
    });
    expect(cAssign.ok).toBe(true);

    // 2b. SDK
    const sAssign = await sdk.setAssignment("text", "standard", {
      providerAccount: "openai-main",
      model: "gpt-4o",
    });
    expect(sAssign.ok).toBe(true);

    // 2c. Server HTTP
    const overlay3 = await configStore3.getOverlay();
    const { req: r2, res: res2 } = createMockReqRes(
      "PUT",
      "/v1/models/assignments/text/standard",
      { authorization: `Bearer ${adminKey.rawKey}`, "if-match": `${overlay3.revision}` },
      JSON.stringify({
        providerAccount: "openai-main",
        model: "gpt-4o",
      }),
    );
    await new Promise<void>((resolve) => { res2.on("finish", () => resolve()); serverHandler(r2, res2); });
    expect(res2.statusCode).toBe(200);

    // ── Operation 3: Assert Effective Config & Assignments Parity ────
    const state1 = await controller.getState();
    const assignSdk = sdk.getAssignments();
    const conf3 = await configStore3.getEffectiveConfig();

    expect(state1.assignments.text?.standard?.providerAccount).toBe("openai-main");
    expect(state1.assignments.text?.standard?.model).toBe("gpt-4o");

    expect(assignSdk.text?.standard?.providerAccount).toBe("openai-main");
    expect(assignSdk.text?.standard?.model).toBe("gpt-4o");

    expect(conf3.modelAssignments?.text?.standard?.providerAccount).toBe("openai-main");
    expect(conf3.modelAssignments?.text?.standard?.model).toBe("gpt-4o");

    // Check REST GET /v1/models/assignments matches
    const { req: rAssign, res: resAssign } = createMockReqRes("GET", "/v1/models/assignments", { authorization: `Bearer ${adminKey.rawKey}` });
    await new Promise<void>((resolve) => { resAssign.on("finish", () => resolve()); serverHandler(rAssign, resAssign); });
    expect(resAssign.statusCode).toBe(200);
    const serverAssignments = JSON.parse(resAssign.body);
    expect(serverAssignments.text?.standard?.providerAccount).toBe("openai-main");
    expect(serverAssignments.text?.standard?.model).toBe("gpt-4o");

    // ── Operation 4: Resolution Parity across Controller, SDK, and HTTP ──
    const ctrlResolve = await controller.resolvePreview("text", "standard");
    expect("ok" in ctrlResolve && ctrlResolve.ok === false).toBe(false);
    const ctrlRes = ctrlResolve as any;

    const sdkResolve = await sdk.resolve({ purpose: "text", tier: "standard" });
    expect(sdkResolve.providerAccount).toBe("openai-main");
    expect(sdkResolve.model.id).toBe("gpt-4o");

    const { req: rResolve, res: resResolve } = createMockReqRes(
      "POST",
      "/v1/models/resolve",
      { authorization: `Bearer ${adminKey.rawKey}` },
      JSON.stringify({ purpose: "text", tier: "standard" }),
    );
    await new Promise<void>((resolve) => { resResolve.on("finish", () => resolve()); serverHandler(rResolve, resResolve); });
    expect(resResolve.statusCode).toBe(200);
    const serverResolve = JSON.parse(resResolve.body);

    expect(ctrlRes.selectedTarget.providerAccount).toBe("openai-main");
    expect(ctrlRes.selectedTarget.model).toBe("gpt-4o");
    expect(serverResolve.selectedTarget.providerAccount).toBe("openai-main");
    expect(serverResolve.selectedTarget.model).toBe("gpt-4o");

    // ── Operation 5: Catalog Reachability Parity ───────────────────────
    const catSdk = await sdk.getCatalog();
    const { req: r3, res: res3 } = createMockReqRes("GET", "/v1/catalog", { authorization: `Bearer ${adminKey.rawKey}` });
    await new Promise<void>((resolve) => { res3.on("finish", () => resolve()); serverHandler(r3, res3); });
    const catServer = JSON.parse(res3.body);

    const modelCtrl = state1.models.find((m) => m.id === "gpt-4o" && m.upstreamProvider === "openai");
    const modelSdk = (catSdk as any[]).find((m) => m.id === "gpt-4o" && m.upstreamProvider === "openai");
    const modelServer = catServer.find((m: any) => m.id === "gpt-4o" && m.upstreamProvider === "openai");

    expect(modelCtrl?.reachableVia).toContain("openai-main");
    expect(modelSdk?.reachableVia).toContain("openai-main");
    expect(modelServer?.reachableVia).toContain("openai-main");

    // ── Operation 6: Delete Blocking & Deletion Parity ────────────────
    // Controller blocked delete
    const cBlockDel = await controller.deleteAccount("openai-main");
    expect(cBlockDel.ok).toBe(false);
    expect((cBlockDel as any).blocked).toBe(true);

    // Server HTTP blocked delete
    const { req: rDelBlock, res: resDelBlock } = createMockReqRes(
      "DELETE",
      "/v1/providers/openai-main",
      { authorization: `Bearer ${adminKey.rawKey}` },
    );
    await new Promise<void>((resolve) => { resDelBlock.on("finish", () => resolve()); serverHandler(rDelBlock, resDelBlock); });
    expect(resDelBlock.statusCode).toBe(409);

    // Clear assignments across all
    const cClear = await controller.clearAssignment("text", "standard");
    expect(cClear.ok).toBe(true);
    const sClear = await sdk.clearAssignment("text", "standard");
    expect(sClear.ok).toBe(true);

    const overlayClear = await configStore3.getOverlay();
    const { req: rClear, res: resClear } = createMockReqRes(
      "DELETE",
      "/v1/models/assignments/text/standard",
      { authorization: `Bearer ${adminKey.rawKey}`, "if-match": `${overlayClear.revision}` },
    );
    await new Promise<void>((resolve) => { resClear.on("finish", () => resolve()); serverHandler(rClear, resClear); });
    expect(resClear.statusCode).toBe(200);

    // Delete accounts cleanly across all
    const cDel = await controller.deleteAccount("openai-main");
    expect(cDel.ok).toBe(true);
    const sDel = await sdk.removeProvider("openai-main");
    expect(sDel.ok).toBe(true);

    const overlayClean = await configStore3.getOverlay();
    const { req: rDelClean, res: resDelClean } = createMockReqRes(
      "DELETE",
      "/v1/providers/openai-main",
      { authorization: `Bearer ${adminKey.rawKey}`, "if-match": `${overlayClean.revision}` },
    );
    await new Promise<void>((resolve) => { resDelClean.on("finish", () => resolve()); serverHandler(rDelClean, resDelClean); });
    expect(resDelClean.statusCode).toBe(200);

    await sdk.dispose();
  });
});
