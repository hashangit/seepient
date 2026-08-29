/**
 * generate_image destination through broker chaining (spec 019 FR-011,
 * T036, QS-1.6 a–d).
 *
 * (a) analysis with an output path adds the filesystem-write effect and
 *     performs no network I/O (action digest computed without the fetch);
 * (b) after dispatch the file lands on disk via FileCommitBroker (the
 *     envelope carried the commit-file cap because of the effect);
 * (c) envelope without the cap → fetch result discarded, write refused;
 * (d) without a destination → URL/base64 result, no write.
 * Plus the take_screenshot denial-message parity check (plan P1 step 3).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeGenerateImage } from "../../../capabilities/tools/analyzers.js";
import { BrokerExecutor } from "../../../capabilities/execution/executors.js";
import { FileCommitBroker } from "../../../capabilities/execution/file-commit-broker.js";
import { EffectBroker } from "../../../capabilities/execution/effect-broker.js";
import { InMemoryArtifactStore } from "../../../capabilities/execution/in-memory-artifact-store.js";
import { createSnapshotStore } from "../../../foundations/hashline/snapshot-store.js";
import { fakeCommitEnvelope, diskBackedFakeHelper, fakeHelper } from "../../../capabilities/execution/__tests__/helpers/commit-helper-fakes.js";
import type { ToolAnalysisContext } from "../../../foundations/contracts/custom-tools.js";
import type { CapabilityEnvelope, Capability } from "../../../foundations/contracts/permission-policy.js";

/** A minimal PNG header so "raw binary body" extraction has a real payload. */
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

/** Stub the OpenAI images API: JSON envelope with b64_json (the default). */
function b64JsonResponse(bytes: Buffer): { status: number; body: string; contentType: string } {
  return {
    status: 200,
    body: JSON.stringify({ data: [{ b64_json: bytes.toString("base64") }] }),
    contentType: "application/json",
  };
}

function envelopeFor(action: { actionDigest: string }, paths: string[]): CapabilityEnvelope {
  const caps: Capability[] = [
    { kind: "network-destination", scheme: "https", host: "api.openai.com" },
    { kind: "secret-ref", ref: "OPENAI_API_KEY" },
    ...paths.map((p) => ({ kind: "commit-file" as const, path: p })),
  ];
  // The envelope must carry THIS action's digest (lease authority binds the
  // envelope to the prepared action it was issued for).
  return {
    ...fakeCommitEnvelope(paths[0] ?? "/nowhere"),
    actionDigest: action.actionDigest,
    capabilities: caps,
  };
}

describe("image destination via broker chaining (spec 019)", () => {
  let dir: string;
  let artifacts: InMemoryArtifactStore;
  let ctx: ToolAnalysisContext;
  let effectBroker: EffectBroker;
  let fetchCalls: number;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-img-e2e-")));
    artifacts = new InMemoryArtifactStore();
    ctx = {
      principalId: "user",
      runId: "r1",
      toolCallId: "c1",
      workspace: { workspaceId: "ws", canonicalRoot: dir, policyVersion: 1, policyDigest: "d" },
      artifacts,
      modelProviderClass: "openai",
      snapshotStore: createSnapshotStore(),
    };
    fetchCalls = 0;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.OPENAI_API_KEY;
  });

  /** Build the effect broker with a stubbed network adapter that serves the
   *  given response (the broker is unit-tested through this seam). */
  function brokerWithResponse(response: { status: number; body: string }): EffectBroker {
    return new EffectBroker({
      artifacts,
      network: {
        async resolve() {
          return ["93.184.216.34"];
        },
        async fetch(destination, init) {
          void init;
          fetchCalls++;
          return {
            status: response.status,
            bytes: new Uint8Array(Buffer.from(response.body, "latin1")),
            effectiveHost: destination.host,
            effectiveIp: "93.184.216.34",
            headers: {},
          };
        },
      },
    });
  }

  async function runBroker(action: Awaited<ReturnType<typeof analyzeGenerateImage>>, envelope: CapabilityEnvelope, response: { status: number; body: string; contentType: string }) {
    const executor = new BrokerExecutor({
      broker: brokerWithResponse(response),
      artifacts,
      workspaceRoot: dir,
      commitBroker: new FileCommitBroker({ artifacts, helper: diskBackedFakeHelper() }),
    });
    return executor.execute(
      action,
      envelope,
      action.operation.kind === "broker" ? action.operation : (undefined as never),
      {},
    );
  }

  it("(a)+(b) destination declared → file lands via FileCommitBroker with the cap in the envelope", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const dest = join(dir, "sunset.png");
    const action = await analyzeGenerateImage({ prompt: "a sunset", image_path: dest }, ctx);
    expect(action.operation.kind).toBe("broker");

    const result = await runBroker(action, envelopeFor(action, [dest]), b64JsonResponse(PNG_BYTES));
    expect(result.state).toBe("succeeded");
    if (result.state === "succeeded") {
      expect(String(result.result.output)).toContain("sunset.png");
    }
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest)).toEqual(PNG_BYTES);
    expect(fetchCalls).toBe(1);
  });

  it("(c) envelope without the commit-file cap → fetch happens but the write is refused", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const dest = join(dir, "refused.png");
    const action = await analyzeGenerateImage({ prompt: "no cap", image_path: dest }, ctx);
    // An envelope that forgot the commit-file cap the effect demands.
    const envelope = envelopeFor(action, []);
    const result = await runBroker(action, envelope, b64JsonResponse(PNG_BYTES));
    expect(result.state).toBe("failed");
    if (result.state === "failed") {
      expect(result.error.message).toMatch(/refused|commit/i);
    }
    expect(existsSync(dest)).toBe(false);
  });

  it("(d) no destination → URL/base64 result, no write", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const action = await analyzeGenerateImage({ prompt: "no destination" }, ctx);
    expect(action.operation.kind).toBe("broker");
    if (action.operation.kind !== "broker") return;
    expect((action.operation.request as { outputCommit?: unknown }).outputCommit).toBeUndefined();

    const result = await runBroker(action, envelopeFor(action, []), b64JsonResponse(PNG_BYTES));
    expect(result.state).toBe("succeeded");
    if (result.state === "succeeded") {
      // The model sees the provider payload, not a saved file.
      expect(String(result.result.output)).not.toContain("saved to");
    }
    expect(fetchCalls).toBe(1);
  });

  it("(b2) raw binary body is committed when b64_json is absent", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const dest = join(dir, "raw.png");
    const action = await analyzeGenerateImage({ prompt: "raw body", image_path: dest }, ctx);
    const result = await runBroker(action, envelopeFor(action, [dest]), {
      status: 200,
      body: PNG_BYTES.toString("latin1"),
      contentType: "image/png",
    });
    expect(result.state).toBe("succeeded");
    expect(existsSync(dest)).toBe(true);
  });

  it("take_screenshot keeps its honest denial message (parity check)", async () => {
    // The screenshot analyzer answers with a none-op carrying the honest
    // unsupported message — unchanged by 019 (plan P1 step 3).
    const { analyzeTakeScreenshot } = await import("../../../capabilities/tools/analyzers.js");
    const action = await analyzeTakeScreenshot({}, ctx);
    expect(action.operation.kind).toBe("none");
    if (action.operation.kind !== "none") return;
    const output = String(action.operation.result.output ?? "");
    expect(output).toContain("browser worker");
  });
});
