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
        if (decl.effects) {
          if (!Array.isArray(decl.effects)) {
            throw new Error(`effects in trustedHostTool declaration must be an array`);
          }
          const ALLOWED_EFFECT_KINDS = ["network-egress", "secret-use", "model-egress"];
          for (const effect of decl.effects) {
            if (!effect || typeof effect !== "object" || !("kind" in effect)) {
              throw new Error(`Invalid effect in trustedHostTool declaration: must be an object with a "kind" property`);
            }
            const kind = (effect as any).kind;
            if (!ALLOWED_EFFECT_KINDS.includes(kind)) {
              throw new Error(
                `Invalid effect kind "${kind}" in trustedHostTool declaration. Allowed kinds: ${ALLOWED_EFFECT_KINDS.join(", ")}`,
              );
            }
            if (kind === "network-egress") {
              const dests = (effect as any).destinations;
              if (!Array.isArray(dests) || dests.length === 0) {
                throw new Error(
                  `Invalid effect "network-egress" in trustedHostTool declaration: "destinations" must be a non-empty array`,
                );
              }
            } else if (kind === "secret-use") {
              const refs = (effect as any).secretRefs;
              if (!Array.isArray(refs) || refs.length === 0) {
                throw new Error(
                  `Invalid effect "secret-use" in trustedHostTool declaration: "secretRefs" must be a non-empty array`,
                );
              }
            } else if (kind === "model-egress") {
              const classes = (effect as any).dataClasses;
              if (!Array.isArray(classes) || classes.length === 0) {
                throw new Error(
                  `Invalid effect "model-egress" in trustedHostTool declaration: "dataClasses" must be a non-empty array`,
                );
              }
            }
          }
        }
      }

      const operation: PreparedOperation = {
        kind: "trusted-host",
        registrationId: toolName,
        toolName,
        args: jsonArgs as any,
      };

      const effects: EffectRequest[] = decl?.effects
        ? decl.effects.map((e): EffectRequest => {
            if (e.kind === "model-egress") {
              return {
                kind: "model-egress",
                dataClasses: e.dataClasses,
                providerClass: e.providerClass ?? ctx.modelProviderClass,
                sources: e.sources ?? [toolName],
              };
            }
            if (e.kind === "network-egress") {
              return {
                kind: "network-egress",
                destinations:
                  e.destinations === "dynamic"
                    ? "dynamic"
                    : e.destinations.map((d) => {
                        if (typeof d !== "string") return d;
                        const hasHttp = d.startsWith("http://");
                        const hasHttps = d.startsWith("https://");
                        const scheme = hasHttp ? ("http" as const) : ("https" as const);
                        const urlString = hasHttp || hasHttps ? d : `https://${d}`;
                        try {
                          const u = new URL(urlString);
                          const rawHostname = u.hostname;
                          const host = rawHostname.startsWith("[") && rawHostname.endsWith("]")
                            ? rawHostname.slice(1, -1)
                            : rawHostname;
                          return {
                            scheme,
                            host,
                            port: u.port ? Number(u.port) : undefined,
                          };
                        } catch {
                          const withoutScheme = d.replace(/^https?:\/\//, "");
                          const colonIdx = withoutScheme.lastIndexOf(":");
                          if (colonIdx !== -1) {
                            const hostPart = withoutScheme.slice(0, colonIdx);
                            const portPart = Number(withoutScheme.slice(colonIdx + 1));
                            if (!isNaN(portPart)) {
                              return { scheme, host: hostPart, port: portPart };
                            }
                          }
                          return { scheme, host: withoutScheme, port: undefined };
                        }
                      }),
              };
            }
            if (e.kind === "secret-use") {
              return {
                kind: "secret-use",
                secretRefs: e.secretRefs,
              };
            }
            throw new Error(`Unsupported effect declaration kind: ${(e as any).kind}`);
          })
        : [
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
