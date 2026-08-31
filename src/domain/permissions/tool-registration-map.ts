/**
 * Tool Registration Map & Extraction — Domain (spec 020, FR-001, US2).
 *
 * Extracts PreparedToolRegistration and BrokerConnectorRegistration records
 * from user-supplied tools lists and indexes them by tool name.
 */
import type {
  PreparedToolRegistration,
  BrokerConnectorRegistration,
  AnyToolRegistration,
} from "../../foundations/contracts/custom-tools.js";
import { ALL_TOOLS } from "../tool-executor.js";
import { PreparedActionError } from "./prepared-action-validator.js";

/** Keyed by definition.function.name; built per composition root. */
export type ToolRegistrationMap = Map<
  string,
  PreparedToolRegistration | BrokerConnectorRegistration
>;

/**
 * Extract prepared and broker-connector registrations from tools array passed to composition roots.
 * Rejects collisions with built-in tool names and duplicate custom registrations.
 */
export function extractRegistrations(
  tools?: readonly unknown[],
): ToolRegistrationMap {
  const map: ToolRegistrationMap = new Map();
  for (const input of tools ?? []) {
    if (!input || typeof input !== "object") continue;
    const item = input as AnyToolRegistration;
    if ("kind" in item) {
      if (item.kind === "prepared" || item.kind === "broker-connector") {
        const name = item.definition?.function?.name;
        if (!name) continue;
        if (ALL_TOOLS.includes(name)) {
          throw new PreparedActionError(
            "PREPARED_ACTION_REGISTRATION_COLLISION",
            `Custom tool registration name "${name}" collides with built-in tool name.`,
            `Choose a unique name for your custom tool that does not shadow built-in tools [${ALL_TOOLS.join(", ")}].`,
          );
        }
        if (map.has(name)) {
          throw new PreparedActionError(
            "PREPARED_ACTION_REGISTRATION_COLLISION",
            `Duplicate custom tool registration for name "${name}".`,
            `Ensure each custom tool registration in tools array has a unique function name.`,
          );
        }
        map.set(name, item);
      }
    } else if ("trust" in item && (item as any).trust === "host") {
      const name = (item as any).definition?.function?.name;
      if (name && ALL_TOOLS.includes(name)) {
        throw new PreparedActionError(
          "PREPARED_ACTION_REGISTRATION_COLLISION",
          `Custom tool registration name "${name}" collides with built-in tool name.`,
          `Choose a unique name for your custom tool that does not shadow built-in tools [${ALL_TOOLS.join(", ")}].`,
        );
      }
    }
  }
  return map;
}
