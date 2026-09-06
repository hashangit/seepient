---
title: Slash commands
description: In-session commands for steering, model switching, and session management in the TUI.
---

# Slash commands

The TUI provides built-in slash commands for controlling the agent loop, switching models, and managing sessions without exiting the interface.

Type `/` in the input box to open the interactive command autocomplete list.

---

## Command reference

### `/steer <instruction>`
Injects high-priority guidance into the active planning loop.

If the model begins down an unintended path or misinterprets a requirement, use `/steer` to redirect it immediately without terminating the session or losing previous tool context:

```text
/steer Focus only on the backend router. Do not modify the frontend components.
```

### `/model [name]`
Displays or changes the active model configuration.

- `/model`: Opens an interactive selector listing discovered upstream models and active Purpose × Tier assignments.
- `/model claude-3-7-sonnet`: Switches the current text generation model immediately.
- `/model tier complex`: Escalates the active session to the high-reasoning tier for difficult tasks.

### `/session [action]`
Manages conversation checkpoints.

- `/session list`: Shows previous sessions with timestamps, token counts, and last prompts.
- `/session resume <id>`: Resumes a previous session.
- `/session fork`: Clones the current conversation into a new independent branch.
- `/session export <file.md>`: Writes the full conversation history to a clean markdown document.

### `/skill <name>`
Manages skill pack injection.

- `/skill list`: Shows discovered workspace and global skills.
- `/skill load <name>`: Injects a skill into the active session turn.

### `/clear`
Clears the visual terminal scroll buffer while retaining conversation history in memory.

### `/audit`
Displays the last five entries recorded in `~/.seepient/audit.log`, showing tool executions, timestamps, and approval statuses.

### `/quit` or `/exit`
Terminates active background workers and exits the TUI cleanly.
