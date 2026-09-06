---
title: Built-in Tools Reference
description: Complete reference for all 15 built-in tools in Seepient Agent with parameters, examples, and notes.
---

# Built-in Tools Reference

Seepient Agent includes 15 built-in tools organized into three functional groups (`CORE_TOOLS`, `COMM_TOOLS`, and `ADVANCED_TOOLS`). Every tool works identically across `generateText`, `streamText`, `createSeepient`, the CLI, and the server REST API.

## Quick Import

```typescript
import {
  CORE_TOOLS,
  COMM_TOOLS,
  ADVANCED_TOOLS,
  ALL_TOOLS,
} from "seepient";
```

| Group Constant | Count | Tools |
|---|---|---|
| `CORE_TOOLS` | 7 | `execute_shell_command`, `read_file`, `write_file`, `edit_file`, `get_current_datetime`, `manage_todos`, `render_widget` |
| `COMM_TOOLS` | 3 | `send_email`, `web_search`, `send_notification` |
| `ADVANCED_TOOLS` | 5 | `read_website`, `take_screenshot`, `generate_image`, `optimize_prompt`, `use_skill` |
| `ALL_TOOLS` | 15 | All 15 built-in tools |

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

### edit_file

Apply a hash-anchored line patch to targeted sections of an existing file. Prefer this over `write_file` for targeted edits to avoid reproducing entire files and reduce token costs.

**Category:** Core (Filesystem)

| Parameter | Type | Required | Description |
|---|---|---|---|
| `patch` | `string` | Yes | Hashline patch formatted with section headers `[/path#TAG]` and line operations |

**Example:**

```typescript
const result = await generateText("Fix the timeout value in src/config.ts", {
  tools: ["read_file", "edit_file"],
});
```

**Patch Format:**

```
[/src/config.ts#a1f2]
SWAP 25.=25:
+export const TIMEOUT_MS = 5000;
```

**Notes:**
- Requires first reading the target file with `read_file`, which produces a content tag anchored at `[content-tag:XXXX]`.
- Operations supported: `SWAP A.=B:`, `SWAP.BLK A:`, `DEL A.=B`, `DEL.BLK A`, `INS.PRE A:`, `INS.POST A:`, `INS.HEAD:`, `INS.TAIL:`.
- Order operations bottom-to-top when stacking edits in a single file to keep line numbers stable.

---

### manage_todos

Maintain a structured, visible task checklist rendered directly in the TUI progress panel.

**Category:** Core (Planning / Presentation)

| Parameter | Type | Required | Description |
|---|---|---|---|
| `todos` | `Array<{ description: string, status: string }>` | Yes | Array of task items with statuses (`pending`, `in_progress`, `completed`, `blocked`) |

**Example:**

```typescript
const result = await generateText("Plan and migrate our database schemas", {
  tools: ["manage_todos", "read_file", "execute_shell_command"],
});
```

**Notes:**
- Safe presentation tool with zero external side effects.
- The model replaces the entire list on each update (not append).
- The TUI renders task items with live status glyphs and progress counters.

---

### render_widget

Render rich, interactive widgets (data tables, charts, forms, diffs, status grids) directly in the Terminal UI.

**Category:** Core (Presentation / UI)

| Parameter | Type | Required | Description |
|---|---|---|---|
| `kind` | `string` | Yes | Widget kind: `table`, `keyvalue`, `chart`, `tree`, `panel`, `diff`, `form`, `product_card`, `status_grid` |
| `props` | `Record<string, unknown>` | Yes | Kind-specific rendering properties (e.g. `columns` and `rows` for `table`) |
| `actions` | `Array<WidgetAction>` | No | Optional interactive buttons or actions the user can trigger |

**Example:**

```typescript
const result = await generateText("Show me the server performance metrics as a chart", {
  tools: ["render_widget"],
});
```

**Notes:**
- Supported chart variants: `bar`, `line`, and `sparkline`.
- In headless/CLI/REST mode, widgets gracefully degrade to structured JSON or clean terminal ASCII tables.

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
- See [Skills System Guide](/guides/skills) for creating custom skills.

---

## Tool Groups Summary

| Tool | Name | Group | Category | Side-effect Risk | Key Config |
|---|---|---|---|---|---|
| Shell execution | `execute_shell_command` | Core | System | High (sandbox execution) | OS Sandbox |
| File read | `read_file` | Core | Filesystem | Read-only | -- |
| File write | `write_file` | Core | Filesystem | Medium (full write) | FileCommitBroker |
| File edit | `edit_file` | Core | Filesystem | Medium (targeted patch) | SnapshotStore |
| Date/time | `get_current_datetime` | Core | System | Read-only | -- |
| Task tracking | `manage_todos` | Core | Planning | Read-only / UI | -- |
| Widget display | `render_widget` | Core | UI | Presentation | -- |
| Web search | `web_search` | Comm | Network | Read-only | `TAVILY_API_KEY` |
| Email sending | `send_email` | Comm | Communication | Medium (SMTP dispatch) | SMTP credentials |
| Notification | `send_notification` | Comm | Communication | Low (webhook post) | Webhook URLs |
| Web reader | `read_website` | Advanced | Browser | Read-only | Playwright |
| Screenshot | `take_screenshot` | Advanced | Browser | Read-only | Playwright |
| Image generation | `generate_image` | Advanced | Media | Medium (asset write) | Image model / provider |
| Prompt optimizer | `optimize_prompt` | Advanced | Utility | Read-only | LLM provider |
| Skill activation | `use_skill` | Advanced | Orchestration | Context injection | Skill registry |
