/**
 * `pnpm test` must stay emulator-only even when a developer .env points at
 * Pi, Docker, Graphile, or live Composio. Opt-in canaries set VERIFY_PROVIDERS.
 */
if (!process.env.VERIFY_PROVIDERS) {
  // 029 T048: the required-literal runtime value; deterministic doubles are
  // injected per-rig (ScriptedAgentRuntime), never selected through the env.
  process.env.AGENT_RUNTIME = "seepient";
  process.env.SEEPIENTS_SCRIPTED_VOICE = "1";
  process.env.SANDBOX_PROVIDER = "fake";
  process.env.CLOUD_AGENT_PROVIDER = "emulator";
  delete process.env.CURSOR_API_KEY;
  process.env.WAKEUP_DRIVER = "memory";
  delete process.env.COMPOSIO_API_KEY;
  delete process.env.INTEGRATIONS_CATALOG_URL;
  if (!process.env.VERIFY_DATABASE) {
    delete process.env.DATABASE_URL;
    delete process.env.REALTIME_DATABASE_URL;
  }
}
delete process.env.AXIOM_TOKEN;
delete process.env.AXIOM_DATASET;
if (!process.env.VERIFY_LOGGING) {
  process.env.LOG_LEVEL = "off";
}
