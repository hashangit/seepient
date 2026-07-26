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
import { CommitFilesExecutor } from "./executors.js";
import { ReadFileExecutor } from "./executors.js";
import { ProcessExecutor } from "./process-executor.js";
import { NoneExecutor } from "./executors.js";
import { InMemoryArtifactStore } from "./in-memory-artifact-store.js";
import { FileCommitBroker } from "./file-commit-broker.js";
import { UncontainedSandbox } from "../../vendors/sandbox-runtime/index.js";
import { probeCommitHelper, PackagedCommitHelper } from "../../vendors/native-fs-commit/index.js";
import type { ExecutionBoundary } from "../../foundations/contracts/execution-boundary.js";

export interface BuildLocalBoundaryResult {
  boundary: ExecutionBoundary;
  artifacts: InMemoryArtifactStore;
}

/**
 * Build a local execution boundary with real typed executors.
 *
 * - `commit-files` → CommitFilesExecutor → FileCommitBroker → native helper
 *   (exactCommit:true when helper available, false otherwise — fail closed)
 * - `read-file`    → ReadFileExecutor (reads via canonical path)
 * - `process`      → ProcessExecutor → UncontainedSandbox (honestly reports
 *   isolated:false until a real sandbox backend is wired)
 * - `none`         → NoneExecutor (returns precomputed result)
 *
 * Tools whose analyzers produce `broker` or `trusted-host` operations have no
 * executor registered → policy denies them (backend-unsupported). This is
 * fail-closed: the tool doesn't run through the old handler.
 *
 * The artifact store is SHARED between the analyzer (which stores content)
 * and the executors (which read content). When `artifacts` is provided, that
 * store is used; otherwise a new one is created.
 */
export async function buildLocalBoundary(opts?: {
  artifacts?: InMemoryArtifactStore;
}): Promise<BuildLocalBoundaryResult> {
  const artifacts = opts?.artifacts ?? new InMemoryArtifactStore();

  // Probe the native commit helper. When available → exactCommit:true.
  const probe = await probeCommitHelper();
  const helper = new PackagedCommitHelper(probe);
  const commitBroker = new FileCommitBroker({ artifacts, helper });

  // Process sandbox: UncontainedSandbox honestly reports isolated:false.
  // A real deployment injects Seatbelt/Bubblewrap; tests inject a fake.
  const sandbox = new UncontainedSandbox();

  const registry = new OperationExecutorRegistry();
  registry.register(new NoneExecutor());
  registry.register(new ReadFileExecutor({ artifacts }));
  registry.register(new CommitFilesExecutor({ broker: commitBroker, artifacts, useNative: probe.available }));
  registry.register(new ProcessExecutor({ sandbox }));

  const boundary = new LocalExecutionBoundary({
    registry,
    exactCommit: probe.available,
    hostFilteredEgress: false, // no broker wired → can't claim filtered egress
  });

  return { boundary, artifacts };
}
