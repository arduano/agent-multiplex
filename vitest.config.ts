import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "packages/**/*.test.ts"],
    // Archived protocol-v2 source remains as design evidence, but is not a
    // compatibility suite for the maintained v4 workspace.
    exclude: [
      "tests/host-app-config.test.ts",
      "tests/host-app.test.ts",
      "tests/host-core-authority.test.ts",
      "tests/host-core-child-reconnect.test.ts",
      "tests/host-core-metadata-monotonic.test.ts",
      "tests/host-core-topology.test.ts",
      "tests/host-core-v2-service.test.ts",
      "tests/host-core.test.ts",
      "tests/host-parent.test.ts",
      "tests/e2e.test.ts",
      "packages/host-core/**",
    ],
    testTimeout: 15_000,
  },
});
