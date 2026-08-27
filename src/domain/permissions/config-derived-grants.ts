/**
 * Config-derived capability grants — Domain (spec 017, T007).
 *
 * Evaluates stored configuration and environment variables at startup to
 * produce concrete, deterministic capability grants for the runtime baseline.
 *
 * Rules (from contracts/capability-defaults.md):
 *  1. Read the same settings/env resolution the executors use.
 *  2. Derived grants are exact entries (concrete host, concrete secret ref).
 *  3. Never persisted. Evaluated in memory each run into `runtimeBaseline`.
 *  4. Absent configuration yields no capability (tools then fail with SetupFailure).
 */
import type { Capability } from "../../foundations/contracts/permission-policy.js";
import { resolveCredentials } from "../../foundations/security/credential-resolver.js";

export interface ConfigDerivedGrantsOptions {
  config?: Record<string, any>;
  env?: Record<string, string | undefined>;
  workspaceRoot?: string;
}

/**
 * Derive runtime baseline capabilities from active configuration and environment.
 */
export function deriveConfigGrants(options: ConfigDerivedGrantsOptions = {}): Capability[] {
  const creds = resolveCredentials(options.config, options.workspaceRoot);
  const config = options.config ?? creds.rawConfig;
  const env = options.env ?? process.env;
  const capabilities: Capability[] = [];

  // 1. Tavily web search
  const tavilyKey = creds.tavilyApiKey || env.TAVILY_API_KEY;
  if (tavilyKey) {
    capabilities.push(
      { kind: "network-destination", scheme: "https", host: "api.tavily.com" },
      { kind: "secret-ref", ref: "tavilyApiKey" },
    );
  }

  // 2. Image generation / prompt optimization endpoint
  const rawBaseUrl =
    creds.openaiBaseUrl ||
    (config as any).imageBaseUrl ||
    (config as any).baseUrl ||
    env.OPENAI_COMPAT_BASE_URL ||
    env.OPENAI_BASE_URL ||
    "https://api.openai.com/v1";
  const rawApiKey =
    creds.openaiApiKey ||
    (config as any).imageApiKey ||
    (config as any).apiKey ||
    env.OPENAI_API_KEY;

  if (rawApiKey) {
    try {
      const u = new URL(rawBaseUrl.startsWith("http") ? rawBaseUrl : `https://${rawBaseUrl}`);
      capabilities.push({
        kind: "network-destination",
        scheme: u.protocol === "http:" ? "http" : "https",
        host: u.hostname,
        ...(u.port ? { port: Number(u.port) } : {}),
      });
    } catch {
      capabilities.push({
        kind: "network-destination",
        scheme: "https",
        host: "api.openai.com",
      });
    }
    capabilities.push({ kind: "secret-ref", ref: "OPENAI_API_KEY" });
    if ((config as any).imageApiKey) capabilities.push({ kind: "secret-ref", ref: "imageApiKey" });
    if ((config as any).apiKey) capabilities.push({ kind: "secret-ref", ref: "apiKey" });
  }

  // 3. SMTP email
  const smtpHost = creds.smtpHost || env.SMTP_HOST;
  if (smtpHost) {
    capabilities.push({ kind: "secret-ref", ref: "smtpHost" });
    if (creds.smtpUser || env.SMTP_USER) {
      capabilities.push({ kind: "secret-ref", ref: "smtpUser" });
    }
    if (creds.smtpPass || env.SMTP_PASS) {
      capabilities.push({ kind: "secret-ref", ref: "smtpPass" });
    }
  }

  // 4. Notifications
  const feishuWebhook = creds.feishuWebhook || env.FEISHU_WEBHOOK;
  if (feishuWebhook) {
    capabilities.push(
      { kind: "network-destination", scheme: "https", host: "open.feishu.cn" },
      { kind: "secret-ref", ref: "feishuWebhook" },
      { kind: "secret-ref", ref: "feishuKeyword" },
    );
  }

  const dingtalkWebhook = creds.dingtalkWebhook || env.DINGTALK_WEBHOOK;
  if (dingtalkWebhook) {
    capabilities.push(
      { kind: "network-destination", scheme: "https", host: "oapi.dingtalk.com" },
      { kind: "secret-ref", ref: "dingtalkWebhook" },
      { kind: "secret-ref", ref: "dingtalkKeyword" },
    );
  }

  const wecomWebhook = creds.wecomWebhook || env.WECOM_WEBHOOK;
  if (wecomWebhook) {
    capabilities.push(
      { kind: "network-destination", scheme: "https", host: "qyapi.weixin.qq.com" },
      { kind: "secret-ref", ref: "wecomWebhook" },
      { kind: "secret-ref", ref: "wecomKeyword" },
    );
  }

  // Deduplicate capabilities by stable key
  const seen = new Set<string>();
  const deduped: Capability[] = [];
  for (const cap of capabilities) {
    const key = JSON.stringify(cap, Object.keys(cap).sort());
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(cap);
  }

  return deduped;
}
