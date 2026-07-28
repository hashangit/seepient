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
  customToolCallbacks?: Map<string, (args: unknown) => Promise<string>>;
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

  // Host callbacks map for built-in and custom tools (consults tool registry)
  const hostCallbacks = new Map<string, (args: unknown) => Promise<unknown>>();
  const { getAllToolModules } = await import("../../domain/tool-executor.js");
  for (const tool of getAllToolModules()) {
    const fnName = tool.definition.function.name;
    hostCallbacks.set(fnName, async (args: unknown) => {
      return tool.handler(args as any);
    });
  }
  if (opts?.customToolCallbacks) {
    for (const [k, v] of opts.customToolCallbacks.entries()) {
      hostCallbacks.set(k, v);
    }
  }

  const registry = new OperationExecutorRegistry();
  registry.register(new NoneExecutor());
  registry.register(new ReadFileExecutor({ artifacts }));
  registry.register(new CommitFilesExecutor({ broker: commitBroker, artifacts, useNative: probe.available, allowFallback: opts?.allowFallback ?? true }));
  registry.register(new ProcessExecutor({ sandbox, unsafeUncontained: opts?.unsafeUncontained ?? false }));
  registry.register(new BrokerExecutor({ broker: effectBroker }));
  registry.register(new TrustedHostExecutor(hostCallbacks));

  const boundary = new LocalExecutionBoundary({
    registry,
    exactCommit: probe.available,
    hostFilteredEgress: true,
  });

  return { boundary, artifacts };
}
