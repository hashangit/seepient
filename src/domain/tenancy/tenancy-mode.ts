/**
 * Spec 022 — Tenancy Mode & Fail-Closed Validation (contracts/tenancy-mode.md).
 */
import {
  SeepientError,
  PrincipalRequiredError,
  InvalidPrincipalIdError,
  TenancyWorkspaceRequiredError,
} from "../../foundations/errors.js";

export { PrincipalRequiredError, InvalidPrincipalIdError, TenancyWorkspaceRequiredError };

export type TenancyMode = "single" | "multi";

export const PRINCIPAL_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

export const SENTINEL_PRINCIPAL_IDS = new Set(["sdk-user", "default", "anonymous", "cli-user"]);

export interface TenancySignals {
  explicit?: TenancyMode;
  principalIdSet?: boolean;
  anyStoreInjected?: boolean;
  runtimeInjected?: boolean;
  persistInjected?: boolean;
  /** Injected non-literal skill sources only; inline literals never set this (FR-016, M5). */
  skillSourcesInjected?: boolean;
  credentialsInjected?: boolean;
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
      'Multi-tenant mode requires an isolated ProviderRuntime (isIsolated: true). ' +
      'Construct your runtime with createIsolatedProviderRuntime() or default new ProviderRuntime(). ' +
      'Do not pass an ambient runtime created with createAmbientProviderRuntime(). ' +
      'Or set tenancy: "single" if running in a single-user environment.';
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
      signals.skillSourcesInjected ||
      signals.credentialsInjected,
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
  principalId?: string;
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
    } else if (storeCount === 3 || inputs.runtime) {
      // Explicit-single with fully injected state is usually a mis-set
      // tenancy flag: ambient host state (skills, settings, credential
      // fallback) still composes in single mode (pass-10 P1-5).
      console.warn(
        `[seepient] WARNING: State was injected but tenancy mode is explicitly "single" — ambient host state (skills, settings, secrets fallback) still composes. ` +
          `If this instance serves tenants, pass tenancy: "multi" with a principalId.`,
      );
    }
    return;
  }


  // FR-020 & FR-011: principalId is checked FIRST in multi mode before runtime or store completeness
  const rawPrincipal = inputs.principalId;
  if (!rawPrincipal || typeof rawPrincipal !== "string" || rawPrincipal.trim().length === 0) {
    throw new PrincipalRequiredError();
  }
  const trimmed = rawPrincipal.trim();
  if (SENTINEL_PRINCIPAL_IDS.has(trimmed.toLowerCase())) {
    throw new InvalidPrincipalIdError(
      `INVALID_PRINCIPAL_ID: principalId "${trimmed}" is a reserved sentinel value. Use an explicit tenant principal.`,
    );
  }
  if (!PRINCIPAL_ID_RE.test(trimmed)) {
    throw new InvalidPrincipalIdError(
      `INVALID_PRINCIPAL_ID: principalId "${trimmed}" must match /^[a-zA-Z0-9_-]{1,128}$/.`,
    );
  }

  if (!inputs.runtime) {
    throw new TenancyRuntimeRequiredError();
  }

  const runtimeAny = inputs.runtime as any;
  if (
    runtimeAny.isIsolated !== true ||
    (runtimeAny.configStore && runtimeAny.configStore.isIsolated !== true) ||
    (runtimeAny.credentialStore && runtimeAny.credentialStore.isIsolated !== true)
  ) {
    throw new TenancyRuntimeRequiredError(
      'Multi-tenant mode requires an isolated ProviderRuntime (isIsolated: true) and isolated sub-stores (configStore, credentialStore). ' +
      'Construct your runtime with createIsolatedProviderRuntime() or default new ProviderRuntime(). ' +
      'Do not pass an ambient runtime created with createAmbientProviderRuntime().'
    );
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

  if (
    (inputs.auditStore as any)?.isIsolated !== true ||
    (inputs.policyStore as any)?.isIsolated !== true ||
    (inputs.capabilityLedger as any)?.isIsolated !== true
  ) {
    throw new TenancyStoreIncompleteError(
      [],
      'Multi-tenant mode requires isolated stores (isIsolated: true). ' +
      'Ambient stores cannot be used in multi-tenant mode.'
    );
  }
}

let noticePrinted = { tenancy: false, credentials: false };

/**
 * Emits the one-time tenancy upgrade notice to stderr/console.warn if upgraded is true.
 */
export function emitTenancyNoticeOnce(upgraded: boolean): void {
  if (!upgraded || noticePrinted.tenancy) return;
  noticePrinted.tenancy = true;
  console.warn(
    `[seepient] Notice: Tenancy mode automatically upgraded to "multi" based on injected state. ` +
      `To run in single-user mode explicitly, pass tenancy: "single".`,
  );
}

export function resetTenancyNoticeForTest(): void {
  noticePrinted = { tenancy: false, credentials: false };
}

/**
 * Emits a warning when credentials or providers are injected in single-user mode (NEW-9).
 */
export function emitCredentialsSingleUserWarningOnce(): void {
  if (noticePrinted.credentials) return;
  noticePrinted.credentials = true;
  console.warn(
    `[seepient] Notice: Running in single-user mode with custom credentials/providers. ` +
      `Ambient ~/.seepient stores and single-user policies will be used. ` +
      `For multi-tenant isolation, pass tenancy: "multi" and inject isolated stores.`,
  );
}
