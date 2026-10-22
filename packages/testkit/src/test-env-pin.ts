// Gate-repair round 2 (P2.8/T048): the env pin T048's tick claimed — applied
// as a real setup file now that testkit's suite actually runs (the old
// vacuous discovery meant this never executed). Mirrors the root
// test-setup's isolation posture plus the governed-runtime pin.
const pins: Record<string, string> = {
  AGENT_RUNTIME: "seepient",
  SEEPIENTS_SCRIPTED_VOICE: "1",
  SANDBOX_PROVIDER: "fake",
  WAKEUP_DRIVER: "memory",
};
for (const [key, value] of Object.entries(pins)) {
  process.env[key] = value;
}
// Live-integration keys must never reach the test process (pin-test-env
// asserts their absence; deleting makes that hold on any host).
delete process.env.COMPOSIO_API_KEY;
delete process.env.INTEGRATIONS_CATALOG_URL;
