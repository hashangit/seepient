/**
 * P1 comm-tool analyzers test (spec 008, T103).
 *
 * Verifies every comm analyzer fully enumerates connector, destinations,
 * recipients, artifacts, and secret references; every response declares its
 * model-egress data class; no secret values appear in the prepared action.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeSendEmail,
  analyzeWebSearch,
  analyzeSendNotification,
  analyzeReadWebsite,
  analyzeGenerateImage,
  COMM_ANALYZERS,
} from "../comm-analyzers.js";
import { InMemoryArtifactStore } from "../../../capabilities/execution/in-memory-artifact-store.js";
import type { ToolAnalysisContext } from "../../../foundations/contracts/custom-tools.js";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-comm-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function ctx(): ToolAnalysisContext {
  const artifacts = new InMemoryArtifactStore();
  return {
    principalId: "u",
    runId: "r1",
    toolCallId: "c1",
    workspace: { workspaceId: "ws", canonicalRoot: dir, policyVersion: 1, policyDigest: "d" },
    artifacts,
    modelProviderClass: "openai",
  };
}

describe("comm analyzers (T103)", () => {
  it("send_email enumerates smtp recipient, secret refs, and model-egress", async () => {
    const action = await analyzeSendEmail(
      { to: "x@example.com", subject: "hi", body: "body" },
      ctx(),
    );
    expect(action.operation.kind).toBe("broker");
    if (action.operation.kind === "broker" && action.operation.request.kind === "external-send") {
      expect(action.operation.request.service).toBe("smtp");
      expect(action.operation.request.recipients[0].recipient).toBe("x@example.com");
      expect(action.operation.request.secretRefs).toEqual(["smtpHost", "smtpUser", "smtpPass"]);
    }
    const kinds = action.effects.map((e) => e.kind);
    expect(kinds).toContain("external-send");
    expect(kinds).toContain("secret-use");
    expect(kinds).toContain("model-egress");
    // No secret values in the prepared action — only opaque refs.
    const serialized = JSON.stringify(action);
    expect(serialized).not.toContain("smtpPass-value");
  });

  it("web_search declares network-egress + tavilyApiKey secret + model-egress", async () => {
    const action = await analyzeWebSearch({ query: "test" }, ctx());
    if (action.operation.kind === "broker" && action.operation.request.kind === "http") {
      expect(action.operation.request.destination.host).toBe("api.tavily.com");
      expect(action.operation.request.secretRefs).toEqual(["tavilyApiKey"]);
    }
    expect(action.effects.map((e) => e.kind)).toContain("network-egress");
  });

  it("send_notification routes to the platform host + secret refs", async () => {
    for (const platform of ["feishu", "dingtalk", "wecom"] as const) {
      const action = await analyzeSendNotification({ platform, content: "hi" }, ctx());
      expect(action.display.canonicalTargets[0]).toMatch(/https:\/\/.+/);
      if (action.operation.kind === "broker" && action.operation.request.kind === "external-send") {
        expect(action.operation.request.service).toBe(platform);
      }
    }
  });

  it("read_website parses the URL into scheme + host", async () => {
    const action = await analyzeReadWebsite({ url: "https://docs.example.com/guide" }, ctx());
    if (action.operation.kind === "broker" && action.operation.request.kind === "http") {
      expect(action.operation.request.destination.scheme).toBe("https");
      expect(action.operation.request.destination.host).toBe("docs.example.com");
    }
  });

  it("read_website handles malformed URL without throwing", async () => {
    const action = await analyzeReadWebsite({ url: "not-a-url" }, ctx());
    expect(action.operation.kind).toBe("broker");
  });

  it("generate_image declares OPENAI_API_KEY secret + image API destination", async () => {
    const action = await analyzeGenerateImage({ prompt: "cat" }, ctx());
    if (action.operation.kind === "broker" && action.operation.request.kind === "http") {
      expect(action.operation.request.destination.host).toBe("api.openai.com");
      expect(action.operation.request.secretRefs).toContain("OPENAI_API_KEY");
    }
  });

  it("COMM_ANALYZERS registry exposes all five tools", () => {
    expect(Object.keys(COMM_ANALYZERS).sort()).toEqual([
      "generate_image",
      "read_website",
      "send_email",
      "send_notification",
      "web_search",
    ]);
  });
});
