import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts", "test/unit/**/*.test.tsx", "test/node/**/*.test.ts"],
    globalSetup: ["test/node/build-dist.ts"],
    environment: "node",
    testTimeout: 60_000,
    pool: "forks",
  },
});
