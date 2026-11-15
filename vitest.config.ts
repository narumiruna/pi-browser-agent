import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.{ts,js}", "tests/integration/**/*.test.{ts,js}"],
    testTimeout: 15_000,
  },
})
