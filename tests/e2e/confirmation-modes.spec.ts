import { expect, test } from "@playwright/test"
import {
  configureMockCodex,
  type ExtensionHarness,
  launchExtensionHarness,
} from "./support/extension-harness.js"
import { CODEX_RESPONSES_URL, finalTextResponse, toolCallResponse } from "./support/mock-codex.js"

test.setTimeout(120_000)

async function routeBookmarkTurns(
  harness: ExtensionHarness,
  requested: { limit: number },
): Promise<void> {
  let responseIndex = 0
  await harness.context.route(CODEX_RESPONSES_URL, async (route) => {
    responseIndex += 1
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body:
        responseIndex % 2 === 1
          ? toolCallResponse(responseIndex, "browser_get_recent_bookmarks", {
              limit: requested.limit,
            })
          : finalTextResponse(responseIndex, `Read complete ${responseIndex / 2}`),
    })
  })
}

async function readBookmarks(
  harness: ExtensionHarness,
  turn: number,
  prompts: boolean,
  approve = true,
): Promise<void> {
  await harness.controller.locator("#prompt").fill(`Read recent bookmarks ${turn}`)
  await harness.controller.locator("#send").click()
  if (prompts) {
    await expect(harness.controller.locator("#confirm-dialog")).toBeVisible()
    await harness.controller
      .locator(`#confirm-dialog button[value="${approve ? "confirm" : "cancel"}"]`)
      .click()
  }
  await expect(harness.controller.locator("#transcript .message.assistant").last()).toContainText(
    `Read complete ${turn}`,
  )
  await expect(harness.controller.locator("#confirm-dialog")).toBeHidden()
}

for (const [mode, promptsAgain, promptsAfterRestart] of [
  ["strict", true, true],
  ["balanced", false, true],
  ["convenient", false, false],
] as const) {
  test(`${mode} scopes bookmark approval over a browser restart`, async () => {
    const harness = await launchExtensionHarness({ bookmarks: true })
    try {
      await configureMockCodex(harness)
      const settingsTab = await harness.context.newPage()
      await settingsTab.goto(`${harness.controller.url()}?view=settings`)
      await expect(settingsTab.locator("#confirmation-mode")).toHaveValue("balanced")
      await settingsTab.locator("#confirmation-mode").selectOption(mode)
      const settingsClosed = settingsTab.waitForEvent("close")
      await settingsTab.locator("#save-settings").click()
      await settingsClosed
      await harness.fixturePage.bringToFront()
      const requested = { limit: 1 }
      await routeBookmarkTurns(harness, requested)
      await readBookmarks(harness, 1, true)
      await harness.controller.reload()
      await harness.fixturePage.bringToFront()
      await readBookmarks(harness, 2, promptsAgain)
      requested.limit = 2
      await readBookmarks(harness, 3, true, false)
      await readBookmarks(harness, 4, true)
      requested.limit = 1
      if (mode === "balanced") {
        const cdp = await harness.context.browser()?.newBrowserCDPSession()
        if (!cdp) throw new Error("Missing browser CDP session")
        try {
          const targets = await cdp.send("Target.getTargets")
          const target = targets.targetInfos.find(
            (item) => item.type === "service_worker" && item.url === harness.worker.url(),
          )
          if (!target) throw new Error("Missing service worker target")
          await cdp.send("Target.closeTarget", { targetId: target.targetId })
          await harness.controller.evaluate(() =>
            chrome.runtime.sendMessage({
              kind: "request",
              requestId: crypto.randomUUID(),
              method: "app.getState",
              params: {},
            }),
          )
          await readBookmarks(harness, 5, false)
        } finally {
          await cdp.detach().catch(() => undefined)
        }
      }
      await harness.restart()
      await routeBookmarkTurns(harness, requested)
      await readBookmarks(harness, 1, promptsAfterRestart)
      if (mode === "convenient") {
        const revocationTab = await harness.context.newPage()
        await revocationTab.goto(`${harness.controller.url()}?view=settings`)
        await revocationTab.locator("#clear-confirmation-approvals").click()
        await expect(revocationTab.locator("#confirmation-approvals-status")).toHaveText(
          "Remembered approvals cleared",
        )
        await revocationTab.close()
        await harness.fixturePage.bringToFront()
        await readBookmarks(harness, 2, true)
        for (const nextMode of ["strict", "convenient"]) {
          const modeTab = await harness.context.newPage()
          await modeTab.goto(`${harness.controller.url()}?view=settings`)
          await modeTab.locator("#confirmation-mode").selectOption(nextMode)
          const closed = modeTab.waitForEvent("close")
          await modeTab.locator("#save-settings").click()
          await closed
        }
        await harness.fixturePage.bringToFront()
        await readBookmarks(harness, 3, true)
      }
      expect(harness.pageErrors).toEqual([])
    } finally {
      await harness.close()
    }
  })
}

test("WebMCP reuses only the same page, tool, and arguments", async () => {
  const harness = await launchExtensionHarness({ webMcp: true })
  try {
    await configureMockCodex(harness)
    const requested = { args: {} as Record<string, unknown>, name: "read_fixture_marker" }
    let responseIndex = 0
    await harness.context.route(CODEX_RESPONSES_URL, async (route) => {
      responseIndex += 1
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          responseIndex % 2 === 1
            ? toolCallResponse(responseIndex, "browser_webmcp", {
                action: "call",
                name: requested.name,
                arguments: requested.args,
              })
            : finalTextResponse(responseIndex, `WebMCP complete ${responseIndex / 2}`),
      })
    })
    const run = async (turn: number, prompts: boolean, approve = true) => {
      await harness.controller.locator("#prompt").fill(`Read WebMCP marker ${turn}`)
      await harness.controller.locator("#send").click()
      if (prompts) {
        await expect(harness.controller.locator("#confirm-dialog")).toBeVisible()
        await harness.controller
          .locator(`#confirm-dialog button[value="${approve ? "confirm" : "cancel"}"]`)
          .click()
      }
      await expect(
        harness.controller.locator("#transcript .message.assistant").last(),
      ).toContainText(`WebMCP complete ${turn}`)
    }
    await run(1, true)
    await run(2, false)
    requested.args = { changed: true }
    await run(3, true, false)
    requested.name = "unknown_tool"
    requested.args = {}
    await run(4, true, false)
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})
