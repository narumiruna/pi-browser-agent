import { expect, type Page, type Route, test } from "@playwright/test"
import { type ExtensionHarness, launchExtensionHarness } from "./support/extension-harness.js"
import { CODEX_RESPONSES_URL } from "./support/mock-codex.js"

test.setTimeout(120_000)

const STORAGE_KEY = "piBrowserAgentSkillsV1"
const API = "https://api.github.com"
const PATTERN = `${API}/*`
const COMMIT = "a".repeat(40)
const TREE = "b".repeat(40)
const BLOB = "c".repeat(40)
const PATH = "skills/.curated/example/SKILL.md"
const NAME = "github-review"
const DESCRIPTION = "Review the café safely."
const BODY =
  "<script>window.skillInjected=true</script>\nReview scripts/task.py and references/guide.md as text.\n"

type SkillRecord = { id: string; name: string; description: string; body: string; enabled: boolean }
type PermissionState = {
  granted: boolean
  allowed: boolean
  requests: chrome.permissions.Permissions[]
  revoke: () => void
}
type TestWindow = typeof window & { githubPermissions: PermissionState; skillInjected?: boolean }

function source(body = BODY): string {
  return `---\nname: ${NAME}\ndescription: >-\n  Review the café\n  safely.\nlicense: MIT\ncompatibility: Requires a local Python interpreter\nmetadata:\n  author: synthetic-review-author\nallowed-tools: Read\n---\n${body}`
}

async function records(page: Page): Promise<SkillRecord[]> {
  return page.evaluate(async (key) => {
    const value = (await chrome.storage.local.get(key))[key] as
      | { records: SkillRecord[] }
      | undefined
    return value?.records ?? []
  }, STORAGE_KEY)
}

async function seed(page: Page, value: SkillRecord[]): Promise<void> {
  await page.evaluate(
    async ({ key, value }) => {
      await chrome.storage.local.set({ [key]: { version: 1, records: value } })
    },
    { key: STORAGE_KEY, value },
  )
}

async function settingsPage(harness: ExtensionHarness): Promise<Page> {
  const page = await harness.context.newPage()
  // Mock browser APIs only in the test page. Never modify the built extension.
  await page.addInitScript(
    ({ pattern }) => {
      const removed = new Set<(permissions: chrome.permissions.Permissions) => void>()
      const state: PermissionState = {
        granted: true,
        allowed: true,
        requests: [],
        revoke: () => {
          state.allowed = false
          for (const listener of removed) listener({ origins: [pattern] })
        },
      }
      ;(window as TestWindow).githubPermissions = state
      const contains = chrome.permissions.contains.bind(chrome.permissions)
      const request = chrome.permissions.request.bind(chrome.permissions)
      chrome.permissions.contains = (async (value) =>
        value.origins?.includes(pattern)
          ? state.allowed
          : contains(value)) as typeof chrome.permissions.contains
      chrome.permissions.request = (async (value) => {
        state.requests.push(value)
        return value.origins?.includes(pattern) ? state.granted : request(value)
      }) as typeof chrome.permissions.request
      chrome.permissions.onRemoved.addListener = (listener) => {
        removed.add(listener)
      }
      chrome.permissions.onRemoved.removeListener = (listener) => {
        removed.delete(listener)
      }
    },
    { pattern: PATTERN },
  )
  await page.goto(`${harness.controller.url()}?view=settings`)
  await page.getByRole("tab", { name: "Skills", exact: true }).click()
  await expect(page.locator("#skills-github-repository")).toBeEnabled()
  return page
}

async function fulfill(route: Route, text = source(), path = PATH): Promise<void> {
  const url = route.request().url()
  const bytes = Buffer.from(text, "utf8")
  const value = url.endsWith("/commits?per_page=1")
    ? [
        {
          sha: COMMIT,
          commit: { tree: { sha: TREE }, message: "Default branch is release, not main" },
        },
      ]
    : url.endsWith(`/git/trees/${TREE}?recursive=1`)
      ? {
          sha: TREE,
          truncated: false,
          tree: [{ path, mode: "100644", type: "blob", sha: BLOB, size: bytes.length }],
        }
      : url.endsWith(`/git/blobs/${BLOB}`)
        ? { sha: BLOB, encoding: "base64", size: bytes.length, content: bytes.toString("base64") }
        : undefined
  expect(value, `Unexpected GitHub endpoint: ${url}`).toBeDefined()
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(value),
  })
}

async function find(page: Page, repository = "openai/skills"): Promise<void> {
  await page.locator("#skills-github-repository").fill(repository)
  await page.getByRole("button", { name: "Find GitHub skills", exact: true }).click()
  await expect(page.locator("#skills-github-results")).toBeVisible()
  await expect(page.locator("#skills-github-candidates")).toBeEnabled()
  await expect(page.locator("#skills-github-candidates")).toHaveValue("")
  await expect(page.locator("#skills-github-review")).toBeDisabled()
}

async function review(page: Page, path = PATH): Promise<void> {
  await page.locator("#skills-github-candidates").selectOption(path)
  await page.getByRole("button", { name: "Review selected GitHub skill", exact: true }).click()
  await expect(page.locator("#skills-preview")).toContainText("Original SKILL.md:")
  await expect(page.locator("#skills-import-reviewed")).toBeEnabled()
}

async function blockModelRequests(harness: ExtensionHarness): Promise<string[]> {
  const requests: string[] = []
  await harness.context.route(CODEX_RESPONSES_URL, async (route) => {
    requests.push(route.request().url())
    await route.fulfill({ status: 500, body: "Unexpected model request" })
  })
  return requests
}

test("nested GitHub skill review is plain text and imports only an explicit disabled snapshot; replacement keeps its ID", async () => {
  const harness = await launchExtensionHarness({ screenshots: true })
  try {
    const modelRequests = await blockModelRequests(harness)
    const requests: string[] = []
    let text = source()
    await harness.context.route(`${API}/**`, async (route) => {
      requests.push(route.request().url())
      expect(route.request().headers().authorization).toBeUndefined()
      expect(route.request().headers().cookie).toBeUndefined()
      await fulfill(route, text)
    })
    const page = await settingsPage(harness)
    // A broad screenshot grant alone cannot start GitHub discovery.
    expect(requests).toEqual([])
    expect(await page.evaluate(() => (window as TestWindow).githubPermissions.requests)).toEqual([])
    await find(page)
    expect(requests).toEqual([
      `${API}/repos/openai/skills/commits?per_page=1`,
      `${API}/repos/openai/skills/git/trees/${TREE}?recursive=1`,
    ])
    expect(await records(page)).toEqual([])
    await expect(page.locator("#skills-review")).toBeHidden()
    await page.locator("#skills-github-candidates").selectOption(PATH)
    await expect(page.locator("#skills-github-review")).toBeEnabled()
    await expect(page.locator("#skills-review")).toBeHidden()
    expect(requests).toHaveLength(2)
    await review(page)
    const preview = page.locator("#skills-preview")
    for (const value of [
      source(),
      "openai/skills",
      PATH,
      COMMIT,
      DESCRIPTION,
      "synthetic-review-author",
      "not available",
    ]) {
      await expect(preview).toContainText(value)
    }
    await expect(preview.locator("script, img")).toHaveCount(0)
    await expect(page.locator("#skills-source-link")).toHaveAttribute(
      "href",
      `https://github.com/openai/skills/blob/${COMMIT}/${PATH}`,
    )
    expect(await records(page)).toEqual([])
    expect(modelRequests).toEqual([])
    expect(requests).toHaveLength(3)
    expect(await page.evaluate(() => (window as TestWindow).githubPermissions.requests)).toEqual([
      { origins: [PATTERN] },
    ])
    await page.locator("#skills-import-reviewed").click()
    await expect(page.locator("#skills-status")).toContainText("imported disabled")
    const installed = (await records(page))[0]
    expect(installed).toEqual({
      id: expect.any(String),
      name: NAME,
      description: DESCRIPTION,
      body: BODY,
      enabled: false,
    })
    if (!installed) throw new Error("Missing imported skill")
    expect(
      await page.evaluate(async (key) => (await chrome.storage.local.get(key))[key], STORAGE_KEY),
    ).toEqual({ version: 1, records: [installed] })
    expect(requests).toHaveLength(3)
    await page.locator("#skills-enabled").check()
    await expect(page.locator("#skills-status")).toContainText("enabled for the next run")
    text = source("Replacement snapshot body.\n")
    await find(page)
    await review(page)
    const reviewed = await preview.textContent()
    await page.locator("#skills-import-reviewed").click()
    await expect(page.locator("#skills-status")).toContainText("explicit replacement")
    expect(await records(page)).toEqual([{ ...installed, enabled: true }])
    await expect(preview).toHaveText(reviewed ?? "")
    await page.locator("#skills-replace-reviewed").click()
    await expect(page.locator("#skills-status")).toContainText("replaced and disabled")
    expect(await records(page)).toEqual([
      { ...installed, body: "Replacement snapshot body.\n", enabled: false },
    ])
    await expect(page.locator("#skills-enabled")).not.toBeChecked()
    expect(requests).toHaveLength(6)
    expect(modelRequests).toEqual([])
    expect(await page.evaluate(() => (window as TestWindow).skillInjected)).toBeUndefined()
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("GitHub import quota failure preserves the complete review and existing storage", async () => {
  const harness = await launchExtensionHarness()
  try {
    const modelRequests = await blockModelRequests(harness)
    const installed = Array.from({ length: 20 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      name: `installed-${index}`,
      description: "Installed fixture",
      body: "Original body",
      enabled: false,
    }))
    await seed(harness.controller, installed)
    let count = 0
    await harness.context.route(`${API}/**`, async (route) => {
      count++
      await fulfill(route)
    })
    const page = await settingsPage(harness)
    await find(page)
    await review(page)
    const preview = await page.locator("#skills-preview").textContent()
    await page.locator("#skills-import-reviewed").click()
    await expect(page.locator("#skills-status")).toContainText("Installed skill limit")
    await expect(page.locator("#skills-preview")).toHaveText(preview ?? "")
    await expect(page.locator("#skills-import-reviewed")).toBeEnabled()
    expect(await records(page)).toEqual(installed)
    expect(count).toBe(3)
    expect(modelRequests).toEqual([])
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("cancel and source changes reject delayed GitHub responses without overwriting a newer review", async () => {
  const harness = await launchExtensionHarness()
  const held: Route[] = []
  try {
    const modelRequests = await blockModelRequests(harness)
    await harness.context.route(`${API}/**`, async (route) => {
      if (
        route.request().url().includes("/git/blobs/") &&
        !route.request().url().includes("/new-source/")
      ) {
        held.push(route)
        return
      }
      await fulfill(route)
    })
    const page = await settingsPage(harness)
    await find(page)
    await page.locator("#skills-github-candidates").selectOption(PATH)
    await page.locator("#skills-github-review").click()
    await expect.poll(() => held.length).toBe(1)
    await page.getByRole("button", { name: "Cancel fetch", exact: true }).click()
    await expect(page.locator("#skills-status")).toContainText("cancelled")
    await expect(page.locator("#skills-github-cancel")).toBeHidden()
    await expect(page.locator("#skills-review")).toBeHidden()
    expect(await records(page)).toEqual([])

    await page.locator("#skills-github-review").click()
    await expect.poll(() => held.length).toBe(2)
    await page.locator("#skills-github-repository").fill("example/new-source")
    await expect(page.locator("#skills-github-results")).toBeHidden()
    await expect(page.locator("#skills-github-fetch")).toBeEnabled()
    await find(page, "example/new-source")
    await review(page)
    await expect(page.locator("#skills-preview")).toContainText("example/new-source")
    const current = await page.locator("#skills-preview").textContent()
    for (const route of held.splice(0)) await fulfill(route).catch(() => undefined)
    await expect(page.locator("#skills-preview")).toHaveText(current ?? "")
    expect(await records(page)).toEqual([])
    expect(modelRequests).toEqual([])
    expect(harness.pageErrors).toEqual([])
  } finally {
    for (const route of held) await route.abort().catch(() => undefined)
    await harness.close()
  }
})

test("GitHub denial makes no request; root/default-branch review requires access again after revocation", async () => {
  const harness = await launchExtensionHarness({ screenshots: true })
  try {
    const modelRequests = await blockModelRequests(harness)
    const requests: string[] = []
    await harness.context.route(`${API}/**`, async (route) => {
      requests.push(route.request().url())
      await fulfill(route, source(), "SKILL.md")
    })
    const page = await settingsPage(harness)
    await page.evaluate(() => {
      ;(window as TestWindow).githubPermissions.granted = false
    })
    await page.locator("#skills-github-repository").fill("example/release-branch")
    await page.locator("#skills-github-fetch").click()
    await expect(page.locator("#skills-status")).toContainText("not granted")
    expect(requests).toEqual([])
    await expect(page.locator("#skills-file-input")).toBeEnabled()
    await page.evaluate(() => {
      ;(window as TestWindow).githubPermissions.granted = true
    })
    await find(page, "example/release-branch")
    expect(requests).toEqual([
      `${API}/repos/example/release-branch/commits?per_page=1`,
      `${API}/repos/example/release-branch/git/trees/${TREE}?recursive=1`,
    ])
    await review(page, "SKILL.md")
    await expect(page.locator("#skills-source-link")).toHaveAttribute(
      "href",
      `https://github.com/example/release-branch/blob/${COMMIT}/SKILL.md`,
    )
    await page.locator("#skills-import-reviewed").click()
    await expect(page.locator("#skills-status")).toContainText("imported disabled")
    const installed = await records(page)
    await page.evaluate(() => {
      ;(window as TestWindow).githubPermissions.revoke()
    })
    await page.locator("#skills-github-review").click()
    await expect(page.locator("#skills-status")).toContainText("host approval is required")
    expect(requests).toHaveLength(3)
    expect(await records(page)).toEqual(installed)
    await expect(page.locator("#skills-review")).toBeHidden()
    expect(modelRequests).toEqual([])
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})
