/**
 * Seepient Core — Tool executor
 *
 * Tool registry, resolution, factory, and execution logic.
 * Transport-agnostic: no chalk, no HTTP, no CLI concerns.
 */

import { randomUUID } from "node:crypto";
import { builtInTools } from "../capabilities/tools/index.js";
import { UseSkillTool } from "./skills/use-skill-tool.js";
import { ToolModule, ToolDefinition, ToolExecExtra, ToolRegistryContract } from "../foundations/contracts/tool.js";
export type { ToolModule, ToolDefinition, ToolExecExtra, ToolRegistryContract };
import {
  UserToolDefinition,
  ToolContext,
  ToolResult,
} from "../foundations/types.js";
import { SeepientError } from "../foundations/errors.js";

// ── Built-in Tools & Per-Agent Registry ──────────────────────────────

/**
 * Immutable, frozen built-in tool modules — shared safely across all agents in a process.
 */
export const BUILT_IN_TOOL_MODULES: readonly ToolModule[] = Object.freeze([
  ...builtInTools,
  UseSkillTool,
]);

/**
 * Thrown when registering a tool whose name conflicts with an existing tool in the registry.
 */
export class ToolRegistrationError extends SeepientError {
  readonly conflictingName: string;

  constructor(conflictingName: string, message?: string) {
    const defaultMessage = `Cannot register tool "${conflictingName}": a tool with this name is already registered in this ToolRegistry. Pass tools per agent; names are scoped to one registry.`;
    super(message ?? defaultMessage, "TOOL_NAME_CONFLICT", false);
    this.name = "ToolRegistrationError";
    this.conflictingName = conflictingName;
  }
}

/**
 * Per-agent tool registry holding built-in and explicitly registered custom/gateway tools.
 */
export class ToolRegistry implements ToolRegistryContract {
  private readonly _modules: ToolModule[] = [];
  private readonly _byName: Map<string, ToolModule> = new Map();

  constructor(builtIns?: readonly ToolModule[]) {
    const initial = builtIns ?? BUILT_IN_TOOL_MODULES;
    for (const mod of initial) {
      this.register(mod);
    }
  }

  register(module: ToolModule): void {
    const name = module.definition.function.name;
    if (this._byName.has(name)) {
      throw new ToolRegistrationError(name);
    }
    this._modules.push(module);
    this._byName.set(name, module);
  }

  registerMany(modules: ToolModule[]): void {
    for (const mod of modules) {
      this.register(mod);
    }
  }

  modules(): readonly ToolModule[] {
    return [...this._modules];
  }

  definitions(): ToolDefinition[] {
    return this._modules.map((m) => m.definition);
  }

  find(name: string): ToolModule | undefined {
    return this._byName.get(name);
  }
}

// ── Tool groups ──────────────────────────────────────────────────────

export const CORE_TOOLS = [
  "execute_shell_command",
  "read_file",
  "write_file",
  "edit_file",
  "get_current_datetime",
  "manage_todos",
  "render_widget",
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
  return `custom_tool_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
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

// ── normalizeToolResult ────────────────────────────────────────────────
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
    const found = BUILT_IN_TOOL_MODULES.find(
      (t) => t.definition.function.name === name,
    );
    if (found) {
      defs.push(found.definition);
    }
  }

  return defs;
}

// ── resolveTools ─────────────────────────────────────────────────────

type ToolInput =
  | string
  | UserToolDefinition
  | ToolModule
  | import("../foundations/contracts/custom-tools.js").AnyToolRegistration;

/** Is this input an explicit-trust registration or ToolModule (definition-carrying)? */
function isToolRegistration(input: unknown): input is import("../foundations/contracts/custom-tools.js").AnyToolRegistration | ToolModule {
  return (
    typeof input === "object" &&
    input !== null &&
    "definition" in input &&
    typeof (input as { definition?: unknown }).definition === "object"
  );
}

/**
 * Resolve a mixed array of tool references into concrete OpenAI function
 * definitions ready to send to the LLM.
 *
 * Accepted input shapes:
 *  - `"all"`                     — expands to all built-in tools
 *  - `"core"` / `"comm"` / `"advanced"` — expands to the named group
 *  - A built-in tool name string — looked up from the provided/default ToolRegistry
 *  - A `UserToolDefinition` object   — converted via `tool()` factory
 *
 * @param tools           Array of tool references (defaults to all built-in tools)
 * @param targetRegistry  ToolRegistry to resolve against (defaults to a new registry of built-in tools)
 * @returns               Deduplicated array of OpenAI function definitions
 * @throws                Error if a string name is not found in the registry
 */
export function resolveTools(tools?: ToolInput[], targetRegistry?: ToolRegistryContract): ToolDefinition[] {
  const inputs = tools ?? ["all"];
  const reg = targetRegistry ?? new ToolRegistry();

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
          const found = reg.find(name);
          if (found && !seen.has(name)) {
            seen.add(name);
            result.push(found.definition);
          }
        }
        continue;
      }

      // Individual tool lookup
      const found = reg.find(input);
      if (!found) {
        const available = reg.definitions().map((t) => t.function.name).join(", ");
        throw new Error(
          `Unknown tool "${input}". Available: ${available}`,
        );
      }
      const name = found.definition.function.name;
      if (!seen.has(name)) {
        seen.add(name);
        result.push(found.definition);
      }
      continue;
    }

    // Explicit-trust registration (preparedTool / brokerConnector /
    // trustedHostTool) — contribute its definition directly. The executor
    // wiring for trusted-host callbacks happens in the composition root.
    if (isToolRegistration(input)) {
      const name = input.definition.function.name;
      if (!seen.has(name)) {
        seen.add(name);
        result.push(input.definition);
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
