import { expect, test } from "@playwright/test"
import { configureMockCodex, launchExtensionHarness } from "./support/extension-harness.js"

test("restores the active session after a full Chrome restart", async () => {
  // Own the profile and expected ID instead of depending on an earlier test's session.
  const harness = await launchExtensionHarness()
  try {
    const previous = await harness.controller.locator("#sessions").inputValue()
    await harness.controller.locator("#new-session").click()
    await expect(harness.controller.locator("#sessions")).not.toHaveValue(previous)
    const savedSessionId = await harness.controller.locator("#sessions").inputValue()
    expect(savedSessionId).not.toBe("")
    await harness.restart()
    await expect(harness.controller.locator("#sessions")).toHaveValue(savedSessionId)
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("mock configuration waits for delayed conversation initialization after reload", async () => {
  const harness = await launchExtensionHarness()
  let configuring: Promise<void> | undefined
  try {
    await harness.controller.addInitScript(() => {
      const state = window as typeof window & {
        initializationGate?: { entered: boolean; release: () => void }
      }
      const original = chrome.storage.local.get.bind(chrome.storage.local)
      let release: () => void = () => undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      state.initializationGate = { entered: false, release }
      chrome.storage.local.get = (async (keys: string | string[] | null | undefined) => {
        if (keys === "piBrowserAgentSettings") {
          if (state.initializationGate) state.initializationGate.entered = true
          await gate
        }
        return original<Record<string, unknown>>(keys)
      }) as unknown as typeof chrome.storage.local.get
    })
    let ready = false
    const loaded = harness.controller.waitForEvent("domcontentloaded")
    configuring = configureMockCodex(harness).then(() => {
      ready = true
    })
    await loaded
    await expect
      .poll(() =>
        harness.controller.evaluate(
          () =>
            (window as typeof window & { initializationGate?: { entered: boolean } })
              .initializationGate?.entered,
        ),
      )
      .toBe(true)
    await expect(harness.controller.locator("body")).toHaveAttribute(
      "data-conversation-ready",
      "false",
    )
    expect(ready).toBe(false)
    await harness.controller.evaluate(() =>
      (
        window as typeof window & { initializationGate?: { release: () => void } }
      ).initializationGate?.release(),
    )
    await configuring
    expect(ready).toBe(true)
    await expect(harness.controller.locator("#auth-status")).toHaveAttribute(
      "data-logged-in",
      "true",
    )
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
    await configuring?.catch(() => undefined)
  }
})
