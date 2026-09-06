---
title: Tools and effects
description: Built-in tools, prepared action drafts, and brokered effect execution in Seepient.
---

# Tools and effects

Language models should not directly perform destructive side effects. When a model attempts to write a file, execute a shell script, or send an email, Seepient splits the process into two phases: **preparation** and **brokered execution**.

<DiagramFlow
  :steps="[
    { title: 'Model generates a tool call' },
    { title: 'Tool creates a PreparedActionDraft' },
    { title: 'Permission Engine checks policy & consent mode' },
    { title: 'Approval Broker confirms the action' },
    { title: 'Execution Boundary runs the action inside the OS sandbox' },
    { title: 'Audit Recorder logs the outcome' }
  ]"
/>

## Prepared actions

Built-in tools that cause external side effects do not execute actions immediately. Instead, they produce a `PreparedActionDraft` structure containing:

- The requested action name
- Target resources (file paths, network hosts, environment keys)
- Intended mutation details (exact line replacements, shell command line)
- Pre-image hashes of targeted files on disk

The permission engine evaluates this draft against active consent modes, system policies, and sandbox profiles before anything runs.

## Built-in tools

Seepient ships with 15 built-in tools organized by capability:

| Tool | Category | Type | Description |
|---|---|---|---|
| `read_file` | Filesystem | Read-only | Reads file contents with line range slicing |
| `write_file` | Filesystem | Effectful | Creates new files or writes complete file contents |
| `edit_file` | Filesystem | Effectful | Performs targeted contiguous edits with line verification |
| `execute_shell_command` | System | Effectful | Executes shell commands inside the OS sandbox |
| `get_current_datetime` | System | Read-only | Returns accurate system time and timezone |
| `web_search` | Network | Read-only | Queries Tavily for real-time web results |
| `read_website` | Network | Read-only | Extracts readable markdown from HTTP URLs |
| `take_screenshot` | Browser | Read-only | Captures full-page or element screenshots |
| `send_email` | Communication | Effectful | Sends email messages via configured SMTP servers |
| `send_notification` | Communication | Effectful | Sends webhook alerts to Feishu, DingTalk, Slack, or Discord |
| `generate_image` | Media | Effectful | Generates images via Fal, Google, or OpenAI backends |
| `render_widget` | UI | Presentation | Renders interactive tables, charts, or forms in the TUI |
| `manage_todos` | Planning | Local state | Manages the agent's internal task tracking list |
| `optimize_prompt` | Analysis | Read-only | Analyzes and refines prompts for upstream models |
| `use_skill` | Orchestration | Context | Loads and activates an external skill folder |

> [!TIP]
> For complete parameter schemas, configuration requirements, and code examples for all 15 tools, see the [Built-in Tools Reference](/tools/reference).

## Read vs effectful tools

- **Read-only tools** (such as `read_file`, `web_search`, and `get_current_datetime`) run without prompting in standard consent modes. They cannot alter files or execute arbitrary host instructions.
- **Effectful tools** (such as `write_file`, `edit_file`, and `execute_shell_command`) mutate disk state or execute code. In `always-ask` mode, they prompt for confirmation with a clear visual preview of the command or file diff.

## Dry runs

You can run commands with the `--dry-run` flag. In dry-run mode:

1. The model plans and reasons normally.
2. Tools generate prepared action drafts.
3. The execution boundary logs the action to stdout or the TUI without applying mutations to the filesystem or spawning shell processes.

---

## Next steps

- [Built-in Tools Reference](/tools/reference) -- Complete parameters and examples for all 15 tools
- [Custom Tools in SDK](/sdk/custom-tools) -- Define custom application-specific tools
- [MCP Gateway](/sdk/mcp-gateway) -- Expose remote MCP servers and REST APIs as tools
- [Permissions and Consent](/security/permissions) -- Control tool authorization policies
