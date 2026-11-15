import { expect, test } from "@playwright/test"
import { encryptedPdf, pdfFixture, pdfPages } from "./support/pdf-fixture.js"
import { menu, setupTranslation } from "./support/translation.js"

test("packaged PDF reader renders selectable originals and translates local bytes without a worker credential bridge", async () => {
  const { harness, requests } = await setupTranslation()
  try {
    const reader = await harness.context.newPage()
    await reader.goto(`chrome-extension://${harness.extensionId}/pages/pdf.html`)
    await expect(reader.locator("#local-file")).toBeEnabled()
    expect(
      await reader.evaluate(async () => {
        for (const name of ["jbig2.wasm", "openjpeg.wasm", "qcms_bg.wasm"])
          await WebAssembly.compile(
            await (await fetch(chrome.runtime.getURL(`pdf/wasm/${name}`))).arrayBuffer(),
          )
        return true
      }),
    ).toBe(true)
    await reader
      .locator("#local-file")
      .setInputFiles({ name: "owned.pdf", mimeType: "application/pdf", buffer: pdfFixture() })
    await expect(reader.locator(".text-layer")).toContainText("reliable browser PDF reader", {
      timeout: 15000,
    })
    expect(requests()).toBe(0)
    await reader.locator("#pdf-approve").click()
    await expect(reader.locator(".translation-block[data-state=ready]")).toContainText("譯文", {
      timeout: 15000,
    })
    await expect(reader.locator(".pdf-page canvas")).toHaveCount(1)
    await reader.locator("#translation-search").fill("absent-sentence")
    await expect(reader.locator(".translation-block[data-state=ready]")).toBeHidden()
    await reader.locator("#translation-search").fill("")
    await expect(reader.locator(".translation-block[data-state=ready]")).toBeVisible()
    const before = requests()
    await reader.locator("#local-file").setInputFiles({
      name: "broken.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("not a PDF"),
    })
    await expect(reader.locator("#error")).toBeVisible()
    await expect(reader.locator(".text-layer")).toContainText("reliable browser PDF reader")
    expect(requests()).toBe(before)
    await reader.locator("#cancel-translation").click()
    await expect(reader.locator("#pdf-approve")).toBeVisible()
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("Cancel then the first explicit Start restarts PDF translation without losing completed text", async () => {
  const { harness, requests } = await setupTranslation()
  try {
    const reader = await harness.context.newPage()
    await reader.goto(`chrome-extension://${harness.extensionId}/pages/pdf.html`)
    await expect(reader.locator("#local-file")).toBeEnabled()
    await reader
      .locator("#local-file")
      .setInputFiles({ name: "restart.pdf", mimeType: "application/pdf", buffer: pdfFixture() })
    await reader.locator("#pdf-approve").click()
    const notes = reader.locator(".translation-block[data-state=ready]")
    await expect(notes).toBeVisible()
    const text = await notes.textContent()
    const completed = requests()
    await reader.locator("#cancel-translation").click()
    await expect(reader.locator("#pdf-approve")).toBeVisible()
    await expect(reader.locator("#pdf-approve")).toBeEnabled()
    expect(requests()).toBe(completed)
    await reader.locator("#pdf-approve").click()
    await expect(reader.locator("#pdf-approve")).toBeHidden()
    await expect(reader.locator("#cancel-translation")).toBeEnabled()
    await expect(notes).toHaveText(text ?? "")
    await expect(reader.locator("#error")).toBeHidden()
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("encrypted PDF passwords stay in memory and wrong passwords can be corrected", async () => {
  const { harness, requests } = await setupTranslation()
  try {
    const reader = await harness.context.newPage()
    await reader.goto(`chrome-extension://${harness.extensionId}/pages/pdf.html`)
    await expect(reader.locator("#local-file")).toBeEnabled()
    await reader.locator("#local-file").setInputFiles({
      name: "encrypted.pdf",
      mimeType: "application/pdf",
      buffer: encryptedPdf("reader-private-password"),
    })
    await expect(reader.locator("#password-dialog")).toBeVisible()
    await reader.locator("#pdf-password").fill("wrong-password")
    await reader.locator("#submit-password").click()
    await expect(reader.locator("#password-dialog p")).toContainText("incorrect")
    await reader.locator("#pdf-password").fill("reader-private-password")
    await reader.locator("#pdf-password").press("Enter")
    await expect(reader.locator(".text-layer")).toContainText("encrypted owned document")
    await expect(reader.locator("#pdf-password")).toHaveValue("")
    expect(requests()).toBe(0)
    const storage = await reader.evaluate(async () =>
      JSON.stringify([
        await chrome.storage.local.get(null),
        await chrome.storage.session.get(null),
      ]),
    )
    expect(storage).not.toContain("reader-private-password")
    await reader.locator("#pdf-approve").click()
    await expect(reader.locator(".translation-block[data-state=ready]")).toContainText("譯文")
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("six-page originals remain navigable and changing the target never reuses old rendered translations", async () => {
  const { harness, requests } = await setupTranslation()
  try {
    const reader = await harness.context.newPage()
    await reader.goto(`chrome-extension://${harness.extensionId}/pages/pdf.html`)
    await expect(reader.locator("#local-file")).toBeEnabled()
    const texts = Array.from(
      { length: 6 },
      (_value, index) =>
        `Unique paragraph ${index + 1} explains browser translation and safe document navigation with selectable original content.`,
    )
    await reader.locator("#local-file").setInputFiles({
      name: "six-pages.pdf",
      mimeType: "application/pdf",
      buffer: pdfPages(texts),
    })
    await expect(reader.locator(".pdf-page")).toHaveCount(6)
    await reader.locator("#pdf-approve").click()
    await expect(reader.locator(".translation-block[data-state=ready]").first()).toContainText(
      "Unique paragraph 1",
    )
    await expect(reader.locator("#translate-all")).toBeEnabled()
    let confirmed = false
    reader.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("characters")
      confirmed = true
      await dialog.accept()
    })
    await reader.locator("#translate-all").click()
    await expect.poll(() => confirmed).toBe(true)
    for (let count = 0; count < 5; count++) await reader.locator("#next-page").click()
    await expect(reader.locator(".translation-block[data-state=ready]")).toHaveCount(6)
    const before = requests()
    await reader.evaluate(async () => {
      const key = "piBrowserAgentTranslationSettingsV1"
      const record = (await chrome.storage.local.get(key))[key] as {
        version: 1
        settings: Record<string, unknown>
      }
      await chrome.storage.local.set({
        [key]: { ...record, settings: { ...record.settings, targetLanguage: "Japanese" } },
      })
    })
    await expect(reader.locator("#pdf-approve")).toBeVisible()
    await reader.locator("#pdf-approve").click()
    await expect.poll(() => requests()).toBeGreaterThan(before)
    await expect(reader.locator(".translation-block[data-state=ready]").first()).toContainText(
      "日本語",
    )
    expect(
      (await reader.locator(".translation-block[data-state=ready]").allTextContents()).some(
        (text) => text.includes("譯文"),
      ),
    ).toBe(false)
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

for (const cancellation of ["Cancel", "local replacement", "settings change"] as const)
  test(`a stalled remote PDF source aborts on ${cancellation} without stale loading or replay`, async () => {
    const { harness, requests } = await setupTranslation()
    let pending = 0
    let cancelled = 0
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const source = `${new URL(harness.fixtureUrl).origin}/pending.pdf`
    try {
      harness.context.on("requestfailed", (request) => {
        if (request.url() === source) cancelled++
      })
      await harness.context.route(source, async (route) => {
        if (route.request().isNavigationRequest()) {
          await route.fulfill({
            contentType: "text/html",
            body: "<p>Explicit PDF launch fixture</p>",
          })
          return
        }
        pending++
        await gate
        await route
          .fulfill({ contentType: "application/pdf", body: pdfFixture() })
          .catch(() => undefined)
      })
      await harness.fixturePage.goto(source)
      const opened = harness.context.waitForEvent("page")
      await menu(harness, "pi-translate-pdf")
      const reader = await opened
      await expect.poll(() => pending).toBe(1)
      if (cancellation === "Cancel") await reader.locator("#cancel-translation").click()
      else if (cancellation === "local replacement") {
        await reader.locator("#local-file").setInputFiles({
          name: "replacement.pdf",
          mimeType: "application/pdf",
          buffer: pdfFixture(),
        })
      } else
        await reader.evaluate(async () => {
          const key = "piBrowserAgentTranslationSettingsV1"
          const stored = (await chrome.storage.local.get(key))[key] as {
            version: 1
            settings: Record<string, unknown>
          }
          await chrome.storage.local.set({
            [key]: { ...stored, settings: { ...stored.settings, targetLanguage: "Japanese" } },
          })
        })
      await expect.poll(() => cancelled).toBe(1)
      release()
      if (cancellation === "local replacement") {
        await expect(reader.locator("#document-title")).toHaveText("replacement")
        await expect(reader.locator(".translation-block[data-state=ready]")).toBeVisible()
      } else {
        await expect(reader.locator("#pdf-approve")).toBeVisible()
        await expect(reader.locator(".pdf-page")).toHaveCount(0)
        expect(requests()).toBe(0)
      }
      expect(pending).toBe(1)
      expect(harness.pageErrors).toEqual([])
    } finally {
      release()
      await harness.close()
    }
  })

test("PDF menu keeps the original tab and opens a tab-bound reader without leaking its source URL into the fragment", async () => {
  const { harness } = await setupTranslation()
  try {
    const source = `${new URL(harness.fixtureUrl).origin}/owned.pdf?private-signed-query=example`
    await harness.context.route("**/owned.pdf?*", (route) =>
      route.fulfill({ contentType: "application/pdf", body: pdfFixture() }),
    )
    await harness.fixturePage.goto(source)
    const opened = harness.context.waitForEvent("page")
    await menu(harness, "pi-translate-pdf")
    const reader = await opened
    await expect(reader.locator(".translation-block[data-state=ready]")).toContainText("譯文", {
      timeout: 15000,
    })
    expect(reader.url()).toBe(`chrome-extension://${harness.extensionId}/pages/pdf.html`)
    expect(reader.url()).not.toContain("private-signed-query")
    expect(harness.fixturePage.isClosed()).toBe(false)
    expect(harness.fixturePage.url()).toBe(source)
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})
