import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { test } from "vitest"
import * as Rules from "../../../src/browser/translation/content/extraction/rules.js"
import { createSourceAnalyzer } from "../../../src/browser/translation/content/extraction/source-analyzer.js"
import { createContentRenderer } from "../../../src/browser/translation/content/rendering/runtime.js"
import * as SubtitleApi from "../../../src/browser/translation/content/youtube/subtitles.js"

function createElement(attributes = {}) {
  return {
    tagName: "P",
    attributes: { ...attributes },
    children: [],
    getAttribute(name) {
      return this.attributes[name] ?? null
    },
    setAttribute(name, value) {
      this.attributes[name] = value
    },
    removeAttribute(name) {
      delete this.attributes[name]
    },
    matches(selector) {
      return selector === "p"
    },
    replaceChildren(...children) {
      this.children = children
    },
    appendChild(child) {
      this.children.push(child)
    },
    remove() {
      this.removed = true
    },
  }
}

function createFixture() {
  const source = createElement({
    "data-ot-source-id": "source",
    "data-ot-source-stale": "true",
    "data-ot-translated": "stale",
    "data-ot-queued": "true",
  })
  source.text = "Current revision C"
  source.protectedFragments = []
  const note = createElement({
    "data-phase": "pending",
    "data-ot-note-id": "source",
    "data-stale": "true",
  })
  const label = createElement()
  const body = createElement()
  body.children = ["pending"]
  note.querySelector = (selector) => (selector.includes("note-label") ? label : body)
  source.nextElementSibling = note
  const renderer = createContentRenderer({
    document: {
      body: {},
      querySelectorAll: (selector) =>
        selector.includes('data-phase="pending"') ? [note] : [source],
      querySelector: () => source,
      createTextNode: (text) => text,
    },
    window: {
      getComputedStyle: () => ({
        display: "block",
        transform: "none",
        filter: "none",
        backdropFilter: "none",
        mixBlendMode: "normal",
      }),
    },
    pageState: { pageTranslation: {} },
    activeSiteProfile: { id: "default" },
    sourceAttr: "data-ot-source-id",
    noteAttr: "data-ot-note-id",
    staleAttr: "data-ot-source-stale",
    rootAttr: "data-ot-role",
    readableBlockSelector: "p",
    SubtitleApi,
    isHeadingLikeElement: () => false,
    isReadableTitleLink: () => false,
    withObserverPaused: (fn) => fn(),
    ensureStyles() {},
    ensureObserver() {},
    getExistingNoteForSource: () => note,
    getSegmentContent: () => ({ text: source.text, protectedFragments: source.protectedFragments }),
    setSourceTranslated: (element, value) =>
      element.setAttribute("data-ot-translated", String(value)),
    setSourceQueued: (element, value) => element.setAttribute("data-ot-queued", String(value)),
  })
  return { renderer, source, note, body }
}

for (const sourceText of ["Old revision A", undefined]) {
  test(`ordinary results reject ${sourceText ?? "missing"} source snapshots without clearing stale state`, () => {
    const { renderer, source, note, body } = createFixture()
    const result = renderer.renderPageTranslationUpdates({
      targetLanguage: "zh-TW",
      translations: [
        {
          id: "source",
          sourceText,
          translation: "Old translation",
          provisional: true,
        },
      ],
    })
    assert.equal(result.rendered, 0)
    assert.deepEqual(result.renderedIds, [])
    assert.equal(source.getAttribute("data-ot-source-stale"), "true")
    assert.equal(source.getAttribute("data-ot-translated"), "stale")
    assert.equal(note.getAttribute("data-phase"), "pending")
    assert.equal(note.getAttribute("data-stale"), "true")
    assert.deepEqual(body.children, ["pending"])
  })
}

test("ordinary latest results become ready and report only accepted IDs", () => {
  const { renderer, source, note, body } = createFixture()
  const result = renderer.renderPageTranslationUpdates({
    targetLanguage: "zh-TW",
    translations: [
      {
        id: "source",
        sourceText: source.text,
        translation: "Final translation",
      },
    ],
  })
  assert.deepEqual(result, { rendered: 1, renderedIds: ["source"] })
  assert.equal(note.getAttribute("data-phase"), "ready")
  assert.equal(source.getAttribute("data-ot-translated"), "true")
  assert.equal(source.getAttribute("data-ot-source-stale"), null)
  assert.deepEqual(body.children, ["Final translation"])
})

test("old ordinary failure preserves a newer stale source and its pending note", () => {
  const { renderer, source, note } = createFixture()
  const result = renderer.clearPagePlaceholders({
    ids: ["source"],
    items: [{ id: "source", text: "Old revision A" }],
  })
  assert.equal(result.cleared, 0)
  assert.equal(note.removed, undefined)
  assert.equal(source.getAttribute("data-ot-source-stale"), "true")
  assert.equal(source.getAttribute("data-ot-translated"), "stale")
  assert.equal(source.getAttribute("data-ot-queued"), "true")
})

const mathFragment = (value) => ({
  placeholder: "__OT_MATH_1__",
  preservePlaceholder: true,
  kind: "math",
  text: value,
  value,
})
test("source revisions include math even when masked prose is unchanged", () => {
  const dom = new JSDOM(
    '<p>Review this equation <span class="katex">x = 1</span> before continuing.</p>',
  )
  try {
    const { window } = dom
    const analyzer = createSourceAnalyzer({
      document: window.document,
      window,
      Node: window.Node,
      activeSiteProfile: { id: "default" },
      sourceAttr: "data-ot-source-id",
      rootAttr: "data-ot-role",
      mathSelector: Rules.MATH_SELECTOR,
      skipAncestorSelector: Rules.SKIP_ANCESTOR_SELECTOR,
      inlineCodeSelector: Rules.INLINE_CODE_SELECTOR,
      ExtractionApi: Rules,
      SubtitleApi,
      isInsideTranslation: () => false,
      normalizeSegmentText: Rules.normalizeSegmentText,
      normalizeInlineWhitespace: Rules.normalizeInlineWhitespace,
    })
    const source = window.document.querySelector("p")
    const original = analyzer.getSegmentContent(source)
    analyzer.rememberSourceText(source, original.text)
    assert.equal(analyzer.hasSourceTextChanged(source), false)
    window.document.querySelector(".katex").textContent = "x = 2"
    assert.equal(analyzer.getSegmentContent(source).text, original.text)
    assert.equal(analyzer.hasSourceTextChanged(source), true)
    analyzer.rememberSourceText(source, original.text)
    assert.equal(analyzer.hasSourceTextChanged(source), false)
  } finally {
    dom.window.close()
  }
})
for (const fragments of [undefined, [mathFragment("x = 1")]])
  test("ordinary math rejects missing or old protected source snapshots", () => {
    const { renderer, source, note, body } = createFixture()
    source.text = "Equation __OT_MATH_1__"
    source.protectedFragments = [mathFragment("x = 2")]
    const result = renderer.renderPageTranslationUpdates({
      targetLanguage: "zh-TW",
      translations: [
        {
          id: "source",
          sourceText: source.text,
          protectedFragments: fragments,
          translation: "Current __OT_MATH_1__",
        },
      ],
    })
    assert.equal(result.rendered, 0)
    assert.equal(source.getAttribute("data-ot-source-stale"), "true")
    assert.equal(note.getAttribute("data-phase"), "pending")
    assert.deepEqual(body.children, ["pending"])
  })
test("ordinary math accepts a matching full source snapshot", () => {
  const { renderer, source, body } = createFixture()
  source.text = "Equation __OT_MATH_1__"
  source.protectedFragments = [mathFragment("x = 2")]
  const result = renderer.renderPageTranslationUpdates({
    targetLanguage: "zh-TW",
    translations: [
      {
        id: "source",
        sourceText: source.text,
        protectedFragments: [mathFragment("x = 2")],
        translation: "Current __OT_MATH_1__",
      },
    ],
  })
  assert.equal(result.rendered, 1)
  assert.deepEqual(body.children, ["Current ", "x = 2"])
})
test("old math failure cannot clear the newer revision's pending note", () => {
  const { renderer, source, note } = createFixture()
  source.text = "Equation __OT_MATH_1__"
  source.protectedFragments = [mathFragment("x = 2")]
  const result = renderer.clearPagePlaceholders({
    ids: ["source"],
    items: [
      {
        id: "source",
        text: source.text,
        protectedFragments: [mathFragment("x = 1")],
      },
    ],
  })
  assert.equal(result.cleared, 0)
  assert.equal(note.removed, undefined)
  assert.equal(source.getAttribute("data-ot-source-stale"), "true")
})
