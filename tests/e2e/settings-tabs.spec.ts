import { expect, type Page, test } from "@playwright/test"
import { type ExtensionHarness, launchExtensionHarness } from "./support/extension-harness.js"

const names = ["Model", "Tools", "MCP", "Skills", "Appearance", "Instructions"] as const

async function openSettings(harness: ExtensionHarness): Promise<Page> {
  const page = await harness.context.newPage()
  await page.goto(`${harness.controller.url()}?view=settings`)
  await expect(page.locator("#settings-page")).toBeVisible()
  return page
}

async function expectActive(page: Page, name: string): Promise<void> {
  const tab = page.getByRole("tab", { name, exact: true })
  const panel = page.getByRole("tabpanel", { name, exact: true })
  await expect(page.getByRole("tab", { selected: true })).toHaveCount(1)
  await expect(tab).toHaveAttribute("aria-selected", "true")
  await expect(tab).toHaveAttribute("tabindex", "0")
  await expect(page.getByRole("tabpanel")).toHaveCount(1)
  await expect(panel).toBeVisible()
  await expect(tab).toHaveAttribute("aria-controls", `settings-panel-${name.toLowerCase()}`)
  await expect(panel).toHaveAttribute("aria-labelledby", `settings-tab-${name.toLowerCase()}`)
}

test("Settings tabs support mouse selection, roving focus, and keyboard navigation", async () => {
  const harness = await launchExtensionHarness()
  try {
    const page = await openSettings(harness)
    await expect(page.getByRole("tablist", { name: "Settings sections" })).toBeVisible()
    await expect(page.getByRole("tab")).toHaveText([...names])
    await expectActive(page, "Model")
    for (const name of names) {
      await page.getByRole("tab", { name, exact: true }).click()
      await expectActive(page, name)
      await expect(
        page.getByRole("button", { name: "Save general settings", exact: true }),
      ).toBeVisible()
      await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeVisible()
    }
    await page.getByRole("tab", { name: "Model", exact: true }).click()
    await page.keyboard.press("ArrowLeft")
    await expectActive(page, "Instructions")
    await expect(page.getByRole("tab", { name: "Instructions", exact: true })).toBeFocused()
    await page.keyboard.press("ArrowRight")
    await expectActive(page, "Model")
    await page.keyboard.press("ArrowRight")
    await expectActive(page, "Tools")
    await expect(page.getByRole("heading", { name: "Available tools", exact: true })).toBeVisible()
    await expect(
      page.getByRole("heading", { name: "Browser action confirmations", exact: true }),
    ).toBeVisible()
    await page.keyboard.press("End")
    await expectActive(page, "Instructions")
    await page.keyboard.press("Home")
    await expectActive(page, "Model")
    await page.keyboard.press("Tab")
    await expect(page.getByRole("tabpanel", { name: "Model", exact: true })).toBeFocused()
    await page.keyboard.press("Tab")
    await expect(page.locator("#provider-search")).toBeFocused()
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("tab navigation keeps drafts and Save general settings saves controls from every tab", async () => {
  const harness = await launchExtensionHarness()
  try {
    const page = await openSettings(harness)
    const read = () =>
      harness.controller.evaluate(() =>
        chrome.storage.local.get(["piBrowserAgentSettings", "piBrowserAgentMcpServersV1"]),
      )
    const initial = await read()
    await page.locator("#thinking-level").selectOption("high")
    await page.getByRole("tab", { name: "Instructions", exact: true }).click()
    await page.locator("#system-prompt").fill("Cross-tab system instructions")
    await page.locator("#agent-instructions").fill("Cross-tab agent instructions")
    await page.getByRole("tab", { name: "Tools", exact: true }).click()
    await page.locator('#available-tools input[value="browser_click"]').uncheck()
    await page.locator("#confirmation-mode").selectOption("strict")
    await page.getByRole("tab", { name: "Appearance", exact: true }).click()
    await page.locator("#font-family").selectOption("serif")
    await page.locator("#font-size").fill("20")
    await page.getByRole("tab", { name: "MCP", exact: true }).click()
    await page.locator("#mcp-name").fill("Unsaved server")
    await page.locator("#mcp-endpoint").fill("https://draft.example.com/mcp")
    await page.getByRole("tab", { name: "Instructions", exact: true }).click()
    await expect(page.locator("#system-prompt")).toHaveValue("Cross-tab system instructions")
    await expect(page.locator("#agent-instructions")).toHaveValue("Cross-tab agent instructions")
    await page.getByRole("tab", { name: "MCP", exact: true }).click()
    await expect(page.locator("#mcp-name")).toHaveValue("Unsaved server")
    expect(await read()).toEqual(initial)
    await page.getByRole("button", { name: "Save general settings", exact: true }).click()
    await expect(page.locator("#settings-confirm-dialog")).toBeVisible()
    await expect(page.locator("#settings-confirm-title")).toHaveText(
      "Unsaved MCP or Skills changes",
    )
    await expect(page.locator("#settings-confirm-cancel")).toBeFocused()
    await page.locator("#settings-confirm-cancel").click()
    await expect(page.locator("#settings-confirm-dialog")).toBeHidden()
    await expect(page.locator("#mcp-name")).toHaveValue("Unsaved server")
    expect(await read()).toEqual(initial)
    await page.getByRole("button", { name: "Save general settings", exact: true }).click()
    await expect(page.locator("#settings-confirm-action")).toHaveText("Discard drafts and save")
    const closed = page.waitForEvent("close")
    await page.locator("#settings-confirm-action").click()
    await closed
    const saved = await read()
    expect(saved).toMatchObject({
      piBrowserAgentSettings: {
        thinkingLevel: "high",
        systemPrompt: "Cross-tab system instructions",
        agentInstructions: "Cross-tab agent instructions",
        confirmationMode: "strict",
        fontFamily: "serif",
        fontSize: 20,
        disabledTools: ["browser_click"],
      },
    })
    expect(saved.piBrowserAgentMcpServersV1).toEqual(initial.piBrowserAgentMcpServersV1)
    const reopened = await openSettings(harness)
    await expect(reopened.locator("#thinking-level")).toHaveValue("high")
    await reopened.getByRole("tab", { name: "Tools", exact: true }).click()
    await expect(
      reopened.locator('#available-tools input[value="browser_click"]'),
    ).not.toBeChecked()
    await reopened.getByRole("tab", { name: "Appearance", exact: true }).click()
    await expect(reopened.locator("#font-family")).toHaveValue("serif")
    await expect(reopened.locator("#font-size")).toHaveValue("20")
    await reopened.getByRole("tab", { name: "Instructions", exact: true }).click()
    await expect(reopened.locator("#system-prompt")).toHaveValue("Cross-tab system instructions")
    await reopened.getByRole("tab", { name: "MCP", exact: true }).click()
    await expect(reopened.locator("#mcp-name")).toHaveValue("")
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("tab changes preserve skill review and Cancel keeps independent MCP and skill saves", async () => {
  const harness = await launchExtensionHarness()
  try {
    const page = await openSettings(harness)
    const read = () =>
      harness.controller.evaluate(() =>
        chrome.storage.local.get([
          "piBrowserAgentSettings",
          "piBrowserAgentMcpServersV1",
          "piBrowserAgentSkillsV1",
        ]),
      )
    const initial = await read()
    const initialPrompt = await page.locator("#system-prompt").inputValue()
    await page.getByRole("tab", { name: "Skills", exact: true }).click()
    await page.locator("#skills-file-input").setInputFiles({
      name: "SKILL.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(
        "---\nname: tab-review\ndescription: Review across Settings tabs\n---\nReviewed content survives navigation.",
      ),
    })
    await expect(page.locator("#skills-preview")).toContainText(
      "Reviewed content survives navigation.",
    )
    const reviewed = await page.locator("#skills-preview").textContent()
    if (!reviewed) throw new Error("Missing reviewed skill content")
    await page.getByRole("tab", { name: "Instructions", exact: true }).click()
    await page.locator("#system-prompt").fill("Discard this draft")
    await page.getByRole("tab", { name: "Appearance", exact: true }).click()
    await page.locator("#font-size").fill("21")
    await page.getByRole("tab", { name: "Skills", exact: true }).click()
    await expect(page.locator("#skills-preview")).toHaveText(reviewed)
    await expect(page.locator("#skills-import-reviewed")).toBeEnabled()
    await page.locator("#skills-import-reviewed").click()
    await expect(page.locator("#skills-status")).toContainText("Skill imported disabled")
    await page.getByRole("tab", { name: "MCP", exact: true }).click()
    await page.locator("#mcp-name").fill("Saved across tabs")
    await page.locator("#mcp-endpoint").fill("https://saved.example.com/mcp")
    await page.locator("#mcp-save").click()
    await expect(page.locator("#mcp-status")).toContainText("Saved disconnected")
    await page.getByRole("tab", { name: "Model", exact: true }).click()
    const closed = page.waitForEvent("close")
    await page.locator("#cancel-settings").click()
    await expect(page.locator("#settings-confirm-dialog")).toBeVisible()
    await expect(page.locator("#settings-confirm-title")).toHaveText("Discard unsaved changes?")
    await page.locator("#settings-confirm-action").click()
    await closed
    const saved = await read()
    expect(saved.piBrowserAgentSettings).toEqual(initial.piBrowserAgentSettings)
    expect(saved).toMatchObject({
      piBrowserAgentMcpServersV1: {
        servers: [{ name: "Saved across tabs", enabled: false, approved: false }],
      },
      piBrowserAgentSkillsV1: {
        records: [{ name: "tab-review", enabled: false }],
      },
    })
    const reopened = await openSettings(harness)
    await reopened.getByRole("tab", { name: "Instructions", exact: true }).click()
    await expect(reopened.locator("#system-prompt")).toHaveValue(initialPrompt)
    await reopened.getByRole("tab", { name: "Appearance", exact: true }).click()
    await expect(reopened.locator("#font-size")).toHaveValue("16")
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

for (const colorScheme of ["light", "dark"] as const) {
  test(`Settings tabs remain usable at 320 px and 24 px text in ${colorScheme} mode`, async () => {
    const harness = await launchExtensionHarness()
    try {
      const page = await openSettings(harness)
      await page.setViewportSize({ width: 320, height: 640 })
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" })
      await page.getByRole("tab", { name: "Appearance", exact: true }).click()
      await page.locator("#font-size").fill("24")
      await page.getByRole("tab", { name: "Model", exact: true }).focus()
      await page.keyboard.press("End")
      await expectActive(page, "Instructions")
      const tablist = page.getByRole("tablist", { name: "Settings sections" })
      const selected = page.getByRole("tab", { selected: true })
      const listBounds = await tablist.boundingBox()
      const tabBounds = await selected.boundingBox()
      if (!listBounds || !tabBounds) throw new Error("Missing Settings tab bounds")
      expect(tabBounds.x).toBeGreaterThanOrEqual(listBounds.x)
      expect(tabBounds.x + tabBounds.width).toBeLessThanOrEqual(listBounds.x + listBounds.width)
      await page.keyboard.press("Home")
      await expectActive(page, "Model")
      for (const name of names) {
        await page.getByRole("tab", { name, exact: true }).click()
        await expectActive(page, name)
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
        ).toBe(true)
        expect(
          await page
            .locator(".settings-content")
            .evaluate((content) => content.scrollWidth <= content.clientWidth),
        ).toBe(true)
        await expect(
          page.getByRole("button", { name: "Save general settings", exact: true }),
        ).toBeInViewport()
        await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeInViewport()
      }
      await page.getByRole("tab", { name: "MCP", exact: true }).click()
      await page.screenshot({
        path: test.info().outputPath(`settings-tabs-${colorScheme}-320.png`),
      })
      expect(harness.pageErrors).toEqual([])
    } finally {
      await harness.close()
    }
  })
}
