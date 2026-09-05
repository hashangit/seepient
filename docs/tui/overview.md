---
title: Terminal UI overview
description: Tour, layout, and keyboard shortcuts for Seepient's full-screen terminal interface.
---

# Terminal UI overview

The Terminal User Interface (TUI) is Seepient's primary interactive interface. Built with Ink and React, it provides an interactive terminal workspace for multi-turn conversations, code reviews, and tool execution without leaving the terminal.

## Launching the interface

To start the TUI, run `seepient` without command arguments in any standard terminal emulator:

```bash
seepient
```

If your terminal window is smaller than 80 columns by 24 rows, Seepient prompts you to resize the window for optimal layout rendering.

## Interface layout

The TUI splits the screen into four regions:

<TermAnatomy
  :regions="[
    { label: 'Header', kind: 'header', lines: ['Seepient [sess_20260905_a1b2]  |  Model: claude-3-7-sonnet'] },
    { label: 'Stream feed & widgets', kind: 'feed', lines: [
      '> You: Review the router logic in src/domain/providers',
      '',
      '🧠 Thinking (12.4s)',
      '• Inspecting src/domain/providers/provider-runtime.ts',
      '',
      '🤖 Agent:',
      'The router uses a Purpose × Tier matrix. I noticed that',
      'fallback chains handle network timeouts, but lack retry',
      'backoff jitter. Here is the proposed fix:',
      'Diff: src/domain/providers/provider-runtime.ts',
      '-   const delay = retryCount * 1000;',
      '+   const delay = retryCount * 1000 + Math.random() * 200;'
    ] },
    { label: 'Approval bar', kind: 'bar', lines: ['Pending: [Enter] Approve  |  [r] Reject  |  [d] View full diff'] },
    { label: 'Bordered input', kind: 'input', lines: ['> Ask a question or type / for commands...'] }
  ]"
/>
### 1. Header bar
Displays the active session identifier, current provider, primary model name, and accumulated token expenditure for the session.

### 2. Streaming feed
Renders conversation messages, model deliberations, tool outputs, and formatted code blocks. Long code blocks include syntax highlighting, and tables render with clean box-drawing borders.

### 3. Approval bar and dialogs
When the model proposes an effectful tool call (such as writing a file or running a shell command), the feed pauses and displays an approval prompt showing the exact command or file diff.

### 4. Bordered input box
An always-on input box at the bottom of the screen. You can type new questions, paste multi-line snippets, or enter slash commands.

## Keyboard shortcuts

| Keybinding | Action |
|---|---|
| `Enter` | Submit current prompt or confirm dialog selection |
| `Shift + Enter` | Insert newline in multi-line prompt mode |
| `Up` / `Down` | Browse prompt input history |
| `Ctrl + C` | Cancel active model streaming; press twice to exit |
| `Ctrl + L` | Clear terminal screen buffer while keeping session history |
| `Tab` | Autocomplete slash commands and file paths |
| `Esc` | Close active modal dialog or dismiss command menu |

## Steering and message queue

You do not need to wait for long-running tool executions to finish before typing additional instructions. 

If you type a prompt while the model is thinking or executing a tool, Seepient queues your message. The agent incorporates your queued prompt at the beginning of the next planning turn without resetting the session.
