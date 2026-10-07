import { defineConfig } from "vitest/config";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    // Spec 027: resolve seepient-core/dist/* back to SOURCE for tests — one
    // engine instance per test process. Without this, full-side src files
    // load the engine from packages/core/dist while tests import engine
    // modules from src, and seam registrations land in one copy while the
    // pipeline reads the other. Production emit is untouched; the core
    // artifact's what-ships gate is the tarball e2e (pnpm run qs:core-chat).
    alias: [
      {
        find: /^seepient-core\/dist\/(.*)\.js$/,
        replacement: resolve(dirname(fileURLToPath(import.meta.url)), "src/$1.ts"),
      },
    ],
    include: ["src/**/__tests__/**/*.test.{ts,tsx}", "src/**/__tests__/*.test.{ts,tsx}", "tests/conformance/**/*.spec.{ts,tsx}", "examples/**/__tests__/*.test.{ts,tsx}"],
    setupFiles: ["src/test-setup.ts"],
    testTimeout: 20000,
  },
});
