/**
 * J5 Adversarial Journey — VULN-10 / VULN-11: Post-inversion trap & isolated defaults.
 *
 * Verifies that `new ProviderRuntime()` constructs an isolated in-memory instance by default:
 * 1. Zero ambient providers synthesized from host `process.env` or `~/.seepient`.
 * 2. Carries `isIsolated === true`.
 * 3. Sibling runtimes have independent in-memory overlays (no disk write-through leak).
 * 4. CompositeCredentialStore has no ambient fileStore/env read-through on isolated instances.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ProviderRuntime } from "../provider-runtime.js";
import { createSecurityGuard } from "../../permissions/__tests__/composition-closure/_guard.js";

describe("J5 Isolated Defaults & Post-Inversion Trap (VULN-10 / VULN-11)", () => {
  const originalEnv = process.env;
  let guard = createSecurityGuard("VULN-10");

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.OPENAI_API_KEY = "sk-host-operator-env-secret";
    process.env.ANTHROPIC_API_KEY = "sk-ant-host-operator-env-secret";
    guard = createSecurityGuard("VULN-10");
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("new ProviderRuntime() composes zero ambient providers and has isIsolated: true", async () => {
    // No-arg construction
    const runtime = new ProviderRuntime();

    // 1. Must carry isIsolated === true stamp (VULN-10)
    expect((runtime as any).isIsolated).toBe(true);

    // 2. Must not synthesize providers from host environment variables
    const config = await runtime.getConfig();
    const providers = config.providers ?? {};
    expect(Object.keys(providers)).toHaveLength(0);

    // 3. Sibling runtime isolation: adding a provider to runtimeA must not be visible to runtimeB
    const runtimeB = new ProviderRuntime();
    await runtime.getConfigStore().addProvider("custom-tenant-provider", {
      type: "openai-compatible",
      baseUrl: "https://tenant.example.com",
    });

    const configB = await runtimeB.getConfig();
    expect(configB.providers?.["custom-tenant-provider"]).toBeUndefined();

    // 4. Credential store must not resolve host env credentials through fallback (VULN-11)
    const credStore = runtime.getCredentialStore();
    const handle = await credStore.resolve({
      kind: "env",
      name: "OPENAI_API_KEY",
    });

    expect(handle).toBeDefined();
    expect(await handle!.isResolvable()).toBe(false);
    expect(() => handle!.acquireLease()).toThrow(/CREDENTIAL_REQUIRED/);

    if (handle && (await handle.isResolvable()) === false) {
      guard.recordHit("credential.fail_closed");
    }

    guard.assertGuardedPathExecuted(1);
  });
});
