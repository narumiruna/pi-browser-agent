import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

const temporaryDirectories: string[] = []

async function artifactFixture(options: {
  bookmarkCode?: string
  bookmarksRequired?: boolean
  screenshotPermissionOmitted?: boolean
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-browser-agent-artifact-audit-"))
  temporaryDirectories.push(root)
  await mkdir(join(root, "icons"))
  await mkdir(join(root, "background"))
  await mkdir(join(root, "nested", "deep"), { recursive: true })
  await writeFile(join(root, "icons", "icon.png"), "icon")
  await writeFile(join(root, "background", "service_worker.js"), "")
  await writeFile(join(root, "nested", "deep", "chunk.js"), options.bookmarkCode ?? "")
  const requiredPermissions = [
    "activeTab",
    "contextMenus",
    "scripting",
    "sidePanel",
    "storage",
    "tabs",
    ...(options.bookmarksRequired ? ["bookmarks"] : []),
  ]
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Audit fixture",
      version: "1.0.0",
      icons: { 16: "icons/icon.png" },
      action: { default_icon: { 16: "icons/icon.png" } },
      permissions: requiredPermissions,
      optional_permissions: options.bookmarksRequired ? [] : ["bookmarks"],
      optional_host_permissions: [
        "https://auth.openai.com/*",
        "https://chatgpt.com/*",
        "http://*/*",
        "https://*/*",
        ...(options.screenshotPermissionOmitted ? [] : ["<all_urls>"]),
      ],
    }),
  )
  return root
}

function audit(root: string) {
  return spawnSync(process.execPath, [resolve("scripts/audit-artifact.mjs")], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, PI_BROWSER_AGENT_ARTIFACT_ROOT: root },
  })
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

describe("production artifact permission policy", () => {
  test("accepts optional read-only bookmark access", async () => {
    const result = audit(await artifactFixture({}))
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("Artifact audit passed")
  })

  test("requires screenshot access to remain an optional host permission", async () => {
    const result = audit(await artifactFixture({ screenshotPermissionOmitted: true }))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("missing optional host <all_urls>")
  })

  test("rejects bookmarks as a required permission", async () => {
    const result = audit(await artifactFixture({ bookmarksRequired: true }))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("unexpected permission bookmarks")
    expect(result.stderr).toContain("missing optional permission bookmarks")
  })

  test("rejects bookmark mutation calls in nested artifact files", async () => {
    const result = audit(
      await artifactFixture({ bookmarkCode: "chrome.bookmarks.create({ title: 'nope' })" }),
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("bookmark mutation call")
  })
})
