/**
 * Seepient Core — Settings Schema
 *
 * Static data structures mapping all user-visible settings to their
 * AppConfig paths, validation rules, env var overrides, and metadata.
 */

// ── Types ──────────────────────────────────────────────────────────────

export type SettingsCategory =
  | 'permissions'
  | 'tools'
  | 'notifications'
  | 'skills'
  | 'gateway'
  | 'sessions';

export interface SettingsMapEntry {
  dotKey: string;
  configPath: string[];
  category: SettingsCategory;
  label: string;
}

export interface SettingsSchemaEntry {
  type: 'string' | 'number' | 'boolean' | 'enum' | 'array';
  /** Element type for `array` settings. */
  itemType?: 'string';
  secret: boolean;
  enumValues?: string[];
  min?: number;
  max?: number;
  default?: string | number | boolean | string[];
  restartRequired: boolean;
  envVar?: string;
}

// ── Categories ─────────────────────────────────────────────────────────

export const SETTINGS_CATEGORIES: {
  key: SettingsCategory;
  label: string;
  description: string;
}[] = [
  {
    key: 'permissions',
    label: 'Permissions & Safety',
    description: 'Permission level and auto-confirm settings',
  },
  {
    key: 'tools',
    label: 'Tools & Integrations',
    description: 'Image generation, SMTP email, and web search settings',
  },
  {
    key: 'notifications',
    label: 'Notifications',
    description: 'Feishu, DingTalk, and WeCom webhook settings',
  },
  {
    key: 'skills',
    label: 'Skills',
    description: 'Skill system configuration (reserved for future use)',
  },
  {
    key: 'gateway',
    label: 'Gateway',
    description: 'MCP gateway, REST proxy, and OpenAPI adapter settings',
  },
  {
    key: 'sessions',
    label: 'Sessions',
    description: 'Session persistence and cleanup settings',
  },
];

// ── Settings Map ───────────────────────────────────────────────────────

const entries: [string, SettingsMapEntry][] = [
  // SMTP
  ['smtp.host', { dotKey: 'smtp.host', configPath: ['smtpHost'], category: 'tools', label: 'SMTP Host' }],
  ['smtp.port', { dotKey: 'smtp.port', configPath: ['smtpPort'], category: 'tools', label: 'SMTP Port' }],
  ['smtp.user', { dotKey: 'smtp.user', configPath: ['smtpUser'], category: 'tools', label: 'SMTP Username' }],
  ['smtp.pass', { dotKey: 'smtp.pass', configPath: ['smtpPass'], category: 'tools', label: 'SMTP Password' }],
  ['smtp.from', { dotKey: 'smtp.from', configPath: ['smtpFrom'], category: 'tools', label: 'SMTP From Address' }],

  // Search
  ['search.tavilyApiKey', { dotKey: 'search.tavilyApiKey', configPath: ['tavilyApiKey'], category: 'tools', label: 'Tavily API Key' }],

  // Notifications
  ['notifications.feishu.webhook', { dotKey: 'notifications.feishu.webhook', configPath: ['feishuWebhook'], category: 'notifications', label: 'Feishu Webhook URL' }],
  ['notifications.feishu.keyword', { dotKey: 'notifications.feishu.keyword', configPath: ['feishuKeyword'], category: 'notifications', label: 'Feishu Keyword' }],
  ['notifications.dingtalk.webhook', { dotKey: 'notifications.dingtalk.webhook', configPath: ['dingtalkWebhook'], category: 'notifications', label: 'DingTalk Webhook URL' }],
  ['notifications.dingtalk.keyword', { dotKey: 'notifications.dingtalk.keyword', configPath: ['dingtalkKeyword'], category: 'notifications', label: 'DingTalk Keyword' }],
  ['notifications.wecom.webhook', { dotKey: 'notifications.wecom.webhook', configPath: ['wecomWebhook'], category: 'notifications', label: 'WeCom Webhook URL' }],
  ['notifications.wecom.keyword', { dotKey: 'notifications.wecom.keyword', configPath: ['wecomKeyword'], category: 'notifications', label: 'WeCom Keyword' }],

  // Permissions
  ['agent.autoConfirm', { dotKey: 'agent.autoConfirm', configPath: ['autoConfirm'], category: 'permissions', label: 'Auto-Confirm All Tools' }],
  ['permissions.consentMode', { dotKey: 'permissions.consentMode', configPath: ['permissions', 'consentMode'], category: 'permissions', label: 'Consent Mode (ask-everything | edit-enabled | autonomous)' }],
  ['permissions.autonomousWarned', { dotKey: 'permissions.autonomousWarned', configPath: ['permissions', 'autonomousWarned'], category: 'permissions', label: 'Autonomous warning acknowledged' }],
  ['permissions.approvalTimeoutMs', { dotKey: 'permissions.approvalTimeoutMs', configPath: ['approvalTimeoutMs'], category: 'permissions', label: 'Approval Timeout (ms)' }],
  ['permissions.trustedHostAllowlist', { dotKey: 'permissions.trustedHostAllowlist', configPath: ['permissions', 'trustedHostAllowlist'], category: 'permissions', label: 'Trusted-Host Tool Allowlist' }],

  // Gateway
  ['gateway.enabled', { dotKey: 'gateway.enabled', configPath: ['gatewayEnabled'], category: 'gateway', label: 'Gateway Enabled' }],
  ['gateway.semanticTopK', { dotKey: 'gateway.semanticTopK', configPath: ['gatewaySemanticTopK'], category: 'gateway', label: 'Semantic Injection Top-K' }],
  ['gateway.defaultRateLimitPerMin', { dotKey: 'gateway.defaultRateLimitPerMin', configPath: ['gatewayRateLimit'], category: 'gateway', label: 'Gateway Rate Limit (per min)' }],
  ['gateway.maxAuditLogs', { dotKey: 'gateway.maxAuditLogs', configPath: ['gatewayMaxAuditLogs'], category: 'gateway', label: 'Max Audit Log Records' }],

  // Sessions
  ['sessions.maxAgeDays', { dotKey: 'sessions.maxAgeDays', configPath: ['sessions', 'maxAgeDays'], category: 'sessions', label: 'Max Session Age (days)' }],
];

export const SETTINGS_MAP: Map<string, SettingsMapEntry> = new Map(entries);

// ── Reverse lookup ─────────────────────────────────────────────────────

export const CONFIG_PATH_TO_DOTKEY: Map<string, string> = new Map(
  entries.map(([, entry]) => [entry.configPath.join('.'), entry.dotKey]),
);

// ── Consent Mode ───────────────────────────────────────────────────────

export type ConsentMode = "ask-everything" | "edit-enabled" | "autonomous";

export function consentModeToApprovalMode(mode: ConsentMode): "manual" | "balanced" | "autonomous" {
  switch (mode) {
    case "ask-everything":
      return "manual";
    case "edit-enabled":
      return "balanced";
    case "autonomous":
      return "autonomous";
    default:
      return "balanced";
  }
}

// ── Settings Schema ────────────────────────────────────────────────────

const schemaEntries: [string, SettingsSchemaEntry][] = [
  // SMTP
  ['smtp.host', { type: 'string', secret: false, restartRequired: false, envVar: 'SMTP_HOST' }],
  ['smtp.port', { type: 'string', secret: false, restartRequired: false, envVar: 'SMTP_PORT' }],
  ['smtp.user', { type: 'string', secret: false, restartRequired: false, envVar: 'SMTP_USER' }],
  ['smtp.pass', { type: 'string', secret: true, restartRequired: false, envVar: 'SMTP_PASS' }],
  ['smtp.from', { type: 'string', secret: false, restartRequired: false }],

  // Search
  ['search.tavilyApiKey', { type: 'string', secret: true, restartRequired: false, envVar: 'TAVILY_API_KEY' }],

  // Notifications
  ['notifications.feishu.webhook', { type: 'string', secret: true, restartRequired: false, envVar: 'FEISHU_WEBHOOK' }],
  ['notifications.feishu.keyword', { type: 'string', secret: false, restartRequired: false, envVar: 'FEISHU_KEYWORD' }],
  ['notifications.dingtalk.webhook', { type: 'string', secret: true, restartRequired: false, envVar: 'DINGTALK_WEBHOOK' }],
  ['notifications.dingtalk.keyword', { type: 'string', secret: false, restartRequired: false, envVar: 'DINGTALK_KEYWORD' }],
  ['notifications.wecom.webhook', { type: 'string', secret: true, restartRequired: false, envVar: 'WECOM_WEBHOOK' }],
  ['notifications.wecom.keyword', { type: 'string', secret: false, restartRequired: false, envVar: 'WECOM_KEYWORD' }],

  // Agent / Permissions
  ['agent.autoConfirm', { type: 'boolean', secret: false, default: false, restartRequired: false }],
  ['permissions.consentMode', { type: 'enum', secret: false, enumValues: ['ask-everything', 'edit-enabled', 'autonomous'], default: 'edit-enabled', restartRequired: false, envVar: 'SEEPIENT_CONSENT_MODE' }],
  ['permissions.autonomousWarned', { type: 'boolean', secret: false, default: false, restartRequired: false }],
  ['permissions.approvalTimeoutMs', { type: 'number', secret: false, default: 600000, min: 10000, max: 3600000, restartRequired: true, envVar: 'SEEPIENT_APPROVAL_TIMEOUT_MS' }],
  ['permissions.trustedHostAllowlist', { type: 'array', itemType: 'string', secret: false, default: ['use_skill'], restartRequired: true }],

  // Gateway
  ['gateway.enabled', { type: 'boolean', secret: false, default: true, restartRequired: true, envVar: 'SEEPIENT_GATEWAY_ENABLED' }],
  ['gateway.semanticTopK', { type: 'number', secret: false, default: 3, min: 1, max: 10, restartRequired: false }],
  ['gateway.defaultRateLimitPerMin', { type: 'number', secret: false, default: 60, min: 0, restartRequired: false, envVar: 'SEEPIENT_GATEWAY_RATE_LIMIT' }],
  ['gateway.maxAuditLogs', { type: 'number', secret: false, default: 1000, min: 10, max: 10000, restartRequired: false }],

  // Sessions
  ['sessions.maxAgeDays', { type: 'number', secret: false, default: 30, min: 0, restartRequired: false }],
];

export const SETTINGS_SCHEMA: Map<string, SettingsSchemaEntry> = new Map(schemaEntries);

// ── Env Var Map ────────────────────────────────────────────────────────

export const ENV_VAR_MAP: Map<string, string> = new Map(
  schemaEntries
    .filter(([, s]) => s.envVar !== undefined)
    .map(([dotKey, s]) => [dotKey, s.envVar!]),
);

// ── Helpers ────────────────────────────────────────────────────────────

export function getSettingEntry(dotKey: string): SettingsMapEntry | undefined {
  return SETTINGS_MAP.get(dotKey);
}

export function getSettingSchema(dotKey: string): SettingsSchemaEntry | undefined {
  return SETTINGS_SCHEMA.get(dotKey);
}

export function getDotKeyForConfigPath(path: string[]): string | undefined {
  return CONFIG_PATH_TO_DOTKEY.get(path.join('.'));
}

export function isSecretField(dotKey: string): boolean {
  return SETTINGS_SCHEMA.get(dotKey)?.secret ?? false;
}

export function isRestartRequired(dotKey: string): boolean {
  return SETTINGS_SCHEMA.get(dotKey)?.restartRequired ?? false;
}

export function getSettingsByCategory(category: SettingsCategory): string[] {
  const keys: string[] = [];
  for (const entry of SETTINGS_MAP.values()) {
    if (entry.category === category) keys.push(entry.dotKey);
  }
  return keys;
}
