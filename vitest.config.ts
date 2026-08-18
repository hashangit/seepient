import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/*.test.{ts,tsx}", "tests/conformance/**/*.spec.{ts,tsx}"],
    setupFiles: ["src/test-setup.ts"],
  },
});
