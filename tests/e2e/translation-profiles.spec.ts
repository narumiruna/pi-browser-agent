import { expect, test } from "@playwright/test"
import { menu, setupTranslation } from "./support/translation.js"

const prose =
  "This owned article paragraph explains safe browser translation while keeping the original source text unchanged and readable."
const profiles = [
  [
    "github",
    "https://github.com/owned/project/pull/1",
    `<main><div class="Layout-main"><div class="markdown-body"><p>${prose}</p></div></div></main>`,
    ".markdown-body > p",
  ],
  [
    "reddit",
    "https://www.reddit.com/r/owned/comments/fixture/",
    `<main><article><p>${prose}</p></article></main>`,
    "article > p",
  ],
  [
    "x",
    "https://x.com/owned/status/123",
    `<main><div data-testid="primaryColumn"><article><div data-testid="tweetText">${prose}</div></article></div></main>`,
    '[data-testid="tweetText"]',
  ],
  [
    "threads",
    "https://www.threads.net/@owned/post/fixture",
    `<main><div lang="en"><div><span dir="auto">${prose}</span></div></div></main>`,
    'span[dir="auto"]',
  ],
  [
    "carmina",
    "https://www.carminashoemaker.com/owned-article",
    `<main><div id="module-special-category-header"><div class="html-output"><p>${prose}</p></div></div></main>`,
    ".html-output > p",
  ],
  [
    "findy",
    "https://findy-code.io/engineer-lab/owned-article",
    `<main class="p-single__wrap"><p>${prose}</p></main>`,
    ".p-single__wrap > p",
  ],
  [
    "schiit",
    "https://www.schiit.com/guides/owned",
    `<div id="content-box"><div class="product"><div class="pad"><div class="body"><div>${prose}</div></div></div></div></div>`,
    ".body > div",
  ],
] as const
for (const [name, url, body, originalSelector] of profiles)
  test(`${name} profile renders owned prose without changing source content`, async () => {
    const origin = new URL(url).origin
    const { harness } = await setupTranslation({ hostPatterns: [`${origin}/*`] })
    try {
      await harness.context.route(url, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><meta charset="utf-8"><body class="guides">${body}</body>`,
        }),
      )
      await harness.fixturePage.goto(url)
      const original = await harness.fixturePage.locator(originalSelector).elementHandle()
      if (!original) throw new Error("Missing original source")
      await menu(harness, "pi-translate-page")
      await expect(
        harness.fixturePage.locator('[data-ot-role="note-body"][data-state="ready"]').first(),
      ).toContainText("譯文", { timeout: 15000 })
      expect(await original.evaluate((element) => element.isConnected)).toBe(true)
      expect(
        await original.evaluate((element) => {
          const copy = element.cloneNode(true) as Element
          for (const note of copy.querySelectorAll("[data-ot-role]")) note.remove()
          return copy.textContent
        }),
      ).toBe(prose)
      expect(harness.pageErrors).toEqual([])
    } finally {
      await harness.close()
    }
  })

test("approved embedded Disqus comments translate with the current antirez article", async () => {
  const { harness } = await setupTranslation({
    hostPatterns: ["https://antirez.com/*", "https://disqus.com/*"],
  })
  try {
    await harness.context.route("https://antirez.com/news/owned", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><meta charset="utf-8"><div id="content"><article class="comment"><pre>${prose}</pre></article></div><iframe title="Owned comments" width="700" height="300" src="https://disqus.com/embed/comments/?owned=1"></iframe>`,
      }),
    )
    await harness.context.route("https://disqus.com/embed/comments/?owned=1", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><meta charset="utf-8"><main id="posts"><article><div data-role="message"><p>An owned embedded comment preserves its frame identity and uses only an explicitly approved comment origin.</p></div></article></main>`,
      }),
    )
    await harness.fixturePage.goto("https://antirez.com/news/owned")
    await menu(harness, "pi-translate-page")
    await expect(
      harness.fixturePage.locator('[data-ot-role="note-body"][data-state="ready"]').first(),
    ).toContainText("譯文", { timeout: 15000 })
    await expect(
      harness.fixturePage
        .frameLocator("iframe")
        .locator('[data-ot-role="note-body"][data-state="ready"]'),
    ).toContainText("譯文", { timeout: 15000 })
    const selected = await harness.fixturePage
      .frameLocator("iframe")
      .locator('[data-role="message"] p:not([data-ot-role])')
      .evaluate((element) => {
        const range = document.createRange()
        range.selectNodeContents(element)
        const selection = getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        return element.textContent ?? ""
      })
    await harness.fixturePage.bringToFront()
    await harness.worker.evaluate(async (selectionText) => {
      const tab = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
      if (!tab?.id) throw new Error("Missing active tab")
      const frames = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: () => location.href,
      })
      const frame = frames.find(
        (entry) =>
          typeof entry.result === "string" && entry.result.startsWith("https://disqus.com/"),
      )
      if (!frame?.frameId) throw new Error("Missing comment frame")
      const listeners = (
        globalThis as typeof globalThis & {
          __piTestMenus: Array<(info: unknown, tab: unknown) => void>
        }
      ).__piTestMenus
      for (const listener of listeners)
        listener(
          {
            menuItemId: "pi-translate-selection",
            frameId: frame.frameId,
            frameUrl: frame.result,
            selectionText,
          },
          tab,
        )
    }, selected)
    const selection = harness.fixturePage
      .frameLocator("iframe")
      .locator('[data-ot-role="selection-panel"]')
    await expect(selection).toContainText("譯文")
    await expect(harness.fixturePage.locator('[data-ot-role="selection-panel"]')).toHaveCount(0)
    await selection.getByRole("button", { name: "Dismiss translation" }).focus()
    await harness.fixturePage.keyboard.press("Escape")
    await expect(selection).toHaveCount(0)
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})
