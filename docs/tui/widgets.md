---
title: Interactive widgets
description: Terminal UI components for rendering tables, forms, spinners, and markdown.
---

# Interactive widgets

The Seepient TUI renders structured terminal widgets instead of raw text walls. When an agent queries data, reports status, or requests structured inputs, it uses specialized React/Ink components.

---

## 1. Tables

When displaying structured data (such as benchmark numbers, file listings, or database rows), the agent invokes table components:

<TermTable
  title="Outdated Dependencies"
  :columns="['Package', 'Current', 'Latest', 'Type', 'Breaking?']"
  :rows="[
    ['typescript', '5.4.2', '5.9.3', 'dev', 'Yes'],
    ['chalk', '4.1.2', '5.6.2', 'dependency', 'Yes (ESM)'],
    ['vitest', '1.2.0', '4.1.4', 'dev', 'No']
  ]"
/>
Tables automatically adapt to your terminal width, truncating long strings with ellipses and aligning numbers to the right.

---

## 2. Interactive forms and selectors

When an operation requires user choices, the TUI displays keyboard-navigable selection dialogs:

- **Single choice lists**: Use the `Up` and `Down` arrow keys to navigate and press `Enter` to pick an option.
- **Multi-select checklists**: Use `Space` to toggle items on or off, then press `Enter` to confirm.
- **Text input prompts**: Prompts for sensitive input (such as passwords) mask input characters with asterisks.

---

## 3. Spinners and task progress

During multi-step background actions, the TUI shows a collapsible task tree:

```text
⠿ Running test suite (vitest run)
  ✔ src/domain/agent-loop.test.ts (14 tests passed, 180ms)
  ✔ src/capabilities/tools/shell.test.ts (8 tests passed, 92ms)
  ⠋ src/capabilities/execution/fs-commit.test.ts (running...)
```

Completed steps collapse to green checkmarks, keeping terminal screen space clear for active output.

---

## 4. Syntax-highlighted code blocks

Code blocks render with syntax highlighting matching your terminal color profile. Long code blocks include line numbering and copy shortcuts:

```typescript
// Example: Registering an effectful tool
export const customDeployTool = {
  name: "deploy_service",
  description: "Deploys the built service container to Cloud Run",
  parameters: {
    serviceName: { type: "string", required: true },
    imageTag: { type: "string", required: true }
  }
};
```
