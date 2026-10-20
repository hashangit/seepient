/**
 * S08 development-candidate composition (spec 029, M02 T029, decision D7).
 *
 * Wires the engine's SeepientAgentRuntime as this app's AgentRuntime. The
 * recorded development provider account rides the ENGINE's normal provider
 * runtime — the operator provisions it once via `seepient auth login`
 * (never env keys, never ambient fallback); only the ACCOUNT ID is named
 * here. Model, instructions, external history and the tool set flow through
 * the adapter's translation from the trusted run request; an explicitly
 * empty tool list stays empty end to end.
 */
import { SeepientAgentRuntime } from "seepient/app-runtime";
import type { AgentRunRequest } from "@seepients/adapter-kit";
import type { AgentRuntime } from "@seepients/adapter-kit";
import type { CreateSeepientOptions } from "seepient/types";

/** Env var naming the operator-provisioned development provider account. */
export const SEEPIENT_DEV_ACCOUNT_ENV = "SEEPIENTS_DEV_ACCOUNT";
export const SEEPIENT_DEV_ACCOUNT_DEFAULT = "seepients-dev";

export function createSeepientAgentRuntime(): AgentRuntime {
  return new SeepientAgentRuntime({
    resolveEngineOptions: (request: AgentRunRequest): CreateSeepientOptions => ({
      model: request.model.id,
      providerAccount: process.env[SEEPIENT_DEV_ACCOUNT_ENV] ?? SEEPIENT_DEV_ACCOUNT_DEFAULT,
    }),
  });
}
