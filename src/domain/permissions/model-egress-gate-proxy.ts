/**
 * Model-egress gate proxy — re-exports ModelEgressGate from the capabilities
 * layer so the agent-loop (Domain) can use it without importing capabilities
 * directly (which would violate the layer rule). The actual gate lives in
 * capabilities/execution/model-egress-gate.ts.
 *
 * Product purpose: when a tool reads a secret file (.ssh/id_rsa, .env, etc.),
 * the gate blocks that content from reaching the AI provider. The output is
 * replaced with a redaction notice.
 */
export { ModelEgressGate, IMMUTABLE_DENY_CLASSES } from "../../capabilities/execution/model-egress-gate.js";
