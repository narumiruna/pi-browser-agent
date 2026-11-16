import { JSDOM } from "jsdom"
import { expect, test } from "vitest"
import * as Rules from "../../../src/browser/translation/content/extraction/rules.js"
import { resolveSiteProfile } from "../../../src/browser/translation/content/extraction/site-profiles.js"
import { createSourceAnalyzer } from "../../../src/browser/translation/content/extraction/source-analyzer.js"
import * as SubtitleApi from "../../../src/browser/translation/content/youtube/subtitles.js"

function fixture(html: string) {
  const dom = new JSDOM(html)
  const { window } = dom
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 300, height: 40 }) as DOMRect
  const analyzer = createSourceAnalyzer({
    document: window.document,
    window,
    Node: window.Node,
    activeSiteProfile: resolveSiteProfile("example.com"),
    sourceAttr: "data-ot-source-id",
    rootAttr: "data-ot-role",
    processedAttr: "data-translated",
    staleAttr: "data-ot-source-stale",
    protectedPlaceholderRegex: /__OT_MATH_\d+__/gu,
    mathSelector: Rules.MATH_SELECTOR,
    skipAncestorSelector: Rules.SKIP_ANCESTOR_SELECTOR,
    inlineCodeSelector: Rules.INLINE_CODE_SELECTOR,
    terminalLikeSelector: Rules.TERMINAL_LIKE_SELECTOR,
    contentRules: Rules.createContentRulesForProfile(resolveSiteProfile("example.com")),
    ExtractionApi: Rules,
    SubtitleApi,
    isInsideTranslation: () => false,
    debugSkip() {},
    normalizeInlineWhitespace: Rules.normalizeInlineWhitespace,
    normalizeSegmentText: Rules.normalizeSegmentText,
  })
  return { dom, document: window.document, analyzer }
}
test.each([
  "hidden",
  'hidden="until-found"',
  'style="display:none"',
  'style="visibility:hidden"',
  'style="visibility:collapse"',
  'style="opacity:0"',
  'style="content-visibility:hidden"',
  'aria-hidden="true"',
])("serialization excludes %s from prose, code, and math", (attribute) => {
  const { dom, document, analyzer } = fixture(
    `<p>Public prose<span ${attribute}>PRIVATE_PROSE</span><code>safe<span ${attribute}>PRIVATE_CODE</span></code><span class="katex"><span>x</span><span ${attribute}>PRIVATE_MATH</span></span><span style="display:contents">visible boxless text</span></p>`,
  )
  try {
    const content = analyzer.getSegmentContent(document.querySelector("p"))
    expect(content.text).toContain("Public prose")
    expect(content.text).toContain("safe")
    expect(content.text).toContain("visible boxless text")
    expect(content.protectedFragments).toEqual([expect.objectContaining({ text: "x" })])
    expect(JSON.stringify(content)).not.toContain("PRIVATE_")
    expect(JSON.stringify(content)).not.toContain("outerHTML")
  } finally {
    dom.window.close()
  }
})
test.each([
  "contenteditable",
  'contenteditable="true"',
  'contenteditable="plaintext-only"',
  'contenteditable="TRUE"',
])("editable ancestors exclude readable descendants and non-editable islands: %s", (attribute) => {
  const { dom, document, analyzer } = fixture(
    `<section ${attribute}><div><p>This is an unsent editor draft with enough prose to pass the ordinary paragraph threshold.</p><div contenteditable="false"><p>This non-editable child cannot bypass its outer editor boundary.</p></div></div></section>`,
  )
  try {
    for (const paragraph of document.querySelectorAll("p")) {
      expect(analyzer.classifyCandidateElement(paragraph)).toMatchObject({
        ok: false,
        reason: "editable content",
      })
      expect(analyzer.getSegmentContent(paragraph).text).toBe("")
    }
  } finally {
    dom.window.close()
  }
})
test("editable descendants are removed from prose, code, and math; design mode rejects the document", () => {
  const { dom, document, analyzer } = fixture(
    '<p>Public original prose <span contenteditable>PRIVATE_PROSE</span><code>safe<span contenteditable="plaintext-only">PRIVATE_CODE</span></code><math><mi>x</mi><mi contenteditable>PRIVATE_MATH</mi></math></p>',
  )
  try {
    expect(JSON.stringify(analyzer.getSegmentContent(document.querySelector("p")))).not.toContain(
      "PRIVATE_",
    )
    document.designMode = "on"
    expect(analyzer.getSegmentContent(document.querySelector("p")).text).toBe("")
    expect(analyzer.classifyCandidateElement(document.querySelector("p"))).toMatchObject({
      ok: false,
    })
  } finally {
    dom.window.close()
  }
})
test("short citation prose remains readable while actual controls remain UI", () => {
  const { dom, document, analyzer } = fixture(
    '<p>A public paragraph with two short citation links explains the source material without acting as a navigation menu. <a href="#one">1</a><a href="#two">2</a></p><div><button>One</button><button>Two</button></div>',
  )
  try {
    expect(analyzer.classifyCandidateElement(document.querySelector("p"))).toMatchObject({
      ok: true,
    })
    const controls = document.querySelector("div")!
    expect(Rules.isLikelyUiMetaBlock(controls, controls.textContent!)).toBe(true)
  } finally {
    dom.window.close()
  }
})
