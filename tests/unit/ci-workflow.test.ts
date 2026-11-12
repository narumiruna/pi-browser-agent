import { readFile } from "node:fs/promises"
import { expect, test } from "vitest"
import { parse } from "yaml"

test("CI uses a Playwright image that matches the locked browser version", async () => {
  const workflow = parse(await readFile(".github/workflows/ci.yml", "utf8"))
  const lockfile = JSON.parse(await readFile("package-lock.json", "utf8"))
  const version = lockfile.packages["node_modules/playwright-core"].version

  expect(workflow.jobs.ci.container?.image).toBe(`mcr.microsoft.com/playwright:v${version}-noble`)
})
