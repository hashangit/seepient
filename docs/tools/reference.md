---
title: Built-in Tools Reference
description: Complete reference for all 12 built-in tools in Seepient Agent with parameters, examples, and notes.
---

# Built-in Tools Reference

Seepient Agent includes 12 built-in tools organized into four groups. Every tool works identically across `generateText`, `streamText`, `createAgent`, the CLI, and the server REST API.

## Quick Import

```typescript
import {
  CORE_TOOLS,
  COMM_TOOLS,
  ADVANCED_TOOLS,
  ALL_TOOLS,
} from "seepient";
```

| Group Constant | Tools |
|---|---|
| `CORE_TOOLS` | `execute_shell_command`, `read_file`, `write_file`, `get_current_datetime` |
| `COMM_TOOLS` | `send_email`, `web_search`, `send_notification` |
| `ADVANCED_TOOLS` | `read_website`, `take_screenshot`, `generate_image`, `optimize_prompt`, `use_skill` |
| `ALL_TOOLS` | All 12 tools |

### Using Group Names in Options

```typescript
const result = await generateText("Search for recent AI news", {
  tools: ["web_search"],    // single tool by name
});

const result2 = await generateText("Analyze the codebase", {
  tools: ["core", "comm"],  // all core + all communication tools
});

const result3 = await generateText("Full analysis", {
  tools: ["all"],           // every built-in tool
});
```

---

## Core Tools

### execute_shell_command

Run shell commands on the host machine.

**Category:** Core

| Parameter | Type | Required | Description |
|---|---|---|---|
| `command` | `string` | Yes | The shell command to execute |
| `rationale` | `string` | Yes | Explanation of why this command is being run |

**Example:**

```typescript
const result = await generateText("List all TypeScript files in the src directory", {
  tools: ["execute_shell_command"],
});
```

**Notes:**
- In CLI mode, commands require user confirmation unless `--yes` (auto-confirm) is set.
- In SDK mode, commands execute without confirmation. Use hooks (`beforeToolCall`) to implement custom approval logic.
- Returns both stdout and stderr.

---

### read_file

Read the contents of a file.

**Category:** Core

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | `string` | Yes | Path to the file to read |

**Example:**

```typescript
const result = await generateText("What does the main entry point do?", {
  tools: ["read_file"],
});
```

**Notes:**
- Returns the full file content as a string.
- Returns an error message if the file does not exist or is not readable.

---

### write_file

Write content to a file. Creates parent directories if needed. Overwrites existing files.

**Category:** Core

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | `string` | Yes | Path to the file to write |
| `content` | `string` | Yes | The content to write |

**Example:**

```typescript
const result = await generateText("Create a package.json for a React project", {
  tools: ["write_file"],
});
```

**Notes:**
- Parent directories are created automatically (`mkdir -p` behavior).
- Overwrites existing files without warning. Use with caution in production.

---

### get_current_datetime

Get the current system date and time. Returns ISO timestamp, local time, timezone, and weekday.

**Category:** Core

| Parameter | Type | Required | Description |
|---|---|---|---|
| *(none)* | -- | -- | -- |

**Example:**

```typescript
const result = await generateText("What day is it today?", {
  tools: ["get_current_datetime"],
});
```

**Response format:**

```json
{
  "iso": "2026-04-08T12:00:00.000Z",
  "local": "4/8/2026, 8:00:00 AM",
  "timezone": "America/New_York",
  "weekday": "Tuesday"
}
```

**Notes:**
- Useful when the user references relative dates like "today", "next week", or "this March".
- No parameters required.

---

## Communication Tools

### web_search

Search the web using the Tavily search API. Returns summaries of search results.

**Category:** Communication

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | `string` | Yes | The search query |
| `depth` | `"basic"` \| `"advanced"` | No | Search depth. `"basic"` is faster; `"advanced"` scrapes more content |

**Configuration required:**

```bash
TAVILY_API_KEY=tvly-...   # Get a free key at https://tavily.com
```

**Example:**

```typescript
const result = await generateText("What are the latest developments in quantum computing?", {
  tools: ["web_search"],
});
```

**Notes:**
- Returns up to 5 results with titles, URLs, and content summaries.
- Includes a direct answer when Tavily can synthesize one.
- Requires `TAVILY_API_KEY` in environment or `tavilyApiKey` in config.

---

### send_email

Send an email using configured SMTP settings. Supports file attachments.

**Category:** Communication

| Parameter | Type | Required | Description |
|---|---|---|---|
| `to` | `string` | Yes | Recipient email address |
| `subject` | `string` | Yes | Email subject line |
| `body` | `string` | Yes | Email body content (plain text) |
| `attachments` | `string[]` | No | List of local file paths to attach |

**Configuration required:**

```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your@email.com
SMTP_PASS=app-password
SMTP_FROM=your@email.com     # optional, defaults to SMTP_USER
```

**Example:**

```typescript
const result = await generateText(
  "Send an email to team@company.com summarizing the project status",
  { tools: ["send_email"] }
);
```

**Notes:**
- Uses `nodemailer` under the hood.
- Port 465 uses TLS; all other ports use STARTTLS.
- Returns the message ID on success.

---

### send_notification

Send a text message to an IM group bot. Supports Feishu/Lark, DingTalk, and WeCom.

**Category:** Communication

| Parameter | Type | Required | Description |
|---|---|---|---|
| `platform` | `"feishu"` \| `"dingtalk"` \| `"wecom"` | Yes | Target platform |
| `content` | `string` | Yes | Text content to send |

**Configuration required:**

```bash
# Set at least one platform webhook
FEISHU_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/...
DINGTALK_WEBHOOK=https://oapi.dingtalk.com/robot/send?access_token=...
WECOM_WEBHOOK=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...
```

**Example:**

```typescript
const result = await generateText(
  "Notify the team on Feishu that the deployment is complete",
  { tools: ["send_notification"] }
);
```

**Notes:**
- If a security keyword is configured, it is automatically prepended to the message content if not already present.
- Config keys: `feishuWebhook`, `dingtalkWebhook`, `wecomWebhook`, `feishuKeyword`, `dingtalkKeyword`, `wecomKeyword`.

---

## Advanced Tools

### read_website

Fetch and extract the main content from a web page. Uses Playwright + Mozilla Readability.

**Category:** Browser

| Parameter | Type | Required | Description |
|---|---|---|---|
| `url` | `string` | Yes | Full URL of the page to read |

**Example:**

```typescript
const result = await generateText("Summarize this article: https://example.com/article", {
  tools: ["read_website"],
});
```

**Notes:**
- Requires Playwright browsers installed: `npx playwright install chromium`.
- Uses a headless Chromium browser with a realistic user agent.
- Falls back to raw body text if Readability parsing fails.
- 30-second navigation timeout.

---

### take_screenshot

Capture a screenshot of a web page and save it as an image file.

**Category:** Browser

| Parameter | Type | Required | Description |
|---|---|---|---|
| `url` | `string` | Yes | Full URL to capture |
| `outputPath` | `string` | Yes | File path to save the screenshot (e.g., `homepage.png`) |
| `fullPage` | `boolean` | No | Capture full scrollable page (default: `true`) |
| `waitTime` | `number` | No | Seconds to wait for dynamic content before capture (default: `1`) |

**Example:**

```typescript
const result = await generateText("Take a screenshot of google.com", {
  tools: ["take_screenshot"],
});
```

**Notes:**
- Requires Playwright browsers installed: `npx playwright install chromium`.
- Uses 1280x720 viewport at 2x DPI (2560x1440 effective resolution).
- Prefers system Chrome over bundled Chromium for better font support.
- On Linux, auto-installs CJK and emoji fonts if missing.

---

### generate_image

Generate or edit images using AI models (DALL-E 3, DALL-E 2, or compatible models).

**Category:** Media

| Parameter | Type | Required | Description |
|---|---|---|---|
| `prompt` | `string` | For text-to-image and edit | Text description of the desired image |
| `image_path` | `string` | For variation and edit | Path to existing image file |
| `mask_path` | `string` | No | Path to mask image for editing |
| `mode` | `"text-to-image"` \| `"variation"` \| `"edit"` | No | Operation mode (auto-inferred if omitted) |
| `model` | `string` | No | Model to use (default: `dall-e-3`). Also supports `dall-e-2` and custom models like `doubao-seedream-4-5-251128` |
| `n` | `number` | No | Number of images to generate (default: `1`) |
| `size` | `string` | No | Resolution. DALL-E 3: `1024x1024`, `1792x1024`, `1024x1792`. High-res models: `2048x2048`, `2560x1440`, `1440x2560` |
| `quality` | `"standard"` \| `"hd"` | No | Image quality, DALL-E 3 only (default: `standard`) |
| `style` | `"vivid"` \| `"natural"` | No | Image style, DALL-E 3 only (default: `vivid`) |
| `output_path` | `string` | No | Exact destination file path (e.g. `images/logo.png`) committed via exact-file commit |
| `output_dir` | `string` | No | Directory to save images (default: current workspace directory) |

**Configuration required:**

Configure an image model in `/models` under the `image-generation` purpose slot or via `seepient models image`.

**Example:**

```typescript
const result = await generateText(
  "Generate a logo for a coffee shop called 'Bean & Brew'",
  { tools: ["generate_image"] }
);
```

**Notes:**
- Mode is auto-inferred: `image_path` + `mask_path` = edit, `image_path` alone = variation, otherwise text-to-image.
- Image generation executes through the configured `ProviderRuntime` image model and commits results safely via `FileCommitBroker`.

---

### optimize_prompt

Optimize a user's raw prompt to be more structured and effective for LLMs.

**Category:** Utility

| Parameter | Type | Required | Description |
|---|---|---|---|
| `raw_prompt` | `string` | Yes | The original prompt to optimize |
| `context` | `string` | No | Context about the goal or audience (e.g., `"for image generation"`) |

**Example:**

```typescript
const result = await generateText(
  "Optimize this prompt before generating an image: a cat sitting on a tree",
  { tools: ["optimize_prompt", "generate_image"] }
);
```

**Notes:**
- Uses the configured LLM (GPT-5.4 by default) to rewrite the prompt.
- The optimized prompt preserves original intent while adding structure (role, context, constraints, output format).
- Returns only the optimized prompt with no conversational filler.

---

### use_skill

Activate a skill by name. Injects the skill's content into the agent's context.

**Category:** Skills

| Parameter | Type | Required | Description |
|---|---|---|---|
| `skill_name` | `string` | Yes | Name of the skill to activate |
| `args` | `object` | No | Arguments to pass to the skill (e.g., `{ environment: "staging" }`) |

**Example:**

```typescript
const result = await generateText(
  "Review my authentication code for security vulnerabilities",
  { tools: ["use_skill", "read_file", "execute_shell_command"] }
);
```

**Notes:**
- Returns an error if the skill name is not found in the registry.
- Lists available skills in the error message if the requested skill is not found.
- Arguments support template substitution (`$1`, `$2`, `$ALL`, etc.) in the skill body.
- See [Custom Skills Guide](/guides/custom-skills-guide) for creating custom skills.

---

## Tool Groups Summary

| Tool | Name | Category | Key Config |
|---|---|---|---|
| Shell execution | `execute_shell_command` | Core | -- |
| File read | `read_file` | Core | -- |
| File write | `write_file` | Core | -- |
| Date/time | `get_current_datetime` | Core | -- |
| Web search | `web_search` | Search | `TAVILY_API_KEY` |
| Browser reader | `read_website` | Browser | Playwright |
| Screenshots | `take_screenshot` | Browser | Playwright |
| Email | `send_email` | Communication | SMTP credentials |
| Notifications | `send_notification` | Communication | Webhook URLs |
| Image generation | `generate_image` | Media | `OPENAI_API_KEY` |
| Prompt optimizer | `optimize_prompt` | Utility | `OPENAI_API_KEY` |
| Skill invocation | `use_skill` | Skills | -- |
