import { expect, type Locator, type Page, test } from "@playwright/test"
import {
  type ExtensionHarness,
  launchExtensionHarness as launchTemporaryHarness,
} from "./support/extension-harness.js"

const sections = ["Model", "Tools", "MCP", "Skills", "Appearance", "Instructions"] as const

async function launchExtensionHarness(): Promise<ExtensionHarness> {
  const harness = await launchTemporaryHarness()
  await harness.context.route("https://**/*", (route) =>
    route.fulfill({ status: 500, body: "Unexpected external request" }),
  )
  return harness
}

async function openSettings(harness: ExtensionHarness): Promise<Page> {
  const page = await harness.context.newPage()
  await page.goto(`${harness.controller.url()}?view=settings`)
  await expect(page.locator("#settings-page")).toBeVisible()
  return page
}

async function selectTab(page: Page, name: string): Promise<void> {
  await page.getByRole("tab", { name, exact: true }).click()
}

async function bounds(locator: Locator) {
  const box = await locator.boundingBox()
  if (!box) throw new Error(`Missing bounds for ${locator}`)
  return box
}

async function expectReachable(control: Locator): Promise<void> {
  await control.scrollIntoViewIfNeeded()
  await expect(control).toBeInViewport({ ratio: 1 })
  const targetHeight = await control.evaluate((node) => {
    const target = node.matches('input[type="checkbox"], input[type="radio"]')
      ? node.closest("label")
      : node
    if (!target) throw new Error("Missing native choice label")
    return target.getBoundingClientRect().height
  })
  expect(targetHeight, `Pointer target height: ${control}`).toBeGreaterThanOrEqual(44)
  expect(
    await control.evaluate((node) => {
      const box = node.getBoundingClientRect()
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
      return hit === node || (hit !== null && node.contains(hit))
    }),
    `Control is covered or clipped: ${control}`,
  ).toBe(true)
}

async function expectNoOverflow(page: Page): Promise<void> {
  for (const selector of ["html", "body", ".settings-content", '[role="tabpanel"]:not([hidden])']) {
    expect(
      await page.locator(selector).evaluate((node) => node.scrollWidth <= node.clientWidth),
      `Horizontal overflow in ${selector}`,
    ).toBe(true)
  }
}

for (const colorScheme of ["light", "dark"] as const) {
  for (const { width, fontSize } of [
    { width: 1280, fontSize: 16 },
    { width: 320, fontSize: 24 },
    { width: 360, fontSize: 12 },
    { width: 768, fontSize: 16 },
    { width: 800, fontSize: 12 },
  ]) {
    test(`all six sections are aligned and reachable at ${width}px / ${fontSize}px in ${colorScheme}`, async () => {
      test.setTimeout(120_000)
      const harness = await launchExtensionHarness()
      try {
        const page = await openSettings(harness)
        await page.setViewportSize({ width, height: width >= 800 ? 900 : 640 })
        await page.emulateMedia({ colorScheme, reducedMotion: "reduce" })
        await selectTab(page, "Appearance")
        await page.locator("#font-size").fill(String(fontSize))
        await expect(page.locator("html")).toHaveCSS("font-size", `${fontSize}px`)
        const header = await bounds(page.locator(".settings-page-header"))
        const content = await bounds(page.locator(".settings-content"))
        const footer = await bounds(page.locator(".settings-page-actions"))
        const nav = await bounds(page.getByRole("tablist"))
        const shell = await bounds(page.locator(".settings-layout"))
        expect(shell.width).toBeLessThanOrEqual(1080)
        expect(Math.abs(header.x - footer.x)).toBeLessThanOrEqual(1)
        expect(Math.abs(header.x + header.width - footer.x - footer.width)).toBeLessThanOrEqual(1)
        // The content scrollport includes a 3px focus-outline allowance on each side.
        expect(Math.abs(header.x - content.x)).toBeLessThanOrEqual(3)
        expect(Math.abs(header.x + header.width - content.x - content.width)).toBeLessThanOrEqual(3)
        await expect(page.getByRole("tablist")).toHaveAttribute(
          "aria-orientation",
          width >= 800 ? "vertical" : "horizontal",
        )
        const modelTab = await bounds(page.getByRole("tab", { name: "Model", exact: true }))
        const toolsTab = await bounds(page.getByRole("tab", { name: "Tools", exact: true }))
        if (width >= 800) {
          expect(nav.width).toBe(192)
          expect(nav.x + nav.width).toBeLessThan(header.x)
          expect(header.width).toBeLessThanOrEqual(720)
          expect(toolsTab.y).toBeGreaterThanOrEqual(modelTab.y + modelTab.height)
        } else {
          expect(modelTab.y).toBeGreaterThanOrEqual(header.y + header.height)
          expect(toolsTab.y).toBe(modelTab.y)
          expect(toolsTab.x).toBeGreaterThanOrEqual(modelTab.x + modelTab.width)
        }
        for (const name of sections) {
          await selectTab(page, name)
          await expect(page.getByRole("tab", { selected: true })).toHaveCount(1)
          const panel = page.getByRole("tabpanel", { name, exact: true })
          await expect(page.getByRole("tabpanel")).toHaveCount(1)
          await expect(panel).toBeVisible()
          const controls = panel.locator(
            "button:visible, input:visible, select:visible, textarea:visible, summary:visible",
          )
          expect(await controls.count()).toBeGreaterThan(0)
          for (const control of await controls.all()) await expectReachable(control)
          await expectReachable(page.locator("#cancel-settings"))
          await expectReachable(page.locator("#save-settings"))
          await expectNoOverflow(page)
        }
        await page.screenshot({
          path: test.info().outputPath(`settings-${colorScheme}-${width}-${fontSize}.png`),
        })
        expect(harness.pageErrors).toEqual([])
      } finally {
        await harness.close()
      }
    })
  }
}

function contrast(first: string, second: string): number {
  function luminance(color: string): number {
    const channels = color.match(/[\d.]+/g)?.map(Number)
    if (!channels || channels.length < 3 || (channels.length === 4 && channels[3] !== 1)) {
      throw new Error(`Expected an opaque computed RGB color: ${color}`)
    }
    const linear = channels.slice(0, 3).map((channel) => {
      const value = channel / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    })
    return (linear[0] ?? 0) * 0.2126 + (linear[1] ?? 0) * 0.7152 + (linear[2] ?? 0) * 0.0722
  }
  const a = luminance(first)
  const b = luminance(second)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

async function expectPrimaryContrast(page: Page, button: Locator): Promise<void> {
  await expect(button).toBeEnabled()
  for (const state of ["normal", "hover", "active"] as const) {
    if (state === "normal") await page.mouse.move(0, 0)
    else await button.hover()
    if (state === "active") await page.mouse.down()
    try {
      const fill = await button.evaluate(
        (node, token) => {
          const probe = document.createElement("span")
          probe.style.backgroundColor = `var(${token})`
          node.append(probe)
          const color = getComputedStyle(probe).backgroundColor
          probe.remove()
          return color
        },
        state === "normal" ? "--primary-fill" : "--primary-hover",
      )
      await expect(button).toHaveCSS("background-color", fill)
      await expect
        .poll(() => button.evaluate((node) => node.matches(":active")))
        .toBe(state === "active")
      await expect
        .poll(
          async () => {
            const colors = await button.evaluate((node) => {
              const style = getComputedStyle(node)
              return [style.color, style.backgroundColor] as const
            })
            return contrast(...colors)
          },
          { message: `Primary text contrast in ${state} state` },
        )
        .toBeGreaterThanOrEqual(4.5)
    } finally {
      if (state === "active") {
        // Release outside the button to avoid committing Settings or sending a prompt.
        await page.mouse.move(0, 0)
        await page.mouse.up()
      }
    }
  }
}

for (const colorScheme of ["light", "dark"] as const) {
  test(`enabled general Save, conversation, and credential dialog share accessible primary colors in ${colorScheme}`, async () => {
    const harness = await launchExtensionHarness()
    try {
      const requests: string[] = []
      await harness.context.route("https://**/*", async (route) => {
        requests.push(route.request().url())
        await route.fulfill({ status: 500, body: "Unexpected external request" })
      })
      const page = await openSettings(harness)
      await page.emulateMedia({ colorScheme })
      await selectTab(page, "Instructions")
      await page.locator("#system-prompt").fill("Harmless contrast-test draft")
      await expectPrimaryContrast(page, page.locator("#save-settings"))
      const selected = page.getByRole("tab", { selected: true })
      const selectedColors = await selected.evaluate((node) => {
        const style = getComputedStyle(node)
        return [style.borderTopColor, style.backgroundColor] as const
      })
      expect(contrast(...selectedColors)).toBeGreaterThanOrEqual(3)
      await selected.focus()
      await page.keyboard.press("Tab")
      await page.keyboard.press("Shift+Tab")
      await expect(selected).toBeFocused()
      const focus = await selected.evaluate((node) => {
        const style = getComputedStyle(node)
        return { color: style.outlineColor, width: style.outlineWidth, style: style.outlineStyle }
      })
      expect(focus.style).toBe("solid")
      expect(Number.parseFloat(focus.width)).toBeGreaterThanOrEqual(2)
      const background = await page
        .locator("body")
        .evaluate((node) => getComputedStyle(node).backgroundColor)
      expect(contrast(focus.color, background)).toBeGreaterThanOrEqual(3)
      await selectTab(page, "Model")
      await page.locator("#configure-provider").click()
      await page.locator("#api-key-auth-method").click()
      await expect(page.locator("#auth-provider-dialog")).toBeVisible()
      await expectPrimaryContrast(page, page.locator("#auth-provider-confirm"))
      await page.locator("#auth-provider-cancel").click()
      await harness.controller.emulateMedia({ colorScheme })
      await harness.controller.locator("#prompt").fill("Unsent local contrast sample")
      await expectPrimaryContrast(harness.controller, harness.controller.locator("#send"))
      expect(requests).toEqual([])
      expect(harness.pageErrors).toEqual([])
    } finally {
      await harness.close()
    }
  })
}

test("keyboard focus and general drafts survive both responsive navigation orientations", async () => {
  const harness = await launchExtensionHarness()
  try {
    const page = await openSettings(harness)
    await page.setViewportSize({ width: 1280, height: 900 })
    await selectTab(page, "Instructions")
    await page.locator("#system-prompt").fill("Draft retained after resize")
    await page.getByRole("tab", { name: "Instructions", exact: true }).focus()
    await page.setViewportSize({ width: 320, height: 720 })
    await expect(page.getByRole("tablist")).toHaveAttribute("aria-orientation", "horizontal")
    await expect(page.getByRole("tab", { name: "Instructions", exact: true })).toBeFocused()
    await expect(page.getByRole("tab", { selected: true })).toBeInViewport({ ratio: 1 })
    await page.keyboard.press("Home")
    await expect(page.getByRole("tab", { name: "Model", exact: true })).toBeFocused()
    await page.keyboard.press("ArrowRight")
    await expect(page.getByRole("tab", { name: "Tools", exact: true })).toBeFocused()
    await page.keyboard.press("End")
    await expect(page.getByRole("tab", { selected: true })).toBeInViewport({ ratio: 1 })
    await expect(page.locator("#system-prompt")).toHaveValue("Draft retained after resize")
    await page.setViewportSize({ width: 1280, height: 900 })
    await expect(page.getByRole("tablist")).toHaveAttribute("aria-orientation", "vertical")
    await expect(page.getByRole("tab", { name: "Instructions", exact: true })).toBeFocused()
    await page.keyboard.press("ArrowDown")
    await expect(page.getByRole("tab", { name: "Model", exact: true })).toBeFocused()
    await page.keyboard.press("ArrowUp")
    await expect(page.getByRole("tab", { name: "Instructions", exact: true })).toBeFocused()
    await expect(page.locator("#system-prompt")).toHaveValue("Draft retained after resize")
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("the static conversation sample previews shared font variables without effects and discard restores baseline", async () => {
  const harness = await launchExtensionHarness()
  try {
    const requests: string[] = []
    await harness.context.route("https://**/*", async (route) => {
      requests.push(route.request().url())
      await route.fulfill({ status: 500, body: "Unexpected external request" })
    })
    const page = await openSettings(harness)
    await selectTab(page, "Appearance")
    const sample = page.getByRole("region", { name: "Sample conversation" })
    await expect(sample.locator(".message.user")).toHaveText("Summarize this page.")
    await expect(sample.locator(".message.assistant")).toContainText("Page summary")
    await expect(sample.locator("pre code")).toContainText('const title = "Sample page"')
    await expect(sample.locator(".preview-tool-result")).toContainText("Tool result")
    await expect(sample.locator("button, input, a")).toHaveCount(0)
    const baseline = await sample.evaluate((node) => {
      const style = getComputedStyle(node)
      return { family: style.fontFamily, size: style.fontSize }
    })
    const codeFont = await sample
      .locator("code")
      .evaluate((node) => getComputedStyle(node).fontFamily)
    const readPreviewStorage = () =>
      harness.controller.evaluate(() =>
        chrome.storage.local.get([
          "piBrowserAgentSettings",
          "piBrowserAgentMcpServersV1",
          "piBrowserAgentSkillsV1",
        ]),
      )
    const storage = await readPreviewStorage()
    const permissions = await harness.controller.evaluate(() => chrome.permissions.getAll())
    await page.evaluate(() => {
      const counts = { writes: 0, permissions: 0, messages: 0, databases: 0 }
      Object.assign(window, { previewEffects: counts })
      const set = chrome.storage.local.set.bind(chrome.storage.local)
      chrome.storage.local.set = (async (items) => {
        counts.writes++
        await set(items)
      }) as typeof chrome.storage.local.set
      const request = chrome.permissions.request.bind(chrome.permissions)
      chrome.permissions.request = (async (value) => {
        counts.permissions++
        return request(value)
      }) as typeof chrome.permissions.request
      const send = chrome.runtime.sendMessage.bind(chrome.runtime)
      chrome.runtime.sendMessage = ((...args: Parameters<typeof chrome.runtime.sendMessage>) => {
        counts.messages++
        return send(...args)
      }) as typeof chrome.runtime.sendMessage
      const open = indexedDB.open.bind(indexedDB)
      indexedDB.open = (...args) => {
        counts.databases++
        return open(...args)
      }
    })
    await page.locator("#font-family").selectOption("serif")
    await page.locator("#font-size").fill("24")
    await expect(sample).toHaveCSS("font-size", "24px")
    await expect(sample).toHaveCSS("font-family", /Georgia/)
    for (const selector of [".message.user", ".message.assistant p", ".preview-tool-result p"]) {
      await expect(sample.locator(selector).first()).toHaveCSS("font-size", "24px")
      await expect(sample.locator(selector).first()).toHaveCSS("font-family", /Georgia/)
    }
    expect(await sample.evaluate((node) => getComputedStyle(node).fontFamily)).not.toBe(
      baseline.family,
    )
    expect(
      await page
        .locator("html")
        .evaluate((node) => getComputedStyle(node).getPropertyValue("--app-font-size")),
    ).toBe("24px")
    await expect(sample.locator("code")).toHaveCSS("font-family", codeFont)
    expect(
      await page.evaluate(
        () => (window as typeof window & { previewEffects: unknown }).previewEffects,
      ),
    ).toEqual({ writes: 0, permissions: 0, messages: 0, databases: 0 })
    expect(await readPreviewStorage()).toEqual(storage)
    expect(await harness.controller.evaluate(() => chrome.permissions.getAll())).toEqual(
      permissions,
    )
    expect(requests).toEqual([])
    const restored: unknown[] = []
    await page.exposeFunction("recordSampleBaseline", (value: unknown) => restored.push(value))
    await page.evaluate(() => {
      new MutationObserver(() => {
        const node = document.getElementById("appearance-preview")
        if (!node) throw new Error("Missing sample")
        const style = getComputedStyle(node)
        void (
          window as typeof window & { recordSampleBaseline: (value: unknown) => Promise<void> }
        ).recordSampleBaseline({ family: style.fontFamily, size: style.fontSize })
      }).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-font-family", "data-font-size"],
      })
    })
    await page.locator("#cancel-settings").click()
    await expect(page.locator("#settings-confirm-dialog")).toBeVisible()
    const closed = page.waitForEvent("close")
    await page.locator("#settings-confirm-action").click()
    await closed
    await expect.poll(() => restored).toEqual([baseline])
    expect(await readPreviewStorage()).toEqual(storage)
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})
