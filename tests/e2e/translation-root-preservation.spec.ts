import { expect, test } from "@playwright/test"
import { menu, setupTranslation } from "./support/translation.js"

const prose =
  "This visible article paragraph must remain the chosen public source even when an earlier matching root is hidden in the document."
for (const explicit of [true, false])
  test(`GitHub ignores hidden explicit roots and uses a ${explicit ? "visible explicit root" : "permitted fallback"}`, async () => {
    const { harness } = await setupTranslation({ hostPatterns: ["https://github.com/*"] })
    try {
      await harness.context.route("https://github.com/owned/review", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<main><div class="Layout-main" hidden><div class="markdown-body"><p>PRIVATE_HIDDEN_ROOT with enough prose to appear to be the main readable source before visibility filtering.</p></div></div><${explicit ? 'div class="Layout-main"' : "article"}><div class="markdown-body"><p id="original">${prose}</p></div></${explicit ? "div" : "article"}></main>`,
        }),
      )
      await harness.fixturePage.goto("https://github.com/owned/review")
      await menu(harness, "pi-translate-page")
      await expect(
        harness.fixturePage.locator('[data-ot-role="note-body"][data-state="ready"]'),
      ).toContainText(prose)
      await expect(harness.fixturePage.locator("#original")).toHaveText(prose)
      expect(harness.pageErrors).toEqual([])
    } finally {
      await harness.close()
    }
  })
test("splitting antirez prose keeps a trailing image node and its original identity", async () => {
  const { harness } = await setupTranslation({
    hostPatterns: ["https://antirez.com/*", "https://disqus.com/*"],
  })
  try {
    await harness.context.route("https://antirez.com/news/review", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<div id="content"><article class="comment"><pre>${prose}\n\n<img id="original-image" alt="Owned image" width="20" height="20" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'/%3E"></pre></article></div>`,
      }),
    )
    await harness.fixturePage.goto("https://antirez.com/news/review")
    const image = await harness.fixturePage.locator("#original-image").elementHandle()
    if (!image) throw new Error("Missing original image")
    await menu(harness, "pi-translate-page")
    await expect(
      harness.fixturePage.locator('[data-ot-role="note-body"][data-state="ready"]'),
    ).toContainText(prose)
    expect(await image.evaluate((element) => element.isConnected)).toBe(true)
    await expect(harness.fixturePage.locator("#original-image")).toHaveCount(1)
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})
