/**
 * Spec 022 — Tenancy Mode & Fail-Closed Validation (contracts/tenancy-mode.md).
 */
import { SeepientError } from "../../foundations/errors.js";

export type TenancyMode = "single" | "multi";

export interface TenancySignals {
  explicit?: TenancyMode;
  principalIdSet?: boolean;
  anyStoreInjected?: boolean;
  runtimeInjected?: boolean;
  persistInjected?: boolean;
  skillSourcesInjected?: boolean;
}

export interface TenancyResolution {
  mode: TenancyMode;
  upgraded: boolean;
}

/**
 * Thrown when multi-tenant mode is active or inferred but no ProviderRuntime is injected.
 */
export class TenancyRuntimeRequiredError extends SeepientError {
  constructor(message?: string) {
    const defaultMessage =
      'Multi-tenant mode requires an explicit ProviderRuntime to be injected. ' +
      'Pass an isolated runtime instance via options.runtime, or set tenancy: "single" ' +
      'if running in a single-user environment.';
    super(message ?? defaultMessage, "TENANCY_RUNTIME_REQUIRED", false);
    this.name = "TenancyRuntimeRequiredError";
  }
}

/**
 * Thrown when multi-tenant mode is active but required stores are missing.
 */
export class TenancyStoreIncompleteError extends SeepientError {
  readonly missingStores: string[];

  constructor(missingStores: string[], message?: string) {
    const defaultMessage =
      `Multi-tenant mode requires complete store injection to maintain tenant isolation. ` +
      `Missing required stores: ${missingStores.join(", ")}. ` +
      `Inject all required stores (auditStore, policyStore, capabilityLedger). For sessionful agents without session persistence, specify stateless: true.`;
    super(message ?? defaultMessage, "TENANCY_STORE_INCOMPLETE", false);
    this.name = "TenancyStoreIncompleteError";
    this.missingStores = missingStores;
  }
}

/**
 * Thrown when ambient operator configuration or filesystem access is attempted in multi-tenant mode.
 */
export class TenancyAmbientIoError extends SeepientError {
  readonly targetPath?: string;

  constructor(targetPath?: string, message?: string) {
    const defaultMessage = targetPath
      ? `Ambient filesystem access at "${targetPath}" is forbidden in multi-tenant mode. In multi-tenant mode, all state and configuration must be explicitly injected.`
      : `Ambient filesystem access to operator-scoped paths is forbidden in multi-tenant mode. All state and configuration must be explicitly injected.`;
    super(message ?? defaultMessage, "TENANCY_AMBIENT_IO", false);
    this.name = "TenancyAmbientIoError";
    this.targetPath = targetPath;
  }
}

/**
 * Resolve the effective tenancy mode from explicit options and injection signals.
 *
 * Matrix (Spec 022 data-model §2):
 *  - explicit "multi"  -> multi (upgraded: false)
 *  - explicit "single" -> single (upgraded: false; overrides injection signals)
 *  - no explicit, any signal true -> multi (upgraded: true, once-per-process notice)
 *  - no explicit, no signals -> single (upgraded: false)
 */
export function resolveTenancyMode(signals: TenancySignals): TenancyResolution {
  if (signals.explicit === "multi") {
    return { mode: "multi", upgraded: false };
  }

  if (signals.explicit === "single") {
    return { mode: "single", upgraded: false };
  }

  const hasSignal = Boolean(
    signals.principalIdSet ||
      signals.anyStoreInjected ||
      signals.runtimeInjected ||
      signals.persistInjected ||
      signals.skillSourcesInjected,
  );

  if (hasSignal) {
    return { mode: "multi", upgraded: true };
  }

  return { mode: "single", upgraded: false };
}

export interface TenancyValidationInputs {
  runtime?: unknown;
  auditStore?: unknown;
  policyStore?: unknown;
  capabilityLedger?: unknown;
  persist?: unknown;
  isSessionful?: boolean;
  stateless?: boolean;
}

/**
 * Validates that all required components are provided for the given tenancy mode.
 * Throws appropriate errors if the configuration is incomplete or violates isolation.
 */
export function validateTenancyCompleteness(
  mode: TenancyMode,
  inputs: TenancyValidationInputs,
): void {
  if (mode !== "multi") {
    const injectedStores = {
      auditStore: Boolean(inputs.auditStore),
      policyStore: Boolean(inputs.policyStore),
      capabilityLedger: Boolean(inputs.capabilityLedger),
    };
    const storeCount =
      Number(injectedStores.auditStore) +
      Number(injectedStores.policyStore) +
      Number(injectedStores.capabilityLedger);
    if (storeCount > 0 && storeCount < 3) {
      const missing = Object.entries(injectedStores)
        .filter(([_, present]) => !present)
        .map(([name]) => name);
      const present = Object.entries(injectedStores)
        .filter(([_, present]) => present)
        .map(([name]) => name);
      console.warn(
        `[seepient] WARNING: Partial state store injection detected. ` +
          `Injected: [${present.join(", ")}]. Missing: [${missing.join(", ")}]. ` +
          `Missing stores will fall back to local disk at ~/.seepient or ./.seepient. ` +
          `For fully stateless worker execution, all three permission stores (auditStore, policyStore, capabilityLedger) must be injected.`,
      );
    }
    return;
  }

  if (!inputs.runtime) {
    throw new TenancyRuntimeRequiredError();
  }

  const missing: string[] = [];

  if (!inputs.auditStore) missing.push("auditStore");
  if (!inputs.policyStore) missing.push("policyStore");
  if (!inputs.capabilityLedger) missing.push("capabilityLedger");

  if (inputs.isSessionful && !inputs.persist && !inputs.stateless) {
    missing.push("persist");
  }

  if (missing.length > 0) {
    throw new TenancyStoreIncompleteError(missing);
  }
}

let noticePrinted = false;

/**
 * Emits the one-time tenancy upgrade notice to stderr/console.warn if upgraded is true.
 */
export function emitTenancyNoticeOnce(upgraded: boolean): void {
  if (!upgraded || noticePrinted) return;
  noticePrinted = true;
  console.warn(
    `[seepient] Notice: Tenancy mode automatically upgraded to "multi" based on injected state. ` +
      `To run in single-user mode explicitly, pass tenancy: "single".`,
  );
}

export function resetTenancyNoticeForTest(): void {
  noticePrinted = false;
}
