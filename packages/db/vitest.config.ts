import { defineConfig } from "vitest/config";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Same engine-instance rule as the root config: resolve the engine's
// self-import convention (seepient-engine/dist/*) back to SOURCE so product
// tests and the engine share one module copy per test process. Test-time
// only — the publish surface (dist-only exports) is untouched.
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^seepient-engine\/dist\/(.*)\.js$/,
        replacement: resolve(dirname(fileURLToPath(import.meta.url)), "../../src/$1.ts"),
      },
    ],
  },
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 20000,
  },
});
