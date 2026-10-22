/**
 * Tool activity lines for progress surfaces (recovered verbatim from the
 * demolished pi-runtime module — the governed runtime's onStep tool_progress
 * path now produces them; T011's redaction property pins the behavior).
 */

const ACTIVITY_DETAIL_LIMIT = 90;

function sanitizeSensitiveText(message: string) {
  return message
    .replace(/sk-or-v1-[a-zA-Z0-9]+/g, "[redacted]")
    .replace(/sk-[a-zA-Z0-9-]+/g, "[redacted]")
    .replace(/Bearer\s+[^\s"',;&]+/gi, "Bearer [redacted]")
    .replace(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, "[redacted]")
    .replace(/COMPOSIO_API_KEY[=:]?\s*\S+/gi, "COMPOSIO_API_KEY=[redacted]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)[^\s"',;&]+/gi,
      "$1[redacted]",
    )
    .replace(/((?:auth|authorization)\s*[=:]\s*)(?!Bearer\b)[^\s"',;&]+/gi, "$1[redacted]");
}

/** Origin + path only for activity chips; drop userinfo, query, and fragment. */
function redactActivityUrl(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return raw;
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    // Never echo unparsed input — it may still contain userinfo/secrets.
    return "[invalid URL]";
  }
}

export function describeToolActivity(toolName: string, args: unknown): string {
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const detail = (value: unknown): string => {
    const text = sanitizeSensitiveText(String(value ?? ""))
      .replaceAll(/\s+/g, " ")
      .trim();
    return text.length > ACTIVITY_DETAIL_LIMIT ? `${text.slice(0, ACTIVITY_DETAIL_LIMIT)}…` : text;
  };
  if (toolName === "shell") return `Running: ${detail(record.command)}`;
  if (toolName === "read_file") return `Reading ${detail(record.path)}`;
  if (toolName === "write_file") return `Writing ${detail(record.path)}`;
  if (toolName === "list_files") return `Listing ${detail(record.path ?? ".")}`;
  if (toolName === "attach_file") return `Attaching ${detail(record.path)}`;
  if (toolName === "open_path") return `Opening ${detail(record.path)}`;
  if (toolName === "render_plot") return "Rendering a chart";
  if (toolName === "add_mcp_server") return `Connecting MCP server: ${detail(record.name)}`;
  if (toolName === "computer_observe") return "Looking at the screen";
  if (toolName === "browser_navigate")
    return `Opening page: ${detail(redactActivityUrl(record.url))}`;
  if (toolName === "browser_snapshot") return "Reading the page";
  if (toolName === "browser_act") return "Using the page";
  if (toolName === "computer_act") return "Operating the computer";
  if (toolName === "run_subagent") return `Delegating to helper: ${detail(record.name)}`;
  if (toolName === "create_space") return `Creating space: ${detail(record.name)}`;
  if (toolName === "remember") return "Saving a note to memory";
  if (toolName === "save_shared_memory") return `Saving shared memory: ${detail(record.path)}`;
  if (toolName === "web_search") return `Searching the web: ${detail(record.query)}`;
  if (toolName === "web_fetch") return `Reading page: ${detail(redactActivityUrl(record.url))}`;
  if (toolName === "skill_read") return `Reading skill: ${detail(record.name)}`;
  if (toolName === "skill_create") return `Creating skill: ${detail(record.name ?? "skill")}`;
  if (toolName === "skill_update")
    return `Updating skill: ${detail(record.name ?? record.skillId)}`;
  if (toolName === "skill_delete")
    return `Deleting skill: ${detail(record.name ?? record.skillId)}`;
  const mcp = toolName.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) return `Using ${mcp[1]}: ${mcp[2]}`;
  return `Using ${toolName}`;
}
