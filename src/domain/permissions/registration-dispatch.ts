import type { ToolAnalyzer } from "./default-analyzers.js";
import type {
  PreparedToolRegistration,
  BrokerConnectorRegistration,
  TrustedHostToolRegistration,
} from "../../foundations/contracts/custom-tools.js";
import type { PreparedOperation, ActionDisplay } from "../../foundations/contracts/prepared-action.js";
import type { EffectRequest, ToolRiskCategory } from "../../foundations/contracts/tool-effects.js";
import { buildPreparedAction } from "./prepared-action-validator.js";
import { digestArgs, digestAction } from "./default-analyzers.js";
import { generateId } from "../../foundations/id.js";

export function makeRegistrationAnalyzer(
  registration: PreparedToolRegistration | BrokerConnectorRegistration | TrustedHostToolRegistration,
): ToolAnalyzer {
  if ("kind" in registration) {
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
  }
  if ("trust" in registration && registration.trust === "host") {
    return async (args, ctx) => {
      const jsonArgs = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
      const toolName = registration.definition.function.name;
      const decl = registration.declaration;

      // Validate declaration fields fail-closed
      if (decl) {
        if (decl.risk && !["safe", "read", "edit", "sensitive", "destructive"].includes(decl.risk)) {
          throw new Error(`Invalid risk category "${decl.risk}" in trustedHostTool declaration`);
        }
        if (decl.effects && !Array.isArray(decl.effects)) {
          throw new Error(`effects in trustedHostTool declaration must be an array`);
        }
      }

      const operation: PreparedOperation = {
        kind: "trusted-host",
        registrationId: toolName,
        toolName,
        args: jsonArgs as any,
      };

      const effects: EffectRequest[] = decl?.effects ?? [
        { kind: "host-callback", toolName },
        {
          kind: "model-egress",
          providerClass: ctx.modelProviderClass,
          dataClasses: ["normal", "sensitive"],
          sources: [toolName],
        },
      ];

      const risk: ToolRiskCategory = decl?.risk ?? "destructive";

      const display: ActionDisplay = {
        title: decl?.display?.title ?? toolName,
        summary: decl?.display?.summary ?? `Execute host callback ${toolName}`,
        canonicalTargets: decl?.display?.canonicalTargets ?? [],
        effects: decl?.display?.effects ?? (decl?.effects ? decl.effects.map((e) => e.kind) : ["host-callback"]),
      };

      const argsDigest = digestArgs(args);
      const actionDigest = digestAction({
        operation,
        effects,
        principalId: ctx.principalId,
        toolName,
        argsDigest,
        runId: ctx.runId,
        toolCallId: ctx.toolCallId,
      });

      return {
        version: 1,
        actionId: generateId(),
        runId: ctx.runId,
        toolCallId: ctx.toolCallId,
        toolName,
        principalId: ctx.principalId,
        argsDigest,
        actionDigest,
        risk,
        effects,
        display,
        operation,
      };
    };
  }
  throw new Error(`Unsupported registration: ${(registration as any)?.kind ?? (registration as any)?.trust}`);
}
