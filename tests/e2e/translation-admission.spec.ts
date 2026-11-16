import { expect, test } from "@playwright/test"
import { menu, setupTranslation } from "./support/translation.js"

test("a pending translation claim reserves Send and can be cancelled without publication", async () => {
  const { harness, requests } = await setupTranslation()
  try {
    await harness.fixturePage.evaluate(() => {
      document.body.innerHTML =
        "<main><article><p>This visible source tests translation startup ownership while its asynchronous capability claim is pending.</p></article></main>"
    })
    await harness.controller.evaluate(() => {
      const state = window as typeof window & { releaseReviewClaim?: () => void }
      const send = chrome.runtime.sendMessage.bind(chrome.runtime)
      chrome.runtime.sendMessage = ((message: { kind?: string; operation?: string }) => {
        if (message.kind === "translation" && message.operation === "claim")
          return new Promise((resolve) => {
            state.releaseReviewClaim = () => resolve(send(message))
          })
        return send(message)
      }) as typeof chrome.runtime.sendMessage
    })
    await menu(harness, "pi-translate-page")
    await expect
      .poll(() =>
        harness.controller.evaluate(
          () =>
            typeof (window as typeof window & { releaseReviewClaim?: () => void })
              .releaseReviewClaim,
        ),
      )
      .toBe("function")
    await expect(harness.controller.locator("#send")).toBeDisabled()
    await expect(harness.controller.locator("#translation-stop")).toBeVisible()
    await harness.controller.locator("#translation-stop").click()
    await harness.controller.evaluate(() =>
      (window as typeof window & { releaseReviewClaim?: () => void }).releaseReviewClaim?.(),
    )
    await expect(harness.controller.locator("#translation-stop")).toBeHidden()
    await expect(harness.fixturePage.locator('[data-ot-role="note"]')).toHaveCount(0)
    await expect(harness.controller.locator("#error")).toBeEmpty()
    expect(requests()).toBe(0)
  } finally {
    await harness.close()
  }
})

test("chat credential preflight rejects a competing translation intent", async () => {
  const { harness, requests } = await setupTranslation()
  try {
    await harness.controller.evaluate(() => {
      const state = window as typeof window & { reviewPermissionPending?: boolean }
      const get = chrome.storage.local.get.bind(chrome.storage.local) as (
        keys: string | string[] | Record<string, unknown> | null,
      ) => Promise<Record<string, unknown>>
      chrome.storage.local.get = ((keys: string | string[] | Record<string, unknown> | null) => {
        if (JSON.stringify(keys).includes("piBrowserAgentCredentialsV1")) {
          state.reviewPermissionPending = true
          return new Promise<Record<string, unknown>>((resolve) =>
            window.addEventListener("pagehide", () => resolve({}), { once: true }),
          )
        }
        return get(keys)
      }) as typeof chrome.storage.local.get
    })
    await harness.controller
      .locator("#prompt")
      .fill("Keep this prompt in preflight without dispatching a model request.")
    await harness.controller.locator("#send").click()
    await expect
      .poll(() =>
        harness.controller.evaluate(
          () =>
            (window as typeof window & { reviewPermissionPending?: boolean })
              .reviewPermissionPending,
        ),
      )
      .toBe(true)
    await menu(harness, "pi-translate-page")
    await expect(harness.controller.locator("#error")).toContainText(
      "Finish the current operation before translating",
    )
    await expect(harness.fixturePage.locator('[data-ot-role="note"]')).toHaveCount(0)
    expect(requests()).toBe(0)
  } finally {
    await harness.close()
  }
})
