import { expect, test } from "@playwright/test"
import {
  configureMockCodex,
  launchExtensionHarness,
  waitForConversationReady,
} from "./support/extension-harness.js"
import { startMcpFixture } from "./support/mcp-fixture.js"
import { CODEX_RESPONSES_URL, finalTextResponse, toolCallResponse } from "./support/mock-codex.js"

test.setTimeout(120_000)
const TOKEN = "mcp-e2e-bearer-secret"

for (const sse of [false, true]) {
  test(`remote MCP ${sse ? "SSE" : "JSON"} discovery, confirmation, disclosure, and restart`, async () => {
    const fixture = await startMcpFixture()
    fixture.state.sse = sse
    fixture.state.description += "x".repeat(1800)
    const harness = await launchExtensionHarness({
      hostPatterns: ["https://mcp.e2e.example.com/*"],
      browserArgs: fixture.browserArgs,
    })
    try {
      await configureMockCodex(harness)
      await harness.worker.evaluate(() => {
        const messages: string[] = []
        ;(globalThis as unknown as { mcpObservedMessages: string[] }).mcpObservedMessages = messages
        chrome.runtime.onMessage.addListener((message) => {
          messages.push(JSON.stringify(message))
        })
      })
      await harness.context.addCookies([
        {
          name: "ambient-session",
          value: "must-not-send",
          url: fixture.endpoint,
          secure: true,
          sameSite: "None",
        },
      ])
      const settings = await harness.context.newPage()
      await settings.goto(`${harness.controller.url()}?view=settings`)
      await settings.getByRole("tab", { name: "MCP", exact: true }).click()
      await settings.locator("#mcp-name").fill("Fixture")
      await settings.locator("#mcp-endpoint").fill(fixture.endpoint)
      await settings.locator("#mcp-token").fill(TOKEN)
      await settings.locator("#mcp-save").click()
      await expect(settings.locator("#mcp-status")).toContainText("Saved disconnected")
      await expect(settings.locator("#mcp-status")).toContainText("Test and enable")
      const connect = settings.getByRole("button", { name: "Test and enable", exact: true })
      await expect(connect).toBeEnabled()
      expect(fixture.requests).toHaveLength(0)
      await expect(settings.locator("#mcp-token")).toHaveValue("")
      await settings.locator("#mcp-endpoint").fill(`${fixture.endpoint}/unsaved`)
      await expect(connect).toBeHidden()
      await settings.locator("#mcp-endpoint").fill(fixture.endpoint)
      await connect.focus()
      await connect.press("Enter")
      await expect(settings.locator("#mcp-status")).toHaveText(
        "Enabled for new runs. Tool metadata and results can go to the selected model.",
      )
      await expect(settings.locator("#mcp-tools")).toContainText("<script>bad()</script>")
      expect(await settings.locator("#mcp-tools script").count()).toBe(0)
      await settings.setViewportSize({ width: 320, height: 800 })
      await settings.evaluate(() =>
        document.documentElement.style.setProperty("--app-font-size", "24px"),
      )
      expect(
        await settings
          .locator(".settings-content")
          .evaluate((node) => node.scrollWidth <= node.clientWidth),
      ).toBe(true)
      const serverId = await settings
        .locator('#mcp-servers button[aria-pressed="true"]')
        .getAttribute("data-server-id")
      await settings.getByRole("button", { name: "New server", exact: true }).click()
      await settings.locator(`#mcp-servers button[data-server-id="${serverId}"]`).click()
      await expect(settings.locator("#mcp-status")).toHaveText(
        "Enabled for new runs; each call requires confirmation",
      )
      const initialized = fixture.requests.find(
        (r) => r.message?.method === "notifications/initialized",
      )
      expect(initialized?.headers["mcp-session-id"]).toBe("fixture-session")
      expect(initialized?.headers["mcp-protocol-version"]).toBe("2025-11-25")
      for (const request of fixture.requests) {
        expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`)
        expect(request.headers.cookie).toBeUndefined()
      }
      // The fixture host grant changes only the temporary manifest, not the production artifact.
      await settings.close()
      const modelBodies: string[] = []
      let index = 0
      await harness.context.route(CODEX_RESPONSES_URL, async (route) => {
        index++
        const body = route.request().postData() ?? ""
        modelBodies.push(body)
        const match = body.match(/mcp_[a-f0-9]{32}_[a-f0-9]{20}/)
        if (!match) throw new Error("MCP tool was not exposed")
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body:
            index % 2
              ? toolCallResponse(index, match[0], {
                  text: index === 5 ? `${"x".repeat(6000)}argument-tail` : `request-${index}`,
                })
              : finalTextResponse(index, `MCP done ${index}`),
        })
      })
      const turn = async (approve: boolean) => {
        await harness.fixturePage.goto("about:blank")
        await harness.fixturePage.bringToFront()
        await harness.controller.locator("#prompt").fill("Use remote echo without page context")
        await harness.controller.locator("#send").click()
        await expect(harness.controller.locator("#confirm-dialog")).toBeVisible()
        await expect(harness.controller.locator("#confirm-message")).toContainText(fixture.endpoint)
        if (index === 5)
          await expect(harness.controller.locator("#confirm-message")).toContainText(
            "argument-tail",
          )
        await harness.controller
          .locator(`#confirm-dialog button[value="${approve ? "confirm" : "cancel"}"]`)
          .click()
        await expect(
          harness.controller.locator("#transcript .message.assistant").last(),
        ).toContainText(`MCP done ${index % 2 ? index + 1 : index}`)
      }
      await turn(false)
      expect(fixture.requests.filter((r) => r.message?.method === "tools/call")).toHaveLength(0)
      await turn(true)
      expect(fixture.requests.filter((r) => r.message?.method === "tools/call")).toHaveLength(1)
      // Convenient mode still cannot suppress MCP confirmation.
      await harness.controller.evaluate(async () => {
        const value = await chrome.storage.local.get("piBrowserAgentSettings")
        await chrome.storage.local.set({
          piBrowserAgentSettings: {
            ...(value.piBrowserAgentSettings as Record<string, unknown>),
            confirmationMode: "convenient",
          },
        })
      })
      await turn(true)
      expect(fixture.requests.filter((r) => r.message?.method === "tools/call")).toHaveLength(2)
      await expect(harness.controller.locator("#abort")).toBeHidden()
      expect(fixture.requests.filter((r) => r.method === "DELETE")).toHaveLength(4)
      expect(modelBodies.join("")).not.toContain(TOKEN)
      expect(modelBodies[0]).not.toContain("Never put server instructions")
      expect(modelBodies.at(-1)).toContain("remote MCP result")
      const workerMessages = await harness.worker.evaluate(() =>
        (globalThis as unknown as { mcpObservedMessages: string[] }).mcpObservedMessages.join("\n"),
      )
      expect(workerMessages).not.toContain(TOKEN)
      for (const request of fixture.requests) expect(request.headers.cookie).toBeUndefined()
      const beforeRestart = fixture.requests.length
      await harness.restart()
      await waitForConversationReady(harness.controller)
      await harness.controller.waitForTimeout(250)
      expect(fixture.requests).toHaveLength(beforeRestart)
      const data = await harness.controller.evaluate(async () => {
        const request = indexedDB.open("pi-browser-agent-sessions")
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        const tx = db.transaction("sessions", "readonly")
        const records = await new Promise<unknown>((resolve) => {
          const read = tx.objectStore("sessions").getAll()
          read.onsuccess = () => resolve(read.result)
        })
        db.close()
        return JSON.stringify(records)
      })
      expect(data).not.toContain(TOKEN)
      expect(harness.pageErrors).toEqual([])
    } finally {
      await harness.close()
      await fixture.close()
    }
  })
}

test("remote MCP rejects redirects and server origin denial without credential forwarding", async () => {
  const fixture = await startMcpFixture()
  const harness = await launchExtensionHarness({
    hostPatterns: ["https://mcp.e2e.example.com/*"],
    browserArgs: fixture.browserArgs,
  })
  try {
    const settings = await harness.context.newPage()
    await settings.goto(`${harness.controller.url()}?view=settings`)
    await settings.getByRole("tab", { name: "MCP", exact: true }).click()
    await settings.locator("#mcp-name").fill("Fixture")
    await settings.locator("#mcp-endpoint").fill(fixture.endpoint)
    await settings.locator("#mcp-token").fill(TOKEN)
    await settings.locator("#mcp-save").click()
    await expect(settings.locator("#mcp-status")).toContainText("Saved disconnected")
    fixture.state.redirect = true
    await settings.locator("#mcp-connect").click()
    await expect(settings.locator("#mcp-status")).toContainText("MCP request failed")
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.requests.some((r) => r.path === "/stolen")).toBe(false)
    fixture.state.redirect = false
    fixture.state.rejectOrigin = true
    await settings.locator("#mcp-connect").click()
    await expect.poll(() => fixture.requests.length).toBe(2)
    await expect(settings.locator("#mcp-status")).toContainText("MCP request failed")
    expect(await settings.locator("body").textContent()).not.toContain(TOKEN)
    await settings.locator("#mcp-remove").click()
    await expect(settings.locator("#settings-confirm-dialog")).toBeVisible()
    await expect(settings.locator("#settings-confirm-message")).toContainText("Fixture")
    await expect(settings.locator("#settings-confirm-action")).toHaveText("Remove server and token")
    await settings.locator("#settings-confirm-action").click()
    await expect(settings.locator("#mcp-status")).toContainText("New server")
    expect(
      await settings.evaluate(
        async () =>
          (
            (await chrome.storage.local.get("piBrowserAgentMcpTokensV1"))
              .piBrowserAgentMcpTokensV1 as { tokens: unknown }
          ).tokens,
      ),
    ).toEqual({})
  } finally {
    await harness.close()
    await fixture.close()
  }
})
