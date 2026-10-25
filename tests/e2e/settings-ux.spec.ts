import { expect, type Locator, type Page, test } from "@playwright/test"
import { type ExtensionHarness, launchExtensionHarness } from "./support/extension-harness.js"

const ENDPOINT = "https://settings-ux.example.com/mcp"
const TOKEN = "settings-ux-private-token"

async function openSettings(harness: ExtensionHarness): Promise<Page> {
  const page = await harness.context.newPage()
  await page.goto(`${harness.controller.url()}?view=settings`)
  await expect(page.locator("#settings-page")).toBeVisible()
  return page
}

async function selectTab(page: Page, name: string): Promise<void> {
  await page.getByRole("tab", { name, exact: true }).click()
}

async function expectConfirmation(page: Page, title: string): Promise<void> {
  await expect(page.locator("dialog#settings-confirm-dialog")).toBeVisible()
  await expect(page.locator("#settings-confirm-title")).toHaveText(title)
  await expect(page.locator("#settings-confirm-cancel")).toBeFocused()
}

function readStorage(harness: ExtensionHarness) {
  return harness.controller.evaluate(() =>
    chrome.storage.local.get([
      "piBrowserAgentSettings",
      "piBrowserAgentMcpServersV1",
      "piBrowserAgentMcpTokensV1",
      "piBrowserAgentSkillsV1",
    ]),
  )
}

async function reviewSkill(page: Page): Promise<void> {
  await selectTab(page, "Skills")
  await page.locator("#skills-file-input").setInputFiles({
    name: "SKILL.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(
      "---\nname: settings-ux-review\ndescription: Local Settings review\n---\nHarmless reviewed content.",
    ),
  })
  await expect(page.locator("#skills-preview")).toContainText("Harmless reviewed content.")
  await expect(page.locator("#skills-import-reviewed")).toBeEnabled()
}

async function saveServer(page: Page, name: string, endpoint = ENDPOINT): Promise<string> {
  await selectTab(page, "MCP")
  await page.locator("#mcp-name").fill(name)
  await page.locator("#mcp-endpoint").fill(endpoint)
  await page.locator("#mcp-token").fill(TOKEN)
  await page.locator("#mcp-save").click()
  await expect(page.locator("#mcp-status")).toContainText("Saved disconnected")
  return page.locator("#mcp-server").inputValue()
}

test("a valid token survives missing Name validation and is stored after correction", async () => {
  const harness = await launchExtensionHarness()
  try {
    const requests: string[] = []
    await harness.context.route("https://settings-ux.example.com/**", async (route) => {
      requests.push(route.request().url())
      await route.fulfill({ status: 500, body: "Unexpected remote request" })
    })
    const page = await openSettings(harness)
    await selectTab(page, "MCP")
    const initial = await readStorage(harness)
    await page.locator("#mcp-endpoint").fill(ENDPOINT)
    await page.locator("#mcp-token").fill(TOKEN)
    await page.locator("#mcp-save").click()
    await expect(page.locator("#mcp-status")).toContainText("server name")
    await expect(page.locator("#mcp-token")).toHaveValue(TOKEN)
    expect(await readStorage(harness)).toEqual(initial)
    await page.locator("#mcp-name").fill("Corrected server")
    await page.locator("#mcp-save").click()
    await expect(page.locator("#mcp-status")).toContainText("Saved disconnected")
    await expect(page.locator("#mcp-token")).toHaveValue("")
    const id = await page.locator("#mcp-server").inputValue()
    expect(await readStorage(harness)).toMatchObject({
      piBrowserAgentMcpServersV1: {
        servers: [{ id, name: "Corrected server", hasToken: true, enabled: false }],
      },
      piBrowserAgentMcpTokensV1: { tokens: { [id]: { endpoint: ENDPOINT, token: TOKEN } } },
    })
    expect(await page.locator("body").textContent()).not.toContain(TOKEN)
    expect(requests).toEqual([])
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("general save preserves MCP and Skills drafts on Cancel, then explicitly discards only drafts", async () => {
  const harness = await launchExtensionHarness()
  try {
    const page = await openSettings(harness)
    await saveServer(page, "Saved independently")
    await reviewSkill(page)
    await page.locator("#skills-import-reviewed").click()
    await expect(page.locator("#skills-status")).toContainText("Skill imported disabled")
    const saved = await readStorage(harness)
    await selectTab(page, "Instructions")
    await page.locator("#system-prompt").fill("Save only these general instructions")
    await selectTab(page, "MCP")
    await page.locator("#mcp-name").fill("Unsaved replacement name")
    await page.locator("#mcp-token").fill("unsaved-replacement-token")
    await reviewSkill(page)
    await page.locator("#save-settings").click()
    await expectConfirmation(page, "Unsaved MCP or Skills changes")
    await expect(page.locator("#settings-confirm-action")).toHaveText("Discard drafts and save")
    await page.locator("#settings-confirm-cancel").click()
    await expect(page.locator("#settings-confirm-dialog")).toBeHidden()
    await expect(page.locator("#skills-preview")).toContainText("Harmless reviewed content.")
    await expect(page.locator("#skills-import-reviewed")).toBeEnabled()
    await selectTab(page, "MCP")
    await expect(page.locator("#mcp-name")).toHaveValue("Unsaved replacement name")
    await expect(page.locator("#mcp-token")).toHaveValue("unsaved-replacement-token")
    await selectTab(page, "Instructions")
    await expect(page.locator("#system-prompt")).toHaveValue("Save only these general instructions")
    expect(await readStorage(harness)).toEqual(saved)
    await page.locator("#save-settings").click()
    await expectConfirmation(page, "Unsaved MCP or Skills changes")
    const closed = page.waitForEvent("close")
    await page.locator("#settings-confirm-action").click()
    await closed
    const current = await readStorage(harness)
    expect(current).toMatchObject({
      piBrowserAgentSettings: { systemPrompt: "Save only these general instructions" },
    })
    for (const key of [
      "piBrowserAgentMcpServersV1",
      "piBrowserAgentMcpTokensV1",
      "piBrowserAgentSkillsV1",
    ]) {
      expect(current[key]).toEqual(saved[key])
    }
    const reopened = await openSettings(harness)
    await selectTab(reopened, "MCP")
    await reopened.locator("#mcp-server").selectOption({ label: "Saved independently" })
    await expect(reopened.locator("#mcp-name")).toHaveValue("Saved independently")
    await expect(reopened.locator("#mcp-token")).toHaveValue("")
    await selectTab(reopened, "Skills")
    await expect(reopened.locator("#skills-import-reviewed")).toBeDisabled()
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("a pending general save blocks duplicate saves and exits; failure restores controls and focus", async () => {
  const harness = await launchExtensionHarness()
  try {
    const page = await openSettings(harness)
    const initial = await readStorage(harness)
    await selectTab(page, "Instructions")
    await page.locator("#system-prompt").fill("Retain this draft after save failure")
    await page.evaluate(() => {
      const originalSet = chrome.storage.local.set
      const callOriginalSet = originalSet.bind(chrome.storage.local)
      let attempts = 0
      let release = (): void => undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const state = window as typeof window & {
        settingsUxSave?: { attempts: () => number; fail: () => void }
      }
      state.settingsUxSave = {
        attempts: () => attempts,
        fail: () => {
          chrome.storage.local.set = originalSet
          release()
        },
      }
      chrome.storage.local.set = (async (items) => {
        if (Object.hasOwn(items, "piBrowserAgentSettings")) {
          attempts++
          await gate
          throw new Error("Settings UX test save failed")
        }
        await callOriginalSet(items)
      }) as typeof chrome.storage.local.set
    })
    await page.locator("#save-settings").click()
    const attempts = () =>
      page.evaluate(() => {
        const state = window as typeof window & { settingsUxSave?: { attempts: () => number } }
        return state.settingsUxSave?.attempts()
      })
    await expect.poll(attempts).toBe(1)
    await expect(page.locator("#settings-page")).toHaveJSProperty("inert", true)
    await expect(page.locator("#settings-page")).toHaveAttribute("aria-busy", "true")
    await expect(page.locator("#save-settings")).toHaveText("Saving…")
    await page.locator("#save-settings").dispatchEvent("click")
    await page.locator("#cancel-settings").dispatchEvent("click")
    await page.locator("#close-settings").dispatchEvent("click")
    await page.keyboard.press("Escape")
    await expect(page.locator("#settings-confirm-dialog")).toBeHidden()
    await expect(page.locator("#settings-page")).toBeVisible()
    expect(await attempts()).toBe(1)
    expect(await readStorage(harness)).toEqual(initial)
    await page.evaluate(() => {
      const state = window as typeof window & { settingsUxSave?: { fail: () => void } }
      state.settingsUxSave?.fail()
      delete state.settingsUxSave
    })
    await expect(page.locator("#settings-error")).toHaveText("Settings UX test save failed")
    await expect(page.locator("#settings-page")).toHaveJSProperty("inert", false)
    await expect(page.locator("#settings-page")).not.toHaveAttribute("aria-busy", "true")
    await expect(page.locator("#save-settings")).toHaveText("Save general settings")
    await expect(page.locator("#save-settings")).toBeFocused()
    await expect(page.locator("#system-prompt")).toHaveValue("Retain this draft after save failure")
    expect(await readStorage(harness)).toEqual(initial)
    const nativeTypes: string[] = []
    page.on("dialog", (dialog) => nativeTypes.push(dialog.type()))
    const closed = page.waitForEvent("close")
    await page.locator("#save-settings").click()
    await closed
    expect(nativeTypes).toEqual([])
    expect(await readStorage(harness)).toMatchObject({
      piBrowserAgentSettings: { systemPrompt: "Retain this draft after save failure" },
    })
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

for (const exit of ["Escape", "Back", "Cancel"] as const) {
  test(`${exit} guards general drafts; dialog Escape cancels only the dialog`, async () => {
    const harness = await launchExtensionHarness()
    try {
      const page = await openSettings(harness)
      const initial = await readStorage(harness)
      await selectTab(page, "Instructions")
      const initialPrompt = await page.locator("#system-prompt").inputValue()
      await page.locator("#system-prompt").fill("Keep this unsaved draft")
      const requestExit = async () => {
        if (exit === "Escape") await page.keyboard.press("Escape")
        else await page.locator(exit === "Back" ? "#close-settings" : "#cancel-settings").click()
      }
      await requestExit()
      await expectConfirmation(page, "Discard unsaved changes?")
      await page.locator("#settings-confirm-dialog").press("Escape")
      await expect(page.locator("#settings-confirm-dialog")).toBeHidden()
      await expect(page.locator("#settings-page")).toBeVisible()
      await expect(page.locator("#system-prompt")).toHaveValue("Keep this unsaved draft")
      await requestExit()
      await expectConfirmation(page, "Discard unsaved changes?")
      await page.locator("#settings-confirm-cancel").click()
      await expect(page.locator("#system-prompt")).toHaveValue("Keep this unsaved draft")
      expect(await readStorage(harness)).toEqual(initial)
      await requestExit()
      await expectConfirmation(page, "Discard unsaved changes?")
      const closed = page.waitForEvent("close")
      await page.locator("#settings-confirm-action").click()
      await closed
      expect(await readStorage(harness)).toEqual(initial)
      const reopened = await openSettings(harness)
      await selectTab(reopened, "Instructions")
      await expect(reopened.locator("#system-prompt")).toHaveValue(initialPrompt)
      const cleanClosed = reopened.waitForEvent("close")
      if (exit === "Escape") await reopened.keyboard.press("Escape")
      else await reopened.locator(exit === "Back" ? "#close-settings" : "#cancel-settings").click()
      await cleanClosed
      expect(harness.pageErrors).toEqual([])
    } finally {
      await harness.close()
    }
  })
}

for (const draft of ["MCP", "Skills"] as const) {
  test(`Cancel guards an isolated ${draft} draft without general edits`, async () => {
    const harness = await launchExtensionHarness()
    try {
      const page = await openSettings(harness)
      const initial = await readStorage(harness)
      if (draft === "MCP") {
        await selectTab(page, "MCP")
        await page.locator("#mcp-token").fill(TOKEN)
      } else {
        await reviewSkill(page)
      }
      await page.locator("#cancel-settings").click()
      await expectConfirmation(page, "Discard unsaved changes?")
      await page.locator("#settings-confirm-cancel").click()
      await expect(page.locator("#settings-page")).toBeVisible()
      if (draft === "MCP") await expect(page.locator("#mcp-token")).toHaveValue(TOKEN)
      else await expect(page.locator("#skills-preview")).toContainText("Harmless reviewed content.")
      expect(await readStorage(harness)).toEqual(initial)
      await page.locator("#cancel-settings").click()
      await expectConfirmation(page, "Discard unsaved changes?")
      const closed = page.waitForEvent("close")
      await page.locator("#settings-confirm-action").click()
      await closed
      expect(await readStorage(harness)).toEqual(initial)
      expect(harness.pageErrors).toEqual([])
    } finally {
      await harness.close()
    }
  })
}

for (const draft of ["general", "MCP", "Skills"] as const) {
  test(`native beforeunload protects an isolated ${draft} draft`, async () => {
    const harness = await launchExtensionHarness()
    try {
      const page = await openSettings(harness)
      const initial = await readStorage(harness)
      if (draft === "general") {
        await selectTab(page, "Instructions")
        await page.locator("#system-prompt").fill("Retain this general draft")
      } else if (draft === "MCP") {
        await selectTab(page, "MCP")
        await page.locator("#mcp-token").fill(TOKEN)
      } else {
        await reviewSkill(page)
      }
      const nativeTypes: string[] = []
      page.on("dialog", (dialog) => nativeTypes.push(dialog.type()))
      const prompted = page.waitForEvent("dialog")
      await page.close({ runBeforeUnload: true })
      const dialog = await prompted
      expect(dialog.type()).toBe("beforeunload")
      await dialog.dismiss()
      await expect(page.locator("#settings-page")).toBeVisible()
      await expect(page.locator("#settings-confirm-dialog")).toBeHidden()
      if (draft === "general") {
        await expect(page.locator("#system-prompt")).toHaveValue("Retain this general draft")
      } else if (draft === "MCP") {
        await expect(page.locator("#mcp-token")).toHaveValue(TOKEN)
      } else {
        await expect(page.locator("#skills-preview")).toContainText("Harmless reviewed content.")
      }
      expect(await readStorage(harness)).toEqual(initial)
      await page.locator("#close-settings").click()
      await expectConfirmation(page, "Discard unsaved changes?")
      const closed = page.waitForEvent("close")
      await page.locator("#settings-confirm-action").click()
      await closed
      expect(nativeTypes).toEqual(["beforeunload"])
      expect(await readStorage(harness)).toEqual(initial)
      expect(harness.pageErrors).toEqual([])
    } finally {
      await harness.close()
    }
  })
}

test("server-switch Cancel restores selection and preserves fields and replacement token", async () => {
  const harness = await launchExtensionHarness()
  try {
    const page = await openSettings(harness)
    const firstId = await saveServer(page, "First saved server")
    await page.locator("#mcp-server").selectOption("")
    await expect(page.locator("#settings-confirm-dialog")).toBeHidden()
    const secondId = await saveServer(page, "Second saved server", `${ENDPOINT}/second`)
    await page.locator("#mcp-server").selectOption(firstId)
    const saved = await readStorage(harness)
    await page.locator("#mcp-name").fill("Draft first name")
    await page.locator("#mcp-endpoint").fill(`${ENDPOINT}/replacement`)
    await page.locator("#mcp-token").fill("replacement-token-for-first")
    await page.locator("#mcp-server").focus()
    await page.locator("#mcp-server").selectOption(secondId)
    await expectConfirmation(page, "Discard MCP changes?")
    await expect(page.locator("#settings-confirm-message")).toContainText("First saved server")
    await expect(page.locator("#mcp-server")).toHaveValue(firstId)
    await page.locator("#settings-confirm-cancel").click()
    await expect(page.locator("#mcp-server")).toBeEnabled()
    await expect(page.locator("#mcp-server")).toBeFocused()
    await expect(page.locator("#mcp-server")).toHaveValue(firstId)
    await expect(page.locator("#mcp-name")).toHaveValue("Draft first name")
    await expect(page.locator("#mcp-endpoint")).toHaveValue(`${ENDPOINT}/replacement`)
    await expect(page.locator("#mcp-token")).toHaveValue("replacement-token-for-first")
    expect(await readStorage(harness)).toEqual(saved)
    await page.locator("#mcp-server").selectOption(secondId)
    await expectConfirmation(page, "Discard MCP changes?")
    await page.locator("#settings-confirm-action").click()
    await expect(page.locator("#mcp-server")).toHaveValue(secondId)
    await expect(page.locator("#mcp-name")).toHaveValue("Second saved server")
    await expect(page.locator("#mcp-endpoint")).toHaveValue(`${ENDPOINT}/second`)
    await expect(page.locator("#mcp-token")).toHaveValue("")
    expect(await readStorage(harness)).toEqual(saved)
    await page.locator("#mcp-server").selectOption("")
    await page.locator("#mcp-server").selectOption(firstId)
    await expect(page.locator("#settings-confirm-dialog")).toBeHidden()
    await expect(page.locator("#mcp-name")).toHaveValue("First saved server")
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("removal names the saved server; Cancel retains server and token, confirmation removes both", async () => {
  const harness = await launchExtensionHarness()
  try {
    const page = await openSettings(harness)
    await saveServer(page, "Named removal target")
    const saved = await readStorage(harness)
    await page.locator("#mcp-name").fill("Unsaved misleading name")
    await page.locator("#mcp-token").fill("unsaved-replacement-token")
    await page.locator("#mcp-remove").click()
    await expectConfirmation(page, "Remove MCP server and token?")
    await expect(page.locator("#settings-confirm-message")).toContainText("Named removal target")
    await expect(page.locator("#settings-confirm-action")).toHaveText("Remove server and token")
    await page.locator("#settings-confirm-cancel").click()
    await expect(page.locator("#mcp-name")).toHaveValue("Unsaved misleading name")
    await expect(page.locator("#mcp-token")).toHaveValue("unsaved-replacement-token")
    expect(await readStorage(harness)).toEqual(saved)
    await page.locator("#mcp-remove").click()
    await expectConfirmation(page, "Remove MCP server and token?")
    await expect(page.locator("#settings-confirm-message")).toContainText("Named removal target")
    await page.locator("#settings-confirm-action").click()
    await expect(page.locator("#mcp-status")).toHaveText("New server")
    await expect(page.locator("#mcp-token")).toHaveValue("")
    expect(await readStorage(harness)).toMatchObject({
      piBrowserAgentMcpServersV1: { version: 1, servers: [] },
      piBrowserAgentMcpTokensV1: { version: 1, tokens: {} },
    })
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("font family and size preview immediately; confirmed discard restores saved appearance", async () => {
  const harness = await launchExtensionHarness()
  try {
    const page = await openSettings(harness)
    const root = page.locator("html")
    const initialFamily = await root.getAttribute("data-font-family")
    const initialSize = await root.getAttribute("data-font-size")
    const initialFont = await root.evaluate((node) => getComputedStyle(node).fontFamily)
    const initialStorage = await readStorage(harness)
    await selectTab(page, "Appearance")
    await page.locator("#font-family").selectOption("serif")
    await expect(root).toHaveAttribute("data-font-family", "serif")
    await expect(root).toHaveCSS("font-family", /Georgia/)
    await page.locator("#font-size").fill("24")
    await expect(root).toHaveAttribute("data-font-size", "24")
    await expect(root).toHaveCSS("font-size", "24px")
    await page.locator("#cancel-settings").click()
    await expectConfirmation(page, "Discard unsaved changes?")
    await page.locator("#settings-confirm-cancel").click()
    await expect(root).toHaveAttribute("data-font-family", "serif")
    await expect(root).toHaveAttribute("data-font-size", "24")
    expect(await readStorage(harness)).toEqual(initialStorage)
    const appearances: unknown[] = []
    await page.exposeFunction("recordSettingsUxAppearance", (appearance: unknown) => {
      appearances.push(appearance)
    })
    await page.evaluate(() => {
      new MutationObserver(() => {
        const state = window as unknown as {
          recordSettingsUxAppearance: (appearance: unknown) => Promise<void>
        }
        void state.recordSettingsUxAppearance({
          family: document.documentElement.dataset.fontFamily,
          size: document.documentElement.dataset.fontSize,
          font: getComputedStyle(document.documentElement).fontFamily,
        })
      }).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-font-family", "data-font-size"],
      })
    })
    await page.locator("#cancel-settings").click()
    await expectConfirmation(page, "Discard unsaved changes?")
    const closed = page.waitForEvent("close")
    await page.locator("#settings-confirm-action").click()
    await closed
    await expect
      .poll(() => appearances)
      .toEqual([{ family: initialFamily, size: initialSize, font: initialFont }])
    expect(await readStorage(harness)).toEqual(initialStorage)
    const reopened = await openSettings(harness)
    await expect(reopened.locator("html")).toHaveAttribute(
      "data-font-family",
      initialFamily ?? "system",
    )
    await expect(reopened.locator("html")).toHaveAttribute("data-font-size", initialSize ?? "16")
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

async function expectBefore(first: Locator, second: Locator): Promise<void> {
  const firstBounds = await first.boundingBox()
  const secondBounds = await second.boundingBox()
  if (!firstBounds || !secondBounds) throw new Error("Missing Settings control bounds")
  expect(firstBounds.y + firstBounds.height).toBeLessThanOrEqual(secondBounds.y)
}

for (const colorScheme of ["light", "dark"] as const) {
  test(`primary controls precede help and tool toggles at 320 px / 24 px in ${colorScheme}`, async () => {
    const harness = await launchExtensionHarness()
    try {
      const page = await openSettings(harness)
      await page.setViewportSize({ width: 320, height: 640 })
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" })
      await selectTab(page, "Appearance")
      await page.locator("#font-size").fill("24")
      await selectTab(page, "Tools")
      await expect(page.locator("#confirmation-mode")).toBeInViewport()
      await expectBefore(page.locator("#confirmation-mode"), page.locator("#available-tools"))
      await page.screenshot({
        path: test.info().outputPath(`settings-tools-${colorScheme}-320.png`),
      })
      await selectTab(page, "MCP")
      await page.screenshot({
        path: test.info().outputPath(`settings-mcp-top-${colorScheme}-320.png`),
      })
      await expect
        .soft(
          page.locator("#mcp-server"),
          `Initial MCP server bounds: ${JSON.stringify(await page.locator("#mcp-server").boundingBox())}`,
        )
        .toBeInViewport()
      const mcpHelp = page.locator("#settings-panel-mcp details")
      await expect(mcpHelp).not.toHaveAttribute("open", "")
      for (const id of ["mcp-server", "mcp-name", "mcp-endpoint", "mcp-token", "mcp-save"]) {
        const control = page.locator(`#${id}`)
        await expectBefore(control, mcpHelp)
        await control.scrollIntoViewIfNeeded()
        await expect(control).toBeInViewport()
      }
      await page.locator("#mcp-name").scrollIntoViewIfNeeded()
      await page.screenshot({ path: test.info().outputPath(`settings-mcp-${colorScheme}-320.png`) })
      await selectTab(page, "Skills")
      await page.screenshot({
        path: test.info().outputPath(`settings-skills-top-${colorScheme}-320.png`),
      })
      await expect
        .soft(
          page.locator("#skills-file-input"),
          `Initial Skills file bounds: ${JSON.stringify(await page.locator("#skills-file-input").boundingBox())}`,
        )
        .toBeInViewport()
      await expect(page.locator("#skills-empty")).toBeVisible()
      await expect(page.locator("#skills-installed-controls")).toBeHidden()
      const skillsHelp = page.locator("#settings-panel-skills details")
      await expect(skillsHelp).not.toHaveAttribute("open", "")
      await expectBefore(page.locator("#skills-file-input"), skillsHelp)
      await expectBefore(page.locator("#skills-import-reviewed"), skillsHelp)
      await page.locator("#skills-file-input").scrollIntoViewIfNeeded()
      await expect(page.locator("#skills-file-input")).toBeInViewport()
      await page.screenshot({
        path: test.info().outputPath(`settings-skills-${colorScheme}-320.png`),
      })
      await reviewSkill(page)
      await page.locator("#skills-import-reviewed").click()
      await expect(page.locator("#skills-status")).toContainText("Skill imported disabled")
      await expect(page.locator("#skills-empty")).toBeHidden()
      await expect(page.locator("#skills-installed-controls")).toBeVisible()
      await expectBefore(page.locator("#skills-import-reviewed"), page.locator("#skills-list"))
      for (const name of ["Tools", "MCP", "Skills"]) {
        await selectTab(page, name)
        await expect(page.locator("#save-settings")).toBeInViewport()
        await expect(page.locator("#cancel-settings")).toBeInViewport()
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
        ).toBe(true)
        expect(
          await page
            .locator(".settings-content")
            .evaluate((node) => node.scrollWidth <= node.clientWidth),
        ).toBe(true)
      }
      expect(harness.pageErrors).toEqual([])
    } finally {
      await harness.close()
    }
  })
}
