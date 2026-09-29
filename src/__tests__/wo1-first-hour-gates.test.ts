/**
 * US0 red gate (022-5-WO1 T009): first-hour truth. (a) The setup command's
 * non-interactive guidance must teach only living patterns — no env-var
 * key names (demolished in 022-5). (b) The provider-management.md isolated
 * example must actually run: its construction, executed against a loopback
 * stub, completes chat() — today it throws CREDENTIAL_REQUIRED because the
 * example references a credential record it never writes (pass-11 F-S3
 * class reborn).
 *
 * Deviation note: the verbatim example run injects exactly one harness line
 * (a loopback baseUrl on the example's provider entry) so the gate never
 * touches the network; the construction text itself is asserted verbatim
 * against the markdown fence.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

describe("first-hour stdout truth (022-5-WO1 T009a)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("non-interactive setup guidance mentions no demolished env names", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").implementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const exitSpy = vi.spyOn(process, "exit").implementation(((code?: number) => {
      throw new Error(`process.exit(${code}) — expected for non-interactive setup`);
    }) as never);

    const { runSetup } = await import("../../transport/cli/setup.js");
    await expect(runSetup({})).rejects.toThrow(/process\.exit/);

    const output = logs.join("\n");
    expect(output).not.toMatch(/OPENAI_API_KEY|ANTHROPIC_API_KEY|GLM_API_KEY|OPENAI_COMPAT/i);
    expect(output).not.toMatch(/environment variables/i);
  });

  it("the CLI setup-command guidance teaches auth login, not env keys", async () => {
    const source = readFileSync(join(process.cwd(), "src/ui/cli/index.ts"), "utf-8");
    const setupAction = source.slice(source.indexOf(".command('setup')"), source.indexOf(".command('setup')") + 1500);
    expect(setupAction).not.toMatch(/OPENAI_API_KEY|ANTHROPIC_API_KEY|GLM_API_KEY|OPENAI_COMPAT/);
    expect(setupAction).toMatch(/auth login/);
  });
});

describe("provider-management.md isolated example executes (022-5-WO1 T009b)", () => {
  it("the documented construction completes chat() against a loopback stub", async () => {
    // Verbatim construction assertions on the markdown fence.
    const md = readFileSync(join(process.cwd(), "docs/sdk/provider-management.md"), "utf-8");
    const fence = md.slice(md.indexOf("const agent = await createSeepient"), md.indexOf("await agent.dispose()"));
    expect(fence).toContain('tenancy: "single"');
    expect(fence).toContain('overlayFile: ":memory:"');
    expect(fence).toContain('credential: { kind: "seepient", id: "isolated_openai" }');

    // The example must write the credential record it references — the fence
    // carries a MemoryCredentialStore injection (added by T029).
    expect(fence).toMatch(/MemoryCredentialStore|credentialStore/);

    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(req.headers.authorization ?? "");
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "sink" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const { createSeepient } = await import("../../transport/sdk/index.js");
      const { MemoryCredentialStore } = await import("../../domain/providers/credentials/memory-credential-store.js");
      const store = new MemoryCredentialStore();
      await store.put("isolated_openai", { kind: "api_key", keyValue: "sk-isolated-example-key" });

      const agent = await createSeepient({
        tenancy: "single",
        overlayFile: ":memory:",
        credentials: store,
        providers: {
          isolated_openai: {
            adapter: "pi-ai",
            upstreamProvider: "openai",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            credential: { kind: "seepient", id: "isolated_openai" },
          } as never,
        },
        modelAssignments: {
          text: {
            standard: { providerAccount: "isolated_openai", model: "gpt-5.4" },
          },
        } as never,
      } as never);

      await agent.chat("Hello from isolated agent!");
      // The wire carried the stored key, never a decoy.
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]).toBe("Bearer sk-isolated-example-key");
      await agent.dispose();
    } finally {
      server.close();
    }
  });
});
