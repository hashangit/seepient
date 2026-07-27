/**
 * Domain shim — re-exports comm-tool analyzers from Capabilities (spec 008,
 * T008a / D46). The implementation lives in
 * `src/capabilities/tools/comm-analyzers.ts`.
 *
 * Domain never contains `analyze*` function implementations.
 */
export * from "../../capabilities/tools/comm-analyzers.js";
