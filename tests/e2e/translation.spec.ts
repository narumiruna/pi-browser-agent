import { expect, test } from "@playwright/test"
import { menu, setupTranslation as setup } from "./support/translation.js"

test("blank-page menu translates inline without submitting chat, updates dynamic sources, and stops", async () => {
  const { harness, requests } = await setup()
  try {
    await harness.fixturePage.evaluate(() => {
      document.body.replaceChildren()
      const main = document.createElement("main")
      const article = document.createElement("article")
      const p = document.createElement("p")
      p.id = "source"
      p.textContent =
        "This is a sufficiently long paragraph about reliable browser translation and safe extension integration."
      article.append(p)
      main.append(article)
      document.body.append(main)
    })
    await expect(harness.controller.locator("#translation-stop")).toBeHidden()
    await menu(harness, "pi-translate-page")
    await expect(
      harness.fixturePage.locator('[data-ot-role="note-body"][data-state="ready"]'),
    ).toContainText("譯文", { timeout: 15000 })
    expect(requests()).toBeGreaterThan(0)
    await expect(harness.fixturePage.locator("#source")).toHaveText(
      "This is a sufficiently long paragraph about reliable browser translation and safe extension integration.",
    )
    await expect(harness.controller.locator(".user-message")).toHaveCount(0)
    await harness.fixturePage.locator("#source").evaluate((p) => {
      p.textContent =
        "A changed paragraph must replace its earlier result without duplicating the displayed translation."
    })
    await expect(
      harness.fixturePage.locator('[data-ot-role="note-body"][data-state="ready"]'),
    ).toContainText("changed paragraph")
    await expect(harness.fixturePage.locator('[data-ot-role="note"]')).toHaveCount(1)
    await harness.controller.locator("#translation-stop").click()
    await expect(harness.controller.locator("#translation-stop")).toBeHidden()
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("a cold conversation consumes one native intent and repeated warm invocations do not duplicate notes", async () => {
  const { harness, requests } = await setup()
  try {
    await harness.fixturePage.evaluate(() => {
      document.body.innerHTML =
        "<main><article><p>This owned paragraph verifies cold conversation startup and replacement without duplicate translated notes.</p></article></main>"
    })
    await harness.controller.close()
    await menu(harness, "pi-translate-page")
    expect(requests()).toBe(0)
    const opened = harness.context.waitForEvent("page")
    // An inactive extension tab models panel startup without changing the web target.
    await harness.worker.evaluate(() =>
      chrome.tabs.create({ active: false, url: chrome.runtime.getURL("sidebar/index.html") }),
    )
    harness.controller = await opened
    await expect(
      harness.fixturePage.locator('[data-ot-role="note-body"][data-state="ready"]'),
    ).toContainText("cold conversation startup")
    await menu(harness, "pi-translate-page")
    await menu(harness, "pi-translate-page")
    await expect(
      harness.fixturePage.locator('[data-ot-role="note-body"][data-state="ready"]'),
    ).toHaveCount(1)
    await expect(harness.controller.locator("#translation-stop")).toBeVisible()
    await expect(harness.controller.locator("#prompt")).toHaveValue("")
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("hidden and editable fields stay out of model input and table/flex layout remains valid", async () => {
  const { harness } = await setup()
  const sent: string[] = []
  try {
    harness.context.on("request", (request) => {
      if (request.url().includes("/codex/responses")) sent.push(request.postData() ?? "")
    })
    await harness.fixturePage.evaluate(() => {
      document.body.innerHTML = `<main><article><p>This owned visible paragraph explains safe extraction without hidden drafts or editable content.</p><div hidden>HIDDEN_UNSENT_VALUE</div><input value="INPUT_UNSENT_VALUE"><textarea>TEXTAREA_UNSENT_VALUE</textarea><div contenteditable>EDITABLE_UNSENT_VALUE</div><table><tr><td>This owned table cell contains a complete natural language explanation and keeps every note inside a valid cell.</td></tr></table><div style="display:flex;width:500px"><p id="flex-original">This owned flexible paragraph retains its original width after a translated note is placed safely outside the row.</p></div></article></main>`
    })
    const before = await harness.fixturePage.locator("#flex-original").boundingBox()
    await menu(harness, "pi-translate-page")
    await expect(
      harness.fixturePage.locator('table td [data-ot-role="note-body"][data-state="ready"]'),
    ).toContainText("譯文")
    await expect(
      harness.fixturePage.locator('[data-ot-role="note-body"][data-state="ready"]'),
    ).toHaveCount(3)
    expect(sent.join(" ")).not.toMatch(/(?:HIDDEN|INPUT|TEXTAREA|EDITABLE)_UNSENT_VALUE/)
    await expect(harness.fixturePage.locator("textarea")).toHaveValue("TEXTAREA_UNSENT_VALUE")
    const after = await harness.fixturePage.locator("#flex-original").boundingBox()
    expect(before).not.toBeNull()
    expect(after?.width).toBe(before?.width)
    await expect(harness.fixturePage.locator("table tr > [data-ot-role]")).toHaveCount(0)
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("selection translation uses the floating panel and ignores results after dismissal", async () => {
  const { harness } = await setup()
  try {
    await menu(
      harness,
      "pi-translate-selection",
      "A short selected sentence for an explicit translation.",
    )
    await expect(harness.fixturePage.locator('[data-ot-role="selection-panel"]')).toContainText(
      "譯文",
      { timeout: 15000 },
    )
    await expect(harness.controller.locator("#prompt")).toHaveValue("")
    await harness.fixturePage.locator('[data-ot-role="selection-panel-close"]').click()
    await expect(harness.fixturePage.locator('[data-ot-role="selection-panel"]')).toHaveCount(0)
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("Settings adds one Translation tab and previews without starting model requests", async () => {
  const { harness, requests } = await setup()
  try {
    const settings = await harness.context.newPage()
    await settings.goto(`${harness.controller.url()}?view=settings`)
    await settings.locator("#settings-tab-translation").click()
    await expect(settings.locator('[role="tab"]')).toHaveCount(7)
    await expect(settings.locator("#translation-targetLanguage")).toHaveValue(
      "Traditional Chinese (Taiwan)",
    )
    await settings.locator("#translation-targetLanguage").fill("Japanese")
    await expect(settings.locator("#save-settings")).toBeEnabled()
    expect(requests()).toBe(0)
    await settings.locator("#save-settings").click()
    await expect
      .poll(() =>
        harness.controller.evaluate(
          async () =>
            (await chrome.storage.local.get("piBrowserAgentTranslationSettingsV1"))
              .piBrowserAgentTranslationSettingsV1,
        ),
      )
      .toMatchObject({
        version: 1,
        settings: { targetLanguage: "Japanese", provider: "openai-codex" },
      })
    expect(requests()).toBe(0)
  } finally {
    await harness.close()
  }
})

test("Test Connection is explicit, serial, and bypasses the translation cache", async () => {
  const { harness, requests } = await setup()
  try {
    const settings = await harness.context.newPage()
    await settings.goto(`${harness.controller.url()}?view=settings`)
    await settings.locator("#settings-tab-translation").click()
    const connection = settings.getByRole("button", { name: "Test Connection", exact: true })
    await expect(connection).toBeEnabled()
    expect(requests()).toBe(0)
    await connection.evaluate((button) => {
      ;(button as HTMLButtonElement).click()
      ;(button as HTMLButtonElement).click()
    })
    await expect(settings.locator("#translation-settings [role=status]")).toContainText("譯文")
    expect(requests()).toBe(1)
    await connection.click()
    await expect.poll(() => requests()).toBe(2)
    await expect(connection).toBeEnabled()
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("appearance previews stay unsaved and concurrent translation fields merge without changing chat settings", async () => {
  const { harness, requests } = await setup()
  try {
    const open = async () => {
      const page = await harness.context.newPage()
      await page.goto(`${harness.controller.url()}?view=settings`)
      await page.locator("#settings-tab-translation").click()
      await expect(page.locator("#translation-targetLanguage")).toBeVisible()
      return page
    }
    const target = await open()
    const appearance = await open()
    await target.locator("#translation-targetLanguage").fill("Japanese")
    await appearance
      .locator("#translation-settings details")
      .filter({ has: appearance.locator("summary", { hasText: /^Translation appearance$/ }) })
      .locator("summary")
      .click()
    await appearance.locator("#translation-translationAppearance-inline-fontSizePx").fill("20")
    await expect(
      appearance
        .locator("#translation-settings p")
        .filter({ hasText: "Translation preview" })
        .first(),
    ).toHaveCSS("font-size", "20px")
    expect(requests()).toBe(0)
    const closed = target.waitForEvent("close")
    await target.locator("#save-settings").click()
    await closed
    const closedAppearance = appearance.waitForEvent("close")
    await appearance.locator("#save-settings").click()
    await closedAppearance
    const saved = await harness.controller.evaluate(
      async () =>
        (await chrome.storage.local.get("piBrowserAgentTranslationSettingsV1"))
          .piBrowserAgentTranslationSettingsV1,
    )
    expect(saved).toMatchObject({
      version: 1,
      settings: {
        targetLanguage: "Japanese",
        translationAppearance: { inline: { fontSizePx: 20 } },
      },
    })
    expect(requests()).toBe(0)
  } finally {
    await harness.close()
  }
})

test("a live owner rebinds after a real worker stop without replaying completed requests", async () => {
  const { harness, requests } = await setup()
  try {
    await harness.fixturePage.evaluate(() => {
      document.body.innerHTML =
        "<main><article><p>This long original paragraph is translated before stopping the extension service worker.</p></article></main>"
    })
    await menu(harness, "pi-translate-page")
    await expect(
      harness.fixturePage.locator('[data-ot-role="note-body"][data-state="ready"]'),
    ).toHaveCount(1)
    const completed = requests()
    const cdp = await harness.context.newCDPSession(harness.fixturePage)
    const { targetInfos } = await cdp.send("Target.getTargets")
    const target = targetInfos.find(
      (entry: { type: string; url: string }) =>
        entry.type === "service_worker" && entry.url.includes(harness.extensionId),
    )
    if (!target) throw new Error("Missing extension worker")
    await cdp.send("Target.closeTarget", { targetId: target.targetId })
    await harness.controller.evaluate(() =>
      chrome.runtime.sendMessage({
        kind: "request",
        requestId: "wake-translation-worker",
        method: "app.getState",
        params: {},
      }),
    )
    await expect(harness.controller.locator("#translation-stop")).toBeVisible()
    await harness.fixturePage.evaluate(() => {
      const p = document.createElement("p")
      p.textContent =
        "This newly inserted paragraph uses fresh routing in the same original authorized document."
      document.querySelector("article")?.append(p)
    })
    await expect(
      harness.fixturePage.locator('[data-ot-role="note-body"][data-state="ready"]'),
    ).toHaveCount(2, { timeout: 15000 })
    expect(requests()).toBe(completed + 1)
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})
