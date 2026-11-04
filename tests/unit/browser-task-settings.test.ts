import { lstat, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"
import {
  loadBrowserSettings,
  publicExtensionId,
  saveBrowserExtensionId,
} from "../../.pi/extensions/browser-tasks/settings.js"

const { rename } = vi.hoisted(() => ({ rename: vi.fn() }))
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>()
  rename.mockImplementation(actual.rename)
  return { ...actual, rename }
})
const directories: string[] = []
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pi-browser-config-"))
  directories.push(directory)
  return { directory, path: join(directory, "pi-browser-agent.json") }
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  vi.clearAllMocks()
})

describe("Browser task user settings", () => {
  test("a missing file reads without creating a directory or file", async () => {
    const env = await fixture()
    const missing = join(env.directory, "missing", "pi-browser-agent.json")
    expect(await loadBrowserSettings(missing)).toEqual({})
    expect(await readdir(env.directory)).toEqual([])
  })

  test("saves only the public ID with an atomic owner-only write and preserves unknown fields", async () => {
    const env = await fixture()
    await writeFile(env.path, JSON.stringify({ unrelated: { keep: true } }))
    await saveBrowserExtensionId(env.path, "a".repeat(32))
    expect(await loadBrowserSettings(env.path)).toEqual({
      unrelated: { keep: true },
      extensionId: "a".repeat(32),
    })
    expect(rename).toHaveBeenCalledOnce()
    expect(await readdir(env.directory)).toEqual(["pi-browser-agent.json"])
    if (process.platform !== "win32") expect((await lstat(env.path)).mode & 0o777).toBe(0o600)
  })

  test.each([
    "{",
    "[]",
    "null",
    '"text"',
    '{"extensionId":null}',
    '{"extensionId":"bad"}',
    " ".repeat(16 * 1024 + 1),
  ])("invalid settings are not overwritten: %s", async (text) => {
    const env = await fixture()
    await writeFile(env.path, text)
    await expect(loadBrowserSettings(env.path)).rejects.toThrow(env.path)
    await expect(saveBrowserExtensionId(env.path, "a".repeat(32))).rejects.toThrow(env.path)
    expect(await readFile(env.path, "utf8")).toBe(text)
    expect(rename).not.toHaveBeenCalled()
  })

  test("a symlink is rejected without changing its target", async () => {
    const env = await fixture()
    const target = join(env.directory, "target.json")
    await writeFile(target, "{}")
    await symlink(target, env.path)
    await expect(saveBrowserExtensionId(env.path, "a".repeat(32))).rejects.toThrow(env.path)
    expect(await readFile(target, "utf8")).toBe("{}")
  })

  test("failed replacement preserves the old settings and removes its temporary file", async () => {
    const env = await fixture()
    const previous = JSON.stringify({ extensionId: "a".repeat(32) })
    await writeFile(env.path, previous)
    rename.mockRejectedValueOnce(new Error("Rename failed"))
    await expect(saveBrowserExtensionId(env.path, "b".repeat(32))).rejects.toThrow(env.path)
    expect(await readFile(env.path, "utf8")).toBe(previous)
    expect(await readdir(env.directory)).toEqual(["pi-browser-agent.json"])
  })

  test.each([
    undefined,
    "",
    "A".repeat(32),
    "a".repeat(31),
    `${"a".repeat(32)}\n`,
    "https://example.org/",
  ])("rejects invalid extension IDs without a write: %s", async (id) => {
    const env = await fixture()
    expect(() => publicExtensionId(id)).toThrow()
    await expect(saveBrowserExtensionId(env.path, id as string)).rejects.toThrow()
    expect(await readdir(env.directory)).toEqual([])
  })
})
