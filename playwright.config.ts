import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  retries: 0,
  timeout: 30_000,
  use: {
    trace: "retain-on-failure",
  },
})
