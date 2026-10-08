/**
 * Shared ProviderRuntime bootstrap for the SDK front doors (spec 027 review
 * round-3 P1-2). `createSeepient`, `createChat` (via `createSeepient`), and
 * `askSeepient` all accept the same providers-record option family and reach
 * the vendor through this one construction — no rung silently drops options
 * another rung teaches.
 */
import type { ProviderRuntimeContract } from "../../foundations/contracts/provider-runtime.js";
import type { CreateSeepientOptions } from "../../foundations/types.js";
import { ProviderConfigStore } from "../../domain/providers/config-store/provider-config-store.js";
import { MemoryCredentialStore } from "../../domain/providers/credentials/memory-credential-store.js";
import { AggregateInferenceAdapter } from "../../capabilities/inference/aggregate-adapter.js";
import { ProviderRuntime, createAmbientProviderRuntime } from "../../domain/providers/provider-runtime.js";

export async function bootstrapProviderRuntime(
  opts: Pick<
    CreateSeepientOptions,
    "runtime" | "providers" | "modelAssignments" | "credentials" | "overlayFile" | "adapter"
  >,
  tenancyMode: "single" | "multi",
): Promise<ProviderRuntimeContract | ProviderRuntime> {
  if (opts.runtime) return opts.runtime;
  if (!(opts.providers || opts.modelAssignments || opts.credentials || opts.overlayFile || opts.adapter)) {
    return createAmbientProviderRuntime();
  }
  const configStore = new ProviderConfigStore(opts.overlayFile ?? ":memory:");
  if (opts.providers || opts.modelAssignments) {
    const currentOverlay = await configStore.getOverlay();
    await configStore.updateOverlay(
      {
        providers: opts.providers as any,
        modelAssignments: opts.modelAssignments as any,
      },
      currentOverlay.revision,
    );
  }
  const credentialStore = opts.credentials ?? new MemoryCredentialStore();
  const adapter = opts.adapter ?? new AggregateInferenceAdapter(undefined, undefined, credentialStore);
  return new ProviderRuntime({
    configStore,
    credentialStore,
    adapter,
    // 022-5-WO3 T007 (D2): the internally-built runtime carries the
    // embed's tenancy stamp — the natural embed shape is egress-armed by
    // construction, not silently single-stamped.
    tenancyMode,
  });
}
