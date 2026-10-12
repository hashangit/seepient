#!/usr/bin/env node
/**
 * Review round-2 P2-5: the compiled-full exact-BPE pin.
 *
 * exact-arming.test.ts runs through the vitest src alias, and qs-core-chat
 * asserts core-only heuristic — nothing imported the BUILT root entry and
 * asserted estimateMode === "exact". This class already fired once silently
 * (the loader was inert in the compiled full package for one commit). This
 * script imports the real dist output — no vitest, no alias — and asserts
 * the full package counts exactly.
 *
 * Run after `pnpm run build`. Exit 1 on any failure.
 */
import { mkdtempSync, rmSync } from "node:fs";
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

// The REAL compiled artifacts — a plain-node import resolves the root
// package's dist output and its seepient-core dependency through the
// workspace symlink. No vitest alias, no src.
const fullEntry = await import(pathToFileURL(join(ROOT, "dist", "transport", "sdk", "index.js")).href);

async function makeMockRuntime(script) {
  let call = 0;
  const languageBackend = {
    chatStream: async function* (_target, req) {
      const step = script[Math.min(call, script.length - 1)];
      call++;
      yield { type: "start", resolvedModel: { providerAccount: "mock-account", modelId: "mock-model" } };
      if (step.content) {
        yield { type: "content_block_start", index: 0, block: { type: "text", text: "" } };
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: step.content } };
        yield { type: "content_block_stop", index: 0 };
      }
      yield { type: "finish", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    },
    chat: async () => ({ message: { role: "assistant", content: [] }, stopReason: "end_turn" }),
  };
  const adapter = {
    async bind(target) {
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
  const configStore = new fullEntry.ProviderConfigStore(":memory:");
  const credentialStore = new fullEntry.MemoryCredentialStore();
  const runtime = new fullEntry.ProviderRuntime({ configStore, credentialStore, adapter });
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
  return runtime;
}

const dir = mkdtempSync(join(tmpdir(), "qs-dist-exact-"));
// Round-3 P2-2: the mock runtime's updateOverlay fires the provider audit
// trail — direct it at the temp dir instead of the operator's real
// ~/.seepient/audit.log (the created `dir` was previously never wired up).
process.env.SEEPIENT_AUDIT_LOG_PATH = join(dir, "provider-audit.log");
try {
  const runtime = await makeMockRuntime([{ content: "count me exactly" }]);
  const res = await fullEntry.askSeepient("hello", {
    runtime,
    tenancy: "single",
    skills: false,
  });
  check(
    "compiled full package reports estimateMode exact (FR-004)",
    res.usage?.estimateMode === "exact",
    JSON.stringify(res.usage),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`[qs-dist-exact] FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("[qs-dist-exact] compiled full package counts exactly");
