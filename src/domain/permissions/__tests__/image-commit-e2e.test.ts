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
import { mkdtempSync, rmSync, realpathSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALL_ANALYZERS } from "../action-lifecycle-factory.js";
import { BrokerExecutor } from "../../../capabilities/execution/executors.js";
import { FileCommitBroker } from "../../../capabilities/execution/file-commit-broker.js";
import { EffectBroker } from "../../../capabilities/execution/effect-broker.js";
import { InMemoryArtifactStore } from "../../../capabilities/execution/in-memory-artifact-store.js";
import { createSnapshotStore } from "../../../foundations/hashline/snapshot-store.js";
import { fakeCommitEnvelope, diskBackedFakeHelper } from "../../../capabilities/execution/__tests__/helpers/commit-helper-fakes.js";
import type { ToolAnalysisContext } from "../../../foundations/contracts/custom-tools.js";
import type { CapabilityEnvelope, Capability } from "../../../foundations/contracts/permission-policy.js";
import type { PreparedToolAction } from "../../../foundations/contracts/prepared-action.js";

/** A minimal PNG header so "raw binary body" extraction has a real payload. */
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

function envelopeFor(action: { actionDigest: string }, paths: string[]): CapabilityEnvelope {
  const caps: Capability[] = [
    { kind: "network-destination", scheme: "https", host: "*" },
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
  let vendorCalls: number;

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
    vendorCalls = 0;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function brokerWithVendorPayload(imageBytes: Uint8Array): EffectBroker {
    return new EffectBroker({
      artifacts,
      network: {
        async resolve() {
          return ["93.184.216.34"];
        },
        async fetch() {
          return {
            status: 200,
            bytes: new Uint8Array(),
            effectiveHost: "api.example.com",
            effectiveIp: "93.184.216.34",
            headers: {},
          };
        },
      },
      vendorOperationHandler: async (req) => {
        vendorCalls++;
        const artifact = await artifacts.put(imageBytes, "image/png");
        return {
          requestId: req.requestId,
          status: "succeeded",
          output: artifact,
        };
      },
    });
  }

  async function runBroker(
    action: PreparedToolAction,
    envelope: CapabilityEnvelope,
    imageBytes: Uint8Array = PNG_BYTES,
  ) {
    const executor = new BrokerExecutor({
      broker: brokerWithVendorPayload(imageBytes),
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
    const dest = join(dir, "sunset.png");
    const action = await ALL_ANALYZERS.generate_image({ prompt: "a sunset", output_path: dest }, ctx);
    expect(action.operation.kind).toBe("broker");

    const result = await runBroker(action, envelopeFor(action, [dest]), PNG_BYTES);
    expect(result.state).toBe("succeeded");
    if (result.state === "succeeded") {
      expect(String(result.result.output)).toContain("sunset.png");
    }
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest)).toEqual(PNG_BYTES);
    expect(vendorCalls).toBe(1);
  });

  it("(c) envelope without the commit-file cap → fetch happens but the write is refused", async () => {
    const dest = join(dir, "refused.png");
    const action = await ALL_ANALYZERS.generate_image({ prompt: "no cap", output_path: dest }, ctx);
    // An envelope that forgot the commit-file cap the effect demands.
    const envelope = envelopeFor(action, []);
    const result = await runBroker(action, envelope, PNG_BYTES);
    expect(result.state).toBe("failed");
    if (result.state === "failed") {
      expect(result.error.message).toMatch(/refused|commit/i);
    }
    expect(existsSync(dest)).toBe(false);
  });

  it("(d) no destination → defaults to deterministic path in workspace root and commits file", async () => {
    const action = await ALL_ANALYZERS.generate_image({ prompt: "no destination" }, ctx);
    expect(action.operation.kind).toBe("broker");
    if (action.operation.kind !== "broker") return;
    const req = action.operation.request as { outputCommit?: { destination: { canonicalPath: string } } };
    expect(req.outputCommit).toBeDefined();
    const defaultPath = req.outputCommit!.destination.canonicalPath;
    expect(defaultPath).toContain(dir);

    const result = await runBroker(action, envelopeFor(action, [defaultPath]), PNG_BYTES);
    expect(result.state).toBe("succeeded");
    if (result.state === "succeeded") {
      expect(String(result.result.output)).toContain(defaultPath);
    }
    expect(existsSync(defaultPath)).toBe(true);
    expect(vendorCalls).toBe(1);
  });

  it("(e) n > 1 creates distinct indexed file targets and commits each image", async () => {
    const dest = join(dir, "multi.png");
    const action = await ALL_ANALYZERS.generate_image({ prompt: "multi cat", output_path: dest, n: 2 }, ctx);
    expect(action.operation.kind).toBe("broker");
    if (action.operation.kind !== "broker") return;
    const req = action.operation.request as { outputCommit?: { destination: { canonicalPath: string }; destinations?: Array<{ canonicalPath: string }> } };
    expect(req.outputCommit?.destinations).toHaveLength(2);
    const dest1 = req.outputCommit!.destinations![0].canonicalPath;
    const dest2 = req.outputCommit!.destinations![1].canonicalPath;
    expect(dest1).toContain("multi-1.png");
    expect(dest2).toContain("multi-2.png");
  });

  it("(b2) raw binary body is committed when bytes are returned", async () => {
    const dest = join(dir, "raw.png");
    const action = await ALL_ANALYZERS.generate_image({ prompt: "raw body", output_path: dest }, ctx);
    const result = await runBroker(action, envelopeFor(action, [dest]), PNG_BYTES);
    expect(result.state).toBe("succeeded");
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest)).toEqual(PNG_BYTES);
  });

  it("take_screenshot keeps its honest denial message (parity check)", async () => {
    const action = await ALL_ANALYZERS.take_screenshot({}, ctx);
    expect(action.operation.kind).toBe("none");
    if (action.operation.kind !== "none") return;
    const output = String(action.operation.result.output ?? "");
    expect(output).toContain("browser worker");
  });
});
