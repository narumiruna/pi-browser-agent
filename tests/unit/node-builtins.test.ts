import { describe, expect, test } from "vitest"
// @ts-expect-error The audited Node script is intentionally plain ESM.
import { containsNodeBuiltinImport } from "../../tooling/node-builtins.mjs"

describe("Node built-in import detection", () => {
  test.each([
    'import "node:fs"',
    'import fs from "node:fs"',
    'import { readFile } from "node:fs/promises"',
    'export { join } from "node:path"',
    'await import("node:crypto")',
    'require("node:os")',
  ])("detects %s", (source) => {
    expect(containsNodeBuiltinImport(source)).toBe(true)
  })

  test("does not reject ordinary browser imports or documentation inside strings", () => {
    expect(containsNodeBuiltinImport('import value from "./browser.js"')).toBe(false)
    expect(
      containsNodeBuiltinImport(
        'throw new Error("Set globalThis.File to `import(\\"node:buffer\\").File`")',
      ),
    ).toBe(false)
  })
})
