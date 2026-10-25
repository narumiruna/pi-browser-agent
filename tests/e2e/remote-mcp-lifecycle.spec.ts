import { expect, type Page, test } from "@playwright/test"
import {
  configureMockCodex,
  launchExtensionHarness,
  waitForConversationReady,
} from "./support/extension-harness.js"
import { startMcpFixture } from "./support/mcp-fixture.js"
import { CODEX_RESPONSES_URL, finalTextResponse, toolCallResponse } from "./support/mock-codex.js"

test.setTimeout(120_000)

async function grantMcpHost(
  context: import("@playwright/test").BrowserContext,
  extensionId: string,
) {
  const permissions = await context.newPage()
  await permissions.goto("chrome://extensions/")
  await permissions.evaluate(async (id) => {
    const api = chrome as unknown as {
      developerPrivate: { addHostPermission(id: string, host: string): Promise<void> }
    }
    await api.developerPrivate.addHostPermission(id, "https://mcp.e2e.example.com/*")
  }, extensionId)
  await permissions.close()
}

async function saveServer(settings: Page, endpoint: string) {
  await settings.locator("#mcp-name").fill("Lifecycle fixture")
  await settings.locator("#mcp-endpoint").fill(endpoint)
  await settings.locator("#mcp-token").fill("lifecycle-private-token")
  await settings.locator("#mcp-save").click()
  await expect(settings.locator("#mcp-status")).toContainText("Saved disconnected")
}

test("Stop cancels discovery before any model request and permits a later new run", async () => {
  const fixture = await startMcpFixture()
  const harness = await launchExtensionHarness({ browserArgs: fixture.browserArgs })
  try {
    await configureMockCodex(harness)
    const settings = await harness.context.newPage()
    await settings.goto(`${harness.controller.url()}?view=settings`)
    await settings.getByRole("tab", { name: "MCP", exact: true }).click()
    await saveServer(settings, fixture.endpoint)
    await grantMcpHost(harness.context, harness.extensionId)
    await settings.locator("#mcp-connect").click()
    await expect(settings.locator("#mcp-status")).toContainText(
      "Enabled for new runs. Tool metadata and results can go to the selected model.",
    )
    let modelRequests = 0
    await harness.context.route(CODEX_RESPONSES_URL, async (route) => {
      modelRequests++
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: finalTextResponse(1, "Fresh run complete"),
      })
    })
    fixture.state.holdDiscovery = true
    await harness.fixturePage.goto("about:blank")
    await harness.fixturePage.bringToFront()
    await harness.controller.locator("#prompt").fill("Start discovery")
    await harness.controller.locator("#send").click()
    await expect
      .poll(() => fixture.requests.filter((r) => r.message?.method === "initialize").length)
      .toBe(2)
    await expect(harness.controller.locator("#abort")).toBeVisible()
    await expect(harness.controller.locator("#send")).toBeDisabled()
    await harness.controller.locator("#abort").click()
    await expect(harness.controller.locator("#error")).toContainText("MCP request failed")
    await expect.poll(() => fixture.state.cancelledDiscovery).toBe(1)
    expect(modelRequests).toBe(0)
    await expect(harness.controller.locator("#prompt")).toHaveValue("Start discovery")
    fixture.state.holdDiscovery = false
    await harness.controller.locator("#prompt").fill("Start a fresh run")
    await harness.controller.locator("#send").click()
    await expect(harness.controller.locator("#transcript")).toContainText("Fresh run complete")
    expect(modelRequests).toBe(1)
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
    await fixture.close()
  }
})

test("optional MCP host permission can be granted and revoked in Chrome", async () => {
  const fixture = await startMcpFixture()
  const harness = await launchExtensionHarness({ browserArgs: fixture.browserArgs })
  try {
    const settings = await harness.context.newPage()
    await settings.goto(`${harness.controller.url()}?view=settings`)
    await settings.getByRole("tab", { name: "MCP", exact: true }).click()
    await saveServer(settings, fixture.endpoint)
    await grantMcpHost(harness.context, harness.extensionId)
    await settings.locator("#mcp-connect").click()
    await expect(settings.locator("#mcp-status")).toContainText(
      "Enabled for new runs. Tool metadata and results can go to the selected model.",
    )
    expect(
      await settings.evaluate(() =>
        chrome.permissions.remove({ origins: ["https://mcp.e2e.example.com/*"] }),
      ),
    ).toBe(true)
    const before = fixture.requests.length
    await configureMockCodex(harness)
    await harness.fixturePage.goto("about:blank")
    await harness.fixturePage.bringToFront()
    await harness.controller.locator("#prompt").fill("Use MCP")
    await harness.controller.locator("#send").click()
    await expect(harness.controller.locator("#error")).toContainText("MCP request failed")
    expect(fixture.requests).toHaveLength(before)
  } finally {
    await harness.close()
    await fixture.close()
  }
})

for (const change of [
  "disable-confirmation",
  "token-in-flight",
  "remove-in-flight",
  "close-in-flight",
  "revoke-in-flight",
]) {
  test(`MCP ${change} cancels work without replay`, async () => {
    const fixture = await startMcpFixture()
    const harness = await launchExtensionHarness({ browserArgs: fixture.browserArgs })
    try {
      await configureMockCodex(harness)
      const settings = await harness.context.newPage()
      await settings.goto(`${harness.controller.url()}?view=settings`)
      await settings.getByRole("tab", { name: "MCP", exact: true }).click()
      await saveServer(settings, fixture.endpoint)
      await grantMcpHost(harness.context, harness.extensionId)
      await settings.locator("#mcp-connect").click()
      await expect(settings.locator("#mcp-status")).toContainText(
        "Enabled for new runs. Tool metadata and results can go to the selected model.",
      )
      let index = 0
      const modelBodies: string[] = []
      await harness.context.route(CODEX_RESPONSES_URL, async (route) => {
        index++
        const body = route.request().postData() ?? ""
        modelBodies.push(body)
        const name = body.match(/mcp_[a-f0-9]{32}_[a-f0-9]{20}/)?.[0]
        if (!name) throw new Error("Missing tool")
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body:
            index === 1
              ? toolCallResponse(index, name, { text: "private argument" })
              : finalTextResponse(index, "Lifecycle complete"),
        })
      })
      fixture.state.hold = true
      await harness.fixturePage.goto("about:blank")
      await harness.fixturePage.bringToFront()
      await harness.controller.locator("#prompt").fill("Use the remote tool")
      await harness.controller.locator("#send").click()
      await expect(harness.controller.locator("#confirm-dialog")).toBeVisible()
      if (change !== "disable-confirmation") {
        await harness.controller.locator('#confirm-dialog button[value="confirm"]').click()
        await expect
          .poll(() => fixture.requests.filter((r) => r.message?.method === "tools/call").length)
          .toBe(1)
      }
      switch (change) {
        case "disable-confirmation":
          await settings.locator("#mcp-disable").click()
          break
        case "token-in-flight":
          await settings.locator("#mcp-token").fill("replacement-private-token")
          await settings.locator("#mcp-save").click()
          break
        case "remove-in-flight":
          await settings.locator("#mcp-remove").click()
          break
        case "close-in-flight":
          await harness.controller.close()
          break
        case "revoke-in-flight":
          expect(
            await settings.evaluate(() =>
              chrome.permissions.remove({ origins: ["https://mcp.e2e.example.com/*"] }),
            ),
          ).toBe(true)
          break
      }
      if (change !== "close-in-flight") {
        await expect(harness.controller.locator("#confirm-dialog")).toBeHidden()
        await expect(
          harness.controller.locator("#transcript .message.assistant").last(),
        ).toContainText("Lifecycle complete")
      }
      if (change !== "disable-confirmation")
        await expect.poll(() => fixture.state.cancelledCalls).toBe(1)
      expect(fixture.requests.filter((r) => r.method === "DELETE")).toHaveLength(1)
      const calls = change === "disable-confirmation" ? 0 : 1
      expect(fixture.requests.filter((r) => r.message?.method === "tools/call")).toHaveLength(calls)
      expect(modelBodies.join("")).not.toContain("lifecycle-private-token")
      expect(modelBodies.join("")).not.toContain("replacement-private-token")
      const requestCount = fixture.requests.length
      fixture.state.hold = false
      await harness.restart()
      await waitForConversationReady(harness.controller)
      await harness.controller.waitForTimeout(200)
      expect(fixture.requests).toHaveLength(requestCount)
      expect(harness.pageErrors).toEqual([])
    } finally {
      await harness.close()
      await fixture.close()
    }
  })
}
