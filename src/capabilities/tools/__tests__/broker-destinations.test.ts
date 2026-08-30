/**
 * Brokered-tool destination contracts (spec 017 hotfix & spec 010 media wiring).
 *
 * Every brokered HTTP analyzer must produce a `NetworkDestination` whose
 * `pathPrefix` names the real API path — the broker/adapter sends requests to
 * `pathPrefix || "/"`. Destinations are typed as NetworkDestination so a `path:` key
 * is a compile error.
 *
 * Vendor-operation analyzers (generate_image, optimize_prompt) route through
 * the connector broker with typed inputs.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolAnalysisContext } from "../../../foundations/contracts/custom-tools.js";
import type { PreparedToolAction, BrokeredEffectRequest } from "../../../foundations/contracts/prepared-action.js";
import { InMemoryArtifactStore } from "../../execution/in-memory-artifact-store.js";
import {
  analyzeWebSearch,
  analyzeReadWebsite,
  analyzeGenerateImage,
  analyzeOptimizePrompt,
} from "../analyzers.js";
import {
  analyzeWebSearch as commAnalyzeWebSearch,
  analyzeReadWebsite as commAnalyzeReadWebsite,
} from "../comm-analyzers.js";

type HttpBrokerRequest = Extract<BrokeredEffectRequest, { kind: "http" }>;
type VendorBrokerRequest = Extract<BrokeredEffectRequest, { kind: "vendor-operation" }>;

function httpRequestOf(action: PreparedToolAction): HttpBrokerRequest {
  const operation = action.operation as Extract<PreparedToolAction["operation"], { kind: "broker" }>;
  return operation.request as HttpBrokerRequest;
}

function vendorRequestOf(action: PreparedToolAction): VendorBrokerRequest {
  const operation = action.operation as Extract<PreparedToolAction["operation"], { kind: "broker" }>;
  return operation.request as VendorBrokerRequest;
}

let tmpGlobal: string;
let tmpCwd: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  tmpGlobal = mkdtempSync(join(tmpdir(), "seepient-dest-global-"));
  tmpCwd = mkdtempSync(join(tmpdir(), "seepient-dest-cwd-"));
  for (const key of [
    "SEEPIENT_CONFIG_GLOBAL_DIR",
    "SEEPIENT_CWD",
    "OPENAI_BASE_URL",
    "OPENAI_COMPAT_BASE_URL",
    "TAVILY_API_KEY",
    "OPENAI_API_KEY",
    "SEEPIENT_LOCAL_MEDIA",
    "SEEPIENT_MEDIA_RUNTIME",
  ]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.SEEPIENT_CONFIG_GLOBAL_DIR = tmpGlobal;
  process.env.SEEPIENT_CWD = tmpCwd;
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmpGlobal, { recursive: true, force: true });
  rmSync(tmpCwd, { recursive: true, force: true });
});

function makeCtx(): ToolAnalysisContext {
  return {
    principalId: "user-test",
    runId: "run-test",
    toolCallId: "call-test",
    workspace: {
      workspaceId: "ws-test",
      canonicalRoot: tmpCwd,
      policyVersion: 1,
      policyDigest: "digest-test",
    },
    artifacts: new InMemoryArtifactStore(),
    modelProviderClass: "*",
  };
}

type WebSearchAnalyzer = typeof analyzeWebSearch;
type ReadWebsiteAnalyzer = typeof analyzeReadWebsite;

async function webSearchFixture(analyzer: WebSearchAnalyzer) {
  const ctx = makeCtx();
  const action = await analyzer({ query: "finland unemployment", depth: "advanced" }, ctx);
  const request = httpRequestOf(action);
  const bodyBytes = await ctx.artifacts.read(request.body!);
  return { destination: request.destination, body: JSON.parse(new TextDecoder().decode(bodyBytes)) };
}

async function readWebsiteFixture(analyzer: ReadWebsiteAnalyzer, url: string) {
  const ctx = makeCtx();
  const action = await analyzer({ url }, ctx);
  return httpRequestOf(action).destination;
}

describe.each([
  ["analyzers.ts", analyzeWebSearch, analyzeReadWebsite],
  ["comm-analyzers.ts", commAnalyzeWebSearch, commAnalyzeReadWebsite],
] as const)("brokered HTTP destinations (%s)", (_name, webSearch, readWebsite) => {
  it("web_search targets /search with search_depth", async () => {
    const { destination, body } = await webSearchFixture(webSearch);
    expect(destination).toMatchObject({ scheme: "https", host: "api.tavily.com", pathPrefix: "/search" });
    expect(body.query).toBe("finland unemployment");
    expect(body.search_depth).toBe("advanced");
    expect(body.depth).toBeUndefined();
    expect(body.include_answer).toBe(true);
    expect(body.max_results).toBe(5);
    expect(body.include_images).toBe(false);
  });

  it("read_website keeps the URL path and query", async () => {
    const dest = await readWebsiteFixture(readWebsite, "https://www.stat.fi/en/statistics/tyok");
    expect(dest).toMatchObject({ host: "www.stat.fi", pathPrefix: "/en/statistics/tyok" });

    const withQuery = await readWebsiteFixture(readWebsite, "https://x.test/search?a=1&b=2");
    expect(withQuery.pathPrefix).toBe("/search?a=1&b=2");
  });
});

describe("vendor-operation destinations (analyzers.ts)", () => {
  it("generate_image emits media/generate_image vendor operation", async () => {
    const ctx = makeCtx();
    const action = await analyzeGenerateImage({ prompt: "a cat" }, ctx);
    const req = vendorRequestOf(action);
    expect(req.connector).toBe("media");
    expect(req.operation).toBe("generate_image");
    expect((req.input as any).prompt).toBe("a cat");
  });

  it("optimize_prompt emits media/optimize_prompt vendor operation", async () => {
    const ctx = makeCtx();
    const action = await analyzeOptimizePrompt({ raw_prompt: "improve me" }, ctx);
    const req = vendorRequestOf(action);
    expect(req.connector).toBe("media");
    expect(req.operation).toBe("optimize_prompt");
    expect((req.input as any).raw_prompt).toBe("improve me");
  });
});
