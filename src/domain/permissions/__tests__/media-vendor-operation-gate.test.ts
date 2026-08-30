import { describe, it, expect } from "vitest";
import { ALL_ANALYZERS } from "../action-lifecycle-factory.js";
import { InMemoryArtifactStore } from "../../../capabilities/execution/in-memory-artifact-store.js";
import { createSnapshotStore } from "../../../foundations/hashline/snapshot-store.js";
import type { ToolAnalysisContext } from "../../../foundations/contracts/custom-tools.js";

function makeContext(overrides?: Partial<ToolAnalysisContext>): ToolAnalysisContext {
  return {
    principalId: "test-user",
    runId: "test-run",
    toolCallId: "test-call-1",
    workspace: {
      workspaceId: "test-ws",
      canonicalRoot: "/workspace",
      policyVersion: 1,
      policyDigest: "test-digest",
    },
    artifacts: new InMemoryArtifactStore(),
    modelProviderClass: "test-provider",
    snapshotStore: createSnapshotStore(),
    ...overrides,
  };
}

describe("Media tools in ALL_ANALYZERS registry (Task 1 regression gate)", () => {
  it("generate_image emits a vendor-operation broker request with no hardcoded OpenAI references", async () => {
    const ctx = makeContext();
    const action = await ALL_ANALYZERS.generate_image({ prompt: "A rocket launching" }, ctx);

    expect(action.toolName).toBe("generate_image");
    expect(action.operation.kind).toBe("broker");
    if (action.operation.kind === "broker") {
      expect(action.operation.request.kind).toBe("vendor-operation");
      if (action.operation.request.kind === "vendor-operation") {
        expect(action.operation.request.connector).toBe("media");
        expect(action.operation.request.operation).toBe("generate_image");
        expect(action.operation.request.secretRefs).not.toContain("OPENAI_API_KEY");
      }
    }

    // Effect assertions: model-egress + network-egress, no secret-use for OpenAI
    const effectKinds = action.effects.map((e) => e.kind);
    expect(effectKinds).toContain("model-egress");
    expect(effectKinds).toContain("network-egress");
    expect(effectKinds).not.toContain("secret-use");
  });

  it("generate_image with output_path declares filesystem-write effect and outputCommit on vendor-operation", async () => {
    const ctx = makeContext();
    const action = await ALL_ANALYZERS.generate_image(
      { prompt: "A rocket launching", output_path: "/workspace/rocket.png" },
      ctx,
    );

    const effectKinds = action.effects.map((e) => e.kind);
    expect(effectKinds).toContain("filesystem-write");

    expect(action.operation.kind).toBe("broker");
    if (action.operation.kind === "broker") {
      expect(action.operation.request.kind).toBe("vendor-operation");
      if (action.operation.request.kind === "vendor-operation") {
        expect((action.operation.request as any).outputCommit).toBeDefined();
        expect((action.operation.request as any).outputCommit.destination.canonicalPath).toBe("/workspace/rocket.png");
      }
    }
  });

  it("generate_image with output_dir derives deterministic filename and declares filesystem-write effect", async () => {
    const ctx = makeContext();
    const action = await ALL_ANALYZERS.generate_image(
      { prompt: "A rocket launching", output_dir: "/workspace/images" },
      ctx,
    );

    const effectKinds = action.effects.map((e) => e.kind);
    expect(effectKinds).toContain("filesystem-write");

    if (action.operation.kind === "broker" && action.operation.request.kind === "vendor-operation") {
      const outputCommit = (action.operation.request as any).outputCommit;
      expect(outputCommit).toBeDefined();
      expect(outputCommit.destination.canonicalPath.startsWith("/workspace/images/")).toBe(true);
      expect(outputCommit.destination.canonicalPath.endsWith(".png")).toBe(true);
    }
  });

  it("generate_image returns SETUP_REQUIRED when imageCapabilityProbe reports unreachable", async () => {
    const ctx = makeContext({
      imageCapabilityProbe: async () => ({
        reachable: false,
        reason: 'No model assignment configured for purpose "image-generation"',
      }),
    });

    const action = await ALL_ANALYZERS.generate_image({ prompt: "A rocket launching" }, ctx);
    expect(action.operation.kind).toBe("none");
    if (action.operation.kind === "none") {
      expect(action.operation.result.success).toBe(false);
      expect(action.operation.result.metadata?.code).toBe("SETUP_REQUIRED");
      expect(action.operation.result.output).toContain("[setup required]");
      expect(action.operation.result.output).toContain("/models");
    }
  });

  it("optimize_prompt emits a vendor-operation broker request with no hardcoded OpenAI REST destination", async () => {
    const ctx = makeContext();
    const action = await ALL_ANALYZERS.optimize_prompt({ raw_prompt: "Draw a mountain" }, ctx);

    expect(action.toolName).toBe("optimize_prompt");
    expect(action.operation.kind).toBe("broker");
    if (action.operation.kind === "broker") {
      expect(action.operation.request.kind).toBe("vendor-operation");
      if (action.operation.request.kind === "vendor-operation") {
        expect(action.operation.request.connector).toBe("media");
        expect(action.operation.request.operation).toBe("optimize_prompt");
        expect(action.operation.request.secretRefs).not.toContain("OPENAI_API_KEY");
      }
    }
    const effectKinds = action.effects.map((e) => e.kind);
    expect(effectKinds).toContain("model-egress");
    expect(effectKinds).not.toContain("secret-use");
  });

  it("EffectBroker does not inject Authorization header for api.openai.com HTTP requests", async () => {
    const { EffectBroker } = await import("../../../capabilities/execution/effect-broker.js");
    let capturedHeaders: Record<string, string> = {};
    const artifacts = new InMemoryArtifactStore();
    const broker = new EffectBroker({
      artifacts,
      network: {
        resolve: async () => ["93.184.216.34"],
        fetch: async (_dest, init) => {
          capturedHeaders = (init.headers as Record<string, string>) || {};
          return {
            status: 200,
            bytes: new Uint8Array(),
            effectiveHost: "api.openai.com",
            effectiveIp: "93.184.216.34",
            headers: {},
          };
        },
      },
    });

    const envelope: any = {
      envelopeId: "env-1",
      actionDigest: "digest-1",
      capabilities: [
        { kind: "network-destination", scheme: "https", host: "api.openai.com" },
      ],
    };

    const result = await broker.execute(
      {
        kind: "http",
        requestId: "req-1",
        destination: { scheme: "https", host: "api.openai.com", pathPrefix: "/v1/models" },
        method: "GET",
        headers: {},
        secretRefs: [],
      },
      envelope,
      {
        leaseId: "env-1",
        actionDigest: "digest-1",
        expiresAt: Date.now() + 60_000,
        singleUseRequestId: "req-1",
      },
    );

    expect(result.status).toBe("succeeded");
    expect(capturedHeaders["authorization"]).toBeUndefined();
  });

  it("TrustedHostExecutor returns HOST_TOOL_NOT_REGISTERED when tool module has no handler", async () => {
    const { TrustedHostExecutor } = await import("../../../capabilities/execution/executors.js");
    const executor = new TrustedHostExecutor(new Map());

    const action: any = {
      toolName: "generate_image",
      actionDigest: "digest-1",
      operation: { kind: "trusted-host", registrationId: "generate_image", args: {} },
    };
    const envelope: any = {
      envelopeId: "env-1",
      actionDigest: "digest-1",
      capabilities: [{ kind: "trusted-host", toolName: "generate_image" }],
    };

    const res = await executor.execute(action, envelope, action.operation, {});
    expect(res.state).toBe("failed");
    if (res.state === "failed") {
      expect(res.error.code).toBe("HOST_TOOL_NOT_REGISTERED");
    }
  });
});
