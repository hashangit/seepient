/**
 * Registration Dispatch Wrapper — Domain (spec 020, FR-001, US2).
 *
 * Wraps registered preparedTool or brokerConnector into a ToolAnalyzer.
 * Keeps Capabilities resolver untouched without upward imports.
 */
import type { ToolAnalyzer } from "./default-analyzers.js";
import type {
  PreparedToolRegistration,
  BrokerConnectorRegistration,
} from "../../foundations/contracts/custom-tools.js";
import { buildPreparedAction } from "./prepared-action-validator.js";

export function makeRegistrationAnalyzer(
  registration: PreparedToolRegistration | BrokerConnectorRegistration,
): ToolAnalyzer {
  if (registration.kind === "prepared") {
    return async (args, ctx) => {
      const draft = await registration.analyze(args, ctx);
      return buildPreparedAction(draft, registration, ctx, args);
    };
  }
  if (registration.kind === "broker-connector") {
    return async (args, ctx) => {
      const { evaluateBrokerConnector } = await import("../../capabilities/tools/connector-registry.js");
      const draft = await evaluateBrokerConnector(registration, args, ctx);
      return buildPreparedAction(draft, registration, ctx, args);
    };
  }
  throw new Error(`Unsupported registration kind: ${(registration as any)?.kind}`);
}
