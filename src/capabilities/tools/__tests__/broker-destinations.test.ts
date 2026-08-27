/**
 * Brokered-tool destination contracts (spec 017 hotfix).
 *
 * Every brokered HTTP analyzer must produce a `NetworkDestination` whose
 * `pathPrefix` names the real API path — the broker/adapter sends requests to
 * `pathPrefix || "/"`, so a missing or mis-keyed path silently hits the host
 * root (the bug that made web_search POST to https://api.tavily.com/ instead
 * of /search). Destinations are typed as NetworkDestination so a `path:` key
 * is a compile error, and these tests pin the runtime values for both
 * analyzer implementations (analyzers.ts and comm-analyzers.ts).
 *
 * Also pins the Tavily request body: `search_depth` is the documented field
 * name (`depth` was silently ignored).
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
  analyzeGenerateImage as commAnalyzeGenerateImage,
} from "../comm-analyzers.js";

type HttpBrokerRequest = Extract<BrokeredEffectRequest, { kind: "http" }>;

function httpRequestOf(action: PreparedToolAction): HttpBrokerRequest {
  const operation = action.operation as Extract<PreparedToolAction["operation"], { kind: "broker" }>;
  return operation.request as HttpBrokerRequest;
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
type GenerateImageAnalyzer = typeof analyzeGenerateImage;

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
  ["analyzers.ts", analyzeWebSearch, analyzeReadWebsite, analyzeGenerateImage],
  ["comm-analyzers.ts", commAnalyzeWebSearch, commAnalyzeReadWebsite, commAnalyzeGenerateImage],
] as const)("brokered destinations (%s)", (_name, webSearch, readWebsite, generateImage) => {
  it("web_search targets /search with search_depth", async () => {
    const { destination, body } = await webSearchFixture(webSearch);
    expect(destination).toMatchObject({ scheme: "https", host: "api.tavily.com", pathPrefix: "/search" });
    expect(body.query).toBe("finland unemployment");
    expect(body.search_depth).toBe("advanced");
    expect(body.depth).toBeUndefined();
  });

  it("read_website keeps the URL path and query", async () => {
    const dest = await readWebsiteFixture(readWebsite, "https://www.stat.fi/en/statistics/tyok");
    expect(dest).toMatchObject({ host: "www.stat.fi", pathPrefix: "/en/statistics/tyok" });

    const withQuery = await readWebsiteFixture(readWebsite, "https://x.test/search?a=1&b=2");
    expect(withQuery.pathPrefix).toBe("/search?a=1&b=2");
  });

  it("generate_image targets the /v1/images/generations path of the default base", async () => {
    const ctx = makeCtx();
    const action = await generateImage({ prompt: "a cat" }, ctx);
    expect(httpRequestOf(action).destination).toMatchObject({
      host: "api.openai.com",
      pathPrefix: "/v1/images/generations",
    });
  });
});

describe("optimize_prompt destination (analyzers.ts)", () => {
  it("targets /v1/chat/completions of the default base", async () => {
    const ctx = makeCtx();
    const action = await analyzeOptimizePrompt({ prompt: "improve me" }, ctx);
    expect(httpRequestOf(action).destination).toMatchObject({
      host: "api.openai.com",
      pathPrefix: "/v1/chat/completions",
    });
  });
});
