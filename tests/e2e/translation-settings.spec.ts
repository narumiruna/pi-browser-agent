import { expect, type Page, test } from "@playwright/test"
import { setupTranslation } from "./support/translation.js"

async function disclosure(page: Page, name: string) {
  const summary = page
    .locator("#translation-settings summary")
    .filter({ hasText: new RegExp(`^${name}$`) })
  await summary.click()
}
test("template previews and independent resets make no request or storage change before discard", async () => {
  const { harness, requests } = await setupTranslation()
  try {
    const before = await harness.controller.evaluate(() =>
      chrome.storage.local.get("piBrowserAgentTranslationSettingsV1"),
    )
    const settings = await harness.context.newPage()
    await settings.goto(`${harness.controller.url()}?view=settings`)
    await settings.locator("#settings-tab-translation").click()
    await settings.locator("#translation-targetLanguage").fill("Japanese")
    await disclosure(settings, "Translation prompt templates")
    await settings
      .locator("#translation-systemPromptTemplate")
      .fill("Owned system prompt for {{targetLanguage}}")
    await settings.locator("#translation-userPromptTemplate").fill("Translate {{sourcePayload}}")
    await expect(settings.locator("#translation-settings pre")).toContainText(
      "Owned system prompt for Japanese",
    )
    await expect(settings.locator("#translation-settings pre")).toContainText("Example source text")
    await settings.getByRole("button", { name: "Reset System Template", exact: true }).click()
    await expect(settings.locator("#translation-userPromptTemplate")).toHaveValue(
      "Translate {{sourcePayload}}",
    )
    await expect(settings.locator("#translation-systemPromptTemplate")).not.toHaveValue(
      "Owned system prompt for {{targetLanguage}}",
    )
    expect(requests()).toBe(0)
    expect(
      await harness.controller.evaluate(() =>
        chrome.storage.local.get("piBrowserAgentTranslationSettingsV1"),
      ),
    ).toEqual(before)
    await settings.locator("#cancel-settings").click()
    await expect(settings.locator("#settings-confirm-dialog")).toBeVisible()
    await settings.locator("#settings-confirm-action").click()
    await expect.poll(() => settings.isClosed()).toBe(true)
    expect(
      await harness.controller.evaluate(() =>
        chrome.storage.local.get("piBrowserAgentTranslationSettingsV1"),
      ),
    ).toEqual(before)
  } finally {
    await harness.close()
  }
})
test("Translation Settings remains usable at native 200% browser zoom", async ({
  browserName,
}, info) => {
  expect(browserName).toBe("chromium")
  const { harness, requests } = await setupTranslation()
  try {
    const page = await harness.context.newPage()
    await page.setViewportSize({ width: 1280, height: 1200 })
    await page.goto(`${harness.controller.url()}?view=settings`)
    await page.evaluate(async () => {
      const tab = await chrome.tabs.getCurrent()
      if (tab?.id === undefined) throw new Error("Missing Settings tab")
      await chrome.tabs.setZoom(tab.id, 2)
    })
    await page.locator("#settings-tab-translation").click()
    await expect(page.locator("#translation-targetLanguage")).toBeVisible()
    expect(
      await page.evaluate(async () => {
        const tab = await chrome.tabs.getCurrent()
        return chrome.tabs.getZoom(tab?.id)
      }),
    ).toBe(2)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath("translation-native-200-percent.png") })
    expect(requests()).toBe(0)
  } finally {
    await harness.close()
  }
})
for (const colorScheme of ["light", "dark"] as const)
  test(`expanded appearance stays keyboard-accessible at 320px/24px text in ${colorScheme} with reduced motion`, async ({
    browserName,
  }, info) => {
    expect(browserName).toBe("chromium")
    const { harness, requests } = await setupTranslation()
    try {
      await harness.controller.evaluate(() =>
        chrome.storage.local.set({ piBrowserAgentSettings: { language: "en", fontSize: 24 } }),
      )
      const page = await harness.context.newPage()
      await page.setViewportSize({ width: 320, height: 900 })
      await page.emulateMedia({
        colorScheme,
        reducedMotion: "reduce",
        forcedColors: colorScheme === "dark" ? "active" : "none",
      })
      await page.goto(`${harness.controller.url()}?view=settings`)
      await page.locator("#settings-tab-translation").click()
      await disclosure(page, "Translation appearance")
      const font = page.locator("#translation-translationAppearance-inline-fontSizePx")
      await font.focus()
      await expect(font).toBeFocused()
      expect(await font.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe(
        "none",
      )
      await page.getByRole("button", { name: "Preview dark colors", exact: true }).click()
      await expect(
        page.locator('#translation-settings [data-translation-theme="light"]').first(),
      ).toBeHidden()
      await expect(
        page.locator('#translation-settings [data-translation-theme="dark"]').first(),
      ).toBeVisible()
      await expect(page.locator("#translation-settings .translation-preview-fade")).toHaveCSS(
        "animation-name",
        "none",
      )
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
      await page.screenshot({ path: info.outputPath(`translation-appearance-${colorScheme}.png`) })
      expect(requests()).toBe(0)
      expect(harness.pageErrors).toEqual([])
    } finally {
      await harness.close()
    }
  })
