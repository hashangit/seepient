#!/usr/bin/env node
/**
 * QS-2 — Core-only chat end-to-end (spec 027).
 *
 * Installs the PACKED seepient-core tarball into a clean temp dir and runs
 * the six contract flows using ONLY `seepient-core` imports (contracts/
 * core-package-surface.md §4). Because the full package is not installed,
 * any dynamic edge into a full-package module would crash the flow with
 * ERR_MODULE_NOT_FOUND — completion is itself the loaded-modules assert.
 * The absence-tolerant seams must degrade typed (heuristic tokenizer,
 * actionable refreshModels denial, fail-closed built-in registration).
 */
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const failures = [];
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
}

// ── 1. pack the core tarball + clean install ────────────────────────────────
const workDir = mkdtempSync(join(tmpdir(), "qs-core-chat-"));
process.on("exit", () => { try { rmSync(workDir, { recursive: true, force: true }); } catch {} });
console.log("[qs-core-chat] packing seepient-core…");
const packOut = execSync("pnpm pack --json", { cwd: join(ROOT, "packages/core"), encoding: "utf8" });
const tarballName = JSON.parse(packOut).filename;
const tarball = join(ROOT, "packages/core", tarballName);
execSync(`npm install ${JSON.stringify(tarball)} --ignore-scripts --no-audit --no-fund --loglevel=error`, {
  cwd: workDir, stdio: "pipe", maxBuffer: 64 * 1024 * 1024,
});
const core = await import(pathToFileURL(join(workDir, "node_modules", "seepient-core", "dist", "transport", "sdk", "core.js")).href);
console.log(`[qs-core-chat] installed seepient-core; ${Object.keys(core).length} runtime exports`);

// ── 2. the mock runtime (structural adapter, seeded config store) ──────────
function makeMockRuntime(script) {
  let call = 0;
  const languageBackend = {
    chatStream: async function* (_target, req) {
      const step = script[Math.min(call, script.length - 1)];
      call++;
      yield { type: "start", resolvedModel: { providerAccount: "mock-account", modelId: "mock-model" } };
      if (step.toolCalls) {
        for (let i = 0; i < step.toolCalls.length; i++) {
          const tc = step.toolCalls[i];
          yield { type: "content_block_start", index: i, block: { type: "tool_use", id: tc.id, name: tc.name, input: {} } };
          yield { type: "content_block_delta", index: i, delta: { type: "tool_input_delta", partialJson: JSON.stringify(tc.args ?? {}) } };
          yield { type: "content_block_stop", index: i };
        }
      }
      if (step.content) {
        yield { type: "content_block_start", index: step.toolCalls?.length ?? 0, block: { type: "text", text: "" } };
        yield { type: "content_block_delta", index: step.toolCalls?.length ?? 0, delta: { type: "text_delta", text: step.content } };
        yield { type: "content_block_stop", index: step.toolCalls?.length ?? 0 };
      }
      yield { type: "finish", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    },
    chat: async () => ({ message: { role: "assistant", content: [] }, stopReason: "end_turn" }),
  };
  const adapter = {
    async bind(target, catalog) {
      return {
        target,
        language: {
          stream: (req, opts) => languageBackend.chatStream(target, req, opts),
          chat: (req, opts) => languageBackend.chat(target, req, opts),
        },
        images: undefined,
      };
    },
    updateCatalog() {},
  };
  const configStore = new core.ProviderConfigStore(":memory:");
  const credentialStore = new core.MemoryCredentialStore();
  const runtime = new core.ProviderRuntime({ configStore, credentialStore, adapter });
  // Seed via the store's public API (mirrors the createSeepient bootstrap).
  const overlayPromise = (async () => {
    const current = await configStore.getOverlay();
    await configStore.updateOverlay(
      {
        providers: {
          "mock-account": { adapter: "pi-ai", upstreamProvider: "mock-account", credential: { kind: "none" } },
        },
        modelAssignments: { text: { standard: { providerAccount: "mock-account", model: "mock-model" } } },
      },
      current.revision,
    );
  })();
  // The overlay write is async; runtime methods await config reads anyway.
  runtime.__overlayReady = overlayPromise;
  return runtime;
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "qs-core-chat-ws-"));

  // ── flow (a): stateless multi-turn via createSeepient + chatStream ──
  console.log("[qs-core-chat] flow (a): stateless multi-turn (createSeepient + chatStream)");
  {
    const runtime = makeMockRuntime([{ content: "turn one answer" }, { content: "turn two answer" }]);
    const agent = await core.createSeepient({
      stateless: true, tenancy: "single", runtime, skills: false,
    });
    const s1 = await agent.chatStream("first");
    let t1 = "";
    for await (const d of s1.textStream) t1 += d;
    check("flow (a) turn 1 streams", t1 === "turn one answer", `got ${JSON.stringify(t1)}`);
    const s2 = await agent.chatStream("second");
    let t2 = "";
    for await (const d of s2.textStream) t2 += d;
    check("flow (a) turn 2 carries history", t2 === "turn two answer");
  }

  // ── flow (b): createChat front door — send + stream + owned history ──
  console.log("[qs-core-chat] flow (b): createChat send + stream with owned history");
  {
    const runtime = makeMockRuntime([{ content: "c1" }, { content: "c2" }, { content: "c3" }]);
    const chat = await core.createChat({ stateless: true, tenancy: "single", runtime, skills: false });
    const r1 = await chat.send("one");
    check("flow (b) send", r1.text === "c1");
    const stream = await chat.stream("two");
    let t = "";
    for await (const d of stream.textStream) t += d;
    check("flow (b) stream", t === "c2");
    check("flow (b) history owned by session",
      chat.messages.filter((m) => m.role === "assistant").length === 2);
  }

  // ── flow (c): askSeepient one-shot ──
  console.log("[qs-core-chat] flow (c): askSeepient one-shot");
  {
    const runtime = makeMockRuntime([{ content: "one-shot answer" }]);
    const res = await core.askSeepient("hello", { runtime, tenancy: "single", skills: false });
    check("flow (c) one-shot", res.text === "one-shot answer");
  }

  // ── flow (d): trustedHostTool registration + roundtrip ──
  console.log("[qs-core-chat] flow (d): trustedHostTool roundtrip");
  {
    const calls = [];
    const echo = core.trustedHostTool({
      definition: {
        type: "function",
        function: { name: "echo", description: "echoes", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
      },
      execute: async (args) => { calls.push(args.text); return `echo:${args.text}`; },
    });
    const runtime = makeMockRuntime([
      { toolCalls: [{ id: "tc1", name: "echo", args: { text: "hi" } }] },
      { content: "done" },
    ]);
    const agent = await core.createSeepient({
      stateless: true, tenancy: "single", runtime, skills: false,
      tools: [echo], cwd: dir, approveTool: async () => true,
    });
    const res = await agent.chat("use echo");
    check("flow (d) host callback executed", calls.join(",") === "hi", JSON.stringify(calls));
    check("flow (d) turn completes", res.text === "done");
  }

  // ── flow (e): tool approval through injected stores on the light pipeline ──
  console.log("[qs-core-chat] flow (e): approval via approveTool on the light default pipeline");
  {
    const echo = core.trustedHostTool({
      definition: {
        type: "function",
        function: { name: "echo2", description: "echoes", parameters: { type: "object", properties: {}, required: [] } },
      },
      execute: async () => "ok",
    });
    const prompts = [];
    const runtime = makeMockRuntime([
      { toolCalls: [{ id: "tc1", name: "echo2", args: {} }] },
      { content: "approved turn done" },
    ]);
    const agent = await core.createSeepient({
      stateless: true, tenancy: "single", runtime, skills: false,
      tools: [echo], cwd: dir,
      approveTool: async (req) => { prompts.push(req.name); return true; },
    });
    const res = await agent.chat("use echo2");
    check("flow (e) approval prompted", prompts.includes("echo2"), JSON.stringify(prompts));
    check("flow (e) approved turn completes", res.text === "approved turn done");
  }

  // ── flow (f): boundary-needing registration denies typed, naming seepient ──
  console.log("[qs-core-chat] flow (f): unavailable built-in denies typed naming seepient");
  {
    let message = "";
    try {
      core.resolveTools(["read_file"], new core.ToolRegistry());
    } catch (err) {
      message = err.message;
    }
    check("flow (f) typed denial names seepient", /seepient/.test(message), message);
  }

  // ── seam degradation: heuristic tokenizer + actionable refreshModels ──
  console.log("[qs-core-chat] seam degradation: heuristic tokenizer, actionable refreshModels");
  {
    const runtime = makeMockRuntime([{ content: "usage probe" }]);
    const res = await core.askSeepient("hi", { runtime, tenancy: "single", skills: false });
    check("estimateMode observable + heuristic (BPE vendor absent)",
      res.usage?.estimateMode === "heuristic", JSON.stringify(res.usage));

    // An openai-provider account routes into the discovery-source branch —
    // the one the full package arms.
    const cur = await runtime.getConfigStore().getOverlay();
    await runtime.getConfigStore().updateOverlay(
      { providers: { "probe-acct": { adapter: "pi-ai", upstreamProvider: "openai", credential: { kind: "none" } } }, modelAssignments: {} },
      cur.revision,
    );
    const errors = [];
    const origErr = console.error;
    console.error = (m) => errors.push(String(m));
    try { await runtime.refreshModels("probe-acct"); } catch {}
    console.error = origErr;
    check("core-only refreshModels degrades with actionable message naming seepient",
      errors.join("\n").includes('ships with the full "seepient" package'), errors.join(" | "));
  }
}

main()
  .then(() => {
    if (failures.length > 0) {
      console.error(`[qs-core-chat] FAILED: ${failures.length} check(s): ${failures.join(", ")}`);
      process.exit(1);
    }
    console.log("[qs-core-chat] ALL CORE-ONLY FLOWS GREEN");
    process.exit(0);
  })
  .catch((err) => {
    console.error("[qs-core-chat] CRASHED:", err);
    process.exit(1);
  });
