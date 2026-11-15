import assert from "node:assert/strict"
import { test } from "vitest"
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
    getSegmentContent: () => ({ text: source.text }),
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
