/**
 * Seepient SDK — Tool utilities (re-export layer)
 *
 * All tool registry, resolution, and factory logic lives in core/tool-executor.
 * This file re-exports for backward compatibility.
 */

export {
  // Tool group constants
  CORE_TOOLS,
  COMM_TOOLS,
  ADVANCED_TOOLS,
  ALL_TOOLS,
  // Factory and resolution
  tool,
  resolveTools,
  getToolGroup,
  // Registry and execution
  registerTool,
  executeTool,
  getAllToolDefinitions,
} from "../../domain/tool-executor.js";

import { getAllToolModules } from "../../domain/tool-executor.js";

// ── spec 019 FR-006 (T022): host-callback wiring for trusted-host tools ──

/**
 * Extract trusted-host callbacks from explicit `trustedHostTool({ trust:
 * "host" })` registrations in a tools list. The composition root passes the
 * result to `buildLocalBoundary({ hostCallbacks })` — after the ambient
 * registry fallback's deletion, the TrustedHostExecutor runs REGISTERED
 * callbacks only. The returned ids are also operator intent: they join the
 * effective trusted-host allowlist for the lifecycle.
 */
export function extractHostCallbacks(
  tools?: readonly unknown[],
): { callbacks: Map<string, (args: unknown) => Promise<unknown>>; registrationIds: string[] } {
  const callbacks = new Map<string, (args: unknown) => Promise<unknown>>();
  const registrationIds: string[] = [];
  for (const mod of getAllToolModules()) {
    if (typeof mod.handler === "function" && mod.definition?.function?.name) {
      callbacks.set(mod.definition.function.name, (args) => mod.handler!(args as never, {}));
    }
  }
  for (const input of tools ?? []) {
    const reg = input as import("../../foundations/contracts/custom-tools.js").TrustedHostToolRegistration | undefined;
    if (
      reg &&
      typeof reg === "object" &&
      (reg as { trust?: unknown }).trust === "host" &&
      typeof reg.execute === "function" &&
      reg.definition &&
      typeof reg.definition.function?.name === "string"
    ) {
      const name = reg.definition.function.name;
      callbacks.set(name, (args: unknown) => reg.execute(args, {}));
      registrationIds.push(name);
    }
  }
  return { callbacks, registrationIds };
}

/**
 * The default operator allowlist for trusted-host execution (spec 019
 * T005/T025 — `permissions.trustedHostAllowlist` default).
 */
export const DEFAULT_TRUSTED_HOST_ALLOWLIST: readonly string[] = ["use_skill"];

// ── spec 020 FR-001 (US2): registration extraction for prepared/connector tools ──
export { extractRegistrations, type ToolRegistrationMap } from "../../domain/permissions/tool-registration-map.js";
