/**
 * Local boundary builder — Capabilities (spec 008).
 *
 * Builds a LocalExecutionBoundary with the REAL typed executors (commit-files,
 * read-file, process, broker) — NOT the legacy handler. This is the boundary
 * the factory should use for local surfaces (CLI, SDK, server-without-scheduler).
 *
 * Product behavior: when the pipeline approves a write, the write goes through
 * the FileCommitBroker (exact-write enforcement). When it approves a shell
 * command, the command runs through the process executor (sandboxed when
 * available). The old tool handlers are NOT used — the prepared operation IS
 * the operation that executes.
 *
 * For operation kinds that don't have a real executor yet (e.g. broker without
 * a network adapter), the executor is omitted and policy denies that kind
 * (fail closed). No tool silently runs through the old unrestricted handler.
 */
import { LocalExecutionBoundary } from "./local-execution-boundary.js";
import { OperationExecutorRegistry } from "./operation-executor-registry.js";
import { CommitFilesExecutor, ReadFileExecutor, NoneExecutor, BrokerExecutor, TrustedHostExecutor } from "./executors.js";
import { ProcessExecutor } from "./process-executor.js";
import { InMemoryArtifactStore } from "./in-memory-artifact-store.js";
import { FileCommitBroker } from "./file-commit-broker.js";
import { EffectBroker, NodeNetworkAdapter } from "./effect-broker.js";
import { createNativeProcessSandbox } from "../../vendors/sandbox-runtime/index.js";
import { probeCommitHelper, PackagedCommitHelper } from "../../vendors/native-fs-commit/index.js";
import { builtInTools } from "../tools/index.js";
import type { ExecutionBoundary } from "../../foundations/contracts/execution-boundary.js";

export interface BuildLocalBoundaryResult {
  boundary: ExecutionBoundary;
  artifacts: InMemoryArtifactStore;
}

/**
 * Build a local execution boundary with real typed executors for all operations.
 */
export async function buildLocalBoundary(opts?: {
  artifacts?: InMemoryArtifactStore;
  /**
   * Host-callback map for `trusted-host` tools. The composition root (which
   * may import Domain) supplies it; Capabilities must not import Domain
   * (AGENTS.md dependency direction) — the previous `getAllToolModules`
   * import from here violated that rule.
   */
  hostCallbacks?: Map<string, (args: unknown) => Promise<unknown>>;
  unsafeUncontained?: boolean;
  allowFallback?: boolean;
}): Promise<BuildLocalBoundaryResult> {
  const artifacts = opts?.artifacts ?? new InMemoryArtifactStore();

  // Probe the native commit helper. When available → exactCommit:true.
  const probe = await probeCommitHelper();
  const helper = new PackagedCommitHelper(probe);
  const commitBroker = new FileCommitBroker({ artifacts, helper });

  // Process sandbox: probe and instantiate the best native sandbox backend (ASRT/Seatbelt/Bubblewrap).
  const sandbox = await createNativeProcessSandbox();

  // Effect broker for network egress and external calls
  const effectBroker = new EffectBroker({
    artifacts,
    network: new NodeNetworkAdapter(),
  });

  // Host callbacks map for built-in and custom tools (consulted by the
  // TrustedHostExecutor). The composition root owns building this map —
  // Capabilities does not import Domain (AGENTS.md).
  const hostCallbacks = opts?.hostCallbacks ?? new Map<string, (args: unknown) => Promise<unknown>>();

  const registry = new OperationExecutorRegistry();
  registry.register(new NoneExecutor());
  registry.register(new ReadFileExecutor({ artifacts }));
  registry.register(new CommitFilesExecutor({ broker: commitBroker, artifacts, useNative: probe.available, allowFallback: opts?.allowFallback ?? false }));
  // SEEPIENT_UNCONTAINED=1 is the environment form of the explicit opt-out;
  // the SAME value must drive both the executor (which honors it) and the
  // advertised environmentIsolation capability (which policy reads), so an
  // operator who follows the setup message can actually run (review P1).
  const unsafeUncontained = opts?.unsafeUncontained ?? process.env.SEEPIENT_UNCONTAINED === "1";
  registry.register(new ProcessExecutor({ sandbox, unsafeUncontained }));
  registry.register(new BrokerExecutor({ broker: effectBroker }));
  registry.register(new TrustedHostExecutor(hostCallbacks));

  const boundary = new LocalExecutionBoundary({
    registry,
    exactCommit: probe.available,
    hostFilteredEgress: true,
    environmentIsolation: sandbox.probe.backend !== "none" || unsafeUncontained,
  });

  return { boundary, artifacts };
}
