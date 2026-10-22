import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const describeFast = process.env.VERIFY_PROVIDERS ? describe.skip : describe;
const itOffline = process.env.VERIFY_DATABASE ? it.skip : it;

describeFast("pnpm test emulator pin", () => {
  it("forces scripted runtime, fake sandbox, and in-memory wakeup", () => {
    expect(process.env.AGENT_RUNTIME).toBe("seepient");
    expect(process.env.SEEPIENTS_SCRIPTED_VOICE).toBe("1");
    expect(process.env.SANDBOX_PROVIDER).toBe("fake");
    expect(process.env.WAKEUP_DRIVER).toBe("memory");
  });

  it("does not keep a live Composio key in the test process", () => {
    expect(process.env.COMPOSIO_API_KEY).toBeUndefined();
    expect(process.env.INTEGRATIONS_CATALOG_URL).toBeUndefined();
  });

  itOffline(
    "does not connect to an inherited database without an explicit integration flag",
    () => {
      expect(process.env.DATABASE_URL).toBeUndefined();
      expect(process.env.REALTIME_DATABASE_URL).toBeUndefined();
    },
  );

  it("exposes one test command family and no leftover verify/e2e aliases", () => {
    const pkg = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, "../../../package.json"), "utf8"),
    ) as {
      scripts: Record<string, string>;
    };
    // The Seepient root gates vitest behind build + typecheck (the imported
    // Rakazo layout had a bare "vitest run"); the harness entrypoints are
    // invoked directly from the testkit package (no root aliases).
    expect(pkg.scripts.test).toContain("vitest run");
    expect(pkg.scripts["test:integration"]).toBeUndefined();
    expect(pkg.scripts["test:e2e"]).toBeUndefined();
    expect(pkg.scripts["test:topology"]).toBeUndefined();
    expect(pkg.scripts["test:canary"]).toBeUndefined();
    expect(pkg.scripts["test:computer"]).toBeUndefined();
    expect(pkg.scripts.verify).toBeUndefined();
    expect(pkg.scripts["verify:fast"]).toBeUndefined();
    expect(pkg.scripts["verify:providers"]).toBeUndefined();
    expect(pkg.scripts.e2e).toBeUndefined();
    expect(pkg.scripts["e2e:computer"]).toBeUndefined();
    expect(pkg.scripts["canary:providers"]).toBeUndefined();
  });
});
