/**
 * Shared Credential and Security Configuration Resolver (Spec 017).
 *
 * Single source of truth for resolving service credentials across:
 * - Preflight checks (executors.ts)
 * - Derived grants (config-derived-grants.ts)
 * - Analyzers (comm-analyzers.ts, analyzers.ts)
 * - EffectBroker internal secret resolution (effect-broker.ts)
 *
 * Resolution precedence:
 * 1. Explicit caller-provided customConfig
 * 2. Environment variables (applyEnvOverrides)
 * 3. Local workspace settings (.seepient/setting.json)
 * 4. Global user settings (~/.seepient/setting.json)
 */

import {
  loadJsonConfig,
  getGlobalConfigFile,
  getLocalConfigFile,
  type AppConfig,
} from "../config.js";

function getVal(config: Record<string, any> | undefined, ...keys: (string | string[])[]): string | undefined {
  if (!config) return undefined;
  for (const key of keys) {
    if (typeof key === "string") {
      if (typeof config[key] === "string" && config[key]) return config[key];
    } else if (Array.isArray(key)) {
      let cur: any = config;
      for (const part of key) {
        if (cur && typeof cur === "object") cur = cur[part];
        else { cur = undefined; break; }
      }
      if (typeof cur === "string" && cur) return cur;
    }
  }
  return undefined;
}

export interface ResolvedCredentials {
  tavilyApiKey?: string;
  smtpHost?: string;
  smtpPort?: string;
  smtpUser?: string;
  smtpPass?: string;
  smtpFrom?: string;
  feishuWebhook?: string;
  feishuKeyword?: string;
  dingtalkWebhook?: string;
  dingtalkKeyword?: string;
  wecomWebhook?: string;
  wecomKeyword?: string;
  rawConfig: AppConfig;
}

/**
 * Resolve all service credentials from merged settings and environment variables.
 */
export function resolveCredentials(
  customConfig?: Record<string, unknown>,
  workspaceRoot?: string,
): ResolvedCredentials {
  const global = loadJsonConfig(getGlobalConfigFile()).config as Record<string, any>;
  const local = loadJsonConfig(getLocalConfigFile(workspaceRoot)).config as Record<string, any>;
  const custom = customConfig as Record<string, any> | undefined;

  const resolve = (envKey: string | undefined, ...keys: (string | string[])[]): string | undefined => {
    // 1. Custom explicit config
    const customVal = getVal(custom, ...keys);
    if (customVal !== undefined) return customVal;

    // 2. Environment variable
    if (envKey && process.env[envKey]) return process.env[envKey];

    // 3. Local workspace setting
    const localVal = getVal(local, ...keys);
    if (localVal !== undefined) return localVal;

    // 4. Global user setting
    const globalVal = getVal(global, ...keys);
    if (globalVal !== undefined) return globalVal;

    return undefined;
  };

  const tavilyApiKey = resolve("TAVILY_API_KEY", "tavilyApiKey", "search.tavilyApiKey", ["search", "tavilyApiKey"]);
  const smtpHost = resolve("SMTP_HOST", "smtpHost", "smtp.host", ["smtp", "host"]);
  const smtpPort = resolve("SMTP_PORT", "smtpPort", "smtp.port", ["smtp", "port"]);
  const smtpUser = resolve("SMTP_USER", "smtpUser", "smtp.user", ["smtp", "user"]);
  const smtpPass = resolve("SMTP_PASS", "smtpPass", "smtp.pass", ["smtp", "pass"]);
  const smtpFrom = resolve("SMTP_FROM", "smtpFrom", "smtp.from", ["smtp", "from"]);
  const feishuWebhook = resolve("FEISHU_WEBHOOK", "feishuWebhook", "notifications.feishu.webhook", ["notifications", "feishu", "webhook"]);
  const feishuKeyword = resolve("FEISHU_KEYWORD", "feishuKeyword", "notifications.feishu.keyword", ["notifications", "feishu", "keyword"]);
  const dingtalkWebhook = resolve("DINGTALK_WEBHOOK", "dingtalkWebhook", "notifications.dingtalk.webhook", ["notifications", "dingtalk", "webhook"]);
  const dingtalkKeyword = resolve("DINGTALK_KEYWORD", "dingtalkKeyword", "notifications.dingtalk.keyword", ["notifications", "dingtalk", "keyword"]);
  const wecomWebhook = resolve("WECOM_WEBHOOK", "wecomWebhook", "notifications.wecom.webhook", ["notifications", "wecom", "webhook"]);
  const wecomKeyword = resolve("WECOM_KEYWORD", "wecomKeyword", "notifications.wecom.keyword", ["notifications", "wecom", "keyword"]);

  const rawConfig: AppConfig = { ...global, ...local, ...custom };

  return {
    tavilyApiKey,
    smtpHost,
    smtpPort,
    smtpUser,
    smtpPass,
    smtpFrom,
    feishuWebhook,
    feishuKeyword,
    dingtalkWebhook,
    dingtalkKeyword,
    wecomWebhook,
    wecomKeyword,
    rawConfig,
  };
}

/**
 * Resolve a named secret reference to its secret string value.
 */
export function resolveSecretRef(
  ref: string,
  customConfig?: Record<string, unknown>,
  workspaceRoot?: string,
): string | undefined {
  const creds = resolveCredentials(customConfig, workspaceRoot);
  switch (ref) {
    case "tavilyApiKey":
      return creds.tavilyApiKey;
    case "smtpHost":
      return creds.smtpHost;
    case "smtpPort":
      return creds.smtpPort;
    case "smtpUser":
      return creds.smtpUser;
    case "smtpPass":
      return creds.smtpPass;
    case "smtpFrom":
      return creds.smtpFrom;
    case "feishuWebhook":
      return creds.feishuWebhook;
    case "feishuKeyword":
      return creds.feishuKeyword;
    case "dingtalkWebhook":
      return creds.dingtalkWebhook;
    case "dingtalkKeyword":
      return creds.dingtalkKeyword;
    case "wecomWebhook":
      return creds.wecomWebhook;
    case "wecomKeyword":
      return creds.wecomKeyword;
    case "tavily":
      return creds.tavilyApiKey;
    default: {
      const direct = (creds as unknown as Record<string, unknown>)[ref];
      if (typeof direct === "string" && direct) return direct;
      if (typeof process !== "undefined" && process.env) {
        const envVal =
          process.env[ref] ??
          process.env[ref.toUpperCase()] ??
          process.env[ref.replace(/([A-Z])/g, "_$1").toUpperCase()];
        if (typeof envVal === "string" && envVal) return envVal;
      }
      return undefined;
    }
  }
}
