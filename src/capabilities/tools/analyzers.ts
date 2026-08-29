/**
 * Capabilities Layer Tool Analyzers — (Spec 008 R9).
 *
 * Placed in `src/capabilities/tools/` according to ARCHITECTURE layer rules.
 * Produces a `PreparedToolAction` with exactly ONE serializable operation
 * (`PreparedOperation`) per tool call before policy runs.
 */

import { createHash } from "node:crypto";
import * as path from "node:path";
import { realpathSync as fs_realpathSync, lstatSync as fs_lstatSync } from "node:fs";
import type { PreparedToolAction, PreparedOperation } from "../../foundations/contracts/prepared-action.js";
import type {
  CanonicalPathTarget,
  EffectRequest,
  FileSnapshot,
  NetworkDestination,
  SensitivityClass,
  ToolEffectKind,
  ToolRiskCategory,
  ExternalRecipient,
} from "../../foundations/contracts/tool-effects.js";
import type { PreparationArtifactStore } from "../../foundations/contracts/execution-brokers.js";
import type { ToolAnalysisContext } from "../../foundations/contracts/custom-tools.js";
import { generateId } from "../../foundations/id.js";

/**
 * Analyzer signature: maps tool args + analysis context to a prepared action.
 * Re-exported via `domain/permissions/default-analyzers.ts` for callers that
 * import the type from the Domain shim.
 */
export type ToolAnalyzer = (
  args: unknown,
  ctx: ToolAnalysisContext,
) => Promise<PreparedToolAction>;

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const keys = Object.keys(value as object).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

/** SHA-256 digest of args object for action id derivation (key-order independent). */
export function digestArgs(args: unknown): string {
  return createHash("sha256").update(stableJson(args), "utf8").digest("hex");
}

export function digestAction(input: {
  operation: PreparedOperation;
  effects: EffectRequest[];
  principalId: string;
  toolName: string;
  argsDigest: string;
  runId?: string;
  toolCallId?: string;
}): string {
  const payload = JSON.stringify({
    operation: input.operation,
    effects: input.effects,
    principalId: input.principalId,
    toolName: input.toolName,
    argsDigest: input.argsDigest,
    runId: input.runId,
    toolCallId: input.toolCallId,
  });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * Resolve a caller-supplied path to a canonical target.
 * Resolves symlinks via realpathSync to detect TOCTOU and workspace escape.
 */
export async function canonicalizePath(
  rawPath: string,
  cwd: string,
): Promise<CanonicalPathTarget> {
  const abs = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
  const parent = path.dirname(abs);
  const basename = path.basename(abs);

  let realParent: string;
  try {
    realParent = fs_realpathSync(parent);
  } catch {
    realParent = parent;
  }

  let exists = false;
  let finalSymlink = false;
  let canonicalPath = path.join(realParent, basename);

  try {
    const st = fs_lstatSync(abs);
    exists = true;
    finalSymlink = st.isSymbolicLink();
    if (exists && !finalSymlink) {
      try {
        canonicalPath = fs_realpathSync(abs);
      } catch {
        /* keep path.join(realParent, basename) */
      }
    }
  } catch {
    /* not existing yet */
  }

  return {
    canonicalPath,
    canonicalParent: realParent,
    basename,
    exists,
    finalSymlink,
  };
}

/** Fast snapshot of a file path for TOCTOU binding. */
export function snapshotPath(target: CanonicalPathTarget): FileSnapshot | undefined {
  if (!target.exists) return undefined;
  try {
    const st = fs_lstatSync(target.canonicalPath);
    return {
      exists: true,
      size: st.size,
      modifiedNs: String(st.mtimeMs * 1e6),
    };
  } catch {
    return { exists: false };
  }
}

/** Sensitivity classification for read sources. */
export function classifyReadSensitivity(canonicalPath: string): SensitivityClass {
  const lower = canonicalPath.toLowerCase();
  if (
    lower.includes("/.seepient/security/") ||
    lower.includes("/.ssh/") ||
    lower.includes("/.aws/credentials") ||
    lower.includes("/.env") ||
    lower.endsWith(".pem") ||
    lower.endsWith(".key")
  ) {
    return "secret";
  }
  if (
    lower.includes("/.seepient/") ||
    lower.includes("/.config/") ||
    lower.includes("/.gnupg/")
  ) {
    return "sensitive";
  }
  return "normal";
}

/** Analyzer helper: build a PreparedToolAction. */
function buildAction(input: {
  toolName: string;
  ctx: ToolAnalysisContext;
  args: unknown;
  argsDigest: string;
  effects: EffectRequest[];
  operation: PreparedOperation;
  display: { title: string; summary: string; canonicalTargets: string[] };
  risk: ToolRiskCategory;
}): PreparedToolAction {
  const actionDigest = digestAction({
    operation: input.operation,
    effects: input.effects,
    principalId: input.ctx.principalId,
    toolName: input.toolName,
    argsDigest: input.argsDigest,
    runId: input.ctx.runId,
    toolCallId: input.ctx.toolCallId,
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

// ── Built-in Analyzers ──────────────────────────────────────────────────

export async function analyzeReadFile(
  args: { path: string },
  ctx: ToolAnalysisContext,
): Promise<PreparedToolAction> {
  const cwd = ctx.workspace.canonicalRoot;
  const target = await canonicalizePath(args.path, cwd);
  const sensitivity = classifyReadSensitivity(target.canonicalPath);
  const expected = snapshotPath(target) ?? { exists: false };

  const effects: EffectRequest[] = [
    { kind: "filesystem-read", targets: [target], sensitivity },
    {
      kind: "model-egress",
      providerClass: ctx.modelProviderClass,
      dataClasses: [sensitivity],
      sources: [target.canonicalPath],
    },
  ];

  const operation: PreparedOperation = {
    kind: "read-file",
    target,
    expected,
    sensitivity,
  };

  return buildAction({
    toolName: "read_file",
    ctx,
    args,
    argsDigest: digestArgs(args),
    effects,
    operation,
    display: {
      title: `Read ${target.basename}`,
      summary: target.canonicalPath,
      canonicalTargets: [target.canonicalPath],
    },
    risk: sensitivity === "secret" ? "destructive" : "safe",
  });
}

export async function analyzeWriteFile(
  args: { path: string; content: string },
  ctx: ToolAnalysisContext,
): Promise<PreparedToolAction> {
  const cwd = ctx.workspace.canonicalRoot;
  const target = await canonicalizePath(args.path, cwd);
  const bytes = Buffer.from(args.content, "utf8");
  const artifact = await ctx.artifacts.put(bytes, "text/plain");
  const expected = snapshotPath(target);

  const effects: EffectRequest[] = [
    {
      kind: "filesystem-write",
      targets: [{ target, mode: target.exists ? "replace" : "create", expected }],
    },
    {
      kind: "model-egress",
      providerClass: ctx.modelProviderClass,
      dataClasses: ["normal", "sensitive"],
      sources: [target.canonicalPath],
    },
  ];

  const operation: PreparedOperation = {
    kind: "commit-files",
    commits: [{ destination: target, content: artifact, expected }],
  };

  return buildAction({
    toolName: "write_file",
    ctx,
    args,
    argsDigest: digestArgs(args),
    effects,
    operation,
    display: {
      title: `Write ${target.basename}`,
      summary: args.path,
      canonicalTargets: [args.path],
    },
    risk: "edit",
  });
}

export async function analyzeEditFile(
  args: { patch: string; approval?: any } | Record<string, any>,
  ctx: ToolAnalysisContext,
): Promise<PreparedToolAction> {
  const cwd = ctx.workspace.canonicalRoot;
  const patchStr = typeof args?.patch === "string" ? args.patch : "";
  const headerRegex = /^\[([^#\]]+)#[^\]]*\]/gm;
  const matches = [...patchStr.matchAll(headerRegex)];
  if (matches.length === 0) {
    throw new Error("Invalid patch: no valid [PATH#TAG] section headers found");
  }
  if (!ctx.snapshotStore) {
    const { HashlineError } = await import("../../foundations/errors.js");
    throw new HashlineError("edit_file requires a snapshot store", "HASHLINE_NO_STORE", false);
  }

  // Spec 019 FR-001: the patch is validated and applied ENTIRELY IN MEMORY
  // at analysis time against the session snapshot store (stale-anchor
  // merge-or-reject included). No disk writes happen here; the resulting
  // bytes are prepared as artifacts and land through FileCommitBroker at
  // dispatch with `expected` snapshots — the capability envelope is finally
  // checked on the write that actually happens.
  const { applySectionsToSnapshot } = await import("../../foundations/hashline/patcher.js");
  const { readFile: fsReadFile } = await import("node:fs/promises");
  const sections = await applySectionsToSnapshot(
    patchStr,
    (p) => fsReadFile(path.isAbsolute(p) ? p : path.resolve(cwd, p), "utf-8"),
    ctx.snapshotStore,
  );

  const commits: Extract<PreparedOperation, { kind: "commit-files" }>["commits"] = [];
  const uniqueTargets: CanonicalPathTarget[] = [];
  const expectedByPath = new Map<string, FileSnapshot>();

  for (const section of sections) {
    const target = await canonicalizePath(section.filePath, cwd);
    if (target.finalSymlink) {
      throw new Error(
        `Refusing edit: ${target.canonicalPath} is a symbolic link; exact commit would reject it (target-symlink)`,
      );
    }
    const bytes = Buffer.from(section.applied, "utf8");
    const artifact = await ctx.artifacts.put(bytes, "text/plain");
    if (!expectedByPath.has(target.canonicalPath)) {
      expectedByPath.set(target.canonicalPath, {
        exists: true,
        size: Buffer.byteLength(section.current, "utf8"),
        sha256: createHash("sha256").update(section.current, "utf8").digest("hex"),
      });
      uniqueTargets.push(target);
    }
    commits.push({
      destination: target,
      content: artifact,
      expected: expectedByPath.get(target.canonicalPath)!,
    });
  }

  const effects: EffectRequest[] = [
    {
      kind: "filesystem-write",
      targets: uniqueTargets.map((target) => ({
        target,
        mode: "replace" as const,
        expected: expectedByPath.get(target.canonicalPath),
      })),
    },
    {
      kind: "model-egress",
      providerClass: ctx.modelProviderClass,
      dataClasses: ["normal", "sensitive"],
      sources: uniqueTargets.map((t) => t.canonicalPath),
    },
  ];

  const operation: PreparedOperation = {
    kind: "commit-files",
    commits,
  };

  return buildAction({
    toolName: "edit_file",
    ctx,
    args,
    argsDigest: digestArgs(args),
    effects,
    operation,
    display: {
      title: uniqueTargets.length === 1 ? `Edit ${uniqueTargets[0].basename}` : `Edit ${uniqueTargets.length} files`,
      summary: uniqueTargets.map((t) => t.canonicalPath).join(", "),
      canonicalTargets: uniqueTargets.map((t) => t.canonicalPath),
    },
    risk: "edit",
  });
}

export async function analyzeExecuteShellCommand(
  args: { command: string; cwd?: string },
  ctx: ToolAnalysisContext,
): Promise<PreparedToolAction> {
  const cwd = ctx.workspace.canonicalRoot;
  const commandStr = args.command;
  const executable = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
  const argv = process.platform === "win32" ? ["/c", commandStr] : ["-c", commandStr];

  const effects: EffectRequest[] = [
    {
      kind: "process-exec",
      command: { executable, argv, cwd },
      requestedRoots: [
        { canonicalRoot: cwd, access: "read" },
        { canonicalRoot: cwd, access: "write" },
      ],
    },
    {
      kind: "model-egress",
      providerClass: ctx.modelProviderClass,
      dataClasses: ["normal", "sensitive"],
      sources: ["shell-output"],
    },
  ];

  const operation: PreparedOperation = {
    kind: "process",
    command: { executable, argv, cwd },
    roots: [
      { canonicalRoot: cwd, access: "read" },
      { canonicalRoot: cwd, access: "write" },
    ],
  };

  function classifyShellCommandRisk(command: string): ToolRiskCategory {
    const trimmed = command.trim();
    const destructivePatterns = [
      /\b(rm\s+-|rm\s+|rmdir|git\s+reset|git\s+clean|git\s+restore|git\s+branch\s+-[dD]|kill|pkill|killall|reboot|shutdown|dd\s+|mkfs|fdisk)\b/i,
      />\s*\/dev\//,
      /\bchmod\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)?([0-7]{3,4}|[+-][rwx]+)\s+\//,
    ];
    if (destructivePatterns.some((p) => p.test(trimmed))) {
      return "destructive";
    }
    return "safe";
  }

  return buildAction({
    toolName: "execute_shell_command",
    ctx,
    args,
    argsDigest: digestArgs(args),
    effects,
    operation,
    display: {
      title: `Execute shell command`,
      summary: commandStr,
      canonicalTargets: [cwd],
    },
    risk: classifyShellCommandRisk(commandStr),
  });
}

export const analyzeShellCommand = analyzeExecuteShellCommand;

export async function analyzeWebSearch(
  args: { query: string; depth?: string },
  ctx: ToolAnalysisContext,
): Promise<PreparedToolAction> {
  const destination: NetworkDestination = { scheme: "https", host: "api.tavily.com", pathPrefix: "/search" };
  const secretRefs = ["tavilyApiKey"];
  const payloadBytes = Buffer.from(
    JSON.stringify({
      query: args.query,
      search_depth: args.depth ?? "basic",
      include_answer: true,
      include_images: false,
      max_results: 5,
    }),
    "utf8",
  );
  const payloadArtifact = await ctx.artifacts.put(payloadBytes, "application/json");

  const effects: EffectRequest[] = [
    { kind: "network-egress", destinations: [destination] },
    { kind: "secret-use", secretRefs },
    {
      kind: "model-egress",
      providerClass: ctx.modelProviderClass,
      dataClasses: ["normal"],
      sources: ["tavily-response"],
    },
  ];

  const operation: PreparedOperation = {
    kind: "broker",
    request: {
      kind: "http",
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

  const operation: PreparedOperation = {
    kind: "broker",
    request: {
      kind: "http",
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

export async function analyzeSendEmail(
  args: { to: string; subject: string; body: string; attachments?: string[] },
  ctx: ToolAnalysisContext,
): Promise<PreparedToolAction> {
  const cwd = ctx.workspace.canonicalRoot;
  const recipients: ExternalRecipient[] = [{ service: "smtp", recipient: args.to }];
  const secretRefs = ["smtpHost", "smtpUser", "smtpPass"];

  const attachmentTargets = await Promise.all(
    (args.attachments ?? []).map((p) => canonicalizePath(p, cwd)),
  );

  const payloadBytes = Buffer.from(args.body, "utf8");
  const payloadArtifact = await ctx.artifacts.put(payloadBytes, "text/plain");

  const effects: EffectRequest[] = [
    { kind: "external-send", destinations: recipients, dataClasses: ["normal"] },
    { kind: "secret-use", secretRefs },
    {
      kind: "model-egress",
      providerClass: ctx.modelProviderClass,
      dataClasses: ["normal"],
      sources: ["smtp-response"],
    },
  ];

  const operation: PreparedOperation = {
    kind: "broker",
    request: {
      kind: "external-send",
      requestId: generateId(),
      service: "smtp",
      recipients,
      payload: payloadArtifact,
      secretRefs,
    },
  };

  return buildAction({
    toolName: "send_email",
    ctx,
    args,
    argsDigest: digestArgs(args),
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

export async function analyzeSendNotification(
  args: { platform: "feishu" | "dingtalk" | "wecom"; content: string },
  ctx: ToolAnalysisContext,
): Promise<PreparedToolAction> {
  const hostMap = {
    feishu: "open.feishu.cn",
    dingtalk: "oapi.dingtalk.com",
    wecom: "qyapi.weixin.qq.com",
  };
  const host = hostMap[args.platform] ?? "im-provider";
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
  ];

  const operation: PreparedOperation = {
    kind: "broker",
    request: {
      kind: "external-send",
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

export async function analyzeGenerateImage(
  args: { prompt: string; image_path?: string },
  ctx: ToolAnalysisContext,
): Promise<PreparedToolAction> {
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
  const payloadBytes = Buffer.from(JSON.stringify({ prompt: args.prompt, n: 1, size: "1024x1024" }), "utf8");
  const payloadArtifact = await ctx.artifacts.put(payloadBytes, "application/json");

  // Spec 019 (FR-011): a file destination adds a filesystem-write effect at
  // analysis time (policy demands the commit-file cap, prompts honestly)
  // and rides the broker operation as outputCommit. No network I/O happens
  // here — the fetched bytes only exist after dispatch, where
  // BrokerExecutor hands them to FileCommitBroker (executor chaining).
  let outputCommit: { destination: CanonicalPathTarget } | undefined;
  if (typeof args.image_path === "string" && args.image_path.length > 0) {
    const target = await canonicalizePath(args.image_path, ctx.workspace.canonicalRoot);
    if (target.finalSymlink) {
      throw new Error(
        `Refusing image save: ${target.canonicalPath} is a symbolic link; exact commit would reject it (target-symlink)`,
      );
    }
    outputCommit = { destination: target };
  }

  const effects: EffectRequest[] = [
    ...(isLocal
      ? []
      : [
          { kind: "network-egress" as const, destinations: [destination] },
          { kind: "secret-use" as const, secretRefs },
        ]),
    ...(outputCommit
      ? [
          {
            kind: "filesystem-write" as const,
            targets: [
              { target: outputCommit.destination, mode: "create" as const, expected: snapshotPath(outputCommit.destination) },
            ],
          },
        ]
      : []),
    {
      kind: "model-egress",
      providerClass: ctx.modelProviderClass,
      dataClasses: ["normal"],
      sources: ["image-response"],
    },
  ];

  const operation: PreparedOperation = isLocal
    ? {
        kind: "none",
        result: { output: "image generated locally", success: true },
      }
    : {
        kind: "broker",
        request: {
          kind: "http",
          requestId: generateId(),
          destination,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payloadArtifact,
          secretRefs,
          ...(outputCommit ? { outputCommit } : {}),
        },
      };

  return buildAction({
    toolName: "generate_image",
    ctx,
    args,
    argsDigest: digestArgs(args),
    effects,
    operation,
    display: {
      title: `Generate image${outputCommit ? " → " + outputCommit.destination.basename : ""}`,
      summary: args.prompt.slice(0, 60),
      canonicalTargets: outputCommit
        ? [outputCommit.destination.canonicalPath]
        : isLocal
          ? []
          : [`${destination.scheme}://${destination.host}${destination.pathPrefix ?? ""}`],
    },
    risk: "safe",
  });
}

export async function analyzeTakeScreenshot(
  _args: unknown,
  ctx: ToolAnalysisContext,
): Promise<PreparedToolAction> {
  // R9: screenshot returns backend-unsupported unless an isolated browser worker is configured.
  const effects: EffectRequest[] = [];
  const operation: PreparedOperation = {
    kind: "none",
    result: { output: "Error: take_screenshot requires a declared browser worker", success: false, metadata: { code: "UNSUPPORTED_BACKEND" } },
  };
  return buildAction({
    toolName: "take_screenshot",
    ctx,
    args: _args,
    argsDigest: digestArgs(_args),
    effects,
    operation,
    display: { title: "Take screenshot", summary: "unsupported", canonicalTargets: [] },
    risk: "safe",
  });
}

export async function analyzeOptimizePrompt(
  args: { raw_prompt: string; context?: string } | Record<string, any>,
  ctx: ToolAnalysisContext,
): Promise<PreparedToolAction> {
  const { resolveCredentials } = await import("../../foundations/security/credential-resolver.js");
  const creds = resolveCredentials();

  const isLocal =
    process.env.SEEPIENT_LOCAL_PROMPT === "1" ||
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
        ? `${u.pathname}/chat/completions`
        : `${u.pathname.replace(/\/$/, "")}/v1/chat/completions`,
    };
  } catch {
    destination = { scheme: "https", host: "api.openai.com", pathPrefix: "/v1/chat/completions" };
  }

  const promptText = (args && typeof args === "object" ? ((args as any).raw_prompt ?? "") : "") as string;
  const secretRefs = ["OPENAI_API_KEY"];
  const payloadBytes = Buffer.from(JSON.stringify({ raw_prompt: promptText }), "utf8");
  const payloadArtifact = await ctx.artifacts.put(payloadBytes, "application/json");

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
      sources: ["prompt-optimizer-response"],
    },
  ];

  const operation: PreparedOperation = isLocal
    ? {
        kind: "none",
        result: { output: promptText, success: true },
      }
    : {
        kind: "broker",
        request: {
          kind: "http",
          requestId: generateId(),
          destination,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payloadArtifact,
          secretRefs,
        },
      };

  return buildAction({
    toolName: "optimize_prompt",
    ctx,
    args,
    argsDigest: digestArgs(args),
    effects,
    operation,
    display: {
      title: "Optimize prompt",
      summary: promptText.slice(0, 60),
      canonicalTargets: isLocal ? [] : [`${destination.scheme}://${destination.host}${destination.pathPrefix ?? ""}`],
    },
    risk: "safe",
  });
}

export async function analyzeUseSkill(
  args: { skill_name?: string; args?: Record<string, unknown> } | Record<string, any>,
  ctx: ToolAnalysisContext,
): Promise<PreparedToolAction> {
  const skillName = (args && typeof args === "object" && typeof args.skill_name === "string") ? args.skill_name : "";
  const operation: PreparedOperation = {
    kind: "trusted-host",
    registrationId: "use_skill",
    toolName: "use_skill",
    args: (args && typeof args === "object" ? args : {}) as any,
  };

  const effects: EffectRequest[] = [
    { kind: "host-callback", toolName: "use_skill" },
    {
      kind: "model-egress",
      providerClass: ctx.modelProviderClass,
      dataClasses: ["normal"],
      sources: ["skill-registry"],
    },
  ];

  return buildAction({
    toolName: "use_skill",
    ctx,
    args,
    argsDigest: digestArgs(args),
    effects,
    operation,
    display: {
      title: `Use skill ${skillName}`,
      summary: skillName,
      canonicalTargets: [],
    },
    risk: "safe",
  });
}

export async function analyzeGetCurrentDatetime(
  _args: unknown,
  ctx: ToolAnalysisContext,
): Promise<PreparedToolAction> {
  const nowStr = new Date().toISOString();
  const operation: PreparedOperation = {
    kind: "none",
    result: { output: nowStr, success: true },
  };
  const effects: EffectRequest[] = [
    {
      kind: "model-egress",
      providerClass: ctx.modelProviderClass,
      dataClasses: ["normal"],
      sources: ["direct-output"],
    },
  ];
  return buildAction({
    toolName: "get_current_datetime",
    ctx,
    args: _args,
    argsDigest: digestArgs(_args),
    effects,
    operation,
    display: { title: "Get current date/time", summary: nowStr, canonicalTargets: [] },
    risk: "safe",
  });
}

export async function analyzeManageTodos(
  args: unknown,
  ctx: ToolAnalysisContext,
): Promise<PreparedToolAction> {
  const operation: PreparedOperation = {
    kind: "none",
    result: { output: JSON.stringify(args ?? {}), success: true },
  };
  const effects: EffectRequest[] = [
    {
      kind: "model-egress",
      providerClass: ctx.modelProviderClass,
      dataClasses: ["normal"],
      sources: ["direct-output"],
    },
  ];
  return buildAction({
    toolName: "manage_todos",
    ctx,
    args,
    argsDigest: digestArgs(args),
    effects,
    operation,
    display: { title: "Manage todos", summary: "todo update", canonicalTargets: [] },
    risk: "safe",
  });
}

export async function analyzeRenderWidget(
  args: unknown,
  ctx: ToolAnalysisContext,
): Promise<PreparedToolAction> {
  const operation: PreparedOperation = {
    kind: "none",
    result: { output: JSON.stringify(args ?? {}), success: true },
  };
  const effects: EffectRequest[] = [
    {
      kind: "model-egress",
      providerClass: ctx.modelProviderClass,
      dataClasses: ["normal"],
      sources: ["direct-output"],
    },
  ];
  return buildAction({
    toolName: "render_widget",
    ctx,
    args,
    argsDigest: digestArgs(args),
    effects,
    operation,
    display: { title: "Render widget", summary: "widget spec", canonicalTargets: [] },
    risk: "safe",
  });
}

/** Registry of default analyzers for built-in tools.
 * Entries are cast to the wide `ToolAnalyzer` signature; each analyzer casts
 * `args` to its expected shape internally (matching the legacy registry). */
export const DEFAULT_ANALYZERS: Record<string, ToolAnalyzer> = {
  read_file: analyzeReadFile as ToolAnalyzer,
  write_file: analyzeWriteFile as ToolAnalyzer,
  edit_file: analyzeEditFile as ToolAnalyzer,
  execute_shell_command: analyzeExecuteShellCommand as ToolAnalyzer,
  web_search: analyzeWebSearch as ToolAnalyzer,
  read_website: analyzeReadWebsite as ToolAnalyzer,
  send_email: analyzeSendEmail as ToolAnalyzer,
  send_notification: analyzeSendNotification as ToolAnalyzer,
  generate_image: analyzeGenerateImage as ToolAnalyzer,
  take_screenshot: analyzeTakeScreenshot as ToolAnalyzer,
  optimize_prompt: analyzeOptimizePrompt as ToolAnalyzer,
  use_skill: analyzeUseSkill as ToolAnalyzer,
  get_current_datetime: analyzeGetCurrentDatetime as ToolAnalyzer,
  manage_todos: analyzeManageTodos as ToolAnalyzer,
  render_widget: analyzeRenderWidget as ToolAnalyzer,
};

export function resolveAnalyzerWithFallback(
  analyzers: Record<string, ToolAnalyzer>,
  toolName: string,
): ToolAnalyzer {
  if (analyzers[toolName]) return analyzers[toolName];
  return async (args: unknown, ctx: ToolAnalysisContext): Promise<PreparedToolAction> => {
    const jsonArgs = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
    const operation: PreparedOperation = {
      kind: "trusted-host",
      registrationId: toolName,
      toolName,
      args: jsonArgs as any,
    };
    const effects: EffectRequest[] = [
      { kind: "host-callback", toolName },
      {
        kind: "model-egress",
        providerClass: ctx.modelProviderClass,
        dataClasses: ["normal", "sensitive"],
        sources: [toolName],
      },
    ];
    const argsDigest = digestArgs(args);
    const actionDigest = digestAction({
      operation,
      effects,
      principalId: ctx.principalId,
      toolName,
      argsDigest,
      runId: ctx.runId,
      toolCallId: ctx.toolCallId,
    });
    return {
      version: 1,
      actionId: generateId(),
      runId: ctx.runId,
      toolCallId: ctx.toolCallId,
      toolName,
      principalId: ctx.principalId,
      argsDigest,
      actionDigest,
      risk: "destructive",
      effects,
      display: {
        title: toolName,
        summary: `Execute host callback ${toolName}`,
        canonicalTargets: [],
        effects: ["host-callback"],
      },
      operation,
    };
  };
}
