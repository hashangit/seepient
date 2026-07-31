/**
 * Seepient Core — Tool executor
 *
 * Tool registry, resolution, factory, and execution logic.
 * Transport-agnostic: no chalk, no HTTP, no CLI concerns.
 */

import { builtInTools } from "../capabilities/tools/index.js";
import { UseSkillTool } from "./skills/use-skill-tool.js";
import { ToolModule, ToolDefinition, ToolExecExtra } from "../foundations/contracts/tool.js";
import {
  UserToolDefinition,
  ToolContext,
  ToolResult,
} from "../foundations/types.js";

// ── Internal registry ───────────────────────────────────────────────

const registry: ToolModule[] = [...builtInTools, UseSkillTool];

/**
 * Return the tool definitions for all registered tools (built-in + custom).
 */
export function getAllToolDefinitions(): ToolDefinition[] {
  return registry.map((t) => t.definition);
}

/**
 * Return all registered tool modules (built-in + custom).
 */
export function getAllToolModules(): ToolModule[] {
  return registry;
}

// ── Tool groups ──────────────────────────────────────────────────────

export const CORE_TOOLS = [
  "execute_shell_command",
  "read_file",
  "write_file",
  "get_current_datetime",
];

export const COMM_TOOLS = [
  "send_email",
  "web_search",
  "send_notification",
];

export const ADVANCED_TOOLS = [
  "read_website",
  "take_screenshot",
  "generate_image",
  "optimize_prompt",
  "use_skill",
];

export const ALL_TOOLS = [...CORE_TOOLS, ...COMM_TOOLS, ...ADVANCED_TOOLS];

// ── Helpers ──────────────────────────────────────────────────────────

let customToolCounter = 0;

/**
 * Convert a parameter definition into JSON Schema.
 *
 * Accepts plain `{ type: "object", properties: {...}, required: [...] }` objects.
 * Anything else is wrapped in a generic object schema.
 */
function parametersToJsonSchema(parameters: unknown): Record<string, unknown> {
  if (parameters == null || typeof parameters !== "object") {
    return { type: "object", properties: {} };
  }

  const rec = parameters as Record<string, unknown>;

  // Already a valid JSON Schema object — validate basic shape
  if (
    "type" in rec && "properties" in rec
    && typeof rec.type === "string"
    && typeof rec.properties === "object" && rec.properties !== null
  ) {
    return rec;
  }

  // Unknown shape — wrap generically
  return { type: "object", properties: {} };
}

/**
 * Generate a unique tool name when the user doesn't supply one.
 */
function generateToolName(): string {
  customToolCounter += 1;
  return `custom_tool_${customToolCounter}`;
}

// ── tool() factory ───────────────────────────────────────────────────

/**
 * Create a custom tool module from a Zod-like schema definition.
 *
 * Returns a `ToolModule` compatible with the built-in tool registry,
 * so custom tools can be mixed freely with built-in ones.
 *
 * @example
 * ```ts
 * const myTool = tool({
 *   description: "Greets a person",
 *   parameters: z.object({ name: z.string() }),
 *   execute: async ({ name }) => `Hello, ${name}!`,
 * });
 * ```
 */
import { classifyLegacyTool } from "../foundations/contracts/custom-tools.js";
export function tool(definition: UserToolDefinition): ToolModule {
  const functionName = definition.name ?? generateToolName();
  const classification = classifyLegacyTool(definition);
  const jsonSchema = parametersToJsonSchema(definition.parameters);

  const openaiDefinition: ToolDefinition = {
    type: "function",
    function: {
      name: functionName,
      description: definition.description,
      parameters: {
        type: (jsonSchema.type as "object") ?? "object",
        properties: (jsonSchema.properties as Record<string, unknown>) ?? {},
        required: (jsonSchema.required as string[]) ?? [],
      },
    },
  };

  const handler: ToolModule["handler"] = async (args: unknown, config?: any, extra?: ToolExecExtra) => {
    if (classification.trust === "legacy-host") {
      return {
        output: `Tool execution denied (LEGACY_TOOL_DENIED): Legacy tool("${functionName}") uses the legacy tool({ execute }) factory without an explicit trust model. Migrate to preparedTool(), brokerConnector(), or trustedHostTool({ trust: "host" }).`,
        success: false,
        error: {
          code: "LEGACY_TOOL_DENIED",
          message: `Legacy tool("${functionName}") uses the legacy tool({ execute }) factory without an explicit trust model.`,
          retryable: false,
        },
      };
    }
    const context: ToolContext = {
      config: config ?? {},
      onUpdate: extra?.onUpdate,
      signal: extra?.signal,
    };
    return definition.execute(args, context);
  };

  return {
    name: functionName,
    definition: openaiDefinition,
    handler,
  };
}

// ── registerTool ──────────────────────────────────────────────────────

/**
 * Register a tool module in the global tool registry.
 *
 * @param module  A `ToolModule` to add to the registry
 */
export function registerTool(module: ToolModule): void {
  if (registry.some(t => t.definition.function.name === module.definition.function.name)) {
    console.warn(`[tool-executor] Duplicate tool registration ignored: ${module.definition.function.name}`);
    return;
  }
  registry.push(module);
}

// ── executeTool ───────────────────────────────────────────────────────

/**
 * Coerce a tool handler's `string | ToolResult` return into a `ToolResult`.
 * Plain strings (the common case) become `{ output, success: true }` with no
 * metadata. Structured ToolResults pass through with `metadata` preserved.
 */
export function normalizeToolResult(raw: string | ToolResult): ToolResult {
  if (typeof raw === "string") return { output: raw, success: true };
  if (raw && typeof raw === "object" && "output" in raw) return raw;
  return { output: String(raw), success: true };
}

/**
 * Execute a tool by name with the given arguments and optional config.
 *
 * @param name    Tool function name (e.g. "execute_shell_command")
 * @param args    Arguments object for the tool
 * @param config  Optional runtime config passed to the tool handler
 * @returns       ToolResult — `output` (what the LLM sees) + optional `metadata`
 *                for adapters (e.g. write_file's FileWriteMetadata for the diff)
 * @throws        Error if the tool name is not found in the registry
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  config?: Record<string, unknown>,
  extra?: ToolExecExtra,
): Promise<ToolResult> {
  const found = registry.find(
    (t) => t.definition.function.name === name,
  );
  if (!found) {
    throw new Error(
      `Unknown tool "${name}". Available: ${registry
        .map((t) => t.definition.function.name)
        .join(", ")}`,
    );
  }
  const raw = await found.handler(args, config, extra);
  return normalizeToolResult(raw);
}

// ── getToolGroup ─────────────────────────────────────────────────────

/**
 * Return the built-in tool definitions belonging to a named group.
 *
 * @param group  One of "core", "comm", "advanced", or "all"
 * @returns      Array of OpenAI function definitions for the matching tools
 * @throws       Error if the group name is not recognised
 */
export function getToolGroup(
  group: "core" | "comm" | "advanced" | "all",
): ToolDefinition[] {
  let names: string[];

  switch (group) {
    case "core":
      names = CORE_TOOLS;
      break;
    case "comm":
      names = COMM_TOOLS;
      break;
    case "advanced":
      names = ADVANCED_TOOLS;
      break;
    case "all":
      names = ALL_TOOLS;
      break;
    default:
      throw new Error(
        `Unknown tool group "${group}". Valid groups: core, comm, advanced, all`,
      );
  }

  const defs: ToolDefinition[] = [];

  for (const name of names) {
    const found = registry.find(
      (t) => t.definition.function.name === name,
    );
    if (found) {
      defs.push(found.definition);
    }
  }

  return defs;
}

// ── resolveTools ─────────────────────────────────────────────────────

type ToolInput = string | UserToolDefinition;

/**
 * Resolve a mixed array of tool references into concrete OpenAI function
 * definitions ready to send to the LLM.
 *
 * Accepted input shapes:
 *  - `"all"`                     — expands to all built-in tools
 *  - `"core"` / `"comm"` / `"advanced"` — expands to the named group
 *  - A built-in tool name string — looked up from the internal registry
 *  - A `UserToolDefinition` object   — converted via `tool()` factory
 *
 * @param tools  Array of tool references (defaults to all built-in tools)
 * @returns      Deduplicated array of OpenAI function definitions
 * @throws       Error if a string name is not found in the built-in registry
 */
export function resolveTools(tools?: ToolInput[]): ToolDefinition[] {
  const inputs = tools ?? ["all"];

  const seen = new Set<string>();
  const result: ToolDefinition[] = [];

  for (const input of inputs) {
    // String reference — group name or built-in tool name
    if (typeof input === "string") {
      // Group expansion
      if (input === "all" || input === "core" || input === "comm" || input === "advanced") {
        const groupDefs = getToolGroup(input);
        for (const def of groupDefs) {
          const name = def.function.name;
          if (!seen.has(name)) {
            seen.add(name);
            result.push(def);
          }
        }
        continue;
      }

      // Individual built-in tool lookup
      const found = registry.find(
        (t) => t.definition.function.name === input,
      );
      if (!found) {
        throw new Error(
          `Unknown tool "${input}". Available: ${registry
            .map((t) => t.definition.function.name)
            .join(", ")}`,
        );
      }
      const name = found.definition.function.name;
      if (!seen.has(name)) {
        seen.add(name);
        result.push(found.definition);
      }
      continue;
    }

    // ToolDefinition object — convert via factory
    const module = tool(input);
    const name = module.definition.function.name;
    if (!seen.has(name)) {
      seen.add(name);
      result.push(module.definition);
    }
  }

  return result;
}
