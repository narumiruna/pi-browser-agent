import { expect, test } from "@playwright/test"
import { menu, setupTranslation } from "./support/translation.js"

test("translation sends public prose but excludes hidden and editable descendants in prose, code, and math", async () => {
  const { harness, requests } = await setupTranslation()
  const inputs: string[] = []
  try {
    harness.context.on("request", (request) => {
      if (request.url().includes("/codex/responses")) inputs.push(request.postData() ?? "")
    })
    await harness.fixturePage.evaluate(() => {
      document.body.innerHTML = `<main><article><p id="public">This public paragraph explains safe extraction and keeps visible code and math. <span hidden>PRIVATE_HIDDEN</span><span style="display:none">PRIVATE_DISPLAY</span><span style="visibility:hidden">PRIVATE_VISIBILITY</span><span style="opacity:0">PRIVATE_OPACITY</span><span style="content-visibility:hidden">PRIVATE_CONTENT_VISIBILITY</span><code>safe<span hidden>PRIVATE_CODE</span><span contenteditable>PRIVATE_CODE_EDIT</span></code><math><mi>x</mi><mi style="display:none">PRIVATE_MATH</mi><mi contenteditable>PRIVATE_MATH_EDIT</mi></math><span contenteditable="plaintext-only">PRIVATE_INLINE_DRAFT</span><span style="display:contents">Visible boxless prose remains readable.</span></p><section contenteditable><p>PRIVATE_BARE_DRAFT has enough words to be a readable paragraph before filtering.</p><div contenteditable="false"><p>PRIVATE_FALSE_ISLAND also remains inside the outer editor.</p></div></section><section contenteditable="plaintext-only"><p>PRIVATE_PLAINTEXT_DRAFT is another long unsent draft that must not leave this editor.</p></section></article></main>`
    })
    await menu(harness, "pi-translate-page")
    await expect(
      harness.fixturePage.locator('[data-ot-role="note-body"][data-state="ready"]'),
    ).toHaveCount(1)
    expect(requests()).toBeGreaterThan(0)
    expect(inputs.join("\n")).not.toContain("PRIVATE_")
    expect(inputs.join("\n")).toContain("Visible boxless prose")
    await expect(harness.fixturePage.locator("#public")).toContainText("PRIVATE_HIDDEN")
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("visually hidden accessibility labels do not produce visible translations", async () => {
  const { harness } = await setupTranslation()
  const inputs: string[] = []
  try {
    harness.context.on("request", (request) => {
      if (request.url().includes("/codex/responses")) inputs.push(request.postData() ?? "")
    })
    const page = harness.fixturePage
    await page.evaluate(() => {
      document.body.innerHTML = `
        <style>
          .primer, .legacy, .modern { position: absolute; width: 1px; height: 1px; overflow: hidden; }
          .primer { clip-path: inset(0 100% 100% 0); }
          .legacy { clip: rect(0, 0, 0, 0); }
          .modern { clip-path: inset(50%); }
        </style>
        <main><article>
          <h2 id="accessible-heading" class="primer">ACCESSIBILITY_HEADING for assistive technology only</h2>
          <p>Visible neighboring prose remains eligible for page translation.
            <span class="legacy">ACCESSIBILITY_LEGACY_LABEL</span>
            <span style="display: contents"><span class="modern"><span>ACCESSIBILITY_LABEL</span></span>
              Visible boxless prose remains eligible.</span>
          </p>
          <p style="clip-path: inset(0 8px 0 0)">Partly clipped visible prose remains eligible for page translation.</p>
        </article></main>`
    })
    await menu(harness, "pi-translate-page")
    const notes = page.locator('[data-ot-role="note-body"][data-state="ready"]')
    await expect(notes.filter({ hasText: "Partly clipped visible prose" })).toHaveCount(1)
    await expect(notes.filter({ hasText: "Visible neighboring prose" })).toHaveCount(1)
    const input = inputs.join("\n")
    expect(input).not.toContain("ACCESSIBILITY_")
    expect(input).toContain("Visible boxless prose")
    await expect(notes).toHaveCount(2)
    await expect(page.locator("#accessible-heading")).toHaveText(
      "ACCESSIBILITY_HEADING for assistive technology only",
    )
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("design-mode documents make no translation request", async () => {
  const { harness, requests } = await setupTranslation()
  try {
    await harness.fixturePage.evaluate(() => {
      document.body.innerHTML =
        "<main><article><p>This is a long unsent document draft that must remain local while document design mode is enabled.</p></article></main>"
      document.designMode = "on"
    })
    await menu(harness, "pi-translate-page")
    await expect(harness.controller.locator("#run-status")).toHaveText("Translation is active")
    expect(requests()).toBe(0)
    await expect(harness.fixturePage.locator('[data-ot-role="note"]')).toHaveCount(0)
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("a new target language replaces ready page notes instead of skipping their sources", async () => {
  const { harness, requests } = await setupTranslation()
  try {
    await harness.fixturePage.evaluate(() => {
      document.body.innerHTML =
        "<main><article><p id=original>This visible source paragraph must receive the newly requested target language without losing the original text.</p></article></main>"
    })
    await menu(harness, "pi-translate-page")
    const notes = harness.fixturePage.locator('[data-ot-role="note-body"][data-state="ready"]')
    await expect(notes).toContainText("譯文")
    const before = requests()
    await harness.controller.evaluate(async () => {
      const key = "piBrowserAgentTranslationSettingsV1"
      const stored = (await chrome.storage.local.get(key))[key] as {
        settings: Record<string, unknown>
      }
      await chrome.storage.local.set({
        [key]: { ...stored, settings: { ...stored.settings, targetLanguage: "Japanese" } },
      })
    })
    await expect(harness.controller.locator("#translation-stop")).toBeHidden()
    await menu(harness, "pi-translate-page")
    await expect(notes).toHaveCount(1)
    await expect(notes).toContainText("日本語")
    expect(requests()).toBeGreaterThan(before)
    await expect(harness.fixturePage.locator("#original")).toHaveText(
      "This visible source paragraph must receive the newly requested target language without losing the original text.",
    )
  } finally {
    await harness.close()
  }
})
