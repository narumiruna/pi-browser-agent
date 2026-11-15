import assert from "node:assert/strict"
import { test } from "vitest"
import * as ExtractionApi from "../../../src/browser/translation/content/extraction/rules.js"
import { resolveSiteProfile } from "../../../src/browser/translation/content/extraction/site-profiles.js"
import { createSourceAnalyzer } from "../../../src/browser/translation/content/extraction/source-analyzer.js"
import * as SubtitleApi from "../../../src/browser/translation/content/youtube/subtitles.js"

function visibilityFixture(profile = resolveSiteProfile("www.youtube.com")) {
  const attributes = new Map([
    ["data-ot-source-id", "ot-1"],
    ["data-ot-source-stale", "true"],
    ["data-ot-subtitle-replaced", "true"],
  ])
  const text = "A progressively growing caption needs another complete translation."
  const note = {
    isConnected: true,
    style: { display: "block", visibility: "visible" },
    getAttribute: () => "ready",
    getBoundingClientRect: () => ({ width: 200, height: 30 }),
  }
  const source = {
    nodeType: 1,
    isConnected: true,
    childNodes: [{ nodeType: 3, textContent: text }],
    children: [],
    tagName: "SPAN",
    textContent: text,
    getAttribute: (name) => attributes.get(name),
    matches: (selector) => selector === ".ytp-caption-segment",
    closest: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
  }
  let existingNote = note
  const analyzer = createSourceAnalyzer({
    document: {},
    window: {
      getComputedStyle: (element) => element.style || { display: "none" },
    },
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    activeSiteProfile: profile,
    sourceAttr: "data-ot-source-id",
    rootAttr: "data-ot-role",
    processedAttr: "data-translated",
    staleAttr: "data-ot-source-stale",
    protectedPlaceholderRegex: /__OT_MATH_\d+__/gu,
    mathSelector: "math",
    skipAncestorSelector: ".skip",
    inlineCodeSelector: "code",
    contentRules: {
      selectors: {
        READABLE_BLOCK_SELECTOR: ".ytp-caption-segment",
        EXPLICIT_TEXT_BLOCK_SELECTOR: ".ytp-caption-segment",
      },
    },
    terminalLikeSelector: ".terminal",
    ExtractionApi,
    SubtitleApi,
    isInsideTranslation: () => false,
    getExistingNoteForSource: () => existingNote,
    debugSkip() {},
    normalizeInlineWhitespace: ExtractionApi.normalizeInlineWhitespace,
    normalizeSegmentText: ExtractionApi.normalizeSegmentText,
  })
  return {
    analyzer,
    source,
    note,
    attributes,
    removeNote: () => {
      existingNote = null
    },
  }
}

test("a visible subtitle note anchors refresh of its hidden stale native caption", () => {
  const f = visibilityFixture()
  const result = f.analyzer.classifyCandidateElement(f.source)
  assert.equal(result.ok, true, JSON.stringify(result))
  f.attributes.delete("data-ot-source-stale")
  assert.equal(f.analyzer.classifyCandidateElement(f.source).reason, "not visible")
})

test("hidden or detached notes do not authorize extraction of hidden captions", () => {
  for (const change of [
    (f) => {
      f.note.isConnected = false
    },
    (f) => {
      f.note.style.display = "none"
    },
    (f) => {
      f.note.getBoundingClientRect = () => ({ width: 0, height: 0 })
    },
    (f) => {
      f.note.getAttribute = () => "loading"
    },
    (f) => {
      f.removeNote()
    },
    (f) => {
      f.attributes.delete("data-ot-subtitle-replaced")
    },
  ]) {
    const f = visibilityFixture()
    change(f)
    assert.equal(f.analyzer.classifyCandidateElement(f.source).reason, "not visible")
  }
  const generic = visibilityFixture(resolveSiteProfile("example.com"))
  assert.equal(generic.analyzer.classifyCandidateElement(generic.source).reason, "not visible")
})
