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
    await expect(settings.locator("#mcp-status")).toContainText(
      "Enabled for new runs. Tool metadata and results can go to the selected model.",
    )
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
    await expect(settings.locator("#mcp-status")).toContainText(
      "Enabled for new runs. Tool metadata and results can go to the selected model.",
    )
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
    expect(await settings.locator("body").textContent()).not.toContain("private token with spaces")
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
        success
          ? "Enabled for new runs. Tool metadata and results can go to the selected model."
          : "MCP request failed",
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

test("MCP server edits require explicit saves and Cancel keeps saved servers", async () => {
  const harness = await launchExtensionHarness()
  try {
    const settings = await harness.context.newPage()
    await settings.goto(`${harness.controller.url()}?view=settings`)
    const section = settings.locator('section[aria-labelledby="mcp-title"]')
    await expect(section).toContainText(
      "Configure up to 8 public HTTPS Streamable HTTP servers. Select New server to add another. A run supports up to 32 tools across all enabled servers.",
    )
    await expect(section).toContainText(
      "Select Save disconnected to save server edits and disable the server. Server actions save separately from Save settings. Cancel does not undo saved server changes.",
    )
    const readServers = () =>
      harness.controller.evaluate(() => chrome.storage.local.get("piBrowserAgentMcpServersV1"))
    const initial = await readServers()
    await settings.locator("#mcp-name").fill("First server")
    await settings.locator("#mcp-endpoint").fill("https://first.example.com/mcp")
    expect(await readServers()).toEqual(initial)
    await settings.getByRole("button", { name: "Save disconnected", exact: true }).click()
    await expect(settings.locator("#mcp-status")).toContainText("Saved disconnected")
    const firstId = await settings.locator("#mcp-server").inputValue()
    expect(firstId).not.toBe("")
    const firstSaved = await readServers()
    expect(firstSaved).toMatchObject({
      piBrowserAgentMcpServersV1: {
        servers: [
          {
            id: firstId,
            name: "First server",
            endpoint: "https://first.example.com/mcp",
            enabled: false,
          },
        ],
      },
    })

    await settings.locator("#mcp-name").fill("Updated first server")
    await settings.locator("#mcp-endpoint").fill("https://first.example.com/updated")
    expect(await readServers()).toEqual(firstSaved)
    await settings.getByRole("button", { name: "Save disconnected", exact: true }).click()
    await expect(settings.locator("#mcp-status")).toContainText("Saved disconnected")
    await settings.locator("#mcp-server").selectOption({ label: "New server" })
    await expect(settings.locator("#mcp-name")).toHaveValue("")
    await settings.locator("#mcp-name").fill("Second server")
    await settings.locator("#mcp-endpoint").fill("https://second.example.com/mcp")
    await settings.getByRole("button", { name: "Save disconnected", exact: true }).click()
    await expect(settings.locator("#mcp-status")).toContainText("Saved disconnected")
    const secondId = await settings.locator("#mcp-server").inputValue()
    expect(secondId).not.toBe(firstId)
    await expect(settings.locator("#mcp-server option")).toHaveText([
      "New server",
      "Updated first server",
      "Second server",
    ])
    const saved = await readServers()
    await settings.locator("#mcp-name").fill("Unsaved second server")
    await settings.locator("#mcp-endpoint").fill("https://second.example.com/unsaved")
    expect(await readServers()).toEqual(saved)
    const closed = settings.waitForEvent("close")
    await settings.getByRole("button", { name: "Cancel", exact: true }).click()
    await closed
    expect(await readServers()).toEqual(saved)

    const reopened = await harness.context.newPage()
    await reopened.goto(`${harness.controller.url()}?view=settings`)
    await expect(reopened.locator("#mcp-server option")).toHaveText([
      "New server",
      "Updated first server",
      "Second server",
    ])
    for (const [id, name, endpoint] of [
      [firstId, "Updated first server", "https://first.example.com/updated"],
      [secondId, "Second server", "https://second.example.com/mcp"],
    ] as const) {
      await reopened.locator("#mcp-server").selectOption(id)
      await expect(reopened.locator("#mcp-name")).toHaveValue(name)
      await expect(reopened.locator("#mcp-endpoint")).toHaveValue(endpoint)
      await expect(reopened.locator("#mcp-status")).toHaveText("Disabled")
    }
    await reopened.locator("#mcp-name").fill("Not saved by Save settings")
    await reopened.locator("#mcp-endpoint").fill("https://second.example.com/footer-unsaved")
    const savedAndClosed = reopened.waitForEvent("close")
    await reopened.getByRole("button", { name: "Save settings", exact: true }).click()
    await savedAndClosed
    expect(await readServers()).toEqual(saved)
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

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
