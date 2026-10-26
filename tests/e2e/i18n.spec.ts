import { expect, type Locator, type Page, type TestInfo, test } from "@playwright/test"
import {
  configureMockCodex,
  type ExtensionHarness,
  launchExtensionHarness,
  waitForConversationReady,
} from "./support/extension-harness.js"
import { CODEX_RESPONSES_URL, finalTextResponse, toolCallResponse } from "./support/mock-codex.js"

// Independent label fixtures: do not derive the primary localization assertion from the catalogs.
const sendLabels = {
  en: "Send",
  "zh-TW": "傳送",
  ja: "送信",
  ko: "보내기",
  es: "Enviar",
  fr: "Envoyer",
  de: "Senden",
  pt: "Enviar",
  "pt-BR": "Enviar",
  it: "Invia",
  nl: "Verzenden",
  pl: "Wyślij",
  tr: "Gönder",
  ru: "Отправить",
  id: "Kirim",
  vi: "Gửi",
  th: "ส่ง",
  hi: "भेजें",
} as const

type Locale = keyof typeof sendLabels
const locales = Object.keys(sendLabels) as Locale[]
const sections = ["model", "tools", "mcp", "skills", "appearance", "instructions"] as const
const visibleControls =
  'button:visible, input:visible:not([aria-hidden="true"]), select:visible:not([aria-hidden="true"]), textarea:visible, summary:visible'

async function blockExternalRequests(harness: ExtensionHarness): Promise<string[]> {
  const requests: string[] = []
  await harness.context.route("https://**/*", async (route) => {
    requests.push(route.request().url())
    await route.fulfill({ status: 500, body: "Unexpected external request in localization test" })
  })
  return requests
}

async function openView(harness: ExtensionHarness, view: "settings" | "microphone"): Promise<Page> {
  const page = await harness.context.newPage()
  const url = new URL(harness.controller.url())
  url.search = new URLSearchParams({ view }).toString()
  await page.goto(url.href, { waitUntil: "domcontentloaded" })
  await expect(
    page.locator(view === "settings" ? "#settings-page" : "#microphone-access-page"),
  ).toBeVisible()
  if (view === "settings") await expect(page.locator("#provider-search")).toBeEnabled()
  return page
}

async function appearance(page: Page): Promise<void> {
  await page.locator("#settings-tab-appearance").click()
  await expect(page.locator("#language option")).toHaveCount(19)
}

async function saveAndClose(page: Page): Promise<void> {
  const closed = page.waitForEvent("close")
  await page.locator("#save-settings").click()
  await closed
}

async function saveLanguage(harness: ExtensionHarness, language: Locale | "auto"): Promise<void> {
  const page = await openView(harness, "settings")
  await appearance(page)
  await page.locator("#language").selectOption(language)
  await saveAndClose(page)
}

async function seedSettings(
  harness: ExtensionHarness,
  values: { language: Locale | "auto"; fontSize?: number },
): Promise<void> {
  await harness.controller.evaluate(async (values) => {
    const stored = await chrome.storage.local.get<{
      piBrowserAgentSettings?: Record<string, unknown>
    }>("piBrowserAgentSettings")
    await chrome.storage.local.set({
      piBrowserAgentSettings: { ...stored.piBrowserAgentSettings, ...values },
    })
  }, values)
}

async function storedLanguage(harness: ExtensionHarness): Promise<unknown> {
  return harness.controller.evaluate(async () => {
    const stored = await chrome.storage.local.get<{
      piBrowserAgentSettings?: { language?: unknown }
    }>("piBrowserAgentSettings")
    return stored.piBrowserAgentSettings?.language
  })
}

async function expectLocale(page: Page, locale: Locale): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("lang", locale)
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr")
  if (
    (await page.locator("#send").isVisible()) &&
    (await page.locator("body").getAttribute("data-state")) !== "running"
  ) {
    await expect(page.locator("#send")).toHaveAccessibleName(sendLabels[locale])
  }
}

async function sessions(page: Page): Promise<unknown[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("pi-browser-agent-sessions", 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<unknown[]>((resolve, reject) => {
        const request = database.transaction("sessions").objectStore("sessions").getAll()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    } finally {
      database.close()
    }
  })
}

test("English overrides a Chinese browser; language drafts save, discard, reopen, and survive restart", async () => {
  // This test owns a persistent profile and exercises a full browser restart.
  test.setTimeout(60_000)
  const harness = await launchExtensionHarness({ locale: "zh-TW" })
  try {
    const requests = await blockExternalRequests(harness)
    expect(await harness.controller.evaluate(() => navigator.language)).toBe("zh-TW")
    await expectLocale(harness.controller, "en")
    await seedSettings(harness, { language: "en" })
    const before = await sessions(harness.controller)
    const sessionId = await harness.controller.locator("#sessions").inputValue()
    await harness.controller.locator("#prompt").fill("Unsent user content 日本語 العربية")
    const microphone = await openView(harness, "microphone")
    const englishMicrophoneTitle = await microphone.title()
    await saveLanguage(harness, "auto")
    await expectLocale(harness.controller, "zh-TW")
    await expectLocale(microphone, "zh-TW")
    await expect(microphone).not.toHaveTitle(englishMicrophoneTitle)

    const draft = await openView(harness, "settings")
    await appearance(draft)
    await expect(draft.locator("#language")).toHaveValue("auto")
    expect(
      await draft
        .locator("#language option")
        .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)),
    ).toEqual(["auto", ...locales])
    await draft.locator("#language").selectOption("ja")
    await expectLocale(draft, "zh-TW")
    await expectLocale(harness.controller, "zh-TW")
    expect(await storedLanguage(harness)).toBe("auto")
    await draft.locator("#cancel-settings").click()
    await expect(draft.locator("#settings-confirm-dialog")).toBeVisible()
    const discarded = draft.waitForEvent("close")
    await draft.locator("#settings-confirm-action").click()
    await discarded
    expect(await storedLanguage(harness)).toBe("auto")
    const reopened = await openView(harness, "settings")
    await appearance(reopened)
    await expect(reopened.locator("#language")).toHaveValue("auto")
    await reopened.locator("#language").selectOption("ja")
    await saveAndClose(reopened)
    await expectLocale(harness.controller, "ja")
    await expectLocale(microphone, "ja")
    await expect(harness.controller.locator("#prompt")).toBeFocused()
    await expect(harness.controller.locator("#prompt")).toHaveValue(
      "Unsent user content 日本語 العربية",
    )
    await expect(harness.controller.locator("#sessions")).toHaveValue(sessionId)
    expect(await sessions(harness.controller)).toEqual(before)
    expect(requests).toEqual([])

    await harness.restart()
    const restartedRequests = await blockExternalRequests(harness)
    expect(await harness.controller.evaluate(() => navigator.language)).toBe("zh-TW")
    await expectLocale(harness.controller, "ja")
    await expect(harness.controller.locator("#sessions")).toHaveValue(sessionId)
    const persisted = await openView(harness, "settings")
    await appearance(persisted)
    await expect(persisted.locator("#language")).toHaveValue("ja")
    await persisted.close()
    // Restart can update session timestamps. Only the following language save must be inert.
    const restartedSessions = await sessions(harness.controller)
    await saveLanguage(harness, "en")
    await expectLocale(harness.controller, "en")
    expect(await sessions(harness.controller)).toEqual(restartedSessions)
    expect(restartedRequests).toEqual([])
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

for (const [browserLocale, expected] of [
  ["zh-TW", "zh-TW"],
  ["zh-Hant", "zh-TW"],
  ["zh-HK", "zh-TW"],
  ["zh-MO", "zh-TW"],
  ["pt-BR", "pt-BR"],
  ["pt-PT", "pt"],
  ["pt-AO", "pt"],
  ["zh-Hans", "en"],
  ["zh-Hans-TW", "en"],
  ["zh-CN", "en"],
  ["zh-SG", "en"],
  ["zh", "en"],
  ["ar", "en"],
  ["he", "en"],
] as const) {
  test(`Follow browser resolves ${browserLocale} to ${expected}`, async () => {
    const harness = await launchExtensionHarness({ locale: browserLocale })
    try {
      const requests = await blockExternalRequests(harness)
      await saveLanguage(harness, "auto")
      await expectLocale(harness.controller, expected)
      expect(await storedLanguage(harness)).toBe("auto")
      expect(requests).toEqual([])
      expect(harness.pageErrors).toEqual([])
    } finally {
      await harness.close()
    }
  })
}

test("unsupported Chinese and RTL preferences continue to the next supported browser language", async () => {
  const harness = await launchExtensionHarness({ locale: "zh-CN" })
  try {
    const requests = await blockExternalRequests(harness)
    // The browser-context locale supplies one preference. Override only this test page to test ordering.
    await harness.controller.addInitScript(() => {
      Object.defineProperty(navigator, "languages", { get: () => ["zh-Hans", "ar", "ja-JP", "en"] })
    })
    await seedSettings(harness, { language: "auto" })
    await harness.controller.reload({ waitUntil: "domcontentloaded" })
    await waitForConversationReady(harness.controller)
    await expectLocale(harness.controller, "ja")
    expect(requests).toEqual([])
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("Portuguese and Brazilian Portuguese remain separate manual selections", async () => {
  const harness = await launchExtensionHarness({ locale: "pt-BR" })
  try {
    const requests = await blockExternalRequests(harness)
    await saveLanguage(harness, "pt")
    await expectLocale(harness.controller, "pt")
    const portuguese = await openView(harness, "settings")
    await appearance(portuguese)
    await expect(portuguese.locator("#language")).toHaveValue("pt")
    const europeanCopy = await portuguese.locator("#language-help").textContent()
    await portuguese.locator("#language").selectOption("pt-BR")
    await saveAndClose(portuguese)
    await expectLocale(harness.controller, "pt-BR")
    const brazilian = await openView(harness, "settings")
    await appearance(brazilian)
    await expect(brazilian.locator("#language")).toHaveValue("pt-BR")
    // A complete locale must not silently render the other Portuguese catalog.
    expect(await brazilian.locator("#language-help").textContent()).not.toBe(europeanCopy)
    expect(requests).toEqual([])
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("saved language waits for authentication without resetting its status or closing the dialog", async () => {
  const harness = await launchExtensionHarness()
  try {
    const unexpected = await blockExternalRequests(harness)
    await harness.controller.locator("#account-menu-trigger").click()
    await harness.controller.locator("#login").click()
    await expect(harness.controller.locator("#auth-method-dialog")).toBeVisible()
    const status = await harness.controller.locator("#run-status").textContent()
    await seedSettings(harness, { language: "ja" })
    await expectLocale(harness.controller, "en")
    await expect(harness.controller.locator("#auth-method-dialog")).toBeVisible()
    expect(await harness.controller.locator("#run-status").textContent()).toBe(status)
    await harness.controller.locator('#auth-method-dialog button[value="cancel"]').click()
    await expectLocale(harness.controller, "ja")
    expect(unexpected).toEqual([])
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("idle relabel preserves unsent images, selected chips, focus, draft, and pending clipboard work", async () => {
  const harness = await launchExtensionHarness()
  let requests = 0
  try {
    const unexpected = await blockExternalRequests(harness)
    await configureMockCodex(harness)
    await harness.context.route(CODEX_RESPONSES_URL, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: finalTextResponse(++requests, "# Safe answer\nData unchanged."),
      })
    })
    await harness.controller.locator("#prompt").fill("Give a harmless local test answer")
    await harness.controller.locator("#send").click()
    await expect(harness.controller.locator("#abort")).toBeHidden()
    await expect(harness.controller.locator("#transcript h1")).toHaveText("Safe answer")
    await harness.controller.locator("#prompt").fill("Keep this unsent draft 日本語")
    await harness.controller.evaluate(() => {
      const bytes = Uint8Array.from(
        atob(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nL8AAAAASUVORK5CYII=",
        ),
        (character) => character.charCodeAt(0),
      )
      const clipboardData = new DataTransfer()
      clipboardData.items.add(new File([bytes], "fixture.png", { type: "image/png" }))
      document
        .getElementById("prompt")
        ?.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData }))
    })
    await expect(harness.controller.locator("#pasted-images img")).toBeVisible()
    await harness.controller.locator("#element-picker").click()
    await expect(harness.controller.locator("#element-picker")).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    const target = await harness.fixturePage.locator("#complete").boundingBox()
    if (!target) throw new Error("Missing picker target")
    await harness.fixturePage.mouse.click(target.x + target.width / 2, target.y + target.height / 2)
    await expect(harness.controller.locator(".selected-element-chip")).toHaveCount(1)
    await harness.controller.evaluate(() => {
      const state = window as typeof window & {
        finishLocalizationCopy?: () => void
        localizationNodes?: Element[]
      }
      navigator.clipboard.writeText = () =>
        new Promise<void>((resolve) => {
          state.finishLocalizationCopy = resolve
        })
      state.localizationNodes = [
        "#pasted-images img",
        ".selected-element-chip",
        ".answer-copy-button",
        ".remove-pasted-image",
      ].map((selector) => {
        const node = document.querySelector(selector)
        if (!node) throw new Error(`Missing ${selector}`)
        return node
      })
    })
    const copy = harness.controller.locator(".answer-copy-button")
    await copy.click()
    await expect(copy).toHaveAttribute("data-copy-state", "copying")
    await harness.controller.locator(".remove-pasted-image").focus()
    const savedSessions = await sessions(harness.controller)
    await seedSettings(harness, { language: "ja" })
    await expectLocale(harness.controller, "ja")
    expect(
      await harness.controller.evaluate(() => {
        const nodes = (window as typeof window & { localizationNodes?: Element[] })
          .localizationNodes
        return (
          nodes?.every(
            (node, index) =>
              node ===
              document.querySelector(
                [
                  "#pasted-images img",
                  ".selected-element-chip",
                  ".answer-copy-button",
                  ".remove-pasted-image",
                ][index] ?? "",
              ),
          ) && document.activeElement === nodes[3]
        )
      }),
    ).toBe(true)
    await expect(harness.controller.locator("#prompt")).toHaveValue("Keep this unsent draft 日本語")
    await expect(copy).toHaveAttribute("data-copy-state", "copying")
    await expect(copy.locator(".copy-label")).not.toHaveText("Copying…")
    expect(await sessions(harness.controller)).toEqual(savedSessions)
    expect(requests).toBe(1)
    expect(unexpected).toEqual([])
    await harness.controller.evaluate(() =>
      (
        window as typeof window & { finishLocalizationCopy?: () => void }
      ).finishLocalizationCopy?.(),
    )
    await expect(copy).toHaveAttribute("data-copy-state", "copied")
    await expect(copy.locator(".copy-label")).not.toHaveText("Copied")
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("localized navigation consent shows the full bounded URL and cancellation never navigates or replays", async () => {
  const harness = await launchExtensionHarness()
  const suffix = "VISIBLE-SIGNIFICANT-URL-SUFFIX"
  const destination = `https://target.example.org/path?query=${"x".repeat(6000)}${suffix}`
  let requests = 0
  try {
    const unexpected = await blockExternalRequests(harness)
    await configureMockCodex(harness)
    await seedSettings(harness, { language: "ja" })
    await expectLocale(harness.controller, "ja")
    await harness.context.route(CODEX_RESPONSES_URL, async (route) => {
      const index = ++requests
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          index === 1
            ? toolCallResponse(index, "browser_navigate", { url: destination })
            : finalTextResponse(index, "Cancelled without navigation"),
      })
    })
    await harness.fixturePage.bringToFront()
    await harness.controller
      .locator("#prompt")
      .fill("Show the harmless navigation confirmation, then cancel")
    await harness.controller.locator("#send").click()
    const confirmation = harness.controller.locator("#confirm-dialog")
    await expect(confirmation).toBeVisible()
    await expect(confirmation.locator("#confirm-message")).toContainText(destination)
    await expect(confirmation.locator("#confirm-message")).toContainText(suffix)
    await confirmation.locator('button[value="cancel"]').click()
    await expect(harness.controller.locator("#abort")).toBeHidden()
    expect(requests).toBe(2)
    expect(harness.fixturePage.url()).toBe(harness.fixtureUrl)
    expect(unexpected).toEqual([])
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("language changes wait for a mocked run and confirmation, without additional model or tool calls", async () => {
  const harness = await launchExtensionHarness({ bookmarks: true })
  let releaseFirst: () => void = () => undefined
  let releaseFinal: () => void = () => undefined
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const finalGate = new Promise<void>((resolve) => {
    releaseFinal = resolve
  })
  try {
    await blockExternalRequests(harness)
    await configureMockCodex(harness)
    await harness.worker.evaluate(() => {
      const state = globalThis as typeof globalThis & { localizationBookmarkReads: number }
      state.localizationBookmarkReads = 0
      const original = chrome.bookmarks.getRecent.bind(chrome.bookmarks)
      chrome.bookmarks.getRecent = (async (count: number) => {
        state.localizationBookmarkReads++
        return original(count)
      }) as typeof chrome.bookmarks.getRecent
    })
    const toolCalls = () =>
      harness.worker.evaluate(
        () =>
          (globalThis as typeof globalThis & { localizationBookmarkReads: number })
            .localizationBookmarkReads,
      )
    let requests = 0
    await harness.context.route(CODEX_RESPONSES_URL, async (route) => {
      const index = ++requests
      await (index === 1 ? firstGate : finalGate)
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          index === 1
            ? toolCallResponse(index, "browser_get_recent_bookmarks", { limit: 1 })
            : finalTextResponse(index, "Unchanged model content 日本語 العربية"),
      })
    })
    await harness.controller.locator("#prompt").fill("Read one harmless fixture bookmark")
    await harness.controller.locator("#send").click()
    await expect.poll(() => requests).toBe(1)
    const runningStatus = await harness.controller.locator("#run-status").textContent()
    await saveLanguage(harness, "ja")
    await expectLocale(harness.controller, "en")
    expect(await harness.controller.locator("#run-status").textContent()).toBe(runningStatus)
    await expect(harness.controller.locator("#abort")).toBeVisible()
    expect(requests).toBe(1)
    expect(await toolCalls()).toBe(0)
    releaseFirst()
    const confirmation = harness.controller.locator("#confirm-dialog")
    await expect(confirmation).toBeVisible()
    const confirmationText = await confirmation.textContent()
    const confirmingStatus = await harness.controller.locator("#run-status").textContent()
    await saveLanguage(harness, "de")
    await expectLocale(harness.controller, "en")
    await expect(confirmation).toBeVisible()
    expect(await confirmation.textContent()).toBe(confirmationText)
    expect(await harness.controller.locator("#run-status").textContent()).toBe(confirmingStatus)
    expect(requests).toBe(1)
    expect(await toolCalls()).toBe(0)
    await harness.fixturePage.bringToFront()
    await harness.controller.locator("#confirm-action").click()
    await expect.poll(() => requests).toBe(2)
    expect(await toolCalls()).toBe(1)
    await expectLocale(harness.controller, "en")
    releaseFinal()
    await expect(harness.controller.locator("#transcript .message.assistant").last()).toContainText(
      "Unchanged model content 日本語 العربية",
    )
    await expectLocale(harness.controller, "de")
    await expect(harness.controller.locator("#abort")).toBeHidden()
    await expect(harness.controller.locator("#transcript .message.user")).toHaveCount(1)
    expect(requests).toBe(2)
    expect(await toolCalls()).toBe(1)
    expect(harness.pageErrors).toEqual([])
  } finally {
    releaseFirst()
    releaseFinal()
    await harness.close()
  }
})

async function expectNoPageOverflow(page: Page): Promise<void> {
  for (const selector of ["html", "body"]) {
    const geometry = await page.locator(selector).evaluate((node) => ({
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
      overflowing: [
        ...document.querySelectorAll<HTMLElement>(
          "h1, h2, h3, p, label, strong, summary, .settings-action-buttons, .settings-layout",
        ),
      ]
        .filter((element) => element.clientWidth > 0 && element.scrollWidth > element.clientWidth)
        .map((element) => ({
          tag: element.tagName,
          id: element.id,
          text: element.textContent?.trim().slice(0, 60),
          scroll: element.scrollWidth,
          client: element.clientWidth,
          overflow: getComputedStyle(element).overflowX,
        })),
      outside: [...document.querySelectorAll("h1, h2, h3, button, input, select")]
        .filter((element) => {
          const box = element.getBoundingClientRect()
          return box.width > 0 && (box.left < 0 || box.right > window.innerWidth)
        })
        .slice(0, 16)
        .map((element) => ({
          id: element.id,
          tag: element.tagName,
          text: element.textContent?.trim().slice(0, 40),
          left: element.getBoundingClientRect().left,
          right: element.getBoundingClientRect().right,
        })),
    }))
    expect(
      geometry.scrollWidth <= geometry.clientWidth,
      `Page-level horizontal overflow: ${selector} at ${page.url()} ${JSON.stringify(geometry)}`,
    ).toBe(true)
  }
}

async function expectControlsReachable(scope: Locator): Promise<void> {
  for (const control of await scope.locator(visibleControls).all()) {
    await expect(control).toHaveAccessibleName(/\S/)
    await control.scrollIntoViewIfNeeded()
    await expect(control).toBeInViewport({ ratio: 1 })
    expect(
      await control.evaluate((node) => {
        const box = node.getBoundingClientRect()
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
        return hit === node || (hit !== null && node.contains(hit))
      }),
      `Covered or clipped control: ${control}`,
    ).toBe(true)
  }
}

async function capture(page: Page, info: TestInfo, name: string): Promise<void> {
  // Native Chrome surfaces and actual screen-reader output require external acceptance testing.
  await page.screenshot({ path: info.outputPath(`${name}.png`) })
}

for (const locale of locales) {
  test(`${locale} renders conversation, six Settings panels, and microphone labels`, async () => {
    const info = test.info()
    const harness = await launchExtensionHarness()
    try {
      const requests = await blockExternalRequests(harness)
      await seedSettings(harness, { language: locale })
      await expectLocale(harness.controller, locale)
      await expect(harness.controller.locator("#prompt")).toHaveAccessibleName(/\S/)
      await expect(harness.controller.locator("#voice-input")).toHaveAccessibleName(/\S/)
      await expectNoPageOverflow(harness.controller)
      await capture(harness.controller, info, `${locale}-conversation`)
      const settings = await openView(harness, "settings")
      await appearance(settings)
      await expectLocale(settings, locale)
      await expect(settings.locator("#language")).toHaveValue(locale)
      await expect(settings.locator("#language")).toHaveAccessibleName(/\S/)
      await expect(settings.locator("#cancel-settings")).toHaveAccessibleName(/\S/)
      if (locale !== "en") {
        await expect(settings.locator("#settings-tab-appearance")).not.toHaveAccessibleName(
          "Appearance",
        )
        await expect(settings.locator("#cancel-settings")).not.toHaveAccessibleName("Cancel")
      }
      for (const section of sections) {
        const tab = settings.locator(`#settings-tab-${section}`)
        await tab.click()
        await expect(tab).toHaveAccessibleName(/\S/)
        const panel = settings.locator(`#settings-panel-${section}`)
        await expect(panel).toBeVisible()
        await expect(panel.getByRole("heading").first()).toHaveAccessibleName(/\S/)
        await expect(panel.locator(visibleControls).first()).toHaveAccessibleName(/\S/)
        await expectNoPageOverflow(settings)
        await capture(settings, info, `${locale}-settings-${section}`)
      }
      const microphone = await openView(harness, "microphone")
      await expectLocale(microphone, locale)
      await expect(microphone.locator("#close-microphone-access")).toHaveAccessibleName(/\S/)
      await expectNoPageOverflow(microphone)
      expect(requests).toEqual([])
      expect(harness.pageErrors).toEqual([])
    } finally {
      await harness.close()
    }
  })
}

for (const locale of ["de", "ru", "zh-TW", "th", "hi"] as const) {
  for (const colorScheme of ["light", "dark"] as const) {
    for (const { width, fontSize } of [
      { width: 1280, fontSize: 16 },
      { width: 320, fontSize: 24 },
    ]) {
      test(`${locale} controls and dialogs at ${width}px / ${fontSize}px in ${colorScheme}`, async () => {
        const info = test.info()
        // Each case checks every visible control in six panels and three dialogs, with captures.
        test.setTimeout(90_000)
        const harness = await launchExtensionHarness()
        try {
          const requests = await blockExternalRequests(harness)
          await seedSettings(harness, { language: locale, fontSize })
          const page = harness.controller
          await page.setViewportSize({ width, height: 900 })
          await page.emulateMedia({ colorScheme, reducedMotion: "reduce" })
          await expectLocale(page, locale)
          await expect(page.locator("html")).toHaveCSS("font-size", `${fontSize}px`)
          await page.locator("#prompt").fill("Unsent layout sample 日本語 العربية")
          await expectControlsReachable(page.locator(".composer"))
          await expectNoPageOverflow(page)
          await capture(page, info, "conversation")
          await page.locator("#account-menu-trigger").click()
          await page.locator("#login").click()
          const methodDialog = page.locator("#auth-method-dialog")
          await expect(methodDialog).toBeVisible()
          await expect(methodDialog.locator("h2")).not.toHaveText("Select authentication method")
          await expectControlsReachable(methodDialog)
          await expectNoPageOverflow(page)
          await capture(page, info, "authentication-method")
          await page.locator("#api-key-auth-method").click()
          const providerDialog = page.locator("#auth-provider-dialog")
          await expect(providerDialog).toBeVisible()
          await expectControlsReachable(providerDialog)
          await expectNoPageOverflow(page)
          await capture(page, info, "authentication-provider")
          await page.locator("#auth-provider-cancel").focus()
          await page.keyboard.press("Enter")
          await expect(providerDialog).toBeHidden()
          await expect(page.locator("#prompt")).toHaveValue("Unsent layout sample 日本語 العربية")

          const settings = await openView(harness, "settings")
          await settings.setViewportSize({ width, height: 900 })
          await settings.emulateMedia({ colorScheme, reducedMotion: "reduce" })
          await expectLocale(settings, locale)
          const firstTab = settings.locator("#settings-tab-model")
          await firstTab.focus()
          for (const [index, section] of sections.entries()) {
            const tab = settings.locator(`#settings-tab-${section}`)
            await expect(tab).toBeFocused()
            await expect(tab).toHaveAttribute("aria-selected", "true")
            await expect(tab).toHaveAccessibleName(/\S/)
            await expect(tab).toBeInViewport({ ratio: 1 })
            const panel = settings.locator(`#settings-panel-${section}`)
            await expect(panel).toBeVisible()
            await expectControlsReachable(panel)
            await expectControlsReachable(settings.locator(".settings-page-actions"))
            await expectNoPageOverflow(settings)
            await capture(settings, info, `settings-${section}`)
            await tab.focus()
            if (index < sections.length - 1) {
              await settings.keyboard.press(width >= 800 ? "ArrowDown" : "ArrowRight")
            }
          }
          await settings.keyboard.press("Home")
          await expect(firstTab).toBeFocused()
          await settings.keyboard.press("End")
          await expect(settings.locator("#settings-tab-instructions")).toBeFocused()
          await settings.locator("#system-prompt").fill("Harmless unsaved dialog layout sample")
          await settings.locator("#cancel-settings").focus()
          await settings.keyboard.press("Enter")
          const discard = settings.locator("#settings-confirm-dialog")
          await expect(discard).toBeVisible()
          await expect(discard).toHaveAccessibleName(/\S/)
          await expectControlsReachable(discard)
          await expectNoPageOverflow(settings)
          await capture(settings, info, "discard-draft")
          await settings.locator("#settings-confirm-cancel").focus()
          await settings.keyboard.press("Enter")
          await expect(discard).toBeHidden()
          await expect(settings.locator("#system-prompt")).toHaveValue(
            "Harmless unsaved dialog layout sample",
          )
          expect(requests).toEqual([])
          expect(harness.pageErrors).toEqual([])
        } finally {
          await harness.close()
        }
      })
    }
  }
}

test("Turkish technical-ID search and Japanese IME and slash tokens retain their behavior", async () => {
  const harness = await launchExtensionHarness()
  try {
    const requests = await blockExternalRequests(harness)
    await seedSettings(harness, { language: "tr" })
    const settings = await openView(harness, "settings")
    await settings.locator("#provider-search").fill("OPENAI")
    await settings
      .locator("#provider-options")
      .getByRole("option")
      .filter({ hasText: /^OpenAI \(/ })
      .click()
    await expect(settings.locator("#provider")).toHaveValue("openai")
    await settings.locator("#model-search").fill("GPT-5-MINI")
    await settings
      .locator("#model-options")
      .getByRole("option")
      .filter({ hasText: /gpt-5-mini$/i })
      .first()
      .click()
    await expect(settings.locator("#model")).toHaveValue("gpt-5-mini")
    await settings.close()
    await seedSettings(harness, { language: "ja" })
    await expectLocale(harness.controller, "ja")
    const prompt = harness.controller.locator("#prompt")
    await prompt.fill("日本語の未送信テキスト")
    await prompt.dispatchEvent("compositionstart")
    await prompt.dispatchEvent("keydown", {
      key: "Enter",
      code: "Enter",
      isComposing: true,
      bubbles: true,
    })
    await expect(prompt).toHaveValue("日本語の未送信テキスト")
    await expect(harness.controller.locator("#transcript .message")).toHaveCount(0)
    await prompt.dispatchEvent("compositionend")
    await prompt.fill("/new")
    await expect(harness.controller.locator("#slash-command-menu")).toBeVisible()
    await expect(harness.controller.locator("#slash-command-menu")).toContainText("/new")
    await prompt.press("Escape")
    await expect(harness.controller.locator("#slash-command-menu")).toBeHidden()
    await expect(prompt).toHaveValue("/new")
    expect(requests).toEqual([])
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})
