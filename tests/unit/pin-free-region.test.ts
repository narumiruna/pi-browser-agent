import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"
import { parseRuntimeRequest, RUNTIME_METHODS } from "../../src/browser/runtime/messages.js"

test("shipping sources have no point-comment files, types, messages, catalogs, or controls", async () => {
  const root = fileURLToPath(new URL("../../src/", import.meta.url))
  const paths = await readdir(root, { recursive: true, withFileTypes: true })
  const files = paths.filter((path) => path.isFile())
  expect(files.length).toBeGreaterThan(0)
  for (const file of files) {
    const path = join(file.parentPath, file.name)
    expect(path).not.toMatch(/point.comments/i)
    const source = await readFile(path, "utf8")
    expect(source, path).not.toMatch(
      /PointComments|pointComments|point-comments|point-comment|Comment on elements/,
    )
  }
  expect(RUNTIME_METHODS.some((method) => method.startsWith("pointComments."))).toBe(false)
})

test.each(["start", "remove", "reselect", "clear", "stop"] as const)(
  "pointComments.%s is unsupported, not a dormant runtime method",
  (method) => {
    const clientId = "11111111-1111-4111-8111-111111111111"
    const id = "22222222-2222-4222-8222-222222222222"
    const params = {
      start: { clientId, capacity: 5, nextNumber: 1 },
      remove: { clientId, id },
      reselect: { clientId, id, number: 1 },
      clear: { clientId },
      stop: { clientId },
    }[method]
    expect(() =>
      parseRuntimeRequest({
        kind: "request",
        requestId: "unsupported",
        method: `pointComments.${method}`,
        params,
      }),
    ).toThrow("Malformed or unknown")
  },
)
