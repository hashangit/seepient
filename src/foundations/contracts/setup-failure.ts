/**
 * Setup failure contracts and formatting — Foundations (spec 017, T014).
 *
 * Emitted when required configuration is absent, distinct from a permission denial.
 * Carries exact user-facing and model-facing remediation instructions.
 */

export interface SetupFailure {
  kind: "setup-failure";
  toolName: string;
  missingSetting: string;
  remediation: string;
  message: string;
}

export function isSetupFailure(value: unknown): value is SetupFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as any).kind === "setup-failure"
  );
}

export function createSetupFailure(
  toolName: string,
  missingSetting: string,
  remediationHint: string,
): SetupFailure {
  const remediation = `Add one with: seepient setup   (or set ${remediationHint})`;
  const message = `[setup required] ${toolName} needs a ${missingSetting}.\n${remediation}`;
  return {
    kind: "setup-failure",
    toolName,
    missingSetting,
    remediation,
    message,
  };
}
