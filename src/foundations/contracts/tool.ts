import type { ToolRiskCategory, ToolContext, ToolResult } from "../types.js";

/** Optional execution context pieces a caller (the agent loop) can pass in. */
export type ToolExecExtra = Pick<ToolContext, "onUpdate" | "signal">;

export interface ToolDefinition {
  type: "function";
  function: {
    name: "execute_shell_command" | "read_file" | "write_file" | "send_email" | string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

export interface ToolModule {
  name: string; // Display name for setup (e.g., "Email Service")
  configKeys?: string[]; // Keys needed in setting.json (e.g., ["smtpHost", "smtpUser"])
  risk?: ToolRiskCategory;
  definition: ToolDefinition; // OpenAI Tool Definition
  // Implementation. `extra` carries optional onUpdate (live progress) + signal.
  // May return a structured ToolResult to carry metadata (e.g. write_file's
  // old/new content for the diff viewer); plain strings still work everywhere.
  handler: (args: any, config?: any, extra?: ToolExecExtra) => Promise<string | ToolResult>;
}

/**
 * Reusable JSON-Schema fragment for the LLM-authored human-in-the-loop gate
 * context. Add as an OPTIONAL `approval` property on risky tools' parameters.
 * The agent loop extracts this into `ApprovalContext` shown by the approval
 * widget. Not added to `required` — the prompt nudges it, but a missing
 * field degrades gracefully (template fallback), never blocks.
 */
export const APPROVAL_SCHEMA = {
  type: "object",
  description:
    "Human-in-the-loop gate context. Fill this so the user can make an informed approval decision. The title/description and per-scope implications are shown in the approval widget.",
  properties: {
    title: { type: "string", description: "Short label for what this action does (e.g. 'Run test suite')." },
    description: { type: "string", description: "1-3 sentences: what this does, why now, and any side effects." },
    implications: {
      type: "object",
      description: "What each persistence scope means for THIS action, so the user understands the consequence of choosing it.",
      properties: {
        once: { type: "string", description: "Implication of approving just this once." },
        session: { type: "string", description: "Implication of allowing this for the rest of the session." },
        project: { type: "string", description: "Implication of allowing this for this project (any matching call)." },
        global: { type: "string", description: "Implication of allowing this for EVERY project (broadest)." },
      },
    },
  },
  required: ["title", "description"],
} as const;
