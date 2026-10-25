import { expect, test } from "@playwright/test"
import { configureMockCodex, launchExtensionHarness } from "./support/extension-harness.js"
import {
  CODEX_RESPONSES_URL,
  type CodexRequest,
  declaredToolNames,
  finalTextResponse,
  toolCallResponse,
} from "./support/mock-codex.js"

test("discovers and calls a native WebMCP tool in Chrome's isolated extension world", async () => {
  const harness = await launchExtensionHarness({ webMcp: true })
  try {
    await configureMockCodex(harness)
    await expect
      .poll(() =>
        harness.fixturePage.evaluate(async () => {
          const page = document as Document & {
            modelContext?: { getTools: () => Promise<{ name: string }[]> }
          }
          return (await page.modelContext?.getTools())?.map((tool) => tool.name) ?? []
        }),
      )
      .toContain("read_fixture_marker")

    const state = (await harness.controller.evaluate(async () =>
      chrome.runtime.sendMessage({
        kind: "request",
        requestId: crypto.randomUUID(),
        method: "app.getState",
        params: {},
      }),
    )) as { ok: boolean; result?: { tabContext?: { tabId: number; url: string; epoch: number } } }
    expect(state).toMatchObject({ ok: true, result: { tabContext: { url: harness.fixtureUrl } } })
    const tabContext = state.result?.tabContext
    if (!tabContext) throw new Error("Missing bound fixture tab")

    const request = (method: string, params: Record<string, unknown>) =>
      harness.controller.evaluate(
        async ({ method, params, tabContext }) =>
          chrome.runtime.sendMessage({
            kind: "request",
            requestId: crypto.randomUUID(),
            method,
            params,
            confirmed: true,
            tabContext,
          }),
        { method, params, tabContext },
      )
    await expect(request("webmcp.listTools", {})).resolves.toMatchObject({
      ok: true,
      result: [{ name: "read_fixture_marker" }],
    })
    await expect(
      request("webmcp.callTool", { name: "read_fixture_marker", arguments: {} }),
    ).resolves.toMatchObject({ ok: true, result: expect.stringContaining("meadow-42") })
  } finally {
    await harness.close()
  }
})

test("runs the production Side Panel from settings through a mocked browser-tool response", async () => {
  test.setTimeout(60_000)
  const testInfo = test.info()
  const harness = await launchExtensionHarness()
  const requestBodies: CodexRequest[] = []
  const finalAnswer = "The production smoke test read meadow-42 from the visible page."

  try {
    await configureMockCodex(harness)
    await expect(harness.controller.locator("#auth-status")).toHaveText(
      "OpenAI Codex (legacy) configured with an account",
    )

    await harness.controller.locator("#account-menu-trigger").click()
    const settingsTabPromise = harness.context.waitForEvent("page")
    await harness.controller.locator("#open-settings").click()
    const settingsTab = await settingsTabPromise
    await expect(settingsTab).toHaveTitle("Settings · Pi Browser Agent")
    await settingsTab.getByRole("tab", { name: "Tools", exact: true }).click()
    const clickTool = settingsTab.locator('#available-tools input[value="browser_click"]')
    await expect(clickTool).toBeChecked()
    await clickTool.uncheck()
    await settingsTab.getByRole("tab", { name: "Appearance", exact: true }).click()
    await settingsTab.locator("#font-family").selectOption("monospace")
    await settingsTab.locator("#font-size").fill("18")
    await expect(settingsTab.locator("#font-size-value")).toHaveText("18 px")
    const settingsTabClosed = settingsTab.waitForEvent("close")
    await settingsTab.locator("#save-settings").click()
    await settingsTabClosed
    await expect
      .poll(() =>
        harness.controller.evaluate(() => ({
          family: document.documentElement.dataset.fontFamily,
          size: document.documentElement.dataset.fontSize,
        })),
      )
      .toEqual({ family: "monospace", size: "18" })

    const responses = [
      toolCallResponse(1, "browser_read_page"),
      toolCallResponse(2, "browser_click", { selector: "#ordinary" }),
      finalTextResponse(3, finalAnswer),
    ]
    let responseIndex = 0
    await harness.context.route(CODEX_RESPONSES_URL, async (route) => {
      expect(route.request().method()).toBe("POST")
      expect(route.request().headers().accept).toContain("text/event-stream")
      requestBodies.push(route.request().postDataJSON() as CodexRequest)
      const body = responses[responseIndex++]
      if (!body) throw new Error(`Unexpected Codex request ${responseIndex}`)
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "cache-control": "no-cache" },
        body,
      })
    })

    await harness.fixturePage.bringToFront()
    await expect
      .poll(() =>
        harness.controller.evaluate(async () => {
          const response = (await chrome.runtime.sendMessage({
            kind: "request",
            requestId: crypto.randomUUID(),
            method: "app.getState",
            params: {},
          })) as { result?: { tabContext?: { url?: string } } }
          return response.result?.tabContext?.url
        }),
      )
      .toBe(harness.fixtureUrl)

    await harness.controller.locator("#prompt").fill("Read the unique marker on this page")
    await harness.controller.locator("#send").click()
    await expect(harness.controller.locator("#transcript")).toContainText(finalAnswer)
    await expect(harness.controller.locator("#run-status")).toHaveText("Ready")
    await expect(harness.controller.locator("#error")).toBeEmpty()
    expect(requestBodies).toHaveLength(3)
    expect(declaredToolNames(requestBodies[0])).toContain("browser_read_page")
    expect(requestBodies[0]?.input).toContainEqual(
      expect.objectContaining({
        role: "developer",
        content: expect.stringContaining(
          "The following tools are no longer available. Do not call them:\n- browser_click",
        ),
      }),
    )
    expect(JSON.stringify(requestBodies[1])).toContain("meadow-42")
    expect(requestBodies[2]?.input).toContainEqual(
      expect.objectContaining({
        type: "function_call_output",
        output: expect.stringContaining("Tool browser_click not found"),
      }),
    )
    await expect(harness.fixturePage.locator("#result")).toHaveText("idle")

    await harness.controller.setViewportSize({ width: 390, height: 844 })
    expect(
      await harness.controller.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true)
    const screenshotPath = testInfo.outputPath("extension-smoke.png")
    await harness.controller.screenshot({ path: screenshotPath, fullPage: true })
    await testInfo.attach("extension-smoke", {
      path: screenshotPath,
      contentType: "image/png",
    })

    await harness.controller.reload({ waitUntil: "domcontentloaded" })
    await expect(harness.controller.locator("#transcript")).toContainText(finalAnswer)
    await expect(harness.controller.locator("#sessions option")).toHaveCount(1)
    const savedSettingsTab = await harness.context.newPage()
    await savedSettingsTab.goto(`${harness.controller.url()}?view=settings`)
    await savedSettingsTab.getByRole("tab", { name: "Tools", exact: true }).click()
    await expect(
      savedSettingsTab.locator('#available-tools input[value="browser_click"]'),
    ).not.toBeChecked()
    await expect(
      savedSettingsTab.locator('#available-tools input[value="browser_read_page"]'),
    ).toBeChecked()
    await savedSettingsTab.close()
    await expect
      .poll(() =>
        harness.controller.evaluate(() => ({
          family: document.documentElement.dataset.fontFamily,
          size: document.documentElement.dataset.fontSize,
        })),
      )
      .toEqual({ family: "monospace", size: "18" })
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.context.unroute(CODEX_RESPONSES_URL).catch(() => undefined)
    await harness.close()
  }
})
