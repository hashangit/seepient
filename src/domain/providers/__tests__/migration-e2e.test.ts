import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ProviderConfigStore, clearBaseConfigCache } from "../config-store/provider-config-store.js";
import { ProviderRuntime } from "../provider-runtime.js";
import { CompositeCredentialStore } from "../credentials/composite-credential-store.js";
import { runAgentLoop } from "../../agent-loop.js";
import { createHookExecutor } from "../../hooks.js";

describe("Legacy Migration & Env Synthesis E2E (Discriminating GLM Test)", () => {
  const origEnv = { ...process.env };
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "seepient-mig-test-"));
    process.env = { ...origEnv, HOME: tempHome, USERPROFILE: tempHome, SEEPIENT_CWD: tempHome };
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GLM_API_KEY;
    clearBaseConfigCache();
  });

  afterEach(() => {
    process.env = origEnv;
    clearBaseConfigCache();
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
    } catch {}
  });

  it("migrates v1 setting.json with GLM provider and resolves credentials and plan to GLM", async () => {
    // 1. Create legacy v1 ~/.seepient/setting.json with GLM config
    const seepientDir = path.join(tempHome, ".seepient");
    fs.mkdirSync(seepientDir, { recursive: true });
    fs.writeFileSync(
      path.join(seepientDir, "setting.json"),
      JSON.stringify({
        provider: "glm",
        model: "glm-4.7",
        apiKey: "glm-secret-12345",
        models: {
          glm: {
            apiKey: "glm-secret-12345",
            model: "glm-4.7",
          },
        },
      }, null, 2),
      "utf-8",
    );

    const credentialStore = new CompositeCredentialStore();
    const configStore = new ProviderConfigStore(":memory:");
    const effective = await configStore.getEffectiveConfig();

    // Verify migration synthesized GLM as default, NOT hardcoded OpenAI
    expect(effective.providers.glm).toBeDefined();
    expect(effective.providers.glm.credential).toEqual({
      kind: "seepient",
      id: "glm-migrated",
    });
    expect(effective.modelAssignments.text.standard).toEqual({
      providerAccount: "glm",
      model: "glm-4.7",
    });

    // Verify migrated credential is saved and resolvable in credentialStore
    const handle = await credentialStore.resolve({
      kind: "seepient",
      id: "glm-migrated",
    });
    const lease = handle.acquireLease();
    const secret = await lease.secret();
    expect(secret.kind).toBe("api_key");
    if (secret.kind === "api_key") {
      expect(secret.value).toBe("glm-secret-12345");
    }
    await lease.release();

    // Verify runtime resolution and execution through GLM target
    let executedModel = "";
    let executedAccount = "";
    const runtime = new ProviderRuntime({
      configStore,
      credentialStore,
      adapter: {
        id: "mock-glm-adapter",
        async bind(target) {
          executedModel = target.model;
          executedAccount = target.providerAccount;
          return {
            language: {
              async *stream() {
                yield {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: `Hello from GLM 4.7!` },
                };
                yield {
                  type: "finish",
                  stopReason: "end_turn",
                  usage: { inputTokens: 10, outputTokens: 10 },
                };
              },
            },
          } as any;
        },
      },
    });

    const snapshot = await runtime.createTurnSnapshot();
    const plan = await runtime.resolvePlan(snapshot, "text", "standard");
    expect(plan.selectedTarget.providerAccount).toBe("glm");
    expect(plan.selectedTarget.model).toBe("glm-4.7");

    const result = await runAgentLoop({
      provider: {} as any,
      model: "glm-4.7",
      messages: [{ id: "m1", role: "user", content: "hi", timestamp: Date.now() }],
      toolDefs: [],
      maxSteps: 1,
      hooks: createHookExecutor(),
      providerRuntime: runtime,
      turnSnapshot: snapshot,
    });

    expect(result.finishReason).toBe("stop");
    expect(executedAccount).toBe("glm");
    expect(executedModel).toBe("glm-4.7");
    const textStep = result.steps.find((s) => s.type === "text_delta" || s.type === "text");
    expect(textStep?.content).toContain("Hello from GLM 4.7!");
  });
});
