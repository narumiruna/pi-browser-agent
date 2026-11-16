import { expect, test } from "@playwright/test"
import { CODEX_RESPONSES_URL, finalTextResponse } from "./support/mock-codex.js"
import { menu, setupTranslation } from "./support/translation.js"

test("equation-only changes reject old in-flight output and replace ready output", async () => {
  const { harness } = await setupTranslation()
  let calls = 0
  let releaseFirst = () => {}
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  try {
    await harness.context.route(CODEX_RESPONSES_URL, async (route) => {
      const call = ++calls
      const text = route
        .request()
        .postDataJSON()
        .input.flatMap((entry: { content?: { text?: string }[] }) =>
          Array.isArray(entry.content) ? entry.content.map((block) => block.text ?? "") : [],
        )
        .join("\n")
      const payload = JSON.parse(
        text.slice(text.lastIndexOf("Source payload:\n") + "Source payload:\n".length),
      )
      if (call === 1) await first
      await route.fulfill({
        contentType: "text/event-stream",
        body: finalTextResponse(
          call,
          JSON.stringify({
            translations: (payload.items ?? [payload]).map(
              (item: { id: string; text: string }) => ({
                id: item.id,
                translatedText: `Updated ${item.text}`,
              }),
            ),
          }),
        ),
      })
    })
    await harness.fixturePage.evaluate(() => {
      document.body.innerHTML =
        '<main><article><p id="source">This public paragraph explains the current equation <math><mtext>x = 1</mtext></math> without changing its surrounding source prose.</p></article></main>'
    })
    await harness.fixturePage.evaluate(() => {
      const state = window as typeof window & { seenMathResults?: string[] }
      state.seenMathResults = []
      new MutationObserver(() => {
        for (const body of document.querySelectorAll(
          '[data-ot-role="note-body"][data-state="ready"]',
        ))
          state.seenMathResults?.push(body.textContent ?? "")
      }).observe(document.body, {
        childList: true,
        characterData: true,
        attributes: true,
        subtree: true,
      })
    })
    await menu(harness, "pi-translate-page")
    await expect.poll(() => calls).toBe(1)
    await harness.fixturePage.locator("mtext").evaluate((element) => {
      element.textContent = "x = 2"
    })
    await expect(harness.fixturePage.locator("#source")).toHaveAttribute(
      "data-ot-source-stale",
      "true",
    )
    releaseFirst()
    const ready = harness.fixturePage.locator('[data-ot-role="note-body"][data-state="ready"]')
    await expect(ready).toContainText("x = 2")
    await expect(ready).not.toContainText("x = 1")
    await harness.fixturePage.locator("mtext").evaluate((element) => {
      element.textContent = "x = 3"
    })
    await expect(ready).toContainText("x = 3")
    await harness.fixturePage.evaluate(() => {
      const equation = document.createElement("span")
      equation.className = "katex"
      equation.setAttribute("data-latex", "x = 4")
      const style = document.createElement("style")
      style.textContent = "#source > .katex::before { content: attr(data-latex) }"
      document.head.append(style)
      document.querySelector("mtext")?.closest("math")?.replaceWith(equation)
    })
    await expect(ready).toContainText("x = 4")
    await harness.fixturePage.locator("#source > .katex").evaluate((element) => {
      element.setAttribute("data-latex", "x = 5")
    })
    await expect(ready).toContainText("x = 5")
    await expect(harness.fixturePage.locator("#source > .katex")).toHaveAttribute(
      "data-latex",
      "x = 5",
    )
    const seen = await harness.fixturePage.evaluate(
      () => (window as typeof window & { seenMathResults?: string[] }).seenMathResults,
    )
    expect(seen?.some((text) => text.includes("x = 2"))).toBe(true)
    expect(seen?.some((text) => text.includes("x = 3"))).toBe(true)
    expect(seen?.some((text) => text.includes("x = 1"))).toBe(false)
    expect(seen?.some((text) => text.includes("x = 5"))).toBe(true)
    expect(harness.pageErrors).toEqual([])
  } finally {
    releaseFirst()
    await harness.close()
  }
})

test("a dynamic 65-cell window translates every source through bounded packets", async () => {
  const { harness, requests } = await setupTranslation()
  try {
    await harness.fixturePage.evaluate(() => {
      document.body.innerHTML =
        "<main><article><p>This public paragraph starts a live page session before a dense table exposes more than sixty-four source blocks.</p></article></main>"
    })
    await menu(harness, "pi-translate-page")
    const ready = harness.fixturePage.locator('[data-ot-role="note-body"][data-state="ready"]')
    await expect(ready).toHaveCount(1)
    await harness.fixturePage.evaluate(() => {
      const table = document.createElement("table")
      table.style.cssText = "table-layout:fixed;width:100%;font-size:12px;line-height:1.2"
      for (let row = 0; row < 13; row += 1) {
        const tr = table.insertRow()
        for (let column = 0; column < 5; column += 1)
          tr.insertCell().textContent = `Public cell ${row * 5 + column} has enough readable source prose for independent page translation.`
      }
      document.querySelector("article")?.append(table)
    })
    await expect(ready).toHaveCount(66, { timeout: 30000 })
    expect(requests()).toBe(66)
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})
