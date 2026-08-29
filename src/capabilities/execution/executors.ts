/**
 * Operation executors for built-in operation kinds — Capabilities (spec 008,
 * T205/T212).
 *
 * Each executor handles one `PreparedOperation.kind`:
 *  - `CommitFilesExecutor`: routes write_file/edit_file/generated output
 *    through the FileCommitBroker. No built-in structured write performs a
 *    direct destination write (T205).
 *  - `ReadFileExecutor`: reads via canonicalized target; model-egress gate
 *    decides whether bytes reach history.
 *  - `BrokerExecutor`: typed HTTP / external-send via the EffectBroker.
 *  - `UnsupportedExecutor`: returns `backend-unsupported` for browser tools
 *    (and any other effect without a declared backend) (T212). No flag
 *    launches control-plane Chromium.
 *
 * Executors are sibling capabilities — they share Foundations contracts only
 * and never import each other or `capabilities/tools/`.
 */
import type { PreparedToolAction } from "../../foundations/contracts/prepared-action.js";
import type { CanonicalPathTarget, FileSnapshot } from "../../foundations/contracts/tool-effects.js";
import type { SnapshotStore } from "../../foundations/hashline/snapshot-store.js";
import type {
  ExecutionResult,
  ToolProgress,
} from "../../foundations/contracts/execution-boundary.js";
import type { CapabilityEnvelope } from "../../foundations/contracts/permission-policy.js";
import type { OperationExecutor } from "./operation-executor-registry.js";
import type {
  FileCommitBroker,
  PreparationArtifactStore,
  EffectBroker,
} from "../../foundations/contracts/execution-brokers.js";
import { UnsupportedBackendError } from "../../foundations/errors.js";
import { isSecurityPath } from "./environment-policy.js";
import { createSetupFailure } from "../../foundations/contracts/setup-failure.js";

/** Read the prepared bytes for a commit operation from the artifact store. */
async function readContent(
  artifacts: PreparationArtifactStore,
  ref: import("../../foundations/contracts/prepared-action.js").PreparedArtifactRef,
): Promise<Uint8Array> {
  return artifacts.read(ref);
}

/**
 * Commit-files executor. Validates every target via the FileCommitBroker
 * (which delegates to the native helper when available). When the native
 * helper is absent (exactCommit:false), falls back to an atomic temp+rename
 * write — the SAME mechanism the legacy write_file tool uses. The fallback
 * is less safe (no TOCTOU protection), but:
 *  1. The write uses the PREPARED bytes and destination (not model args).
 *  2. The capability envelope is still checked.
 *  3. Policy and audit still govern the call.
 * The boundary honestly advertises exactCommit:false so policy and the user
 * know the exact-commit guarantee isn't available.
 */
export class CommitFilesExecutor implements OperationExecutor {
  readonly kind = "commit-files" as const;
  private readonly broker: FileCommitBroker;
  private readonly artifacts: PreparationArtifactStore;
  private readonly useNative: boolean;
  private readonly allowFallback: boolean;

  constructor(opts: { broker: FileCommitBroker; artifacts: PreparationArtifactStore; useNative?: boolean; allowFallback?: boolean }) {
    this.broker = opts.broker;
    this.artifacts = opts.artifacts;
    this.useNative = opts.useNative ?? true;
    // No env default here — the composition root (buildLocalBoundary) owns
    // the single env-honoring opt-in (spec 019, FR-003). Tests construct
    // with explicit booleans.
    this.allowFallback = opts.allowFallback ?? false;
  }

  async execute(
    action: PreparedToolAction,
    envelope: CapabilityEnvelope,
    operation: Extract<PreparedToolAction["operation"], { kind: "commit-files" }>,
    _opts: { signal?: AbortSignal; onUpdate?: (u: ToolProgress) => void },
  ): Promise<ExecutionResult> {
    // T108a: deny any target under ~/.seepient/security/
    for (const commit of operation.commits) {
      if (isSecurityPath(commit.destination.canonicalPath)) {
        return {
          state: "failed",
          error: {
            code: "SECURITY_PATH_DENIED",
            message: `Writes to the security directory are prohibited: ${commit.destination.canonicalPath}`,
            retryable: false,
          },
          evidence: {
            backend: "local-native",
            actionDigest: action.actionDigest,
            executorId: "commit-files-denied",
            operationKind: "commit-files",
          },
        };
      }
    }
    const committed: string[] = [];
    // Diff-viewer parity (spec 019 FR-001): capture the first destination's
    // pre-commit content so metadata can carry oldContent/newContent exactly
    // like the legacy hashline handler did.
    let oldContent: string | null = null;
    try {
      const { readFile: fsReadOld } = await import("node:fs/promises");
      oldContent = await fsReadOld(operation.commits[0].destination.canonicalPath, "utf-8");
    } catch { /* new file or unreadable: metadata degrades, commit proceeds */ }
    try {
      for (const commit of operation.commits) {
        const bytes = await readContent(this.artifacts, commit.content);
        if (this.useNative) {
          await this.broker.commit({
            envelope,
            destination: commit.destination.canonicalPath,
            content: bytes,
            expected: commit.expected,
          });
        } else if (this.allowFallback) {
          await this.fallbackWrite(commit.destination, bytes, commit.expected);
        } else {
          return {
            state: "failed",
            error: {
              code: "EXACT_COMMIT_UNAVAILABLE",
              message: "Native exact-commit helper is unavailable on this system; exact file writes fail closed (FR-007).",
              retryable: false,
            },
            evidence: {
              backend: "local-native",
              actionDigest: action.actionDigest,
              executorId: "commit-files-unsupported",
              operationKind: "commit-files",
            },
          };
        }
        committed.push(commit.destination.canonicalPath);
      }
      const firstCommit = operation.commits[0];
      let metadata: Record<string, unknown> | undefined;
      if (firstCommit) {
        try {
          const bytes = await readContent(this.artifacts, firstCommit.content);
          const newContent = new TextDecoder().decode(bytes);
          metadata = {
            path: action.display.canonicalTargets[0] ?? firstCommit.destination.canonicalPath,
            isNewFile: !firstCommit.expected?.exists,
            oldContent,
            newContent,
            byteDelta: bytes.byteLength - (firstCommit.expected?.size ?? 0),
          };
        } catch (e) {
          process.stderr.write(`METADATA ERROR: ${e instanceof Error ? e.stack : String(e)}\n`);
        }
      }
      return {
        state: "succeeded",
        result: {
          output: `Successfully wrote to ${committed.join(", ")}`,
          success: true,
          metadata,
        },
        evidence: {
          backend: "local-native",
          actionDigest: action.actionDigest,
          executorId: this.useNative ? "commit-files-native" : "commit-files-fallback",
          operationKind: "commit-files",
          committedTargets: committed,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const remaining = operation.commits
        .filter((c) => !committed.includes(c.destination.canonicalPath))
        .map((c) => c.destination.canonicalPath);
      return {
        state: "failed",
        error: {
          code: "COMMIT_FAILED",
          message: committed.length > 0
            ? `${message} (committed: ${committed.join(",")}; uncommitted: ${remaining.join(",")})`
            : message,
          retryable: false,
        },
        evidence: {
          backend: "local-native",
          actionDigest: action.actionDigest,
          executorId: this.useNative ? "commit-files-native" : "commit-files-fallback",
          operationKind: "commit-files",
          committedTargets: committed,
        },
      };
    }
  }

  /**
   * Hardened interim fallback (spec 019 FR-005). Before the temp+rename the
   * destination is checked against the caller's expected snapshot: a symlinked
   * final component is refused (target-symlink-equivalent) and current disk
   * content must hash-match `expected.sha256` (snapshot-changed-equivalent).
   * This is the honest version of the weaker path — the native helper's
   * TOCTOU window closure is still absent, which is exactly why the fallback
   * is opt-in and scheduled for deletion (FR-013).
   */
  private async fallbackWrite(
    destination: CanonicalPathTarget,
    bytes: Uint8Array,
    expected?: FileSnapshot,
  ): Promise<void> {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const crypto = await import("node:crypto");
    const dest = destination.canonicalPath;
    if (destination.finalSymlink) {
      throw new Error(
        `Refusing fallback write: destination is a symbolic link (${dest}); exact-commit would reject this as target-symlink`,
      );
    }
    if (expected) {
      const st = await fs.lstat(dest).then(
        (s) => s,
        () => undefined,
      );
      if (expected.exists && !st) {
        throw new Error(
          `Fallback write refused: expected the file to exist but it is missing (snapshot changed): ${dest}`,
        );
      }
      if (!expected.exists && st) {
        throw new Error(
          `Fallback write refused: expected a new file but one exists (snapshot changed): ${dest}`,
        );
      }
      if (expected.exists && expected.sha256 && st) {
        const current = await fs.readFile(dest);
        const currentSha = crypto.createHash("sha256").update(current).digest("hex");
        if (currentSha !== expected.sha256) {
          throw new Error(
            `Fallback write refused: file changed since it was read (expected snapshot ${expected.sha256.slice(0, 12)}…, current ${currentSha.slice(0, 12)}…): ${dest}`,
          );
        }
      }
    }
    const dir = path.dirname(dest);
    const tmp = path.join(dir, `.seepient-tmp-${crypto.randomUUID().slice(0, 8)}`);
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(tmp, bytes);
      await fs.rename(tmp, dest);
    } catch (err) {
      try { await fs.unlink(tmp); } catch { /* temp may not exist */ }
      throw err;
    }
  }
}

/**
 * Read-file executor. Reads via the canonicalized target; the model-egress
 * gate (consulted by the caller before adding to history) decides release.
 *
 * Spec 019 FR-001 read-side parity: when a snapshot store is wired, a
 * successful read records the content and appends the `[content-tag:N]`
 * line — byte-for-byte the legacy handler contract (core.ts:77-79) — so a
 * following edit_file patch header resolves without manual pre-recording.
 */
export class ReadFileExecutor implements OperationExecutor {
  readonly kind = "read-file" as const;
  private readonly artifacts?: PreparationArtifactStore;
  private readonly snapshotStore?: SnapshotStore;

  constructor(opts?: { artifacts?: PreparationArtifactStore; snapshotStore?: SnapshotStore }) {
    this.artifacts = opts?.artifacts;
    this.snapshotStore = opts?.snapshotStore;
  }

  async execute(
    action: PreparedToolAction,
    _envelope: CapabilityEnvelope,
    operation: Extract<PreparedToolAction["operation"], { kind: "read-file" }>,
    _opts: { signal?: AbortSignal; onUpdate?: (u: ToolProgress) => void },
  ): Promise<ExecutionResult> {
    // T108a: deny reads of the security directory
    if (isSecurityPath(operation.target.canonicalPath)) {
      return {
        state: "failed",
        error: {
          code: "SECURITY_PATH_DENIED",
          message: `Reads of the security directory are prohibited: ${operation.target.canonicalPath}`,
          retryable: false,
        },
        evidence: {
          backend: "local-native",
          actionDigest: action.actionDigest,
          executorId: "read-file-denied",
          operationKind: "read-file",
        },
      };
    }
    try {
      const { readFile } = await import("node:fs/promises");
      const content = await readFile(operation.target.canonicalPath, "utf-8");
      const tag = this.snapshotStore?.record(operation.target.canonicalPath, content);
      const output = tag ? `${content}\n\n[content-tag:${tag}]` : content;
      return {
        state: "succeeded",
        result: { output, success: true },
        evidence: {
          backend: "local-native",
          actionDigest: action.actionDigest,
          executorId: "read-file",
          operationKind: "read-file",
          committedTargets: [operation.target.canonicalPath],
        },
      };
    } catch (err) {
      return {
        state: "failed",
        error: {
          code: "READ_FAILED",
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
        },
        evidence: {
          backend: "local-native",
          actionDigest: action.actionDigest,
          executorId: "read-file",
          operationKind: "read-file",
        },
      };
    }
  }
}

/**
 * Broker executor. Routes typed HTTP / external-send operations through the
 * EffectBroker; the broker owns DNS, redirects, secret resolution.
 */

/** Cap on broker responses materialized into model-visible tool output. */
const MAX_BROKER_OUTPUT_CHARS = 150_000;

function capBrokerOutput(text: string): string {
  if (text.length <= MAX_BROKER_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_BROKER_OUTPUT_CHARS)}\n…[truncated: response exceeded ${MAX_BROKER_OUTPUT_CHARS} characters]`;
}

/**
 * Minimal HTML→text conversion for read_website results. The model needs
 * readable page text, not markup: strip script/style/head blocks, turn
 * block-level closings into newlines, drop remaining tags, decode common
 * entities. A full parser dependency is not warranted for this.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|head|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\b[^>]*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|table|section|article|header|footer|blockquote|pre)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&(#[0-9]+|apos);/g, (m, d: string) => (d.startsWith("#") ? String.fromCodePoint(Number(d.slice(1))) : "'"))
    .replace(/&#x([0-9a-f]+);/gi, (_, d: string) => String.fromCodePoint(parseInt(d, 16)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Format Tavily search results into clean, token-efficient Markdown for the model.
 * Returns the raw string unchanged if it is not valid JSON or lacks a `results` array.
 */
function formatSearchResults(text: string): string {
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || !Array.isArray(data.results)) {
      return text;
    }

    const lines: string[] = [];
    if (data.query) {
      lines.push(`Search results for "${data.query}":`);
    }
    if (data.answer) {
      lines.push(`**Direct answer**: ${data.answer}`);
    }

    data.results.forEach((item: any, idx: number) => {
      const title = item.title || "Untitled";
      const url = item.url || "";
      let content = typeof item.content === "string" ? item.content : "";
      content = content.replace(/\s+/g, " ").trim();
      if (content.length > 400) {
        content = `${content.slice(0, 400)}…`;
      }
      lines.push(`${idx + 1}. **${title}**\n   ${url}\n   ${content}`);
    });

    return lines.join("\n\n").trim() || text;
  } catch {
    return text;
  }
}

export class BrokerExecutor implements OperationExecutor {
  readonly kind = "broker" as const;
  private readonly broker: EffectBroker;
  private readonly artifacts?: PreparationArtifactStore;
  private readonly workspaceRoot?: string;

  constructor(opts: { broker: EffectBroker; artifacts?: PreparationArtifactStore; workspaceRoot?: string }) {
    this.broker = opts.broker;
    this.artifacts = opts.artifacts;
    this.workspaceRoot = opts.workspaceRoot;
  }
  async execute(
    action: PreparedToolAction,
    envelope: CapabilityEnvelope,
    operation: Extract<PreparedToolAction["operation"], { kind: "broker" }>,
    _opts: { signal?: AbortSignal; onUpdate?: (u: ToolProgress) => void },
  ): Promise<ExecutionResult> {
    // Preflight credential checks (spec 017, T014)
    const { resolveCredentials } = await import("../../foundations/security/credential-resolver.js");
    const creds = resolveCredentials(undefined, this.workspaceRoot);
    if (action.toolName === "web_search" && !creds.tavilyApiKey) {
      const failure = createSetupFailure("web_search", "Tavily API key", "TAVILY_API_KEY / search.tavilyApiKey");
      return {
        state: "failed",
        error: {
          code: "SETUP_REQUIRED",
          message: failure.message,
          retryable: false,
        },
        evidence: {
          backend: "local-native",
          actionDigest: action.actionDigest,
          executorId: "broker-preflight",
          operationKind: "broker",
        },
      };
    }
    if (action.toolName === "send_email" && (!creds.smtpHost || !creds.smtpUser || !creds.smtpPass)) {
      const failure = createSetupFailure("send_email", "SMTP configuration", "SMTP_HOST / smtp.host");
      return {
        state: "failed",
        error: {
          code: "SETUP_REQUIRED",
          message: failure.message,
          retryable: false,
        },
        evidence: {
          backend: "local-native",
          actionDigest: action.actionDigest,
          executorId: "broker-preflight",
          operationKind: "broker",
        },
      };
    }
    if (action.toolName === "send_notification") {
      const platform = (operation.request as any)?.service ?? "feishu";
      const platformWebhook =
        platform === "feishu" ? creds.feishuWebhook :
        platform === "dingtalk" ? creds.dingtalkWebhook :
        platform === "wecom" ? creds.wecomWebhook :
        undefined;
      if (!platformWebhook) {
        const envKey = `${String(platform).toUpperCase()}_WEBHOOK`;
        const failure = createSetupFailure("send_notification", `${platform} webhook URL`, `${envKey} / notifications.${platform}.webhook`);
        return {
          state: "failed",
          error: {
            code: "SETUP_REQUIRED",
            message: failure.message,
            retryable: false,
          },
          evidence: {
            backend: "local-native",
            actionDigest: action.actionDigest,
            executorId: "broker-preflight",
            operationKind: "broker",
          },
        };
      }
    }
    if (action.toolName === "generate_image" && !creds.openaiApiKey && !creds.openaiBaseUrl) {
      const failure = createSetupFailure("generate_image", "OpenAI API key (or image provider credentials)", "OPENAI_API_KEY / image.apiKey");
      return {
        state: "failed",
        error: {
          code: "SETUP_REQUIRED",
          message: failure.message,
          retryable: false,
        },
        evidence: {
          backend: "local-native",
          actionDigest: action.actionDigest,
          executorId: "broker-preflight",
          operationKind: "broker",
        },
      };
    }

    const auth = {
      leaseId: envelope.envelopeId,
      actionDigest: action.actionDigest,
      expiresAt: envelope.expiresAt ?? Date.now() + 60_000,
      singleUseRequestId: operation.request.requestId,
    };
    const result = await this.broker.execute(operation.request, envelope, auth);
    if (result.status !== "succeeded") {
      return {
        state: "failed",
        error: result.error ?? {
          code: "BROKER_DENIED",
          message: `broker returned ${result.status}`,
          retryable: false,
        },
        evidence: {
          backend: "local-native",
          actionDigest: action.actionDigest,
          executorId: "broker",
          operationKind: "broker",
          effectiveDestinations: result.effectiveDestination
            ? [result.effectiveDestination]
            : [],
        },
      };
    }
    let outputText = "ok";
    if (result.output && this.artifacts) {
      try {
        const bytes = await this.artifacts.read(result.output);
        let text = new TextDecoder().decode(bytes);
        // The model reads page text, not markup — and context is not free.
        if (action.toolName === "read_website") text = htmlToText(text);
        if (action.toolName === "web_search") text = formatSearchResults(text);
        outputText = capBrokerOutput(text);
      } catch {
        outputText = `<broker artifact ${result.output.artifactId}>`;
      }
    } else if (result.output) {
      outputText = `<broker artifact ${result.output.artifactId}>`;
    }
    // Ground the model in what the server actually said: a 404/429/… page is
    // a completed fetch whose content the model must not mistake for the
    // requested document. Prefix HTTP results with the final status + URL.
    if (result.httpStatus !== undefined) {
      const dest = result.effectiveDestination;
      const url = dest ? ` ${dest.scheme}://${dest.host}${dest.pathPrefix ?? ""}` : "";
      outputText = `[HTTP ${result.httpStatus}${url}]\n\n${outputText}`;
    }
    return {
      state: "succeeded",
      result: {
        output: outputText,
        success: true,
      },
      evidence: {
        backend: "local-native",
        actionDigest: action.actionDigest,
        executorId: "broker",
        operationKind: "broker",
        effectiveDestinations: result.effectiveDestination
          ? [result.effectiveDestination]
          : [],
      },
    };
  }
}

/**
 * Unsupported executor — returns `backend-unsupported` for operation kinds
 * the selected backend cannot enforce. Used for browser tools (T212): no
 * flag launches control-plane Chromium.
 */
export class UnsupportedExecutor implements OperationExecutor {
  readonly kind: PreparedToolAction["operation"]["kind"];

  constructor(kind: PreparedToolAction["operation"]["kind"]) {
    this.kind = kind;
  }

  async execute(action: PreparedToolAction): Promise<ExecutionResult> {
    throw new UnsupportedBackendError({
      backend: "local-native",
      operationKind: action.operation.kind,
      actionDigest: action.actionDigest,
    });
  }
}

/**
 * Trusted-host executor. Host tools are application authority and run the
 * registered callback directly — they are always audit-labelled and excluded
 * from agent-grant persistence. Registry-ONLY (spec 019 FR-006): the lookup
 * consults the composition root's callback map and nothing else — the former
 * ambient `getAllToolModules()` fallback is deleted. Misses fail closed with
 * `HOST_TOOL_NOT_REGISTERED`.
 */
export class TrustedHostExecutor implements OperationExecutor {
  readonly kind = "trusted-host" as const;
  private readonly callbacks: Map<string, (args: unknown) => Promise<unknown>>;

  constructor(callbacks: Map<string, (args: unknown) => Promise<unknown>>) {
    this.callbacks = callbacks;
  }

  async execute(
    action: PreparedToolAction,
    _envelope: CapabilityEnvelope,
    operation: Extract<PreparedToolAction["operation"], { kind: "trusted-host" }>,
    _opts: { signal?: AbortSignal; onUpdate?: (u: ToolProgress) => void },
  ): Promise<ExecutionResult> {
    const cb = this.callbacks.get(operation.registrationId) ?? (operation.toolName ? this.callbacks.get(operation.toolName) : undefined);
    if (!cb) {
      return {
        state: "failed",
        error: {
          code: "HOST_TOOL_NOT_REGISTERED",
          message: `No host callback registered for ${operation.registrationId}`,
          retryable: false,
        },
        evidence: {
          backend: "local-native",
          actionDigest: action.actionDigest,
          executorId: "trusted-host",
          operationKind: "trusted-host",
        },
      };
    }
    try {
      const raw = await cb(operation.args);
      const res = typeof raw === "string" ? { output: raw, success: true, metadata: undefined } : (raw as any);
      return {
        state: "succeeded",
        result: {
          output: typeof res?.output === "string" ? res.output : JSON.stringify(res?.output ?? res ?? ""),
          success: res?.success ?? true,
          metadata: res?.metadata,
        },
        evidence: {
          backend: "local-native",
          actionDigest: action.actionDigest,
          executorId: "trusted-host",
          operationKind: "trusted-host",
        },
      };
    } catch (err) {
      return {
        state: "failed",
        error: {
          code: "HOST_TOOL_FAILED",
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
        },
        evidence: {
          backend: "local-native",
          actionDigest: action.actionDigest,
          executorId: "trusted-host",
          operationKind: "trusted-host",
        },
      };
    }
  }
}

/**
 * None-op executor — for tools with no side effects (e.g. get_current_datetime).
 * Returns the pre-computed result attached to the prepared operation.
 */
export class NoneExecutor implements OperationExecutor {
  readonly kind = "none" as const;

  async execute(
    action: PreparedToolAction,
    _envelope: CapabilityEnvelope,
    operation: Extract<PreparedToolAction["operation"], { kind: "none" }>,
    _opts: { signal?: AbortSignal; onUpdate?: (u: ToolProgress) => void },
  ): Promise<ExecutionResult> {
    return {
      state: "succeeded",
      result: operation.result,
      evidence: {
        backend: "local-native",
        actionDigest: action.actionDigest,
        executorId: "none",
        operationKind: "none",
      },
    };
  }
}
