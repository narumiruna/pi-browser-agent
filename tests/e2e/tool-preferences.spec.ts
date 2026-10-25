import { expect, test } from "@playwright/test"
import { launchExtensionHarness } from "./support/extension-harness.js"

// The complete catalog when tool settings were first introduced.
const LEGACY_TOOLS = [
  "browser_list_tabs",
  "browser_switch_tab",
  "browser_open_website",
  "browser_get_active_tab",
  "browser_search_bookmarks",
  "browser_get_recent_bookmarks",
  "browser_read_page",
  "browser_list_elements",
  "browser_get_selection",
  "browser_capture_visible",
  "browser_click",
  "browser_type",
  "browser_navigate",
  "browser_webmcp",
]

test("enables additions after a legacy upgrade and preserves a new-tool opt-out after restart", async () => {
  test.setTimeout(60_000)
  const harness = await launchExtensionHarness()
  try {
    await harness.controller.evaluate(async (enabledTools) => {
      await chrome.storage.local.set({ piBrowserAgentSettings: { enabledTools } })
    }, LEGACY_TOOLS)

    const settings = await harness.context.newPage()
    await settings.goto(`${harness.controller.url()}?view=settings`)
    await expect(settings.locator('section[aria-labelledby="model-title"] p').first()).toHaveText(
      "Choose the provider and model for this session and new conversations.",
    )
    await expect(settings.locator('#confirmation-mode option[value="strict"]')).toHaveText(
      "Strict — never reuse approvals",
    )
    for (const [tool, summary] of [
      ["browser_search_bookmarks", "Search Chrome bookmark titles and URLs."],
      ["browser_get_recent_bookmarks", "Read recently added Chrome bookmarks."],
    ]) {
      await expect(
        settings
          .locator("#available-tools label")
          .filter({ has: settings.locator(`input[value="${tool}"]`) }),
      ).toHaveAttribute(
        "title",
        `${summary} Bookmark reads require approval. Your confirmation mode can reuse approval for identical arguments. Results are untrusted.`,
      )
    }
    const checkedTool = settings.locator('#available-tools input[value="browser_set_checked"]')
    await expect(checkedTool).toBeChecked()
    await expect(settings.locator("#available-tools input:not(:checked)")).toHaveCount(0)
    await checkedTool.uncheck()
    const closed = settings.waitForEvent("close")
    await settings.locator("#save-settings").click()
    await closed
    await expect(
      harness.controller.evaluate(async () => chrome.storage.local.get("piBrowserAgentSettings")),
    ).resolves.toMatchObject({
      piBrowserAgentSettings: { disabledTools: ["browser_set_checked"] },
    })

    await harness.restart()
    const savedSettings = await harness.context.newPage()
    await savedSettings.goto(`${harness.controller.url()}?view=settings`)
    await expect(
      savedSettings.locator('#available-tools input[value="browser_set_checked"]'),
    ).not.toBeChecked()
    await expect(
      savedSettings.locator('#available-tools input[value="browser_find_text"]'),
    ).toBeChecked()
    await expect(savedSettings.locator("#available-tools input:not(:checked)")).toHaveCount(1)
    await savedSettings.close()
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})
