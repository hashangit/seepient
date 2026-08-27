/**
 * Production tool-pipeline wiring test (spec 017 hotfix).
 *
 * Drives a full brokered tool call — analyzer → prepared action →
 * LocalExecutionBoundary → BrokerExecutor → EffectBroker — against a stub
 * network adapter injected via buildLocalBoundary({ network }).
 *
 * Regression guard for the wiring bug where BrokerExecutor was registered
 * without the shared artifact store, so every "successful" web_search /
 * read_website returned `<broker artifact …>` to the model instead of the
 * response content.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLocalBoundary } from "../../../capabilities/execution/build-local-boundary.js";
import { InMemoryArtifactStore } from "../../../capabilities/execution/in-memory-artifact-store.js";
import { ALL_ANALYZERS } from "../action-lifecycle-factory.js";
import type { ToolAnalysisContext } from "../../../foundations/contracts/custom-tools.js";
import type { CapabilityEnvelope } from "../../../foundations/contracts/permission-policy.js";

let tmpGlobal: string;
let tmpWorkspace: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  tmpGlobal = mkdtempSync(join(tmpdir(), "seepient-pipeline-global-"));
  tmpWorkspace = mkdtempSync(join(tmpdir(), "seepient-pipeline-ws-"));
  for (const key of ["SEEPIENT_CONFIG_GLOBAL_DIR", "SEEPIENT_CWD", "TAVILY_API_KEY"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.SEEPIENT_CONFIG_GLOBAL_DIR = tmpGlobal;
  process.env.SEEPIENT_CWD = tmpWorkspace;
  // Dummy Tavily key so the BrokerExecutor preflight passes and the broker
  // injects a Bearer header we can assert on.
  writeFileSync(join(tmpGlobal, "setting.json"), JSON.stringify({ tavilyApiKey: "tvly-wiring-123" }));
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmpGlobal, { recursive: true, force: true });
  rmSync(tmpWorkspace, { recursive: true, force: true });
});

function makeCtx(artifacts: InMemoryArtifactStore): ToolAnalysisContext {
  return {
    principalId: "user-test",
    runId: "run-test",
    toolCallId: "call-test",
    workspace: {
      workspaceId: "ws-test",
      canonicalRoot: tmpWorkspace,
      policyVersion: 1,
      policyDigest: "digest-test",
    },
    artifacts,
    modelProviderClass: "*",
  };
}

function envelopeFor(actionDigest: string, host: string): CapabilityEnvelope {
  return {
    version: 1,
    envelopeId: `env-${host}`,
    principalId: "user-test",
    runId: "run-test",
    actionDigest,
    policyDigest: "digest-1",
    capabilities: [
      { kind: "network-destination", scheme: "https", host },
      { kind: "secret-ref", ref: "*" },
    ],
    lifetime: { kind: "action", actionDigest, consumeOnce: true },
    issuedBy: { kind: "service", authorityId: "test", authenticatedBy: "test" },
    issuedAt: Date.now(),
  };
}

describe("brokered tool pipeline wiring (analyzer → boundary → broker → model output)", () => {
  it("web_search returns response content to the model, not an artifact placeholder", async () => {
    const artifacts = new InMemoryArtifactStore();
    const captures: Array<{ host: string; pathPrefix?: string; authorization?: string }> = [];
    const { boundary } = await buildLocalBoundary({
      artifacts,
      workspaceRoot: tmpWorkspace,
      network: {
        resolve: async () => ["93.184.216.34"],
        fetch: async (destination, init) => {
          captures.push({
            host: destination.host,
            pathPrefix: destination.pathPrefix,
            authorization: (init.headers as Record<string, string>).authorization,
          });
          // Echo the request body back as the response — proves the artifact
          // round-trip from broker response store to model-visible output.
          const bytes = init.body ?? new TextEncoder().encode('{"results":[]}');
          return {
            status: 200,
            bytes,
            effectiveHost: destination.host,
            effectiveIp: "93.184.216.34",
            headers: {},
          };
        },
      },
    });

    const action = await ALL_ANALYZERS.web_search({ query: "finland unemployment", depth: "advanced" }, makeCtx(artifacts));
    const result = await boundary.execute(action, envelopeFor(action.actionDigest, "api.tavily.com"), {});

    expect(result.state).toBe("succeeded");
    const output = (result as { result?: { output?: string } }).result?.output ?? "";
    expect(output).toContain("finland unemployment");
    expect(output).toContain("search_depth");
    expect(output).not.toContain("<broker artifact");

    // The request actually went to /search with the resolved Bearer credential.
    expect(captures[0]?.pathPrefix).toBe("/search");
    expect(captures[0]?.authorization).toBe("Bearer tvly-wiring-123");
  });

  it("read_website returns extracted readable text, not markup", async () => {
    const artifacts = new InMemoryArtifactStore();
    const { boundary } = await buildLocalBoundary({
      artifacts,
      workspaceRoot: tmpWorkspace,
      network: {
        resolve: async () => ["93.184.216.34"],
        fetch: async (destination) => ({
          status: 200,
          bytes: new TextEncoder().encode(
            "<html><head><style>body{color:red}</style></head><body><h1>Labour force</h1><script>alert('x')</script><p>Hello &amp; welcome</p></body></html>",
          ),
          effectiveHost: destination.host,
          effectiveIp: "93.184.216.34",
          headers: {},
        }),
      },
    });

    const action = await ALL_ANALYZERS.read_website(
      { url: "https://example.com/en/statistics/tyok" },
      makeCtx(artifacts),
    );
    const result = await boundary.execute(action, envelopeFor(action.actionDigest, "example.com"), {});

    expect(result.state).toBe("succeeded");
    const output = (result as { result?: { output?: string } }).result?.output ?? "";
    expect(output).toContain("Labour force");
    expect(output).toContain("Hello & welcome");
    expect(output).not.toContain("<script");
    expect(output).not.toContain("color:red");
    expect(output).not.toContain("<broker artifact");
  });

  it("caps oversized broker responses in model-visible output", async () => {
    const artifacts = new InMemoryArtifactStore();
    const { boundary } = await buildLocalBoundary({
      artifacts,
      workspaceRoot: tmpWorkspace,
      network: {
        resolve: async () => ["93.184.216.34"],
        fetch: async (destination) => ({
          status: 200,
          bytes: new TextEncoder().encode("a".repeat(200_001)),
          effectiveHost: destination.host,
          effectiveIp: "93.184.216.34",
          headers: {},
        }),
      },
    });

    const action = await ALL_ANALYZERS.read_website({ url: "https://example.com/huge" }, makeCtx(artifacts));
    const result = await boundary.execute(action, envelopeFor(action.actionDigest, "example.com"), {});

    expect(result.state).toBe("succeeded");
    const output = (result as { result?: { output?: string } }).result?.output ?? "";
    expect(output.length).toBeLessThan(200_001);
    expect(output).toContain("truncated");
  });

  it("surfaces the HTTP status and final URL so the model can adapt to 404s", async () => {
    const artifacts = new InMemoryArtifactStore();
    const { boundary } = await buildLocalBoundary({
      artifacts,
      workspaceRoot: tmpWorkspace,
      network: {
        resolve: async () => ["93.184.216.34"],
        fetch: async (destination) => ({
          status: 404,
          bytes: new TextEncoder().encode(
            "<html><head><script>self.__next_f=[]</script></head><body></body></html>",
          ),
          effectiveHost: destination.host,
          effectiveIp: "93.184.216.34",
          headers: {},
        }),
      },
    });

    const action = await ALL_ANALYZERS.read_website({ url: "https://stat.fi/en/statistics/tyok" }, makeCtx(artifacts));
    const result = await boundary.execute(action, envelopeFor(action.actionDigest, "stat.fi"), {});

    expect(result.state).toBe("succeeded");
    const output = (result as { result?: { output?: string } }).result?.output ?? "";
    expect(output).toContain("[HTTP 404 https://stat.fi/en/statistics/tyok]");
  });
});
