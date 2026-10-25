import { expect, test } from "@playwright/test"
import { launchExtensionHarness } from "./support/extension-harness.js"
import { startMcpFixture } from "./support/mcp-fixture.js"

test.setTimeout(120_000)

for (const colorScheme of ["light", "dark"] as const) {
  test(`MCP resource list supports keyboard selection, drafts, and eight servers in ${colorScheme} mode`, async () => {
    const harness = await launchExtensionHarness()
    try {
      const page = await harness.context.newPage()
      await page.emulateMedia({ colorScheme })
      await page.goto(`${harness.controller.url()}?view=settings`)
      await page.getByRole("tab", { name: "MCP", exact: true }).click()
      const list = page.getByRole("list", { name: "Saved MCP servers" })
      const buttons = list.getByRole("button")
      const create = page.getByRole("button", { name: "New server", exact: true })
      const save = page.getByRole("button", { name: "Save disconnected", exact: true })
      await expect(page.locator("#mcp-empty")).toBeVisible()
      await expect(buttons).toHaveCount(0)
      await expect(page.locator("#mcp-server")).toHaveCount(0)
      await expect(page.locator("#mcp-connect")).toBeHidden()
      await expect(page.locator("#mcp-danger-zone")).toBeHidden()
      const longName = `<img src=x onerror=alert(1)>${"x".repeat(50)}`
      const longEndpoint = `https://settings-mcp.example.com/${"long-path-".repeat(170)}`
      let remoteRequests = 0
      await harness.context.route("https://settings-mcp.example.com/**", async (route) => {
        remoteRequests++
        await route.abort()
      })
      for (let index = 0; index < 8; index++) {
        if (index) await create.click()
        await page.locator("#mcp-name").fill(index ? `Server ${index + 1}` : longName)
        await page.locator("#mcp-endpoint").fill(longEndpoint)
        await save.focus()
        await save.press("Enter")
        await expect(page.locator("#mcp-status")).toContainText("Saved disconnected")
        await expect(page.locator("#mcp-connect")).toBeFocused()
        await expect(buttons).toHaveCount(index + 1)
        await expect(save).toBeDisabled()
        await expect(page.locator("#mcp-connect")).toBeEnabled()
      }
      await expect(create).toBeDisabled()
      await expect(page.locator("#mcp-empty")).toBeHidden()
      await expect(list.locator("li")).toHaveCount(8)
      await expect(list.locator("img, script, a")).toHaveCount(0)
      await expect(buttons.first()).toContainText(longName)
      await expect(buttons.first()).toContainText(longEndpoint)
      await expect(buttons.first()).toContainText("Disabled")
      await buttons.first().focus()
      await buttons.first().press("Enter")
      await expect(buttons.first()).toHaveAttribute("aria-pressed", "true")
      await expect(page.locator("#mcp-name")).toHaveValue(longName)
      await buttons.first().press("Tab")
      await expect(buttons.nth(1)).toBeFocused()
      await buttons.nth(1).press("Space")
      await expect(buttons.nth(1)).toHaveAttribute("aria-pressed", "true")
      await expect(page.locator("#mcp-name")).toHaveValue("Server 2")
      await page.locator("#mcp-token").fill("unsaved-private-token")
      await buttons.first().click()
      await expect(page.locator("#settings-confirm-dialog")).toBeVisible()
      await expect(buttons.nth(1)).toHaveAttribute("aria-pressed", "true")
      await page.locator("#settings-confirm-cancel").click()
      await expect(page.locator("#mcp-token")).toHaveValue("unsaved-private-token")
      await buttons.first().click()
      await page.locator("#settings-confirm-action").click()
      await expect(buttons.first()).toHaveAttribute("aria-pressed", "true")
      await expect(page.locator("#mcp-token")).toHaveValue("")
      for (const width of [1280, 320]) {
        await page.setViewportSize({ width, height: 900 })
        await page.evaluate(
          (size) => {
            document.documentElement.style.setProperty("--app-font-size", `${size}px`)
          },
          width === 320 ? 24 : 16,
        )
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        )
        await buttons.last().scrollIntoViewIfNeeded()
        await expect(buttons.last()).toBeInViewport()
      }
      expect(remoteRequests).toBe(0)
      expect(harness.pageErrors).toEqual([])
    } finally {
      await harness.close()
    }
  })
}

test("keyboard Save and Disable move lost focus to the next MCP action", async () => {
  const fixture = await startMcpFixture()
  const harness = await launchExtensionHarness({
    hostPatterns: ["https://mcp.e2e.example.com/*"],
    browserArgs: fixture.browserArgs,
  })
  try {
    const page = await harness.context.newPage()
    await page.goto(`${harness.controller.url()}?view=settings`)
    await page.getByRole("tab", { name: "MCP", exact: true }).click()
    await page.locator("#mcp-name").fill("Keyboard flow")
    await page.locator("#mcp-endpoint").fill(fixture.endpoint)
    const save = page.locator("#mcp-save")
    const connect = page.locator("#mcp-connect")
    const disable = page.locator("#mcp-disable")
    await save.focus()
    await save.press("Enter")
    await expect(connect).toBeFocused()
    await connect.press("Enter")
    await expect(page.locator("#mcp-status")).toContainText("Enabled for new runs")
    await disable.focus()
    await disable.press("Enter")
    await expect(disable).toBeHidden()
    await expect(page.locator("#mcp-status")).toHaveText("Disabled")
    await expect(connect).toBeFocused()
    expect(fixture.requests.some((request) => request.message?.method === "tools/call")).toBe(false)
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
    await fixture.close()
  }
})

test("MCP preview blocks general save and exit while busy and closing cancels without replay", async () => {
  const fixture = await startMcpFixture()
  const harness = await launchExtensionHarness({
    hostPatterns: ["https://mcp.e2e.example.com/*"],
    browserArgs: fixture.browserArgs,
  })
  try {
    const page = await harness.context.newPage()
    await page.goto(`${harness.controller.url()}?view=settings`)
    await page.getByRole("tab", { name: "MCP", exact: true }).click()
    await page.locator("#mcp-name").fill("Pending preview")
    await page.locator("#mcp-endpoint").fill(fixture.endpoint)
    await page.locator("#mcp-save").click()
    await expect(page.locator("#mcp-status")).toContainText("Saved disconnected")
    await page.getByRole("tab", { name: "Instructions", exact: true }).click()
    await page.locator("#agent-instructions").fill("Pending general changes")
    await expect(page.locator("#save-settings")).toBeEnabled()
    await page.getByRole("tab", { name: "MCP", exact: true }).click()
    fixture.state.holdDiscovery = true
    await page.locator("#mcp-connect").click()
    await expect
      .poll(
        () => fixture.requests.filter((request) => request.message?.method === "initialize").length,
      )
      .toBe(1)
    await expect(page.locator("#save-settings")).toBeDisabled()
    await expect(page.locator("#cancel-settings")).toBeDisabled()
    await expect(page.locator("#mcp-remove")).toBeDisabled()
    await expect(page.locator("#mcp-servers button")).toBeDisabled()
    await expect(page.locator("#mcp-action-hint")).toContainText("Wait")
    await page.close()
    await expect.poll(() => fixture.state.cancelledDiscovery).toBe(1)
    const count = fixture.requests.length
    await harness.restart()
    await harness.controller.waitForTimeout(200)
    expect(fixture.requests).toHaveLength(count)
    expect(fixture.requests.some((request) => request.message?.method === "tools/call")).toBe(false)
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
    await fixture.close()
  }
})
