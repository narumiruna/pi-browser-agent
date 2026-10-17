import { expect, type Page, test } from "@playwright/test"
import { configureMockCodex, launchExtensionHarness } from "./support/extension-harness.js"
import { startMcpFixture } from "./support/mcp-fixture.js"
import { CODEX_RESPONSES_URL, finalTextResponse } from "./support/mock-codex.js"

test.setTimeout(120_000)

async function saveServer(page: Page, endpoint: string): Promise<void> {
  await page.locator("#mcp-name").fill("Review fixture")
  await page.locator("#mcp-endpoint").fill(endpoint)
  await page.locator("#mcp-token").fill("review-private-token")
  await page.locator("#mcp-save").click()
  await expect(page.locator("#mcp-status")).toContainText("Saved disconnected")
}

test("keeps text, images, and element chips after discovery fails; sends them once on retry", async () => {
  const fixture = await startMcpFixture()
  const harness = await launchExtensionHarness({
    hostPatterns: ["https://mcp.e2e.example.com/*"],
    browserArgs: fixture.browserArgs,
  })
  try {
    await configureMockCodex(harness)
    const settings = await harness.context.newPage()
    await settings.goto(`${harness.controller.url()}?view=settings`)
    await saveServer(settings, fixture.endpoint)
    await settings.locator("#mcp-connect").click()
    await expect(settings.locator("#mcp-status")).toContainText("Connected and enabled")
    await settings.close()
    await harness.fixturePage.bringToFront()
    const target = await harness.fixturePage.locator("#marker").boundingBox()
    if (!target) throw new Error("Missing fixture marker")
    await harness.controller.locator("#element-picker").click()
    await expect(harness.fixturePage.locator("[data-pi-browser-agent-element-picker]")).toHaveCount(
      1,
    )
    await harness.fixturePage.mouse.click(target.x + 10, target.y + target.height / 2)
    await expect(harness.controller.locator("#selected-elements")).toBeVisible()
    await harness.controller.evaluate(() => {
      const bytes = Uint8Array.from(
        atob(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        ),
        (char) => char.charCodeAt(0),
      )
      const clipboard = new DataTransfer()
      clipboard.items.add(new File([bytes], "review.png", { type: "image/png" }))
      document.querySelector("#prompt")?.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: clipboard,
          bubbles: true,
          cancelable: true,
        }),
      )
    })
    await expect(harness.controller.locator("#pasted-images img")).toHaveCount(1)
    const draft = "  Keep this complete draft  "
    await harness.controller.locator("#prompt").fill(draft)
    const modelBodies: string[] = []
    await harness.context.route(CODEX_RESPONSES_URL, async (route) => {
      modelBodies.push(route.request().postData() ?? "")
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: finalTextResponse(1, "Draft sent once"),
      })
    })
    fixture.state.status = 503
    await harness.controller.locator("#send").click()
    await expect(harness.controller.locator("#error")).toContainText("MCP request failed")
    await expect(harness.controller.locator("#prompt")).toHaveValue(draft)
    await expect(harness.controller.locator("#pasted-images img")).toHaveCount(1)
    await expect(harness.controller.locator("#selected-elements")).toBeVisible()
    expect(modelBodies).toHaveLength(0)
    fixture.state.status = 200
    await harness.controller.locator("#send").click()
    await expect(harness.controller.locator("#transcript")).toContainText("Draft sent once")
    await expect(harness.controller.locator("#prompt")).toHaveValue("")
    await expect(harness.controller.locator("#pasted-images")).toBeHidden()
    await expect(harness.controller.locator("#selected-elements")).toBeHidden()
    expect(modelBodies).toHaveLength(1)
    expect(modelBodies[0]).toContain("Keep this complete draft")
    expect(modelBodies[0]).toContain("meadow-42")
    expect(modelBodies[0]?.match(/data:image\/png;base64,/g)).toHaveLength(1)
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
    await fixture.close()
  }
})

test("keeps text edited during discovery after the original prompt is accepted", async () => {
  const fixture = await startMcpFixture()
  const harness = await launchExtensionHarness({
    hostPatterns: ["https://mcp.e2e.example.com/*"],
    browserArgs: fixture.browserArgs,
  })
  let release = (): void => undefined
  try {
    await configureMockCodex(harness)
    const settings = await harness.context.newPage()
    await settings.goto(`${harness.controller.url()}?view=settings`)
    await saveServer(settings, fixture.endpoint)
    await settings.locator("#mcp-connect").click()
    await expect(settings.locator("#mcp-status")).toContainText("Connected and enabled")
    await settings.close()
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let waiting = false
    await harness.context.route(fixture.endpoint, async (route) => {
      if (route.request().postDataJSON()?.method === "initialize") {
        waiting = true
        await gate
      }
      await route.continue()
    })
    const bodies: string[] = []
    await harness.context.route(CODEX_RESPONSES_URL, async (route) => {
      bodies.push(route.request().postData() ?? "")
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: finalTextResponse(1, "Original accepted"),
      })
    })
    await harness.fixturePage.goto("about:blank")
    await harness.fixturePage.bringToFront()
    await harness.controller.locator("#prompt").fill("Original draft")
    await harness.controller.locator("#send").click()
    await expect.poll(() => waiting).toBe(true)
    await harness.controller.locator("#prompt").fill("New unsent text")
    release()
    await expect(harness.controller.locator("#transcript")).toContainText("Original accepted")
    await expect(harness.controller.locator("#prompt")).toHaveValue("New unsent text")
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain("Original draft")
    expect(bodies[0]).not.toContain("New unsent text")
  } finally {
    release()
    await harness.close()
    await fixture.close()
  }
})

test("shows safe local validation messages without any remote request", async () => {
  const fixture = await startMcpFixture()
  const harness = await launchExtensionHarness({ browserArgs: fixture.browserArgs })
  try {
    const settings = await harness.context.newPage()
    await settings.goto(`${harness.controller.url()}?view=settings`)
    await settings.locator("#mcp-endpoint").fill(fixture.endpoint)
    await settings.locator("#mcp-save").click()
    await expect(settings.locator("#mcp-status")).toContainText("server name")
    await settings.locator("#mcp-name").fill("Valid name")
    await settings.locator("#mcp-endpoint").fill("http://mcp.example.com/mcp")
    await settings.locator("#mcp-save").click()
    await expect(settings.locator("#mcp-status")).toContainText("public HTTPS")
    await settings.locator("#mcp-endpoint").fill(fixture.endpoint)
    for (const token of ["a", "private token with spaces"]) {
      await settings.locator("#mcp-token").fill(token)
      await settings.locator("#mcp-save").click()
      await expect(settings.locator("#mcp-status")).toContainText("16 to 4096")
      await expect(settings.locator("#mcp-token")).toHaveValue("")
    }
    expect(await settings.locator("body").innerText()).not.toContain("private token with spaces")
    expect(fixture.requests).toHaveLength(0)
  } finally {
    await harness.close()
    await fixture.close()
  }
})

for (const success of [true, false]) {
  test(`a ${success ? "successful" : "failed"} preview stays isolated and survives unrelated permission removal`, async () => {
    const fixture = await startMcpFixture()
    const harness = await launchExtensionHarness({
      hostPatterns: ["https://mcp.e2e.example.com/*"],
      browserArgs: fixture.browserArgs,
    })
    let release = (): void => undefined
    try {
      await configureMockCodex(harness)
      const settings = await harness.context.newPage()
      await settings.goto(`${harness.controller.url()}?view=settings`)
      await saveServer(settings, fixture.endpoint)
      const permissions = await harness.context.newPage()
      await permissions.goto("chrome://extensions/")
      await permissions.evaluate(async (id) => {
        const api = chrome as unknown as {
          developerPrivate: { addHostPermission(id: string, origin: string): Promise<void> }
        }
        await api.developerPrivate.addHostPermission(id, "https://unrelated.example.org/*")
      }, harness.extensionId)
      await permissions.close()
      expect(
        await settings.evaluate(() =>
          chrome.permissions.request({ origins: ["https://unrelated.example.org/*"] }),
        ),
      ).toBe(true)
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let waiting = false
      await harness.context.route(fixture.endpoint, async (route) => {
        if (route.request().postDataJSON()?.method === "initialize") {
          waiting = true
          await gate
        }
        await route.continue()
      })
      await settings.locator("#mcp-connect").click()
      await expect.poll(() => waiting).toBe(true)
      expect(
        await settings.evaluate(async () => {
          const event = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("No permission removal event")), 5000)
            const listener = () => {
              clearTimeout(timer)
              chrome.permissions.onRemoved.removeListener(listener)
              resolve()
            }
            chrome.permissions.onRemoved.addListener(listener)
          })
          if (
            !(await chrome.permissions.remove({ origins: ["https://unrelated.example.org/*"] }))
          ) {
            throw new Error("Optional grant was not removed")
          }
          await event
          return chrome.permissions.contains({ origins: ["https://mcp.e2e.example.com/*"] })
        }),
      ).toBe(true)
      const record = () =>
        settings.evaluate(async () => {
          const stored = await chrome.storage.local.get("piBrowserAgentMcpServersV1")
          return (
            stored.piBrowserAgentMcpServersV1 as {
              servers: { enabled: boolean; approved: boolean }[]
            }
          ).servers[0]
        })
      expect(await record()).toMatchObject({ enabled: false, approved: false })
      expect(fixture.requests).toHaveLength(0)
      const bodies: string[] = []
      await harness.context.route(CODEX_RESPONSES_URL, async (route) => {
        bodies.push(route.request().postData() ?? "")
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: finalTextResponse(bodies.length, `Concurrent run ${bodies.length}`),
        })
      })
      await harness.fixturePage.goto("about:blank")
      await harness.fixturePage.bringToFront()
      await harness.controller.locator("#prompt").fill("Answer while preview is pending")
      await harness.controller.locator("#send").click()
      await expect(harness.controller.locator("#transcript")).toContainText("Concurrent run 1")
      expect(bodies[0]).not.toMatch(/mcp_[a-f0-9]{32}_/)
      expect(bodies[0]).not.toContain("Untrusted fixture tool")
      expect(fixture.requests).toHaveLength(0)
      fixture.state.status = success ? 200 : 503
      release()
      await expect(settings.locator("#mcp-status")).toContainText(
        success ? "Connected and enabled" : "MCP request failed",
      )
      expect(await record()).toMatchObject({ enabled: success, approved: success })
      const before = fixture.requests.length
      await harness.controller.locator("#prompt").fill("Answer after preview ends")
      await harness.controller.locator("#send").click()
      await expect(harness.controller.locator("#transcript")).toContainText("Concurrent run 2")
      if (success) expect(bodies[1]).toMatch(/mcp_[a-f0-9]{32}_/)
      else {
        expect(bodies[1]).not.toMatch(/mcp_[a-f0-9]{32}_/)
        expect(fixture.requests).toHaveLength(before)
      }
      expect(fixture.requests.some((request) => request.message?.method === "tools/call")).toBe(
        false,
      )
      expect(harness.pageErrors).toEqual([])
    } finally {
      release()
      await harness.close()
      await fixture.close()
    }
  })
}

test("a stale Settings tab cannot replace or remove newer server data or its token", async () => {
  const fixture = await startMcpFixture()
  const harness = await launchExtensionHarness({ browserArgs: fixture.browserArgs })
  try {
    const first = await harness.context.newPage()
    await first.goto(`${harness.controller.url()}?view=settings`)
    await saveServer(first, fixture.endpoint)
    const id = await first.locator("#mcp-server").inputValue()
    const second = await harness.context.newPage()
    await second.goto(`${harness.controller.url()}?view=settings`)
    await second.locator("#mcp-server").selectOption(id)
    await second.locator("#mcp-name").fill("Newer name")
    await second.locator("#mcp-endpoint").fill(`${fixture.endpoint}/new`)
    await second.locator("#mcp-token").fill("replacement-token-value")
    await second.locator("#mcp-save").click()
    await expect(second.locator("#mcp-status")).toContainText("Saved disconnected")
    const read = () =>
      second.evaluate(() =>
        chrome.storage.local.get(["piBrowserAgentMcpServersV1", "piBrowserAgentMcpTokensV1"]),
      )
    const current = await read()
    await first.locator("#mcp-save").click()
    await expect(first.locator("#mcp-status")).toContainText("Reload Settings")
    expect(await read()).toEqual(current)
    await first.locator("#mcp-remove").click()
    await expect(first.locator("#mcp-status")).toContainText("Reload Settings")
    expect(await read()).toEqual(current)
    await second.locator("#mcp-remove").click()
    await expect(second.locator("#mcp-status")).toContainText("New server")
    const removed = await read()
    expect(removed.piBrowserAgentMcpServersV1).toEqual({ version: 1, servers: [] })
    expect(removed.piBrowserAgentMcpTokensV1).toEqual({ version: 1, tokens: {} })
    expect(fixture.requests).toHaveLength(0)
  } finally {
    await harness.close()
    await fixture.close()
  }
})
