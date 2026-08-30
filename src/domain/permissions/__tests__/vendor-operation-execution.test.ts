import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryArtifactStore } from "../../../capabilities/execution/in-memory-artifact-store.js";
import { buildLocalBoundary } from "../../../capabilities/execution/build-local-boundary.js";
import { buildActionLifecycle, ALL_ANALYZERS } from "../action-lifecycle-factory.js";
import { createSnapshotStore } from "../../../foundations/hashline/snapshot-store.js";
import { createMediaVendorOperationHandler } from "../../media/vendor-operation-handler.js";
import type { ProviderRuntime } from "../../providers/provider-runtime.js";
import type { ApprovalBroker } from "../../../foundations/contracts/permission-policy.js";
import { diskBackedFakeHelper } from "../../../capabilities/execution/__tests__/helpers/commit-helper-fakes.js";
import { InferenceError } from "../../../foundations/errors.js";

function createStubRuntime(): ProviderRuntime {
  return {
    async createTurnSnapshot() {
      return {
        id: "turn-1",
        timestamp: Date.now(),
        models: [],
        providers: [],
      } as any;
    },
    async resolvePlan(_snapshot: any, purpose: string, _tier: any, _overrides?: any) {
      return {
        purpose,
        selectedTarget: {
          providerAccount: "test-provider",
          model: "test-model",
        },
      } as any;
    },
    async executeImage(_plan: any, _req: any, _options?: any) {
      return {
        images: [
          {
            bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            mimeType: "image/png",
          },
        ],
      };
    },
    async *executeLanguage(_plan: any, _req: any, _options?: any) {
      yield {
        type: "content_block_delta",
        delta: {
          type: "text_delta",
          text: "Optimized prompt for testing",
        },
      };
    },
  } as unknown as ProviderRuntime;
}

const noneBroker: ApprovalBroker = {
  mode: "none",
  async request(req) {
    return {
      approved: false,
      requestId: req.requestId,
      actionDigest: req.actionDigest,
      actorId: "none",
      decidedAt: Date.now(),
    };
  },
};

describe("vendor-operation execution with media handler (Fix 1)", () => {
  let dir: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-vendor-op-test-")));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("createMediaVendorOperationHandler executes generate_image and returns succeeded artifact", async () => {
    const runtime = createStubRuntime();
    const artifacts = new InMemoryArtifactStore();
    const handler = createMediaVendorOperationHandler({ runtime, artifacts });

    const result = await handler({
      kind: "vendor-operation",
      requestId: "req-img-1",
      connector: "media",
      operation: "generate_image",
      input: { prompt: "a cute robot" },
      secretRefs: [],
    });

    expect(result.status).toBe("succeeded");
    expect(result.output).toBeDefined();
    if (result.status === "succeeded" && result.output) {
      const bytes = await artifacts.read(result.output);
      expect(bytes.length).toBeGreaterThan(0);
    }
  });

  it("createMediaVendorOperationHandler executes optimize_prompt and returns succeeded text artifact", async () => {
    const runtime = createStubRuntime();
    const artifacts = new InMemoryArtifactStore();
    const handler = createMediaVendorOperationHandler({ runtime, artifacts });

    const result = await handler({
      kind: "vendor-operation",
      requestId: "req-opt-1",
      connector: "media",
      operation: "optimize_prompt",
      input: { raw_prompt: "write a poem" },
      secretRefs: [],
    });

    expect(result.status).toBe("succeeded");
    expect(result.output).toBeDefined();
    if (result.status === "succeeded" && result.output) {
      const bytes = await artifacts.read(result.output);
      const text = new TextDecoder().decode(bytes);
      expect(text).toBe("Optimized prompt for testing");
    }
  });

  it("CLI surface: end-to-end lifecycle executes optimize_prompt without EFFECT_UNSUPPORTED", async () => {
    const runtime = createStubRuntime();
    const snapshotStore = createSnapshotStore();
    const sharedArtifacts = new InMemoryArtifactStore();
    const vendorOperationHandler = createMediaVendorOperationHandler({
      runtime: () => runtime,
      artifacts: sharedArtifacts,
    });

    const { boundary } = await buildLocalBoundary({
      artifacts: sharedArtifacts,
      workspaceRoot: dir,
      snapshotStore,
      vendorOperationHandler,
    });

    const pipeline = await buildActionLifecycle({
      principalId: "cli-user",
      runId: "run-cli-1",
      sessionId: "session-1",
      workspaceRoot: dir,
      modelProviderClass: "openai",
      approvalBroker: noneBroker,
      approvalMode: "autonomous",
      executionBoundary: boundary,
      artifacts: sharedArtifacts,
      snapshotStore,
    });

    const action = await ALL_ANALYZERS.optimize_prompt(
      { raw_prompt: "draw a landscape" },
      {
        principalId: "cli-user",
        runId: "run-cli-1",
        toolCallId: "call-1",
        workspace: { workspaceId: "ws", canonicalRoot: dir, policyVersion: 1, policyDigest: "d" },
        artifacts: sharedArtifacts,
        modelProviderClass: "openai",
        snapshotStore,
      },
    );

    const execResult = await pipeline.lifecycle.run(action);

    expect(execResult.outcome.state).toBe("succeeded");
    expect(execResult.toolResult.success).toBe(true);
    expect(execResult.toolResult.output).not.toContain("EFFECT_UNSUPPORTED");
    expect(execResult.toolResult.output).toBe("Optimized prompt for testing");
  });

  it("CLI surface: end-to-end lifecycle executes generate_image without EFFECT_UNSUPPORTED", async () => {
    const runtime = createStubRuntime();
    const snapshotStore = createSnapshotStore();
    const sharedArtifacts = new InMemoryArtifactStore();
    const vendorOperationHandler = createMediaVendorOperationHandler({
      runtime: () => runtime,
      artifacts: sharedArtifacts,
    });

    const { boundary } = await buildLocalBoundary({
      artifacts: sharedArtifacts,
      workspaceRoot: dir,
      snapshotStore,
      vendorOperationHandler,
      commitHelper: diskBackedFakeHelper(),
    });

    const pipeline = await buildActionLifecycle({
      principalId: "cli-user",
      runId: "run-cli-2",
      sessionId: "session-2",
      workspaceRoot: dir,
      modelProviderClass: "openai",
      approvalBroker: noneBroker,
      approvalMode: "autonomous",
      executionBoundary: boundary,
      artifacts: sharedArtifacts,
      snapshotStore,
    });

    const action = await ALL_ANALYZERS.generate_image(
      { prompt: "cyberpunk cat", output_path: join(dir, "cat.png") },
      {
        principalId: "cli-user",
        runId: "run-cli-2",
        toolCallId: "call-2",
        workspace: { workspaceId: "ws", canonicalRoot: dir, policyVersion: 1, policyDigest: "d" },
        artifacts: sharedArtifacts,
        modelProviderClass: "openai",
        snapshotStore,
      },
    );

    const execResult = await pipeline.lifecycle.run(action);

    expect(execResult.outcome.state).toBe("succeeded");
    expect(execResult.toolResult.success).toBe(true);
    expect(execResult.toolResult.output).not.toContain("EFFECT_UNSUPPORTED");
  });

  it("SDK surface: end-to-end lifecycle with generateText wiring executes vendor operations", async () => {
    const runtime = createStubRuntime();
    const snapshotStore = createSnapshotStore();
    const sharedArtifacts = new InMemoryArtifactStore();
    const vendorOperationHandler = createMediaVendorOperationHandler({
      runtime,
      artifacts: sharedArtifacts,
    });

    const { boundary } = await buildLocalBoundary({
      artifacts: sharedArtifacts,
      workspaceRoot: dir,
      snapshotStore,
      vendorOperationHandler,
      commitHelper: diskBackedFakeHelper(),
    });

    const pipeline = await buildActionLifecycle({
      principalId: "sdk-user",
      runId: "run-sdk-1",
      workspaceRoot: dir,
      modelProviderClass: "openai",
      approvalBroker: noneBroker,
      approvalMode: "autonomous",
      executionBoundary: boundary,
      artifacts: sharedArtifacts,
      snapshotStore,
    });

    const action = await ALL_ANALYZERS.optimize_prompt(
      { raw_prompt: "explain quantum physics" },
      {
        principalId: "sdk-user",
        runId: "run-sdk-1",
        toolCallId: "call-sdk-1",
        workspace: { workspaceId: "ws", canonicalRoot: dir, policyVersion: 1, policyDigest: "d" },
        artifacts: sharedArtifacts,
        modelProviderClass: "openai",
        snapshotStore,
      },
    );

    const execResult = await pipeline.lifecycle.run(action);

    expect(execResult.outcome.state).toBe("succeeded");
    expect(execResult.toolResult.success).toBe(true);
    expect(execResult.toolResult.output).toBe("Optimized prompt for testing");
  });

  it("missing vendorOperationHandler returns actionable [setup required] error", async () => {
    const snapshotStore = createSnapshotStore();
    const sharedArtifacts = new InMemoryArtifactStore();

    // Built WITHOUT vendorOperationHandler:
    const { boundary } = await buildLocalBoundary({
      artifacts: sharedArtifacts,
      workspaceRoot: dir,
      snapshotStore,
      commitHelper: diskBackedFakeHelper(),
    });

    const pipeline = await buildActionLifecycle({
      principalId: "test-user",
      runId: "run-guard-1",
      workspaceRoot: dir,
      modelProviderClass: "openai",
      approvalBroker: noneBroker,
      approvalMode: "autonomous",
      executionBoundary: boundary,
      artifacts: sharedArtifacts,
      snapshotStore,
    });

    const action = await ALL_ANALYZERS.optimize_prompt(
      { raw_prompt: "test without handler" },
      {
        principalId: "test-user",
        runId: "run-guard-1",
        toolCallId: "call-guard-1",
        workspace: { workspaceId: "ws", canonicalRoot: dir, policyVersion: 1, policyDigest: "d" },
        artifacts: sharedArtifacts,
        modelProviderClass: "openai",
        snapshotStore,
      },
    );

    const execResult = await pipeline.lifecycle.run(action);

    expect(execResult.outcome.state).toBe("failed");
    expect(execResult.toolResult.success).toBe(false);
    expect(execResult.toolResult.output).toContain("[setup required] optimize_prompt needs a media vendor operation handler");
    expect(execResult.toolResult.output).toContain("seepient setup");
  });

  it("unconfigured image provider returns actionable SETUP_REQUIRED error", async () => {
    const artifacts = new InMemoryArtifactStore();
    const mockRuntime = {
      async createTurnSnapshot() {
        return { id: "turn-1", config: { providers: {} }, assignments: {} } as any;
      },
      async resolvePlan() {
        throw new InferenceError({
          code: "unconfigured_purpose",
          message: 'No model assignment configured for purpose "image-generation" (tier "standard")',
          retryable: false,
        });
      },
    } as unknown as ProviderRuntime;

    const handler = createMediaVendorOperationHandler({
      runtime: mockRuntime,
      artifacts,
    });

    const result = await handler({
      kind: "vendor-operation",
      requestId: "req-err-1",
      connector: "media",
      operation: "generate_image",
      input: { prompt: "a sunset over mountains" },
      secretRefs: [],
    });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("SETUP_REQUIRED");
    expect(result.error?.message).toContain("[setup required] generate_image needs a configured image provider");
    expect(result.error?.message).toContain("No model assignment configured for purpose \"image-generation\"");
  });

  it("inaccessible image provider (auth failure) returns distinct AUTH_FAILED error", async () => {
    const artifacts = new InMemoryArtifactStore();
    const mockRuntime = {
      async createTurnSnapshot() {
        return { id: "turn-1", config: { providers: {} }, assignments: {} } as any;
      },
      async resolvePlan() {
        return {
          purpose: "image-generation",
          selectedTarget: { providerAccount: "openai", model: "dall-e-3" },
        } as any;
      },
      async executeImage() {
        throw new InferenceError({
          code: "auth",
          message: "Incorrect API key provided",
          providerAccount: "openai",
          model: "dall-e-3",
          retryable: false,
        });
      },
    } as unknown as ProviderRuntime;

    const handler = createMediaVendorOperationHandler({
      runtime: mockRuntime,
      artifacts,
    });

    const result = await handler({
      kind: "vendor-operation",
      requestId: "req-err-2",
      connector: "media",
      operation: "generate_image",
      input: { prompt: "a cute kitten" },
      secretRefs: [],
    });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("AUTH_FAILED");
    expect(result.error?.message).toContain('Image provider "openai" is not accessible: authentication failed');
    expect(result.error?.message).toContain("Check your API key");
  });

  it("inaccessible image provider (timeout) returns distinct TIMEOUT error", async () => {
    const artifacts = new InMemoryArtifactStore();
    const mockRuntime = {
      async createTurnSnapshot() {
        return { id: "turn-1", config: { providers: {} }, assignments: {} } as any;
      },
      async resolvePlan() {
        return {
          purpose: "image-generation",
          selectedTarget: { providerAccount: "fal", model: "flux-schnell" },
        } as any;
      },
      async executeImage() {
        throw new InferenceError({
          code: "timeout",
          message: "Connection timed out after 60000ms",
          providerAccount: "fal",
          model: "flux-schnell",
          retryable: true,
        });
      },
    } as unknown as ProviderRuntime;

    const handler = createMediaVendorOperationHandler({
      runtime: mockRuntime,
      artifacts,
    });

    const result = await handler({
      kind: "vendor-operation",
      requestId: "req-err-3",
      connector: "media",
      operation: "generate_image",
      input: { prompt: "a futuristic city" },
      secretRefs: [],
    });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("TIMEOUT");
    expect(result.error?.message).toContain('Image provider "fal" is not accessible: request timed out');
    expect(result.error?.retryable).toBe(true);
  });

  it("duck-typed plain error with code property is classified properly", async () => {
    const artifacts = new InMemoryArtifactStore();
    const mockRuntime = {
      async createTurnSnapshot() {
        return { id: "turn-1", config: { providers: {} }, assignments: {} } as any;
      },
      async resolvePlan() {
        return {
          purpose: "image-generation",
          selectedTarget: { providerAccount: "stability", model: "sdxl" },
        } as any;
      },
      async executeImage() {
        const plainErr = new Error("Rate limit exceeded 429");
        (plainErr as any).code = "rate_limit";
        (plainErr as any).providerAccount = "stability";
        throw plainErr;
      },
    } as unknown as ProviderRuntime;

    const handler = createMediaVendorOperationHandler({
      runtime: mockRuntime,
      artifacts,
    });

    const result = await handler({
      kind: "vendor-operation",
      requestId: "req-err-4",
      connector: "media",
      operation: "generate_image",
      input: { prompt: "a portrait painting" },
      secretRefs: [],
    });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("RATE_LIMITED");
    expect(result.error?.message).toContain('Image provider "stability" is not accessible: rate limit exceeded');
    expect(result.error?.retryable).toBe(true);
  });
});
