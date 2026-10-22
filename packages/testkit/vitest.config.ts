import { defineConfig } from "vitest/config";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Gate-repair round 2 (P2.8): testkit's own vitest config. Without it,
// `pnpm --filter @seepients/testkit test` resolved the ROOT config whose
// include matches nothing under packages/testkit — the suite ran ZERO tests
// while every gate (and CI) reported it green. Mirrors the root config's
// source alias so testkit tests exercise the engine from source.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // DB-gated rigs skip without VERIFY_DATABASE; postgres suites need a
    // live database and stay skipped in the default gate (same contract as
    // apps/api).
    setupFiles: ["src/test-env-pin.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: [
      {
        find: /^seepient-engine\/dist\/(.*)\.js$/,
        replacement: resolve(
          dirname(fileURLToPath(import.meta.url)),
          "../../src/$1.ts",
        ),
      },
    ],
  },
});
