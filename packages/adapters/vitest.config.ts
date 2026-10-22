import { defineConfig } from "vitest/config";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Same engine-instance rule as the root config: resolve the engine (its
// self-import convention seepient-engine/dist/* and the published `seepient`
// entry points, which are dist-only) back to SOURCE so product tests and the
// engine share one module copy per test process. Test-time only — the
// publish surface (dist-only exports) is untouched.
const src = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");

export default defineConfig({
  resolve: {
    alias: [
      { find: /^seepient-engine\/dist\/(.*)\.js$/, replacement: resolve(src, "$1.ts") },
      { find: /^seepient$/, replacement: resolve(src, "transport/sdk/index.ts") },
      { find: /^seepient\/app-runtime$/, replacement: resolve(src, "transport/app/seepient-agent-runtime.ts") },
      { find: /^seepient\/types$/, replacement: resolve(src, "foundations/types.ts") },
    ],
  },
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 20000,
  },
});
