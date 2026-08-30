# Seepient Agent Settings Catalog

**Version:** 0.2.2
**Last Updated:** 2025-04-15
**Status:** Authoritative Reference

This document is the complete specification for every configurable property in Seepient Agent. It covers all settings across CLI, SDK, and Server adapters, their types, defaults, validation rules, environment variable overrides, and cross-setting dependencies.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Configuration Resolution](#2-configuration-resolution)
3. [Category 1: Providers & Models](#3-category-1-providers--models)
4. [Category 2: Image Generation](#4-category-2-image-generation)
5. [Category 3: Email / SMTP](#5-category-3-email--smtp)
6. [Category 4: Web Search](#6-category-4-web-search)
7. [Category 5: Notifications](#7-category-5-notifications)
8. [Category 6: Agent Behavior](#8-category-6-agent-behavior)
9. [Category 7: Server](#9-category-7-server)
10. [Category 8: Session & Persistence](#10-category-8-session--persistence)
11. [Category 9: Skills](#11-category-9-skills)
12. [Deprecated Settings](#12-deprecated-settings)
13. [Proposed New Settings](#13-proposed-new-settings)
14. [Cross-Setting Validation Rules](#14-cross-setting-validation-rules)
15. [Summary Matrix](#15-summary-matrix)

---

## 1. Overview

### Configuration Files

| Scope | Path | Priority |
|-------|------|----------|
| Global | `~/.seepient/setting.json` | Lower |
| Project | `.seepient/setting.json` | Higher |
| Environment | Env vars | Highest |

**Merge order** (highest wins): env vars > project `.seepient/setting.json` > global `~/.seepient/setting.json` > defaults.

### Scope Legend

| Scope | Meaning |
|-------|---------|
| `global` | Only `~/.seepient/setting.json` |
| `project` | Only `.seepient/setting.json` |
| `both` | Either file; project overrides global |
| `env` | Environment variable only |
| `runtime` | Passed at invocation time, not persisted |

### Sensitivity Legend

| Flag | Meaning |
|------|---------|
| Yes | Secret. Masked in display (first 3 + last 4 chars). Never logged. |
| No | Non-secret. Safe to display and log. |

---

## 2. Configuration Resolution

The resolution chain for a given setting follows this order:

```
1. CLI flag / SDK option / Server option (runtime)
2. Environment variable
3. Project config (.seepient/setting.json)
4. Global config (~/.seepient/setting.json)
5. Hardcoded default
```

Provider keys have an additional resolution path: the `models.<provider>.apiKey` map entry in config is checked after env vars but before falling back to defaults. For the active provider, the resolution is:

```
env var > models.<provider>.apiKey (config) > legacy top-level apiKey (deprecated)
```

---

## 3. Category 1: Providers & Models

### 3.1 `provider`

| Property | Value |
|----------|-------|
| **Key** | `provider` |
| **Display Name** | Active Provider |
| **Description** | Which LLM provider to use for the default agent loop. All adapters delegate to this provider unless overridden per-request. |
| **Type** | enum |
| **Default Value** | `"openai-compatible"` |
| **Required** | No |
| **Sensitive** | No |
| **Valid Values** | `"openai"` \| `"openai-compatible"` \| `"anthropic"` \| `"glm"` |
| **Env Var Override** | `LLM_PROVIDER` or `SEEPIENT_PROVIDER` |
| **Scope** | both |
| **Runtime Editable** | Yes (hot-apply) |
| **Category** | Providers & Models |
| **Depends On** | Corresponding `models.<provider>.apiKey` or env var must be set |

**Notes:** `LLM_PROVIDER` and `SEEPIENT_PROVIDER` are checked in that order. Invalid values silently fall through to the default. SDK and Server callers can override per-request via the `provider` option.

---

### 3.2 `models.openai.apiKey`

| Property | Value |
|----------|-------|
| **Key** | `models.openai.apiKey` |
| **Display Name** | OpenAI API Key |
| **Description** | API key for the OpenAI provider. Used for GPT models via the official OpenAI API. |
| **Type** | string |
| **Default Value** | _(none)_ |
| **Required** | Yes (if `openai` is the active provider) |
| **Sensitive** | Yes |
| **Valid Values** | Non-empty string starting with `sk-` |
| **Env Var Override** | `OPENAI_API_KEY` |
| **Scope** | both |
| **Runtime Editable** | Yes (restart required) |
| **Category** | Providers & Models |
| **Depends On** | — |

**Notes:** When `OPENAI_API_KEY` is set, the config-loader also populates `openai-compatible` if it is not already configured, sharing the same key.

---

### 3.3 `models.openai.model`

| Property | Value |
|----------|-------|
| **Key** | `models.openai.model` |
| **Display Name** | OpenAI Model |
| **Description** | Default model for the OpenAI provider. Can be any valid OpenAI model identifier. |
| **Type** | string |
| **Default Value** | `"gpt-5.4"` |
| **Required** | No |
| **Sensitive** | No |
| **Valid Values** | Any valid OpenAI model ID (e.g., `gpt-4o`, `gpt-5.4`, `o3`) |
| **Env Var Override** | `OPENAI_MODEL` |
| **Scope** | both |
| **Runtime Editable** | Yes (hot-apply) |
| **Category** | Providers & Models |
| **Depends On** | `models.openai.apiKey` |

---

### 3.4 `models.anthropic.apiKey`

| Property | Value |
|----------|-------|
| **Key** | `models.anthropic.apiKey` |
| **Display Name** | Anthropic API Key |
| **Description** | API key for the Anthropic provider. Used for Claude models. |
| **Type** | string |
| **Default Value** | _(none)_ |
| **Required** | Yes (if `anthropic` is the active provider) |
| **Sensitive** | Yes |
| **Valid Values** | Non-empty string starting with `sk-ant-` |
| **Env Var Override** | `ANTHROPIC_API_KEY` |
| **Scope** | both |
| **Runtime Editable** | Yes (restart required) |
| **Category** | Providers & Models |
| **Depends On** | — |

---

### 3.5 `models.anthropic.model`

| Property | Value |
|----------|-------|
| **Key** | `models.anthropic.model` |
| **Display Name** | Anthropic Model |
| **Description** | Default model for the Anthropic provider. |
| **Type** | string |
| **Default Value** | `"claude-sonnet-4-6-20260320"` |
| **Required** | No |
| **Sensitive** | No |
| **Valid Values** | Any valid Anthropic model ID (e.g., `claude-sonnet-4-6-20260320`, `claude-opus-4-20250514`) |
| **Env Var Override** | `ANTHROPIC_MODEL` |
| **Scope** | both |
| **Runtime Editable** | Yes (hot-apply) |
| **Category** | Providers & Models |
| **Depends On** | `models.anthropic.apiKey` |

---

### 3.6 `models.glm.apiKey`

| Property | Value |
|----------|-------|
| **Key** | `models.glm.apiKey` |
| **Display Name** | GLM API Key |
| **Description** | API key for the GLM provider. Routes through `api.z.ai/api/anthropic` using the Anthropic-compatible interface. |
| **Type** | string |
| **Default Value** | _(none)_ |
| **Required** | Yes (if `glm` is the active provider) |
| **Sensitive** | Yes |
| **Valid Values** | Non-empty string |
| **Env Var Override** | `GLM_API_KEY` |
| **Scope** | both |
| **Runtime Editable** | Yes (restart required) |
| **Category** | Providers & Models |
| **Depends On** | — |

---

### 3.7 `models.glm.model`

| Property | Value |
|----------|-------|
| **Key** | `models.glm.model` |
| **Display Name** | GLM Model |
| **Description** | Model for the GLM provider. Supports aliases that map to actual model IDs. |
| **Type** | string |
| **Default Value** | `"opus"` |
| **Required** | No |
| **Sensitive** | No |
| **Valid Values** | Alias: `"haiku"` \| `"sonnet"` \| `"opus"`. Direct: any GLM model ID (e.g., `glm-5.1`, `glm-4.7`, `glm-4.5-air`). |
| **Env Var Override** | `GLM_MODEL` |
| **Scope** | both |
| **Runtime Editable** | Yes (hot-apply) |
| **Category** | Providers & Models |
| **Depends On** | `models.glm.apiKey` |

**Alias Resolution:**

| Alias | Resolves To |
|-------|-------------|
| `haiku` | `glm-4.5-air` |
| `sonnet` | `glm-4.7` |
| `opus` | `glm-5.1` |

Unknown aliases pass through unchanged.

---

### 3.8 `models.openai-compatible.apiKey`

| Property | Value |
|----------|-------|
| **Key** | `models.openai-compatible.apiKey` |
| **Display Name** | OpenAI-Compatible API Key |
| **Description** | API key for any OpenAI-compatible endpoint (self-hosted, proxy, alternative provider). |
| **Type** | string |
| **Default Value** | _(none)_ |
| **Required** | Yes (if `openai-compatible` is the active provider) |
| **Sensitive** | Yes |
| **Valid Values** | Non-empty string |
| **Env Var Override** | `OPENAI_COMPAT_API_KEY` |
| **Scope** | both |
| **Runtime Editable** | Yes (restart required) |
| **Category** | Providers & Models |
| **Depends On** | — |

**Notes:** Deprecated fallback: `SEEPIENT_API_KEY` (emits warning). Also falls back to `OPENAI_API_KEY` during env override if `OPENAI_COMPAT_API_KEY` is not set.

---

### 3.9 `models.openai-compatible.baseUrl`

| Property | Value |
|----------|-------|
| **Key** | `models.openai-compatible.baseUrl` |
| **Display Name** | OpenAI-Compatible Base URL |
| **Description** | Base URL for the OpenAI-compatible API endpoint. Required when using the `openai-compatible` provider. |
| **Type** | string |
| **Default Value** | _(none)_ — must be set explicitly |
| **Required** | Yes (if `openai-compatible` is the active provider) |
| **Sensitive** | No |
| **Valid Values** | Valid HTTPS or HTTP URL ending with `/v1` (convention). Example: `https://api.myprovider.com/v1` |
| **Env Var Override** | `OPENAI_COMPAT_BASE_URL` |
| **Scope** | both |
| **Runtime Editable** | Yes (restart required) |
| **Category** | Providers & Models |
| **Depends On** | `models.openai-compatible.apiKey` |

**Notes:** Deprecated fallback: `OPENAI_BASE_URL` (emits warning). The `addProvider()` function throws if `baseUrl` is missing for `openai-compatible`.

**Cross-validation:** If `provider` is `"openai-compatible"`, this setting is **required**. The `addProvider()` call in `provider-config.ts` enforces this.

---

### 3.10 `models.openai-compatible.model`

| Property | Value |
|----------|-------|
| **Key** | `models.openai-compatible.model` |
| **Display Name** | OpenAI-Compatible Model |
| **Description** | Default model ID for the OpenAI-compatible provider. |
| **Type** | string |
| **Default Value** | `"gpt-5.4"` |
| **Required** | No |
| **Sensitive** | No |
| **Valid Values** | Any model ID supported by the target endpoint |
| **Env Var Override** | `OPENAI_MODEL` |
| **Scope** | both |
| **Runtime Editable** | Yes (hot-apply) |
| **Category** | Providers & Models |
| **Depends On** | `models.openai-compatible.apiKey`, `models.openai-compatible.baseUrl` |

---

### 3.11 `timeout` (Provider)

| Property | Value |
|----------|-------|
| **Key** | _(per-provider, via `addProvider()`)_ |
| **Display Name** | Provider Timeout |
| **Description** | Request timeout in milliseconds for the provider's HTTP client. GLM uses a hardcoded 3,000,000 ms (50 min) timeout. Other providers use the SDK default. |
| **Type** | number |
| **Default Value** | Provider SDK default (varies). GLM: `3000000` |
| **Required** | No |
| **Sensitive** | No |
| **Valid Values** | Positive integer, milliseconds |
| **Env Var Override** | _(none — only via SDK `addProvider()`)_ |
| **Scope** | runtime |
| **Runtime Editable** | Yes (restart required) |
| **Category** | Providers & Models |
| **Depends On** | — |

**Notes:** Not exposed in `AppConfig` or env vars today. Only configurable via the SDK's `addProvider()` or `configureProviders()` API. GLM hardcodes this to 3,000,000 ms in the factory.

---

### 3.12 `LLM_MODEL` / `SEEPIENT_MODEL` (Global Model Override)

| Property | Value |
|----------|-------|
| **Key** | _(env var only)_ |
| **Display Name** | Global Model Override |
| **Description** | Overrides the default model for any provider that does not have a provider-specific model set. Lowest-priority model fallback. |
| **Type** | string |
| **Default Value** | _(none)_ |
| **Required** | No |
| **Sensitive** | No |
| **Valid Values** | Any model ID |
| **Env Var Override** | `LLM_MODEL` or `SEEPIENT_MODEL` (checked in that order) |
| **Scope** | env |
| **Runtime Editable** | No (read-only, set before process start) |
| **Category** | Providers & Models |
| **Depends On** | — |

**Resolution order for a provider's model:** `PROVIDER_MODEL` env var > `models.<provider>.model` (config) > `LLM_MODEL` env var > `SEEPIENT_MODEL` env var > hardcoded `DEFAULT_MODELS` map.

---

### 3.13 Default Models Map (Hardcoded)

The following defaults are used when no model is configured:

| Provider | Default Model |
|----------|---------------|
| `openai` | `gpt-5.4` |
| `openai-compatible` | `gpt-5.4` |
| `anthropic` | `claude-sonnet-4-6-20260320` |
| `glm` | `opus` (resolves to `glm-5.1`) |

These are defined in `src/core/provider-env.ts` as `DEFAULT_MODELS`.

---

## 4. Category 2: Image Generation (Decommissioned / Removed)

> **Note (Breaking Change pre-1.0):**
> Legacy `image.*` settings (`image.apiKey`, `image.baseUrl`, `image.model`, `image.size`, `image.quality`, `image.style`, `image.n`) have been **removed**.
> Image generation and prompt optimization now route exclusively through `ProviderRuntime` (spec 010/012 architecture).
> Model configuration is managed through `/models` (or CLI `seepient models image`) under the `image-generation` purpose slot.

---

## 5. Category 3: Email / SMTP

These settings configure the `send_email` tool.

### 5.1 `smtpHost`

| Property | Value |
|----------|-------|
| **Key** | `smtpHost` |
| **Display Name** | SMTP Host |
| **Description** | Hostname of the SMTP server for sending emails. |
| **Type** | string |
| **Default Value** | _(none)_ |
| **Required** | Yes (to use send_email) |
| **Sensitive** | No |
| **Valid Values** | Valid hostname or IP address (e.g., `smtp.gmail.com`, `smtp.sendgrid.net`) |
| **Env Var Override** | `SMTP_HOST` |
| **Scope** | both |
| **Runtime Editable** | Yes (hot-apply) |
| **Category** | Email / SMTP |
| **Depends On** | — |

---

### 5.2 `smtpPort`

| Property | Value |
|----------|-------|
| **Key** | `smtpPort` |
| **Display Name** | SMTP Port |
| **Description** | Port number for the SMTP server. Stored as string but should be a valid port number. |
| **Type** | string |
| **Default Value** | _(none)_ |
| **Required** | Yes (to use send_email) |
| **Sensitive** | No |
| **Valid Values** | `"465"` (SSL) \| `"587"` (TLS) \| any valid port string |
| **Env Var Override** | `SMTP_PORT` |
| **Scope** | both |
| **Runtime Editable** | Yes (hot-apply) |
| **Category** | Email / SMTP |
| **Depends On** | `smtpHost` |

---

### 5.3 `smtpUser`

| Property | Value |
|----------|-------|
| **Key** | `smtpUser` |
| **Display Name** | SMTP Username |
| **Description** | Username for SMTP authentication. |
| **Type** | string |
| **Default Value** | _(none)_ |
| **Required** | Yes (to use send_email) |
| **Sensitive** | No |
| **Valid Values** | Non-empty string |
| **Env Var Override** | `SMTP_USER` |
| **Scope** | both |
| **Runtime Editable** | Yes (hot-apply) |
| **Category** | Email / SMTP |
| **Depends On** | `smtpHost` |

---

### 5.4 `smtpPass`

| Property | Value |
|----------|-------|
| **Key** | `smtpPass` |
| **Display Name** | SMTP Password |
| **Description** | Password or app-specific password for SMTP authentication. |
| **Type** | string |
| **Default Value** | _(none)_ |
| **Required** | Yes (to use send_email) |
| **Sensitive** | Yes |
| **Valid Values** | Non-empty string |
| **Env Var Override** | `SMTP_PASS` |
| **Scope** | both |
| **Runtime Editable** | Yes (hot-apply) |
| **Category** | Email / SMTP |
| **Depends On** | `smtpHost`, `smtpUser` |

---

### 5.5 `smtpFrom`

| Property | Value |
|----------|-------|
| **Key** | `smtpFrom` |
| **Display Name** | SMTP From Address |
| **Description** | Default sender email address. If not set, defaults to `smtpUser`. |
| **Type** | string |
| **Default Value** | Falls back to `smtpUser` |
| **Required** | No (falls back) |
| **Sensitive** | No |
| **Valid Values** | Valid email address (e.g., `user@example.com`) |
| **Env Var Override** | _(none)_ |
| **Scope** | both |
| **Runtime Editable** | Yes (hot-apply) |
| **Category** | Email / SMTP |
| **Depends On** | `smtpHost`, `smtpUser` |

**Fallback:** If `smtpFrom` is not set, the `send_email` tool uses `smtpUser` as the sender address.

---

## 6. Category 4: Web Search

### 6.1 `tavilyApiKey`

| Property | Value |
|----------|-------|
| **Key** | `tavilyApiKey` |
| **Display Name** | Tavily API Key |
| **Description** | API key for the Tavily web search service, used by the `web_search` tool. |
| **Type** | string |
| **Default Value** | _(none)_ |
| **Required** | Yes (to use web_search) |
| **Sensitive** | Yes |
| **Valid Values** | Non-empty string (Tavily API key format: `tvly-...`) |
| **Env Var Override** | `TAVILY_API_KEY` |
| **Scope** | both |
| **Runtime Editable** | Yes (hot-apply) |
| **Category** | Web Search |
| **Depends On** | — |

---

## 7. Category 5: Notifications

Three notification channels: Feishu (Lark), DingTalk, and WeCom. Each follows the same webhook + keyword pattern.

### 7.1 `feishuWebhook`

| Property | Value |
|----------|-------|
| **Key** | `feishuWebhook` |
| **Display Name** | Feishu Webhook URL |
| **Description** | Incoming webhook URL for Feishu (Lark) bot notifications. Used by the `send_notification` tool. |
| **Type** | string |
| **Default Value** | _(none)_ |
| **Required** | Yes (to send Feishu notifications) |
| **Sensitive** | Yes |
| **Valid Values** | Valid HTTPS URL (e.g., `https://open.feishu.cn/open-apis/bot/v2/hook/...`) |
| **Env Var Override** | `FEISHU_WEBHOOK` |
| **Scope** | both |
| **Runtime Editable** | Yes (hot-apply) |
| **Category** | Notifications |
| **Depends On** | — |

---

### 7.2 `feishuKeyword`

| Property | Value |
|----------|-------|
| **Key** | `feishuKeyword` |
| **Display Name** | Feishu Keyword |
| **Description** | Security keyword for the Feishu webhook. Messages must contain this keyword to be accepted by the bot. |
| **Type** | string |
| **Default Value** | _(none)_ |
| **Required** | No |
| **Sensitive** | No |
| **Valid Values** | Non-empty string |
| **Env Var Override** | `FEISHU_KEYWORD` |
| **Scope** | both |
| **Runtime Editable** | Yes (hot-apply) |
| **Category** | Notifications |
| **Depends On** | `feishuWebhook` |

---

### 7.3 `dingtalkWebhook`

| Property | Value |
|----------|-------|
| **Key** | `dingtalkWebhook` |
| **Display Name** | DingTalk Webhook URL |
| **Description** | Incoming webhook URL for DingTalk group bot notifications. |
| **Type** | string |
| **Default Value** | _(none)_ |
| **Required** | Yes (to send DingTalk notifications) |
| **Sensitive** | Yes |
| **Valid Values** | Valid HTTPS URL (e.g., `https://oapi.dingtalk.com/robot/send?access_token=...`) |
| **Env Var Override** | `DINGTALK_WEBHOOK` |
| **Scope** | both |
| **Runtime Editable** | Yes (hot-apply) |
| **Category** | Notifications |
| **Depends On** | — |

---

### 7.4 `dingtalkKeyword`

| Property | Value |
|----------|-------|
| **Key** | `dingtalkKeyword` |
| **Display Name** | DingTalk Keyword |
| **Description** | Security keyword for the DingTalk webhook. Messages must contain this keyword. |
| **Type** | string |
| **Default Value** | _(none)_ |
| **Required** | No |
| **Sensitive** | No |
| **Valid Values** | Non-empty string |
| **Env Var Override** | `DINGTALK_KEYWORD` |
| **Scope** | both |
| **Runtime Editable** | Yes (hot-apply) |
| **Category** | Notifications |
| **Depends On** | `dingtalkWebhook` |

---

### 7.5 `wecomWebhook`

| Property | Value |
|----------|-------|
| **Key** | `wecomWebhook` |
| **Display Name** | WeCom Webhook URL |
| **Description** | Incoming webhook URL for WeCom (WeChat Work) group bot notifications. |
| **Type** | string |
| **Default Value** | _(none)_ |
| **Required** | Yes (to send WeCom notifications) |
| **Sensitive** | Yes |
| **Valid Values** | Valid HTTPS URL (e.g., `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...`) |
| **Env Var Override** | `WECOM_WEBHOOK` |
| **Scope** | both |
| **Runtime Editable** | Yes (hot-apply) |
| **Category** | Notifications |
| **Depends On** | — |

---

### 7.6 `wecomKeyword`

| Property | Value |
|----------|-------|
| **Key** | `wecomKeyword` |
| **Display Name** | WeCom Keyword |
| **Description** | Security keyword for the WeCom webhook. Messages must contain this keyword. |
| **Type** | string |
| **Default Value** | _(none)_ |
| **Required** | No |
| **Sensitive** | No |
| **Valid Values** | Non-empty string |
| **Env Var Override** | `WECOM_KEYWORD` |
| **Scope** | both |
| **Runtime Editable** | Yes (hot-apply) |
| **Category** | Notifications |
| **Depends On** | `wecomWebhook` |

---

## 8. Category 6: Agent Behavior

### 8.1 `consentMode`

| Property | Value |
|----------|-------|
| **Key** | `permissions.consentMode` / `consentMode` |
| **Display Name** | Consent Mode |
| **Description** | Controls which tool executions are auto-approved vs. require explicit user confirmation via the unified Domain policy pipeline. |
| **Type** | enum |
| **Default Value** | `"edit-enabled"` |
| **Required** | No |
| **Sensitive** | No |
| **Valid Values** | `"ask-everything"` \| `"edit-enabled"` \| `"autonomous"` |
| **Env Var Override** | `SEEPIENT_CONSENT_MODE` |
| **Scope** | both |
| **Runtime Editable** | Yes (hot-apply) |
| **Category** | Agent Behavior |
| **Depends On** | — |

**Consent Modes:**
- `edit-enabled`: Pre-approves workspace edits, reads, and normal operations; prompts for high-risk shell commands and outbound external communications.
- `ask-everything`: Prompts for confirmation on every side-effecting operation.
- `autonomous`: Auto-approves all operations within the deployment ceiling.

**Resolution priority:** CLI flag (`--mode` / `-y`) > `SEEPIENT_CONSENT_MODE` env var > config file > `"edit-enabled"` default. Invalid values silently fall through to the next source.

---

### 8.2 `autoConfirm`

| Property | Value |
|----------|-------|
| **Key** | `autoConfirm` |
| **Display Name** | Auto-Confirm All Tools |
| **Description** | When `true`, all tool executions are auto-approved without prompting, regardless of `permissionLevel`. This is a blanket override. |
| **Type** | boolean |
| **Default Value** | `false` |
| **Required** | No |
| **Sensitive** | No |
| **Valid Values** | `true` \| `false` |
| **Env Var Override** | _(none)_ |
| **Scope** | both |
| **Runtime Editable** | Yes (hot-apply) |
| **Category** | Agent Behavior |
| **Depends On** | — |

**Notes:** When `autoConfirm` is `true`, the `permissionLevel` pre-filter is effectively bypassed. Use with caution. Passed to `AgentLoopOptions.autoConfirm`.

---

### 8.3 `maxSteps` (Runtime Only)

| Property | Value |
|----------|-------|
| **Key** | _(not in AppConfig — runtime option only)_ |
| **Display Name** | Maximum Agent Steps |
| **Description** | Maximum number of reasoning + tool-execution steps the agent loop will perform before stopping. Prevents runaway loops. |
| **Type** | number |
| **Default Value** | `5` (in server), `20` (in SDK default) |
| **Required** | No |
| **Sensitive** | No |
| **Valid Values** | Positive integer (recommended: 1-100) |
| **Env Var Override** | _(none)_ |
| **Scope** | runtime |
| **Runtime Editable** | Yes (per-request) |
| **Category** | Agent Behavior |
| **Depends On** | — |

**Notes:** This is NOT in `AppConfig` today. It is passed as `AgentLoopOptions.maxSteps`. Different adapters use different defaults. The server defaults to 5; SDK/CLI can set it per-request. See [Proposed New Settings](#13-proposed-new-settings) for adding this to config.

---

### 8.4 `systemPrompt` (Runtime Only)

| Property | Value |
|----------|-------|
| **Key** | _(not in AppConfig — runtime option only)_ |
| **Display Name** | System Prompt |
| **Description** | Custom system prompt prepended as the first message in the conversation. If not set, a default prompt is used. |
| **Type** | string |
| **Default Value** | _(none — default varies by adapter)_ |
| **Required** | No |
| **Sensitive** | No |
| **Valid Values** | Any text string |
| **Env Var Override** | _(none)_ |
| **Scope** | runtime |
| **Runtime Editable** | Yes (per-request) |
| **Category** | Agent Behavior |
| **Depends On** | — |

**Notes:** Passed as `AgentLoopOptions.systemPrompt`. CLI builds it from the skill catalog + welcome message. SDK/Server accept it as a direct option. See [Proposed New Settings](#13-proposed-new-settings).

---

## 9. Category 7: Server

These settings apply only to the `seepient-server` adapter.

### 9.1 `port`

| Property | Value |
|----------|-------|
| **Key** | _(ServerOptions.port)_ |
| **Display Name** | Server Port |
| **Description** | TCP port the HTTP server listens on. |
| **Type** | number |
| **Default Value** | `7337` |
| **Required** | No |
| **Sensitive** | No |
| **Valid Values** | Positive integer, 1-65535 (practical: 1024-65535 for non-root) |
| **Env Var Override** | `SEEPIENT_PORT` or `PORT` (checked in that order) |
| **Scope** | env / runtime |
| **Runtime Editable** | No (set at startup) |
| **Category** | Server |
| **Depends On** | — |

**Resolution:** `ServerOptions.port` > `SEEPIENT_PORT` > `PORT` > `7337`.

---

### 9.2 `host`

| Property | Value |
|----------|-------|
| **Key** | _(ServerOptions.host)_ |
| **Display Name** | Server Host |
| **Description** | Network interface the server binds to. |
| **Type** | string |
| **Default Value** | `"0.0.0.0"` (all interfaces) |
| **Required** | No |
| **Sensitive** | No |
| **Valid Values** | Valid IP address or `"0.0.0.0"` |
| **Env Var Override** | _(none — only via ServerOptions)_ |
| **Scope** | runtime |
| **Runtime Editable** | No (set at startup) |
| **Category** | Server |
| **Depends On** | — |

---

### 9.3 `cors`

| Property | Value |
|----------|-------|
| **Key** | _(ServerOptions.cors)_ |
| **Display Name** | Enable CORS |
| **Description** | Whether to add CORS headers to all HTTP responses. Enables browser-based clients to call the API. |
| **Type** | boolean |
| **Default Value** | `true` |
| **Required** | No |
| **Sensitive** | No |
| **Valid Values** | `true` \| `false` |
| **Env Var Override** | _(none)_ |
| **Scope** | runtime |
| **Runtime Editable** | No (set at startup) |
| **Category** | Server |
| **Depends On** | — |

**CORS Headers Applied:**
- `Access-Control-Allow-Origin`: mirrors request `Origin` header, or `*`
- `Access-Control-Allow-Methods`: `GET, POST, OPTIONS`
- `Access-Control-Allow-Headers`: `Content-Type, Authorization, X-Seepient-API-Key`
- `Access-Control-Max-Age`: `86400`

---

### 9.4 `sessionTTL`

| Property | Value |
|----------|-------|
| **Key** | _(ServerOptions.sessionTTL)_ |
| **Display Name** | Session TTL |
| **Description** | Time-to-live for server sessions in seconds. Sessions older than this are eligible for cleanup. |
| **Type** | number |
| **Default Value** | `86400` (24 hours) |
| **Required** | No |
| **Sensitive** | No |
| **Valid Values** | Positive integer, seconds |
| **Env Var Override** | `SEEPIENT_SESSION_TTL` |
| **Scope** | env / runtime |
| **Runtime Editable** | No (set at startup) |
| **Category** | Server |
| **Depends On** | — |

---

### 9.5 `maxPermissionLevel`

| Property | Value |
|----------|-------|
| **Key** | _(ServerOptions.maxPermissionLevel)_ |
| **Display Name** | Maximum Permission Level |
| **Description** | Caps the permission level that WebSocket clients can request. Prevents clients from escalating beyond the server operator's comfort level. |
| **Type** | enum |
| **Default Value** | _(none — no cap)_ |
| **Required** | No |
| **Sensitive** | No |
| **Valid Values** | `"strict"` \| `"moderate"` \| `"permissive"` |
| **Env Var Override** | _(none)_ |
| **Scope** | runtime |
| **Runtime Editable** | No (set at startup) |
| **Category** | Server |
| **Depends On** | — |

**Notes:** When set, any WebSocket message requesting a higher permission level is capped to this value. If unset, clients can request any level up to `permissive`.

---

## 10. Category 8: Session & Persistence

### 10.1 `sessionDir`

| Property | Value |
|----------|-------|
| **Key** | _(env var / ServerSessionManagerOptions.sessionDir)_ |
| **Display Name** | Session Directory |
| **Description** | Filesystem directory where session data is stored. Used by the file-based persistence backend. |
| **Type** | string |
| **Default Value** | Server: `.seepient/sessions` (relative to cwd). SDK/CLI default: `~/.seepient/sessions` |
| **Required** | No |
| **Sensitive** | No |
| **Valid Values** | Valid directory path (created automatically if it does not exist) |
| **Env Var Override** | `SEEPIENT_SESSION_DIR` |
| **Scope** | env |
| **Runtime Editable** | No (set at startup) |
| **Category** | Session & Persistence |
| **Depends On** | — |

**Notes:** Server resolves this as `SEEPIENT_SESSION_DIR` env var > `.seepient/sessions` (in cwd). SDK default (via `session-store.ts`) is `~/.seepient/sessions`.

---

### 10.2 `backendType` (SDK / Server)

| Property | Value |
|----------|-------|
| **Key** | _(PersistenceConfig.type)_ |
| **Display Name** | Persistence Backend Type |
| **Description** | Which persistence backend to use for session storage. Built-in options are `"file"` and `"memory"`. Custom backends can be registered via `registerBackend()`. |
| **Type** | enum |
| **Default Value** | `"file"` |
| **Required** | No |
| **Sensitive** | No |
| **Valid Values** | `"file"` \| `"memory"` \| any custom registered backend identifier |
| **Env Var Override** | _(none)_ |
| **Scope** | runtime |
| **Runtime Editable** | No (set at startup) |
| **Category** | Session & Persistence |
| **Depends On** | — |

**Notes:** Not in `AppConfig`. Passed programmatically via `PersistenceConfig` when creating a backend. Custom backends (Redis, SQLite, etc.) are registered with `registerBackend()` and then referenced by their type string.

---

### 10.3 `cleanupInterval` (Server)

| Property | Value |
|----------|-------|
| **Key** | _(ServerSessionManagerOptions.cleanupInterval)_ |
| **Display Name** | Cleanup Interval |
| **Description** | How often the server checks for and removes expired sessions. Runs as a periodic background task. |
| **Type** | number |
| **Default Value** | `300000` (5 minutes, in ms) |
| **Required** | No |
| **Sensitive** | No |
| **Valid Values** | Positive integer, milliseconds |
| **Env Var Override** | _(none)_ |
| **Scope** | runtime |
| **Runtime Editable** | No (set at startup) |
| **Category** | Session & Persistence |
| **Depends On** | — |

---

## 11. Category 9: Skills

### 11.1 `SEEPIENT_SKILLS_PATH`

| Property | Value |
|----------|-------|
| **Key** | _(env var only)_ |
| **Display Name** | Skills Search Path |
| **Description** | Colon-separated list of directories to search for skills. Highest priority skill source. Directories are searched left-to-right; skills found later override earlier ones. |
| **Type** | string |
| **Default Value** | _(none)_ |
| **Required** | No |
| **Sensitive** | No |
| **Valid Values** | Colon-separated absolute or relative paths (e.g., `/opt/skills:~/my-skills`) |
| **Env Var Override** | `SEEPIENT_SKILLS_PATH` |
| **Scope** | env |
| **Runtime Editable** | No (set at startup) |
| **Category** | Skills |
| **Depends On** | — |

**Skill Discovery Priority** (highest wins): `SEEPIENT_SKILLS_PATH` > `.seepient/skills` (project) > `/mnt/skills` (Docker) > bundled skills (`src/skills/`).

---

### 11.2 `SEEPIENT_NO_BUNDLED_SKILLS`

| Property | Value |
|----------|-------|
| **Key** | _(env var only)_ |
| **Display Name** | Disable Bundled Skills |
| **Description** | When set to any value, disables loading of skills bundled with Seepient Agent. Useful in environments where only custom skills should be available. |
| **Type** | boolean (env presence check) |
| **Default Value** | `false` (bundled skills are loaded) |
| **Required** | No |
| **Sensitive** | No |
| **Valid Values** | Any non-empty string (presence = true) |
| **Env Var Override** | `SEEPIENT_NO_BUNDLED_SKILLS` |
| **Scope** | env |
| **Runtime Editable** | No (set at startup) |
| **Category** | Skills |
| **Depends On** | — |

---

### 11.3 `SEEPIENT_SKILLS_DEBUG`

| Property | Value |
|----------|-------|
| **Key** | _(env var only)_ |
| **Display Name** | Skills Debug Mode |
| **Description** | Enables verbose debug logging for the skill system (discovery, parsing, resolution). |
| **Type** | boolean (env presence check) |
| **Default Value** | `false` |
| **Required** | No |
| **Sensitive** | No |
| **Valid Values** | Any non-empty string (presence = true) |
| **Env Var Override** | `SEEPIENT_SKILLS_DEBUG` |
| **Scope** | env |
| **Runtime Editable** | No (set at startup) |
| **Category** | Skills |
| **Depends On** | — |

---

### 11.4 `SEEPIENT_SKILL_BODY_MAX_CHARS`

| Property | Value |
|----------|-------|
| **Key** | _(env var only)_ |
| **Display Name** | Skill Body Max Characters |
| **Description** | Maximum character count for a skill's body text before truncation is applied. Skills exceeding this limit are truncated with a marker. Part of the three-layer skill body size defense. |
| **Type** | number |
| **Default Value** | `32000` (approx. 8k tokens at 4 chars/token) |
| **Required** | No |
| **Sensitive** | No |
| **Valid Values** | Positive integer |
| **Env Var Override** | `SEEPIENT_SKILL_BODY_MAX_CHARS` |
| **Scope** | env |
| **Runtime Editable** | No (set at startup) |
| **Category** | Skills |
| **Depends On** | — |

---

### 11.5 `SEEPIENT_SKILL_BODY_WARN_CHARS`

| Property | Value |
|----------|-------|
| **Key** | _(env var only)_ |
| **Display Name** | Skill Body Warning Threshold |
| **Description** | Character count at which a warning is emitted during skill loading. Does not truncate — only warns. |
| **Type** | number |
| **Default Value** | `8000` (approx. 2k tokens at 4 chars/token) |
| **Required** | No |
| **Sensitive** | No |
| **Valid Values** | Positive integer (should be less than `SEEPIENT_SKILL_BODY_MAX_CHARS`) |
| **Env Var Override** | `SEEPIENT_SKILL_BODY_WARN_CHARS` |
| **Scope** | env |
| **Runtime Editable** | No (set at startup) |
| **Category** | Skills |
| **Depends On** | — |

---

## 12. Deprecated Settings

The following settings are from the legacy configuration format. They continue to work but emit deprecation warnings and should be migrated to the new format.

### 12.1 `apiKey` (Top-Level)

| Property | Value |
|----------|-------|
| **Key** | `apiKey` |
| **Display Name** | _(Legacy)_ API Key |
| **Status** | **DEPRECATED** — Migrate to `models.<provider>.apiKey` |
| **Migration** | Set `models.openai-compatible.apiKey` or use the `OPENAI_COMPAT_API_KEY` env var |
| **Behavior** | Migrated automatically by `migrateLegacyFormat()`. Populates `models.openai-compatible.apiKey` when no `models` map exists. |

---

### 12.2 `baseUrl` (Top-Level)

| Property | Value |
|----------|-------|
| **Key** | `baseUrl` |
| **Display Name** | _(Legacy)_ Base URL |
| **Status** | **DEPRECATED** — Migrate to `models.openai-compatible.baseUrl` |
| **Migration** | Set `models.openai-compatible.baseUrl` or use the `OPENAI_COMPAT_BASE_URL` env var |
| **Behavior** | Migrated automatically by `migrateLegacyFormat()`. Populates `models.openai-compatible.baseUrl`. |

---

### 12.3 `model` (Top-Level)

| Property | Value |
|----------|-------|
| **Key** | `model` |
| **Display Name** | _(Legacy)_ Model |
| **Status** | **DEPRECATED** — Migrate to `models.<provider>.model` |
| **Migration** | Set `models.<provider>.model` or use the provider-specific env var (e.g., `OPENAI_MODEL`) |
| **Behavior** | Migrated automatically by `migrateLegacyFormat()`. Populates the active provider's model. |

---

### 12.4 `SEEPIENT_API_KEY` (Env Var)

| Property | Value |
|----------|-------|
| **Key** | `SEEPIENT_API_KEY` |
| **Status** | **DEPRECATED** — Migrate to `OPENAI_COMPAT_API_KEY` |
| **Behavior** | Falls back to this var when `OPENAI_COMPAT_API_KEY` is not set. Emits `console.warn`. |

---

### 12.5 `OPENAI_BASE_URL` (Env Var)

| Property | Value |
|----------|-------|
| **Key** | `OPENAI_BASE_URL` |
| **Status** | **DEPRECATED** — Migrate to `OPENAI_COMPAT_BASE_URL` |
| **Behavior** | Falls back to this var when `OPENAI_COMPAT_BASE_URL` is not set. Emits `console.warn`. |

---

### 12.6 Deprecated Session Store API

| Old API | New API |
|---------|---------|
| `createSessionStore(path)` | `createPersistenceBackend({ type: "file", path })` |
| `createMemoryStore()` | `createPersistenceBackend({ type: "memory" })` |
| `FileSessionStore` | `FilePersistenceBackend` |
| `MemorySessionStore` | `MemoryPersistenceBackend` |
| `SessionStore` interface | `PersistenceBackend` interface |

---

## 13. Proposed New Settings

These settings do not yet exist in `AppConfig` or env vars but are identified as needed based on the current architecture.

### 13.1 `maxSteps` (Config)

| Property | Value |
|----------|-------|
| **Key** | `maxSteps` |
| **Display Name** | Maximum Agent Steps |
| **Description** | Default maximum agent loop iterations. Overridable per-request. Currently hardcoded per adapter. |
| **Type** | number |
| **Default Value** | `20` |
| **Proposed Env Var** | `SEEPIENT_MAX_STEPS` |
| **Scope** | both |
| **Category** | Agent Behavior |
| **Rationale** | Today the server defaults to 5, CLI/SDK to 20. A single config setting would unify this. Acceptable as a config entry since users frequently want to tune this. |

---

### 13.2 `systemPrompt` (Config)

| Property | Value |
|----------|-------|
| **Key** | `systemPrompt` |
| **Display Name** | Default System Prompt |
| **Description** | Custom system prompt applied to all conversations unless overridden per-request. |
| **Type** | string |
| **Default Value** | _(adapter-specific default)_ |
| **Proposed Env Var** | `SEEPIENT_SYSTEM_PROMPT` |
| **Scope** | both |
| **Category** | Agent Behavior |
| **Rationale** | Useful for project-specific or team-wide prompt customization. The `AgentLoopOptions.systemPrompt` field already exists but has no config file binding. |

---

### 13.3 `logLevel`

| Property | Value |
|----------|-------|
| **Key** | `logLevel` |
| **Display Name** | Log Level |
| **Description** | Controls verbosity of Seepient Agent's internal logging. Currently uses `console.log`/`console.warn` with no level control. |
| **Type** | enum |
| **Default Value** | `"info"` |
| **Valid Values** | `"debug"` \| `"info"` \| `"warn"` \| `"error"` \| `"silent"` |
| **Proposed Env Var** | `SEEPIENT_LOG_LEVEL` |
| **Scope** | both |
| **Category** | Agent Behavior |
| **Rationale** | No structured logging exists today. Adding a log level is prerequisite for production use. |

---

### 13.4 `enabledTools` (Tool Enable/Disable)

| Property | Value |
|----------|-------|
| **Key** | `enabledTools` |
| **Display Name** | Enabled Tools |
| **Description** | Whitelist of tool names that should be available to the agent. If set, only listed tools are registered. If unset, all tools are available. |
| **Type** | string[] |
| **Default Value** | _(all tools enabled)_ |
| **Valid Values** | Array of built-in tool names: `execute_shell_command`, `read_file`, `write_file`, `get_current_datetime`, `send_email`, `web_search`, `send_notification`, `read_website`, `take_screenshot`, `generate_image`, `optimize_prompt`, `use_skill` |
| **Proposed Env Var** | `SEEPIENT_ENABLED_TOOLS` (comma-separated) |
| **Scope** | both |
| **Category** | Agent Behavior |
| **Rationale** | No way to disable individual tools today. Security-conscious deployments need this. |

---

### 13.5 `disabledTools` (Tool Disable)

| Property | Value |
|----------|-------|
| **Key** | `disabledTools` |
| **Display Name** | Disabled Tools |
| **Description** | Blacklist of tool names that should be excluded. Simpler alternative to `enabledTools` when you want all tools except a few. |
| **Type** | string[] |
| **Default Value** | `[]` |
| **Proposed Env Var** | `SEEPIENT_DISABLED_TOOLS` (comma-separated) |
| **Scope** | both |
| **Category** | Agent Behavior |
| **Rationale** | Complements `enabledTools`. If both are set, `disabledTools` is subtracted from `enabledTools`. |

---

### 13.6 `modelAliases`

| Property | Value |
|----------|-------|
| **Key** | `modelAliases` |
| **Display Name** | Custom Model Aliases |
| **Description** | User-defined alias-to-model mappings. Extends the built-in GLM aliases to all providers. |
| **Type** | object |
| **Default Value** | `{}` |
| **Valid Values** | `{ [alias: string]: string }` (e.g., `{ "fast": "gpt-4o-mini", "smart": "claude-opus-4-20250514" }`) |
| **Proposed Env Var** | _(none — config file only)_ |
| **Scope** | both |
| **Category** | Providers & Models |
| **Rationale** | GLM has hardcoded aliases. Users want the same convenience for other providers. |

---

## 14. Cross-Setting Validation Rules

### 14.1 Provider Configuration

| Rule | Severity | Behavior |
|------|----------|----------|
| If `provider` is `"openai-compatible"`, then `models.openai-compatible.baseUrl` is **required**. | Error | `addProvider()` throws. Server fails to start. |
| If `provider` is `"openai"`, then `models.openai.apiKey` or `OPENAI_API_KEY` must be set. | Error | `getProviderConfig()` throws at first LLM call. |
| If `provider` is `"anthropic"`, then `models.anthropic.apiKey` or `ANTHROPIC_API_KEY` must be set. | Error | `getProviderConfig()` throws at first LLM call. |
| If `provider` is `"glm"`, then `models.glm.apiKey` or `GLM_API_KEY` must be set. | Error | `getProviderConfig()` throws at first LLM call. |
| If no provider is configured and no env vars are set, agent loop fails. | Error | `getProviderConfig()` throws. |

### 14.2 Image Generation

| Rule | Severity | Behavior |
|------|----------|----------|
| `imageApiKey` falls back to `apiKey` (legacy) then `OPENAI_API_KEY` env var. | Fallback | Tool returns error if all are unset. |
| `imageBaseUrl` falls back to `baseUrl` (legacy) then `OPENAI_COMPAT_BASE_URL`/`OPENAI_BASE_URL`. | Fallback | Uses OpenAI SDK default if all unset. |
| `imageModel` only overrides the tool's `model` argument when it is `"dall-e-3"` or unset. | Override | Does not override explicit non-default model choices. |

### 14.3 Email

| Rule | Severity | Behavior |
|------|----------|----------|
| `smtpFrom` defaults to `smtpUser` if not set. | Fallback | Automatic; no error. |
| All SMTP settings (`smtpHost`, `smtpPort`, `smtpUser`, `smtpPass`) must be set for `send_email` to work. | Error | Tool returns error message. |

### 14.4 Permissions
 
| Rule | Severity | Behavior |
|------|----------|----------|
| `consentMode` must be one of: `"ask-everything"`, `"edit-enabled"`, `"autonomous"`. | Warning | Invalid values silently fall through to next source. Default: `"edit-enabled"`. |
| `SEEPIENT_CONSENT_MODE` env var value must be one of the three valid modes. | Warning | Invalid values are ignored silently. |
| `autoConfirm` / `-y` maps to `"autonomous"` consent mode. | Override | All in-ceiling operations auto-approved. |

### 14.5 Skills

| Rule | Severity | Behavior |
|------|----------|----------|
| `SEEPIENT_SKILL_BODY_WARN_CHARS` should be less than `SEEPIENT_SKILL_BODY_MAX_CHARS`. | Warning | No enforcement; misconfiguration leads to warning at or above truncation threshold. |
| `SEEPIENT_SKILLS_PATH` directories that do not exist are silently skipped. | Silent | No error. |
| Cumulative resolved body size cap is 2MB across all inlined `@path` references. | Hard limit | Excess references are skipped with a marker. |

### 14.6 Session

| Rule | Severity | Behavior |
|------|----------|----------|
| Session IDs must match `/^[a-zA-Z0-9-]+$/`. | Error | `validateSessionId()` throws. |
| `SEEPIENT_SESSION_DIR` is created automatically if it does not exist. | Auto-create | No error. |
| `backendType` must be registered via `registerBackend()` before use. | Error | `createPersistenceBackend()` throws. |

### 14.7 Config File

| Rule | Severity | Behavior |
|------|----------|----------|
| Config files are saved with mode `0o600` (owner read/write only). | Security | Automatic on save. |
| Invalid JSON in config files emits a warning and falls back to `{}`. | Warning | `loadJsonConfig()` returns `{}`. |
| Project config overrides global config at the top level (shallow merge, not deep). | Behavior | `{ ...global, ...local }`. Nested objects in local replace entire nested object from global. |

---

## 15. Summary Matrix

### All Settings at a Glance

| # | Key | Category | Type | Default | Sensitive | Env Var | Scope | Editable |
|---|-----|----------|------|---------|-----------|---------|-------|----------|
| 1 | `provider` | Providers & Models | enum | `openai-compatible` | No | `LLM_PROVIDER`, `SEEPIENT_PROVIDER` | both | hot-apply |
| 2 | `models.openai.apiKey` | Providers & Models | string | _(none)_ | Yes | `OPENAI_API_KEY` | both | restart |
| 3 | `models.openai.model` | Providers & Models | string | `gpt-5.4` | No | `OPENAI_MODEL` | both | hot-apply |
| 4 | `models.anthropic.apiKey` | Providers & Models | string | _(none)_ | Yes | `ANTHROPIC_API_KEY` | both | restart |
| 5 | `models.anthropic.model` | Providers & Models | string | `claude-sonnet-4-6-20260320` | No | `ANTHROPIC_MODEL` | both | hot-apply |
| 6 | `models.glm.apiKey` | Providers & Models | string | _(none)_ | Yes | `GLM_API_KEY` | both | restart |
| 7 | `models.glm.model` | Providers & Models | string | `opus` | No | `GLM_MODEL` | both | hot-apply |
| 8 | `models.openai-compatible.apiKey` | Providers & Models | string | _(none)_ | Yes | `OPENAI_COMPAT_API_KEY` | both | restart |
| 9 | `models.openai-compatible.baseUrl` | Providers & Models | string | _(none)_ | No | `OPENAI_COMPAT_BASE_URL` | both | restart |
| 10 | `models.openai-compatible.model` | Providers & Models | string | `gpt-5.4` | No | `OPENAI_MODEL` | both | hot-apply |
| 11 | _(provider timeout)_ | Providers & Models | number | varies | No | _(none)_ | runtime | restart |
| 12 | _(global model)_ | Providers & Models | string | _(none)_ | No | `LLM_MODEL`, `SEEPIENT_MODEL` | env | read-only |
| 13 | `imageApiKey` | Image Generation | string | fallback | Yes | _(none)_ | both | hot-apply |
| 14 | `imageBaseUrl` | Image Generation | string | fallback | No | _(none)_ | both | hot-apply |
| 15 | `imageModel` | Image Generation | string | `dall-e-3` | No | _(none)_ | both | hot-apply |
| 16 | `imageSize` | Image Generation | string | `1024x1024` | No | _(none)_ | both | hot-apply |
| 17 | `imageQuality` | Image Generation | enum | `standard` | No | _(none)_ | both | hot-apply |
| 18 | `imageStyle` | Image Generation | enum | `vivid` | No | _(none)_ | both | hot-apply |
| 19 | `imageN` | Image Generation | number | `1` | No | _(none)_ | both | hot-apply |
| 20 | `smtpHost` | Email / SMTP | string | _(none)_ | No | `SMTP_HOST` | both | hot-apply |
| 21 | `smtpPort` | Email / SMTP | string | _(none)_ | No | `SMTP_PORT` | both | hot-apply |
| 22 | `smtpUser` | Email / SMTP | string | _(none)_ | No | `SMTP_USER` | both | hot-apply |
| 23 | `smtpPass` | Email / SMTP | string | _(none)_ | Yes | `SMTP_PASS` | both | hot-apply |
| 24 | `smtpFrom` | Email / SMTP | string | fallback | No | _(none)_ | both | hot-apply |
| 25 | `tavilyApiKey` | Web Search | string | _(none)_ | Yes | `TAVILY_API_KEY` | both | hot-apply |
| 26 | `feishuWebhook` | Notifications | string | _(none)_ | Yes | `FEISHU_WEBHOOK` | both | hot-apply |
| 27 | `feishuKeyword` | Notifications | string | _(none)_ | No | `FEISHU_KEYWORD` | both | hot-apply |
| 28 | `dingtalkWebhook` | Notifications | string | _(none)_ | Yes | `DINGTALK_WEBHOOK` | both | hot-apply |
| 29 | `dingtalkKeyword` | Notifications | string | _(none)_ | No | `DINGTALK_KEYWORD` | both | hot-apply |
| 30 | `wecomWebhook` | Notifications | string | _(none)_ | Yes | `WECOM_WEBHOOK` | both | hot-apply |
| 31 | `wecomKeyword` | Notifications | string | _(none)_ | No | `WECOM_KEYWORD` | both | hot-apply |
| 32 | `permissions.consentMode` | Agent Behavior | enum | `edit-enabled` | No | `SEEPIENT_CONSENT_MODE` | both | hot-apply |
| 33 | `autoConfirm` | Agent Behavior | boolean | `false` | No | _(none)_ | both | hot-apply |
| 34 | `maxSteps` | Agent Behavior | number | 5-20 | No | _(none)_ | runtime | per-request |
| 35 | `systemPrompt` | Agent Behavior | string | _(none)_ | No | _(none)_ | runtime | per-request |
| 36 | `port` | Server | number | `7337` | No | `SEEPIENT_PORT`, `PORT` | env/runtime | startup |
| 37 | `host` | Server | string | `0.0.0.0` | No | _(none)_ | runtime | startup |
| 38 | `cors` | Server | boolean | `true` | No | _(none)_ | runtime | startup |
| 39 | `sessionTTL` | Server | number | `86400` | No | `SEEPIENT_SESSION_TTL` | env/runtime | startup |
| 40 | `maxPermissionLevel` | Server | enum | _(none)_ | No | _(none)_ | runtime | startup |
| 41 | `sessionDir` | Session & Persistence | string | varies | No | `SEEPIENT_SESSION_DIR` | env | startup |
| 42 | `backendType` | Session & Persistence | enum | `file` | No | _(none)_ | runtime | startup |
| 43 | `cleanupInterval` | Session & Persistence | number | `300000` | No | _(none)_ | runtime | startup |
| 44 | `SEEPIENT_SKILLS_PATH` | Skills | string | _(none)_ | No | `SEEPIENT_SKILLS_PATH` | env | startup |
| 45 | `SEEPIENT_NO_BUNDLED_SKILLS` | Skills | boolean | `false` | No | `SEEPIENT_NO_BUNDLED_SKILLS` | env | startup |
| 46 | `SEEPIENT_SKILLS_DEBUG` | Skills | boolean | `false` | No | `SEEPIENT_SKILLS_DEBUG` | env | startup |
| 47 | `SEEPIENT_SKILL_BODY_MAX_CHARS` | Skills | number | `32000` | No | `SEEPIENT_SKILL_BODY_MAX_CHARS` | env | startup |
| 48 | `SEEPIENT_SKILL_BODY_WARN_CHARS` | Skills | number | `8000` | No | `SEEPIENT_SKILL_BODY_WARN_CHARS` | env | startup |

### Statistics

| Category | Count | Config File | Env Vars | Runtime |
|----------|-------|-------------|----------|---------|
| Providers & Models | 12 | 10 | 10 | 2 |
| Image Generation | 7 | 7 | 0 | 0 |
| Email / SMTP | 5 | 5 | 4 | 0 |
| Web Search | 1 | 1 | 1 | 0 |
| Notifications | 6 | 6 | 6 | 0 |
| Agent Behavior | 4 | 2 | 1 | 2 |
| Server | 5 | 0 | 2 | 5 |
| Session & Persistence | 3 | 0 | 1 | 3 |
| Skills | 5 | 0 | 5 | 0 |
| **Total** | **48** | **31** | **30** | **12** |

### Sensitive Settings (14 total)

`models.openai.apiKey`, `models.anthropic.apiKey`, `models.glm.apiKey`, `models.openai-compatible.apiKey`, `imageApiKey`, `smtpPass`, `tavilyApiKey`, `feishuWebhook`, `dingtalkWebhook`, `wecomWebhook`

All webhook URLs are classified as sensitive because they contain access tokens in the URL path.

### Deprecated Settings (5 total)

`apiKey` (top-level), `baseUrl` (top-level), `model` (top-level), `SEEPIENT_API_KEY` env var, `OPENAI_BASE_URL` env var.

### Proposed New Settings (6 total)

`maxSteps`, `systemPrompt`, `logLevel`, `enabledTools`, `disabledTools`, `modelAliases`.
