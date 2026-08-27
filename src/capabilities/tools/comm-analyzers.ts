/**
 * Typed broker analyzers for comm/external tools — Capabilities (spec 008, T103/T008a,
 * FR-006/FR-009).
 *
 * Moved from src/domain/permissions/ to src/capabilities/tools/ per D46 / T008a.
 * The Domain shim (default-analyzers.ts) re-exports from here.
 *
 * Each analyzer enumerates connector, destinations, recipients, artifact
 * payloads, and secret references fully — policy can decide before any
 * connection is opened. Every response declares its model-egress data class
 * so the egress gate can evaluate before broker output enters model-visible
 * history. Secret values are never placed in the prepared action; only
 * `secretRefs` (opaque names the broker resolves internally).
 */
import { createHash } from "node:crypto";
import * as path from "node:path";
import type { PreparedToolAction } from "../../foundations/contracts/prepared-action.js";
import type {
  EffectRequest,
  NetworkDestination,
  ToolEffectKind,
  ToolRiskCategory,
  ExternalRecipient,
} from "../../foundations/contracts/tool-effects.js";
import type { ToolAnalysisContext } from "../../foundations/contracts/custom-tools.js";
import { generateId } from "../../foundations/id.js";
import {
  canonicalizePath,
  digestAction,
  digestArgs,
} from "./analyzers.js";

/** Common helper: build a complete PreparedToolAction. */
function buildAction(input: {
  toolName: string;
  ctx: ToolAnalysisContext;
  args: unknown;
  argsDigest: string;
  effects: EffectRequest[];
  operation: PreparedToolAction["operation"];
  display: { title: string; summary: string; canonicalTargets: string[] };
  risk: ToolRiskCategory;
}): PreparedToolAction {
  const actionDigest = digestAction({
    operation: input.operation,
    effects: input.effects,
    principalId: input.ctx.principalId,
    toolName: input.toolName,
    argsDigest: input.argsDigest,
  });
  return {
    version: 1,
    actionId: generateId(),
    runId: input.ctx.runId,
    toolCallId: input.ctx.toolCallId,
    toolName: input.toolName,
    principalId: input.ctx.principalId,
    argsDigest: input.argsDigest,
    actionDigest,
    risk: input.risk,
    effects: input.effects,
    display: {
      ...input.display,
      effects: input.effects.map((e) => e.kind as ToolEffectKind),
    },
    operation: input.operation,
  };
}

/**
 * `send_email` analyzer. Enumerates recipient + attachments; declares an
 * `external-send` effect for the recipient and `secret-use` for SMTP creds,
 * plus a `model-egress` effect (the broker response is normal status text).
 */
export async function analyzeSendEmail(
  args: { to: string; subject: string; body: string; attachments?: string[] },
  ctx: ToolAnalysisContext,
): Promise<PreparedToolAction> {
  const cwd = ctx.workspace.canonicalRoot;
  const recipients: ExternalRecipient[] = [
    { service: "smtp", recipient: args.to },
  ];
  const secretRefs = ["smtpHost", "smtpUser", "smtpPass"];

  // Resolve attachment paths (filesystem-read side-effect).
  const attachmentTargets = await Promise.all(
    (args.attachments ?? []).map((p) => canonicalizePath(p, cwd)),
  );

  const emailPayload = {
    subject: args.subject,
    body: args.body,
    to: args.to,
    attachments: args.attachments,
  };
  const payloadBytes = Buffer.from(JSON.stringify(emailPayload), "utf8");
  const payloadArtifact = await ctx.artifacts.put(payloadBytes, "application/json");

  const effects: EffectRequest[] = [
    {
      kind: "external-send",
      destinations: recipients,
      dataClasses: ["normal"],
    },
    { kind: "secret-use", secretRefs },
    {
      kind: "model-egress",
      providerClass: ctx.modelProviderClass,
      dataClasses: ["normal"],
      sources: ["smtp-response"],
    },
  ];
  if (attachmentTargets.length > 0) {
    effects.unshift({
      kind: "filesystem-read",
      targets: attachmentTargets,
      sensitivity: "normal",
    });
  }

  const operation = {
    kind: "broker" as const,
    request: {
      kind: "external-send" as const,
      requestId: generateId(),
      service: "smtp",
      recipients,
      payload: payloadArtifact,
      secretRefs,
    },
  };

  const argsDigest = digestArgs(args);
  return buildAction({
    toolName: "send_email",
    ctx,
    args,
    argsDigest,
    effects,
    operation,
    display: {
      title: `Email ${args.to}`,
      summary: `Subject: ${args.subject}`,
      canonicalTargets: [args.to, ...attachmentTargets.map((t) => t.canonicalPath)],
    },
    risk: "communications",
  });
}

/**
 * `web_search` analyzer. Declares an `external-send` to the search API +
 * `secret-use` for the API key + `model-egress` for the response (search
 * results re-enter model history).
 */
export async function analyzeWebSearch(
  args: { query: string; depth?: string },
  ctx: ToolAnalysisContext,
): Promise<PreparedToolAction> {
  const destination: NetworkDestination = { scheme: "https", host: "api.tavily.com", pathPrefix: "/search" };
  const secretRefs = ["tavilyApiKey"];
  const payloadBytes = Buffer.from(
    JSON.stringify({ query: args.query, search_depth: args.depth ?? "basic" }),
    "utf8",
  );
  const payloadArtifact = await ctx.artifacts.put(payloadBytes, "application/json");

  const effects: EffectRequest[] = [
    {
      kind: "network-egress",
      destinations: [destination],
    },
    { kind: "secret-use", secretRefs },
    {
      kind: "model-egress",
      providerClass: ctx.modelProviderClass,
      dataClasses: ["normal"],
      sources: ["tavily-response"],
    },
  ];

  const operation = {
    kind: "broker" as const,
    request: {
      kind: "http" as const,
      requestId: generateId(),
      destination,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payloadArtifact,
      secretRefs,
    },
  };

  return buildAction({
    toolName: "web_search",
    ctx,
    args,
    argsDigest: digestArgs(args),
    effects,
    operation,
    display: {
      title: `Web search`,
      summary: args.query,
      canonicalTargets: ["https://api.tavily.com/search"],
    },
    risk: "safe",
  });
}

/**
 * `send_notification` analyzer. Declares `external-send` to the configured IM
 * webhook + `secret-use` for webhook/keyword creds + `model-egress`.
 */
export async function analyzeSendNotification(
  args: { platform: "feishu" | "dingtalk" | "wecom"; content: string },
  ctx: ToolAnalysisContext,
): Promise<PreparedToolAction> {
  const hostMap = {
    feishu: "open.feishu.cn",
    dingtalk: "oapi.dingtalk.com",
    wecom: "qyapi.weixin.qq.com",
  };
  const host = hostMap[args.platform];
  const secretRefs = [`${args.platform}Webhook`, `${args.platform}Keyword`];
  const payloadBytes = Buffer.from(args.content, "utf8");
  const payloadArtifact = await ctx.artifacts.put(payloadBytes, "text/plain");

  const effects: EffectRequest[] = [
    {
      kind: "external-send",
      destinations: [{ service: args.platform, recipient: "im-group" }],
      dataClasses: ["normal"],
    },
    { kind: "secret-use", secretRefs },
    {
      kind: "model-egress",
      providerClass: ctx.modelProviderClass,
      dataClasses: ["normal"],
      sources: ["im-response"],
    },
  ];

  const operation = {
    kind: "broker" as const,
    request: {
      kind: "external-send" as const,
      requestId: generateId(),
      service: args.platform,
      recipients: [{ service: args.platform, recipient: "im-group" }],
      payload: payloadArtifact,
      secretRefs,
    },
  };

  return buildAction({
    toolName: "send_notification",
    ctx,
    args,
    argsDigest: digestArgs(args),
    effects,
    operation,
    display: {
      title: `${args.platform} notification`,
      summary: args.content.slice(0, 60),
      canonicalTargets: [`https://${host}`],
    },
    risk: "communications",
  });
}

/**
 * `read_website` analyzer. Declares a `network-egress` to the target URL +
 * `model-egress` for the response (page content enters model history).
 */
export async function analyzeReadWebsite(
  args: { url: string },
  ctx: ToolAnalysisContext,
): Promise<PreparedToolAction> {
  let destination: NetworkDestination;
  try {
    const u = new URL(args.url);
    destination = {
      scheme: u.protocol === "http:" ? "http" : "https",
      host: u.hostname,
      port: u.port ? Number(u.port) : undefined,
      pathPrefix: u.pathname + u.search,
    };
  } catch {
    destination = { scheme: "https", host: "invalid-url", pathPrefix: "/" };
  }

  const effects: EffectRequest[] = [
    { kind: "network-egress", destinations: [destination] },
    {
      kind: "model-egress",
      providerClass: ctx.modelProviderClass,
      dataClasses: ["normal"],
      sources: [args.url],
    },
  ];

  const operation = {
    kind: "broker" as const,
    request: {
      kind: "http" as const,
      requestId: generateId(),
      destination,
      method: "GET",
      headers: {},
      secretRefs: [],
    },
  };

  return buildAction({
    toolName: "read_website",
    ctx,
    args,
    argsDigest: digestArgs(args),
    effects,
    operation,
    display: {
      title: `Read website`,
      summary: args.url,
      canonicalTargets: [args.url],
    },
    risk: "safe",
  });
}

/**
 * `generate_image` analyzer. Declares `secret-use` (OpenAI/DALL-E key),
 * `external-send` to the image API, and a `model-egress` for the response
 * (image URLs may re-enter model history as download links).
 */
export async function analyzeGenerateImage(
  args: { prompt: string; image_path?: string; mask_path?: string; n?: number; size?: string; model?: string },
  ctx: ToolAnalysisContext,
): Promise<PreparedToolAction> {
  const cwd = ctx.workspace.canonicalRoot;
  const inputTargets = await Promise.all(
    [args.image_path, args.mask_path]
      .filter((p): p is string => Boolean(p))
      .map((p) => canonicalizePath(p, cwd)),
  );

  const { resolveCredentials } = await import("../../foundations/security/credential-resolver.js");
  const creds = resolveCredentials();

  const isLocal =
    process.env.SEEPIENT_LOCAL_MEDIA === "1" ||
    process.env.SEEPIENT_MEDIA_RUNTIME === "local";

  const rawBaseUrl =
    creds.openaiBaseUrl ||
    process.env.OPENAI_COMPAT_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    "https://api.openai.com/v1";

  let destination: NetworkDestination;
  try {
    const u = new URL(rawBaseUrl.startsWith("http") ? rawBaseUrl : `https://${rawBaseUrl}`);
    destination = {
      scheme: u.protocol === "http:" ? "http" : "https",
      host: u.hostname,
      port: u.port ? Number(u.port) : undefined,
      pathPrefix: u.pathname.endsWith("/v1")
        ? `${u.pathname}/images/generations`
        : `${u.pathname.replace(/\/$/, "")}/v1/images/generations`,
    };
  } catch {
    destination = { scheme: "https", host: "api.openai.com", pathPrefix: "/v1/images/generations" };
  }

  const secretRefs = ["OPENAI_API_KEY"];

  const effects: EffectRequest[] = [
    ...(isLocal
      ? []
      : [
          { kind: "network-egress" as const, destinations: [destination] },
          { kind: "secret-use" as const, secretRefs },
        ]),
    {
      kind: "model-egress",
      providerClass: ctx.modelProviderClass,
      dataClasses: ["normal"],
      sources: ["image-response"],
    },
  ];
  if (inputTargets.length > 0) {
    effects.unshift({
      kind: "filesystem-read",
      targets: inputTargets,
      sensitivity: "normal",
    });
  }

  const payloadBytes = Buffer.from(
    JSON.stringify({ prompt: args.prompt, n: args.n ?? 1, size: args.size, model: args.model }),
    "utf8",
  );
  const payloadArtifact = await ctx.artifacts.put(payloadBytes, "application/json");

  const operation = isLocal
    ? ({
        kind: "none" as const,
        result: { output: "image generated locally", success: true },
      })
    : ({
        kind: "broker" as const,
        request: {
          kind: "http" as const,
          requestId: generateId(),
          destination,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payloadArtifact,
          secretRefs,
        },
      });

  return buildAction({
    toolName: "generate_image",
    ctx,
    args,
    argsDigest: digestArgs(args),
    effects,
    operation,
    display: {
      title: `Generate image`,
      summary: args.prompt.slice(0, 60),
      canonicalTargets: isLocal ? [] : [`${destination.scheme}://${destination.host}${destination.pathPrefix ?? ""}`],
    },
    risk: "communications",
  });
}

/** Extend the default analyzer registry with the comm-tool analyzers. */
export const COMM_ANALYZERS: Record<string, (args: unknown, ctx: ToolAnalysisContext) => Promise<PreparedToolAction>> = {
  send_email: (a, c) => analyzeSendEmail(a as { to: string; subject: string; body: string; attachments?: string[] }, c),
  web_search: (a, c) => analyzeWebSearch(a as { query: string; depth?: string }, c),
  send_notification: (a, c) =>
    analyzeSendNotification(a as { platform: "feishu" | "dingtalk" | "wecom"; content: string }, c),
  read_website: (a, c) => analyzeReadWebsite(a as { url: string }, c),
  generate_image: (a, c) =>
    analyzeGenerateImage(
      a as { prompt: string; image_path?: string; mask_path?: string; n?: number; size?: string; model?: string },
      c,
    ),
};

// Suppress unused import in some build configurations.
export const _sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
export { path };
