import { expect, test } from "@playwright/test"
import { launchExtensionHarness } from "./support/extension-harness.js"
import { CODEX_RESPONSES_URL } from "./support/mock-codex.js"

test.setTimeout(120_000)

const STORAGE_KEY = "piBrowserAgentSkillsV1"

test("deleting an installed skill preserves the unimported review and settings draft warning", async () => {
  const harness = await launchExtensionHarness()
  try {
    const requests: string[] = []
    await harness.context.route(CODEX_RESPONSES_URL, async (route) => {
      requests.push(route.request().postData() ?? "")
      await route.fulfill({ status: 500, body: "Unexpected provider request" })
    })
    const original = {
      id: "00000000-0000-4000-8000-000000000001",
      name: "installed-skill",
      description: "Installed fixture",
      body: "Installed body",
      enabled: false,
    }
    await harness.controller.evaluate(
      async ({ key, record }) => {
        await chrome.storage.local.set({ [key]: { version: 1, records: [record] } })
      },
      { key: STORAGE_KEY, record: original },
    )
    const page = await harness.context.newPage()
    await page.goto(`${harness.controller.url()}?view=settings`)
    await page.getByRole("tab", { name: "Skills", exact: true }).click()
    const list = page.getByRole("list", { name: "Installed skills", exact: true })
    const file = page.locator("#skills-file-input")
    const review = page.locator("#skills-review")
    const preview = page.locator("#skills-preview")
    const importButton = page.locator("#skills-import-reviewed")
    const draftStatus = page.locator("#settings-draft-status")
    await list.getByRole("button", { name: /installed-skill/ }).click()
    const body = "Preserve this reviewed body.\nReview scripts/task.py as text."
    await file.setInputFiles({
      name: "SKILL.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(`---\nname: reviewed-skill\ndescription: Reviewed fixture\n---\n${body}`),
    })
    await expect(review).toBeVisible()
    await expect(preview).toContainText(body)
    await expect(preview).toContainText("Compatibility warnings:")
    await expect(importButton).toBeEnabled()
    await expect(draftStatus).toHaveText("Skill review not imported")
    const reviewedPreview = await preview.textContent()

    await page.locator("#skills-delete").click()
    await expect(page.locator("#skills-delete-name")).toHaveText(original.name)
    await expect(page.locator("#skills-cancel-delete")).toBeFocused()
    await page.locator("#skills-cancel-delete").click()
    await expect(page.locator("#skills-delete-dialog")).toBeHidden()
    await expect(list.getByRole("listitem")).toHaveCount(1)
    await expect(preview).toHaveText(reviewedPreview ?? "")
    await expect(draftStatus).toHaveText("Skill review not imported")

    await page.locator("#skills-delete").click()
    await page.locator("#skills-confirm-delete").click()
    await expect(page.locator("#skills-status")).toContainText("Skill deleted")
    await expect(list.getByRole("listitem")).toHaveCount(0)
    await expect(page.locator("#skills-installed-controls")).toBeHidden()
    await expect(file).toBeFocused()
    await expect(review).toBeVisible()
    await expect(preview).toHaveText(reviewedPreview ?? "")
    await expect(importButton).toBeVisible()
    await expect(importButton).toBeEnabled()
    await expect(page.locator("#skills-replace-reviewed")).toBeHidden()
    await expect(draftStatus).toHaveText("Skill review not imported")
    await expect(page.locator("#save-settings")).toBeDisabled()

    await page.locator("#cancel-settings").click()
    await expect(page.locator("#settings-confirm-dialog")).toBeVisible()
    await page.locator("#settings-confirm-cancel").click()
    await expect(preview).toHaveText(reviewedPreview ?? "")
    await importButton.click()
    await expect(page.locator("#skills-status")).toContainText("Skill imported disabled")
    await expect(list.getByRole("button", { name: /reviewed-skill/ })).toBeFocused()
    await expect(review).toBeHidden()
    await expect(draftStatus).toBeEmpty()
    expect(
      await page.evaluate(async (key) => (await chrome.storage.local.get(key))[key], STORAGE_KEY),
    ).toEqual({
      version: 1,
      records: [
        {
          id: expect.any(String),
          name: "reviewed-skill",
          description: "Reviewed fixture",
          body,
          enabled: false,
        },
      ],
    })
    expect(requests).toEqual([])
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("Skills separates review from the keyboard-accessible installed list and preserves focus", async () => {
  const harness = await launchExtensionHarness()
  try {
    const requests: string[] = []
    await harness.context.route(CODEX_RESPONSES_URL, async (route) => {
      requests.push(route.request().postData() ?? "")
      await route.fulfill({ status: 500, body: "Unexpected provider request" })
    })
    const page = await harness.context.newPage()
    await page.goto(`${harness.controller.url()}?view=settings`)
    await page.getByRole("tab", { name: "Skills", exact: true }).click()
    const list = page.getByRole("list", { name: "Installed skills", exact: true })
    const file = page.locator("#skills-file-input")
    const review = page.locator("#skills-review")
    const installed = page.locator("#skills-installed-controls")
    const replace = page.locator("#skills-replace-reviewed")
    await expect(file).toBeEnabled()
    await expect(list).toBeAttached()
    await expect(list.getByRole("listitem")).toHaveCount(0)
    await expect(page.locator("#skills-empty")).toBeVisible()
    await expect(installed).toBeHidden()
    await expect(review).toBeHidden()
    await expect(page.locator("#skills-import-reviewed")).toBeHidden()
    await expect(replace).toBeHidden()
    await file.focus()
    await expect(file).toBeFocused()

    const body = "<script>window.skillInjected=true</script>\nReview scripts/task.py as text."
    await file.setInputFiles({
      name: "SKILL.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(`---\nname: reviewed-only\ndescription: Review fixture\n---\n${body}`),
    })
    await expect(review).toBeVisible()
    await expect(page.locator("#skills-preview")).toContainText(body)
    await expect(page.locator("#skills-preview")).toContainText("Compatibility warnings:")
    await expect(page.locator("#skills-preview script")).toHaveCount(0)
    await expect(page.locator("#skills-import-reviewed")).toBeVisible()
    await expect(replace).toBeHidden()
    await expect(list.getByRole("listitem")).toHaveCount(0)

    const description = '<img src=x onerror="window.skillInjected=true">'.padEnd(512, "x")
    const records = Array.from({ length: 20 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      name: `skill-${index}-${"x".repeat(50)}`,
      description,
      body: `Installed body ${index}`,
      enabled: false,
    }))
    await harness.controller.evaluate(
      async ({ key, records }) => {
        await chrome.storage.local.set({ [key]: { version: 1, records } })
      },
      { key: STORAGE_KEY, records },
    )
    await expect(list.getByRole("listitem")).toHaveCount(20)
    await expect(installed).toBeHidden()
    await expect(replace).toBeHidden()
    const buttons = list.getByRole("button")
    const first = buttons.nth(0)
    const second = buttons.nth(1)
    await expect(first).toContainText(records[0]?.name ?? "")
    await expect(first).toContainText(description)
    await expect(first).toContainText("Disabled")
    await expect(list.locator("img, script, svg, select")).toHaveCount(0)
    await first.focus()
    await page.keyboard.press("Tab")
    await expect(second).toBeFocused()
    await page.keyboard.press("Space")
    await expect(second).toHaveAttribute("aria-pressed", "true")
    await expect(first).toHaveAttribute("aria-pressed", "false")
    await expect(page.locator("#skills-selected-name")).toHaveText(records[1]?.name ?? "")
    await expect(installed).toBeVisible()
    await expect(replace).toBeVisible()
    await expect(list).toBeVisible()
    await first.focus()
    await page.keyboard.press("Enter")
    await expect(first).toHaveAttribute("aria-pressed", "true")
    await expect(page.locator("#skills-selected-name")).toHaveText(records[0]?.name ?? "")

    const original = records[0]
    if (!original) throw new Error("Missing installed fixture")
    records[0] = { ...original, enabled: true }
    await harness.controller.evaluate(
      async ({ key, records }) => {
        await chrome.storage.local.set({ [key]: { version: 1, records } })
      },
      { key: STORAGE_KEY, records },
    )
    await expect(first).toContainText("Enabled")
    await expect(first).toBeFocused()
    await expect(first).toHaveAttribute("aria-pressed", "true")
    await expect(page.locator("#skills-enabled")).toBeChecked()
    await expect(page.locator("#skills-preview")).toContainText(body)
    await file.focus()
    records[0] = { ...original, enabled: false }
    await harness.controller.evaluate(
      async ({ key, records }) => {
        await chrome.storage.local.set({ [key]: { version: 1, records } })
      },
      { key: STORAGE_KEY, records },
    )
    await expect(first).toContainText("Disabled")
    await expect(file).toBeFocused()

    await page.setViewportSize({ width: 320, height: 640 })
    await page.getByRole("tab", { name: "Appearance", exact: true }).click()
    await page.locator("#font-size").fill("24")
    await page.getByRole("tab", { name: "Skills", exact: true }).click()
    await first.scrollIntoViewIfNeeded()
    await expect(first).toBeInViewport()
    const geometry = await first.evaluate((button) => {
      const rect = button.getBoundingClientRect()
      return {
        left: rect.left,
        right: rect.right,
        height: rect.height,
        viewport: window.innerWidth,
        pageWidth: document.documentElement.scrollWidth,
      }
    })
    expect(geometry.left).toBeGreaterThanOrEqual(0)
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewport)
    expect(geometry.height).toBeGreaterThanOrEqual(44)
    expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewport)
    expect(
      await page.evaluate(() => (window as Window & { skillInjected?: boolean }).skillInjected),
    ).toBeUndefined()
    expect(requests).toEqual([])
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})
