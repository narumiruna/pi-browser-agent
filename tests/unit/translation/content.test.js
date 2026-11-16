import assert from "node:assert/strict"
import { afterAll, test } from "vitest"

const originalWindow = global.window
const originalDocument = global.document
const originalChrome = global.chrome
const originalNode = global.Node

global.Node = {
  DOCUMENT_POSITION_FOLLOWING: 4,
  DOCUMENT_POSITION_PRECEDING: 2,
  ELEMENT_NODE: 1,
  TEXT_NODE: 3,
}

global.window = {
  __OPENAI_TRANSLATOR_CONTENT__: false,
  clearTimeout,
  getComputedStyle(element) {
    return {
      backdropFilter: "none",
      display: "block",
      ...element?.computedStyle,
      filter: "none",
      mixBlendMode: "normal",
      perspective: "none",
      transform: "none",
      visibility: "visible",
    }
  },
  setTimeout,
}
global.document = {
  body: {},
  querySelectorAll() {
    return []
  },
}
global.chrome = {
  runtime: {
    onMessage: {
      addListener() {},
    },
  },
}

import { createContentRulesForProfile } from "../../../src/browser/translation/content/extraction/rules.js"
import {
  ANTIREZ_PROSE_CONTAINER_SELECTOR,
  ANTIREZ_PROSE_TEXT_SELECTOR,
  resolveSiteProfile,
  SCHIIT_ARTICLE_TEXT_SELECTOR,
  THREADS_TEXT_BLOCK_SELECTOR,
  X_CURRENT_POST_TEXT_SELECTOR,
  X_TWEET_TEXT_SELECTOR,
} from "../../../src/browser/translation/content/extraction/site-profiles.js"
import { createContentRuntime } from "../../../src/browser/translation/content.js"

const contentTestApi = createContentRuntime({ mount: false }).__TEST__

const {
  ARTICLE_CONTENT_SELECTOR,
  EXPLICIT_TEXT_BLOCK_SELECTOR,
  READABLE_BLOCK_SELECTOR,
  _createExtractionDebugState,
  _finalizeExtractionDebug,
  _getDebugProfileLabel,
  _allocateSourceId,
  _getHighestSourceIdCounter,
  _getNoteElementTagName,
  _insertNoteForTarget,
  _hasSourceTextChanged,
  _isSafeNoteInsertionTarget,
  _rememberSourceText,
  _resetSourceIdCounterForTest,
  _resetSourceTextSnapshotsForTest,
  _SCROLL_LISTENER_OPTIONS,
  _shouldAppendNoteInsideTarget,
  detectContentMode,
  getSegmentContent,
  isHeadingLikeElement,
  isInsideTranslation,
  isTranslatorOwned,
  isUnsupportedElement,
  scoreCandidateBlock,
  scoreTranslationRoot,
} = contentTestApi

function createExtractionSelectorsForProfile(profile) {
  return createContentRulesForProfile(profile).selectors
}

function splitSelector(selector) {
  return String(selector)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
}

function createFakeElement(options = {}) {
  const matchedSelectors = new Set(options.matchedSelectors || [])
  const ancestorSelectors = new Set(options.ancestorSelectors || [])
  const linkTexts = options.linkTexts || []
  const interactiveCount = options.interactiveCount || 0
  const directBlockChildCount = options.directBlockChildCount || 0

  return {
    isConnected: options.isConnected ?? true,
    // biome-ignore lint/performance/useDomNodeTextContent: These are fixture values, not DOM reads.
    innerText: options.innerText || options.textContent || "",
    // biome-ignore lint/performance/useDomNodeTextContent: These are fixture values, not DOM reads.
    textContent: options.textContent || options.innerText || "",
    tagName: options.tagName || "DIV",
    parentElement: options.parentElement || null,
    computedStyle: options.computedStyle || null,
    children: Array.from({ length: directBlockChildCount }, () => ({
      matches(selector) {
        return splitSelector(selector).includes("div")
      },
    })),
    closest(selector) {
      if (this.matches(selector)) {
        return this
      }

      return splitSelector(selector).some((part) => ancestorSelectors.has(part)) ? {} : null
    },
    matches(selector) {
      return splitSelector(selector).some(
        (part) =>
          matchedSelectors.has(part) ||
          part.toLowerCase() === String(this.tagName || "").toLowerCase(),
      )
    },
    querySelectorAll(selector) {
      if (selector === "a") {
        return linkTexts.map((text) => ({ textContent: text }))
      }

      if (selector === 'main, article, [role="main"]') {
        return Array.from({ length: options.nestedRootCount || 0 }, () => ({}))
      }

      if (selector.includes(".docs-nav-rail") || selector.includes("time")) {
        return Array.from({ length: options.unsupportedCount || 0 }, () => ({}))
      }

      if (selector.includes('[role="button"]')) {
        return Array.from({ length: interactiveCount }, () => ({}))
      }

      if (selector.includes("blockquote") && selector.includes("figcaption")) {
        return Array.from({ length: options.semanticCount || 0 }, () => ({}))
      }

      return []
    },
  }
}

function createSerializableText(text) {
  return {
    nodeType: Node.TEXT_NODE,
    textContent: text,
  }
}

function createSerializableElement(options = {}) {
  const element = createFakeElement({
    matchedSelectors: options.matchedSelectors || [],
    tagName: options.tagName || "DIV",
  })

  element.nodeType = Node.ELEMENT_NODE
  element.childNodes = options.children || []
  element.getAttribute = (name) => options.attributes?.[name] || null
  for (const child of element.childNodes) {
    if (child && child.nodeType === Node.ELEMENT_NODE) {
      child.parentElement = element
    }
  }

  return element
}

test("headline-like selectors are treated as headings", () => {
  assert.equal(
    isHeadingLikeElement(
      createFakeElement({
        matchedSelectors: [".gs-c-promo-heading"],
        tagName: "A",
      }),
    ),
    true,
  )

  assert.equal(
    isHeadingLikeElement(
      createFakeElement({
        matchedSelectors: ['[role="heading"]'],
      }),
    ),
    true,
  )

  assert.equal(
    isHeadingLikeElement(
      createFakeElement({
        matchedSelectors: [".p-eplist__chapter-title"],
      }),
    ),
    true,
  )
})

test("directory-like chapter listing pages use directory mode", () => {
  const root = {
    querySelector(selector) {
      return selector === ".p-eplist" ? {} : null
    },
    querySelectorAll(selector) {
      if (selector === ".p-eplist__subtitle") {
        return Array.from({ length: 20 }, () => ({}))
      }

      return []
    },
  }

  assert.equal(detectContentMode(root), "directory")
})

test("content inside article headers is no longer treated as unsupported", () => {
  assert.equal(
    isUnsupportedElement(
      createFakeElement({
        ancestorSelectors: ["header"],
        matchedSelectors: ["h1"],
        tagName: "H1",
      }),
    ),
    false,
  )

  assert.equal(
    isUnsupportedElement(
      createFakeElement({
        ancestorSelectors: [".share"],
        matchedSelectors: ["p"],
        tagName: "P",
      }),
    ),
    true,
  )
})

test("short GitHub Markdown comments with links remain readable prose", () => {
  const selectors = createExtractionSelectorsForProfile(resolveSiteProfile("github.com"))
  const element = createFakeElement({
    tagName: "P",
    matchedSelectors: [".markdown-body p"],
    linkTexts: ["CONTRIBUTING.md"],
    interactiveCount: 1,
  })
  const text = "See CONTRIBUTING.md."
  assert.ok(scoreCandidateBlock(element, text) < 40)
  assert.ok(
    scoreCandidateBlock(element, text, {
      explicitTextBlockSelector: selectors.EXPLICIT_TEXT_BLOCK_SELECTOR,
    }) >= 40,
  )
})

test("shared class names do not exclude GitHub comments", () => {
  // A shared__ timeline wrapper matches the broad substring, not share- or share_.
  for (const relation of ["matchedSelectors", "ancestorSelectors"]) {
    assert.equal(
      isUnsupportedElement(createFakeElement({ [relation]: ['[class*="share"]'] })),
      false,
    )
  }
})

test("share controls remain unsupported", () => {
  for (const selector of [
    ".share",
    ".sharing",
    ".social-share",
    '[class*="share-"]',
    '[class*="share_"]',
    '[data-testid*="share"]',
  ]) {
    for (const relation of ["matchedSelectors", "ancestorSelectors"]) {
      assert.equal(isUnsupportedElement(createFakeElement({ [relation]: [selector] })), true)
    }
  }
})

test("navigation and table-of-contents regions are unsupported", () => {
  assert.equal(
    isUnsupportedElement(
      createFakeElement({
        ancestorSelectors: ["nav"],
        matchedSelectors: ["h2"],
        tagName: "H2",
      }),
    ),
    true,
  )

  assert.equal(
    isUnsupportedElement(
      createFakeElement({
        ancestorSelectors: [".docs-toc-rail"],
        matchedSelectors: ["p"],
        tagName: "P",
      }),
    ),
    true,
  )
})

test("site-owned translation class is not treated as extension-owned", () => {
  const siteTranslationBlock = createFakeElement({
    ancestorSelectors: [".translation"],
    matchedSelectors: ["p"],
    tagName: "P",
  })
  const extensionBlock = createFakeElement({
    ancestorSelectors: ["[data-ot-role]"],
    matchedSelectors: ["p"],
    tagName: "P",
  })

  assert.equal(isInsideTranslation(siteTranslationBlock), false)
  assert.equal(isTranslatorOwned(siteTranslationBlock), false)
  assert.equal(isUnsupportedElement(siteTranslationBlock), false)
  assert.equal(isInsideTranslation(extensionBlock), true)
  assert.equal(isTranslatorOwned(extensionBlock), true)
})

test("source id allocation scans existing ids once and stays monotonic", () => {
  const originalQuerySelectorAll = global.document.querySelectorAll
  let scanCount = 0

  try {
    _resetSourceIdCounterForTest()
    global.document.querySelectorAll = () => {
      scanCount += 1

      return scanCount === 1
        ? [{ getAttribute: () => "ot-3" }, { getAttribute: () => "ot-7" }]
        : [{ getAttribute: () => "ot-100" }]
    }

    assert.equal(_getHighestSourceIdCounter(), 7)
    scanCount = 0
    assert.equal(_allocateSourceId(), "ot-8")
    assert.equal(_allocateSourceId(), "ot-9")
    assert.equal(scanCount, 1)
  } finally {
    global.document.querySelectorAll = originalQuerySelectorAll
    _resetSourceIdCounterForTest()
  }
})

test("table cell and non-grid notes preserve their insertion behavior", () => {
  const tableCell = createFakeElement({ tagName: "TD" })
  const paragraph = createFakeElement({ tagName: "P" })
  const tableNote = {}
  const paragraphNote = {}
  const insertions = []

  tableCell.appendChild = (note) => insertions.push(["append", note])
  paragraph.insertAdjacentElement = (position, note) => insertions.push([position, note])

  assert.equal(_getNoteElementTagName(tableCell), "div")
  assert.equal(_getNoteElementTagName({ tagName: "TH" }), "div")
  assert.equal(_shouldAppendNoteInsideTarget(tableCell), true)
  assert.equal(_shouldAppendNoteInsideTarget(paragraph), false)

  _insertNoteForTarget(tableCell, tableNote)
  _insertNoteForTarget(paragraph, paragraphNote)
  assert.deepEqual(insertions, [
    ["append", tableNote],
    ["afterend", paragraphNote],
  ])
})

test("constrained table cells never insert notes under their row", () => {
  for (const tagName of ["TD", "TH"]) {
    for (const computedStyle of [
      { display: "flex" },
      { display: "grid" },
      { overflowX: "hidden", overflowY: "hidden" },
      { maxHeight: "24px" },
      { height: "24px" },
      { contain: "paint" },
    ]) {
      const cell = createFakeElement({
        tagName,
        computedStyle,
        parentElement: createFakeElement({
          tagName: "TR",
          computedStyle: { display: "table-row" },
        }),
      })
      const styles = new Map()
      const note = {
        style: { setProperty: (name, value) => styles.set(name, value) },
      }
      cell.appendChild = () => assert.fail("Unsafe cell must not contain a note")
      cell.insertAdjacentElement = () => assert.fail("A note cannot be a sibling of a table cell")
      assert.equal(_shouldAppendNoteInsideTarget(cell), false)
      assert.equal(_isSafeNoteInsertionTarget(cell), false)
      _insertNoteForTarget(cell, note)
      assert.equal(styles.get("display"), "none")
    }
  }
})

test("grid notes stay inside auto, explicit, and responsive source placement", () => {
  const gridParent = createFakeElement({
    computedStyle: { display: "grid" },
  })
  const placements = [
    { gridColumnStart: "auto", gridRowStart: "auto" },
    { gridColumnStart: "2", gridRowStart: "3" },
  ]

  for (const computedStyle of placements) {
    const paragraph = createFakeElement({
      computedStyle,
      parentElement: gridParent,
      tagName: "P",
    })
    const note = {}
    let siblingInsertion = false

    paragraph.appendChild = (child) => {
      child.parentElement = paragraph
    }
    paragraph.insertAdjacentElement = () => {
      siblingInsertion = true
    }

    assert.equal(_shouldAppendNoteInsideTarget(paragraph), true)
    assert.equal(_getNoteElementTagName(paragraph, paragraph), "span")
    _insertNoteForTarget(paragraph, note)
    assert.equal(note.parentElement, paragraph)
    assert.equal(siblingInsertion, false)

    computedStyle.gridColumnStart = "1"
    computedStyle.gridRowStart = "1"
    assert.equal(note.parentElement, paragraph)
  }
})

test("flex notes stay within their source across responsive directions", () => {
  for (const display of ["flex", "inline-flex"]) {
    for (const flexDirection of ["row", "row-reverse", "column", "column-reverse"]) {
      const parent = createFakeElement({
        computedStyle: { display, flexDirection },
      })
      const source = createFakeElement({
        parentElement: parent,
        tagName: "H2",
      })
      const children = new Set()
      const note = {}
      source.appendChild = (child) => children.add(child)
      source.insertAdjacentElement = () => assert.fail("Must not create another flex item")
      assert.equal(_getNoteElementTagName(source), "span")
      assert.equal(_shouldAppendNoteInsideTarget(source), true)
      _insertNoteForTarget(source, note)
      parent.computedStyle.flexDirection = "column"
      _insertNoteForTarget(source, note)
      assert.equal(children.size, 1)
    }
  }
})

test("constrained flex items use sibling notes only in safe column layouts", () => {
  for (const computedStyle of [
    { display: "flex" },
    { display: "grid" },
    { overflowX: "hidden", overflowY: "hidden" },
    { maxHeight: "24px" },
    { height: "24px" },
    { contain: "paint" },
  ]) {
    const parent = createFakeElement({
      computedStyle: { display: "flex", flexDirection: "column" },
    })
    const source = createFakeElement({
      parentElement: parent,
      computedStyle,
      tagName: "P",
    })
    const insertions = []
    const properties = new Map()
    const note = {
      style: {
        setProperty: (name, value) => properties.set(name, value),
        removeProperty: (name) => properties.delete(name),
      },
    }
    source.appendChild = () => assert.fail("Constrained source must not contain the note")
    source.insertAdjacentElement = (position) => insertions.push(position)
    assert.equal(_shouldAppendNoteInsideTarget(source), false)
    _insertNoteForTarget(source, note)
    assert.deepEqual(insertions, ["afterend"])
    parent.computedStyle.flexDirection = "column-reverse"
    _insertNoteForTarget(source, note)
    assert.deepEqual(insertions, ["afterend", "beforebegin"])
    parent.computedStyle.flexDirection = "row"
    _insertNoteForTarget(source, note)
    assert.equal(properties.get("display"), "none")
    assert.equal(insertions.length, 2)
  }
})

test("child placement uses computed height rather than used pixel height", () => {
  for (const height of ["auto", "24px", "50%", "calc(50% + 24px)"]) {
    const source = createFakeElement({
      tagName: "P",
      computedStyle: { height: "24px" },
      parentElement: createFakeElement({
        computedStyle: { display: "grid" },
      }),
    })
    source.computedStyleMap = () => new Map([["height", { toString: () => height }]])
    assert.equal(_shouldAppendNoteInsideTarget(source), height === "auto")
    assert.equal(_isSafeNoteInsertionTarget(source), height === "auto")
  }
})

test("fixed flex basis blocks child placement only on a vertical main axis", () => {
  for (const writingMode of ["horizontal-tb", "vertical-rl", "sideways-lr"]) {
    for (const flexDirection of ["row", "row-reverse", "column", "column-reverse"]) {
      for (const flexBasis of ["auto", "content", "24px", "0%"]) {
        const source = createFakeElement({
          tagName: "P",
          computedStyle: { flexBasis },
          parentElement: createFakeElement({
            computedStyle: { display: "flex", writingMode, flexDirection },
          }),
        })
        const verticalDirections =
          writingMode === "horizontal-tb" ? ["column", "column-reverse"] : ["row", "row-reverse"]
        const allowed =
          ["auto", "content"].includes(flexBasis) || !verticalDirections.includes(flexDirection)
        assert.equal(_shouldAppendNoteInsideTarget(source), allowed)
      }
    }
  }
})

test("nested grid notes are excluded from source text", () => {
  const note = createSerializableElement({
    attributes: { "data-ot-role": "note" },
    children: [createSerializableText("Translated text")],
    matchedSelectors: ["[data-ot-role]"],
    tagName: "SPAN",
  })
  const source = createSerializableElement({
    children: [createSerializableText("Source text"), note],
    tagName: "P",
  })

  assert.equal(getSegmentContent(source).text, "Source text")
})

test("extraction debug exposes a site profile label", () => {
  const debugInfo = _finalizeExtractionDebug(_createExtractionDebugState())

  assert.equal(debugInfo.profileId, "default")
  assert.equal(_getDebugProfileLabel(debugInfo), "Profile: default")
  assert.equal(_getDebugProfileLabel({ profileId: "x" }), "Profile: x")
})

test("source text snapshots ignore unchanged mutations", () => {
  const textNode = {
    nodeType: global.Node.TEXT_NODE,
    textContent: "Alpha text",
  }
  const element = {
    childNodes: [textNode],
    closest() {
      return null
    },
    getAttribute() {
      return null
    },
    matches() {
      return false
    },
    nodeType: global.Node.ELEMENT_NODE,
    tagName: "P",
  }

  _resetSourceTextSnapshotsForTest()
  _rememberSourceText(element, "Alpha text")
  assert.equal(_hasSourceTextChanged(element), false)

  textNode.textContent = "Beta text"
  assert.equal(_hasSourceTextChanged(element), true)
  _resetSourceTextSnapshotsForTest()
})

test("article content roots outrank surrounding docs layout roots", () => {
  const repeatedText = "Readable documentation paragraph ".repeat(80)
  const mainLayout = createFakeElement({
    directBlockChildCount: 2,
    innerText: repeatedText,
    interactiveCount: 50,
    linkTexts: Array.from({ length: 50 }, (_, index) => `Navigation ${index}`),
    matchedSelectors: ["main"],
    semanticCount: 32,
    tagName: "MAIN",
  })
  const articleBody = createFakeElement({
    directBlockChildCount: 13,
    innerText: repeatedText.slice(0, 1800),
    interactiveCount: 20,
    linkTexts: Array.from({ length: 20 }, (_, index) => `Guide ${index}`),
    matchedSelectors: [".docs-prose"],
    semanticCount: 30,
  })

  assert.match(ARTICLE_CONTENT_SELECTOR, /\.docs-prose/)
  assert.ok(scoreTranslationRoot(articleBody) > scoreTranslationRoot(mainLayout))
})

test("hidden article roots are excluded without excluding offscreen roots", () => {
  for (const visible of [false, true]) {
    const article = createFakeElement({
      innerText: "Readable article prose remains eligible outside the viewport. ".repeat(4),
      semanticCount: 4,
      tagName: "ARTICLE",
    })
    article.checkVisibility = (options) => {
      assert.deepEqual(options, { visibilityProperty: true })
      return visible
    }
    article.getBoundingClientRect = () => ({
      top: 10000,
      width: 600,
      height: 500,
    })

    const score = scoreTranslationRoot(article)
    assert.equal(Number.isFinite(score), visible)
    if (!visible) assert.equal(score, Number.NEGATIVE_INFINITY)
  }
})

test("roots without visible boxes require a visible readable descendant", () => {
  for (const rootStyle of [
    { display: "contents" },
    { display: "block", visibility: "hidden" },
    { display: "block", visibility: "collapse" },
  ]) {
    for (const tagName of ["MAIN", "ARTICLE"]) {
      for (const [visible, contentVisibility, eligible] of [
        [true, "visible", true],
        [false, "visible", false],
        [true, "hidden", false],
      ]) {
        const root = createFakeElement({
          innerText: "A boxless root contains readable article prose. ".repeat(4),
          semanticCount: 4,
          tagName,
        })
        const descendant = { checkVisibility: () => visible }
        const querySelectorAll = root.querySelectorAll.bind(root)
        root.querySelectorAll = (selector) =>
          selector === READABLE_BLOCK_SELECTOR ? [descendant] : querySelectorAll(selector)
        root.checkVisibility = () => false
        root.ownerDocument = {
          defaultView: {
            getComputedStyle: (element) =>
              element === root
                ? { ...rootStyle, contentVisibility: "visible" }
                : { display: "block", contentVisibility },
          },
        }
        assert.equal(Number.isFinite(scoreTranslationRoot(root)), eligible)
      }
    }
  }
})

test("root content hidden by content-visibility is excluded even when its box is visible", () => {
  const article = createFakeElement({
    innerText: "This hidden article retains a box but its contents are not rendered. ".repeat(4),
    semanticCount: 4,
    tagName: "ARTICLE",
  })
  article.checkVisibility = () => true
  article.ownerDocument = {
    defaultView: { getComputedStyle: () => ({ contentVisibility: "hidden" }) },
  }
  assert.equal(scoreTranslationRoot(article), Number.NEGATIVE_INFINITY)
})

test("heading candidates score above equivalent non-heading link blocks", () => {
  const heading = createFakeElement({
    interactiveCount: 1,
    linkTexts: ["Breaking news headline"],
    matchedSelectors: ["h2"],
    tagName: "H2",
  })
  const nonHeading = createFakeElement({
    interactiveCount: 1,
    linkTexts: ["Breaking news headline"],
    matchedSelectors: ["div"],
    tagName: "DIV",
  })

  assert.ok(
    scoreCandidateBlock(heading, "Breaking news headline") >
      scoreCandidateBlock(nonHeading, "Breaking news headline"),
  )
})

test("plain heading blocks keep a positive heading bonus", () => {
  const heading = createFakeElement({
    matchedSelectors: ["h2"],
    tagName: "H2",
  })
  const nonHeading = createFakeElement({
    matchedSelectors: ["div"],
    tagName: "DIV",
  })

  assert.ok(
    scoreCandidateBlock(heading, "Section title") >
      scoreCandidateBlock(nonHeading, "Section title"),
  )
})

test("default readable selectors exclude site-specific text blocks", () => {
  assert.equal(READABLE_BLOCK_SELECTOR.includes(X_TWEET_TEXT_SELECTOR), false)
  assert.equal(READABLE_BLOCK_SELECTOR.includes(X_CURRENT_POST_TEXT_SELECTOR), false)
  assert.equal(READABLE_BLOCK_SELECTOR.includes(THREADS_TEXT_BLOCK_SELECTOR), false)
  assert.equal(EXPLICIT_TEXT_BLOCK_SELECTOR, ":not(*)")
})

test("generic content rules derive readable and direct note selectors", () => {
  const rules = createContentRulesForProfile({
    rootSelectors: [".article-shell"],
    textBlockSelectors: [".article-copy"],
    splitContainerSelectors: ["pre.article-copy"],
  })
  const selectors = rules.selectors
  const articleCopy = createFakeElement({
    matchedSelectors: [".article-copy"],
    tagName: "DIV",
  })

  assert.equal(selectors.SITE_ROOT_SELECTOR, ".article-shell")
  assert.equal(selectors.EXPLICIT_TEXT_BLOCK_SELECTOR, ".article-copy")
  assert.ok(selectors.READABLE_BLOCK_SELECTOR.includes(".article-copy"))
  assert.ok(selectors.DIRECT_NOTE_TARGET_SELECTOR.includes(".article-copy"))
  assert.equal(selectors.SPLIT_CONTAINER_SELECTOR, "pre.article-copy")
  assert.ok(
    scoreCandidateBlock(articleCopy, "Short non-semantic article text", {
      explicitTextBlockSelector: selectors.EXPLICIT_TEXT_BLOCK_SELECTOR,
    }) >= 40,
  )
  assert.equal(_isSafeNoteInsertionTarget(articleCopy, selectors), true)
})

test("generic content rules describe dynamic and embedded text blocks", () => {
  const dynamicRules = createContentRulesForProfile({
    allowAncestorTransforms: true,
    dynamic: true,
    textBlockSelectors: [".feed-text"],
  })
  const commentRules = createContentRulesForProfile({
    embeddedFramePatterns: ["https://comments.example/*"],
    rootSelectors: ["#comments"],
    textBlockSelectors: [".comment-body"],
    windowed: false,
  })

  assert.equal(dynamicRules.dynamic, true)
  assert.equal(dynamicRules.allowAncestorTransforms, true)
  assert.ok(dynamicRules.selectors.DIRECT_NOTE_TARGET_SELECTOR.includes(".feed-text"))
  assert.deepEqual(commentRules.embeddedFramePatterns, ["https://comments.example/*"])
  assert.equal(commentRules.windowed, false)
  assert.equal(commentRules.selectors.SITE_ROOT_SELECTOR, "#comments")
  assert.ok(commentRules.selectors.READABLE_BLOCK_SELECTOR.includes(".comment-body"))
  assert.ok(commentRules.selectors.DIRECT_NOTE_TARGET_SELECTOR.includes(".comment-body"))
})

test("generic content rules support safe empty and direct-target overrides", () => {
  const emptyRules = createContentRulesForProfile({})
  const overrideRules = createContentRulesForProfile({
    directNoteTargetSelectors: [".translation-anchor"],
    textBlockSelectors: [".source-copy"],
  })

  assert.equal(emptyRules.selectors.EXPLICIT_TEXT_BLOCK_SELECTOR, ":not(*)")
  assert.equal(emptyRules.selectors.SITE_ROOT_SELECTOR, ":not(*)")
  assert.ok(overrideRules.selectors.READABLE_BLOCK_SELECTOR.includes(".source-copy"))
  assert.equal(overrideRules.selectors.DIRECT_NOTE_TARGET_SELECTOR.includes(".source-copy"), false)
  assert.ok(overrideRules.selectors.DIRECT_NOTE_TARGET_SELECTOR.includes(".translation-anchor"))
})

test("Antirez preformatted article paragraphs are readable direct note targets", () => {
  const antirezProfile = resolveSiteProfile("antirez.com")
  const antirezSelectors = createExtractionSelectorsForProfile(antirezProfile)

  assert.equal(resolveSiteProfile("www.antirez.com").id, "antirez")
  assert.ok(antirezSelectors.READABLE_BLOCK_SELECTOR.includes(ANTIREZ_PROSE_TEXT_SELECTOR))
  assert.ok(antirezSelectors.DIRECT_NOTE_TARGET_SELECTOR.includes(ANTIREZ_PROSE_TEXT_SELECTOR))
  assert.ok(antirezSelectors.EXPLICIT_TEXT_BLOCK_SELECTOR.includes(ANTIREZ_PROSE_TEXT_SELECTOR))
  assert.equal(antirezSelectors.SITE_ROOT_SELECTOR, "#content")
  assert.ok(antirezSelectors.SPLIT_CONTAINER_SELECTOR.includes(ANTIREZ_PROSE_CONTAINER_SELECTOR))
})

test("explicit prose text blocks receive enough score for short FAQ questions", () => {
  const question = createFakeElement({
    matchedSelectors: splitSelector(SCHIIT_ARTICLE_TEXT_SELECTOR),
    tagName: "DIV",
  })

  assert.ok(
    scoreCandidateBlock(question, "How do I return something?", {
      explicitTextBlockSelector: SCHIIT_ARTICLE_TEXT_SELECTOR,
    }) >= 40,
  )
})

test("X tweet text blocks are readable direct note targets", () => {
  const xSelectors = createExtractionSelectorsForProfile(resolveSiteProfile("x.com"))

  assert.ok(xSelectors.READABLE_BLOCK_SELECTOR.includes(X_TWEET_TEXT_SELECTOR))
  assert.ok(xSelectors.DIRECT_NOTE_TARGET_SELECTOR.includes(X_TWEET_TEXT_SELECTOR))

  const tweetText = createFakeElement({
    matchedSelectors: [X_TWEET_TEXT_SELECTOR],
    tagName: "DIV",
  })

  assert.ok(
    scoreCandidateBlock(tweetText, "Short status", {
      explicitTextBlockSelector: xSelectors.EXPLICIT_TEXT_BLOCK_SELECTOR,
    }) >= 40,
  )
})

test("current X post text blocks are readable direct note targets", () => {
  const xSelectors = createExtractionSelectorsForProfile(resolveSiteProfile("x.com"))

  assert.ok(xSelectors.READABLE_BLOCK_SELECTOR.includes(X_CURRENT_POST_TEXT_SELECTOR))
  assert.ok(xSelectors.DIRECT_NOTE_TARGET_SELECTOR.includes(X_CURRENT_POST_TEXT_SELECTOR))
  assert.ok(xSelectors.EXPLICIT_TEXT_BLOCK_SELECTOR.includes(X_CURRENT_POST_TEXT_SELECTOR))

  const tweetText = createFakeElement({
    matchedSelectors: [X_CURRENT_POST_TEXT_SELECTOR],
    tagName: "DIV",
  })

  assert.ok(
    scoreCandidateBlock(
      tweetText,
      "Btw anybody with some Mistral insider info is understanding WTF the company is doing?",
      {
        explicitTextBlockSelector: xSelectors.EXPLICIT_TEXT_BLOCK_SELECTOR,
      },
    ) >= 40,
  )
})

test("Threads language text blocks are readable direct note targets", () => {
  const threadsSelectors = createExtractionSelectorsForProfile(resolveSiteProfile("threads.net"))

  assert.ok(threadsSelectors.READABLE_BLOCK_SELECTOR.includes(THREADS_TEXT_BLOCK_SELECTOR))
  assert.ok(threadsSelectors.DIRECT_NOTE_TARGET_SELECTOR.includes(THREADS_TEXT_BLOCK_SELECTOR))
  assert.ok(threadsSelectors.EXPLICIT_TEXT_BLOCK_SELECTOR.includes(THREADS_TEXT_BLOCK_SELECTOR))

  const threadText = createFakeElement({
    directBlockChildCount: 1,
    interactiveCount: 1,
    matchedSelectors: [THREADS_TEXT_BLOCK_SELECTOR],
    tagName: "DIV",
  })

  assert.ok(
    scoreCandidateBlock(threadText, "佳子様、しっかり見えますね", {
      explicitTextBlockSelector: threadsSelectors.EXPLICIT_TEXT_BLOCK_SELECTOR,
    }) >= 40,
  )
})

test("social text extraction skips inline translate buttons", () => {
  const threadText = createSerializableElement({
    matchedSelectors: [THREADS_TEXT_BLOCK_SELECTOR],
    children: [
      createSerializableElement({
        tagName: "SPAN",
        children: [createSerializableText("佳子様、しっかり見えますね")],
      }),
      createSerializableText("  "),
      createSerializableElement({
        matchedSelectors: ['[role="button"]'],
        children: [createSerializableText("Translate")],
      }),
    ],
  })

  assert.equal(getSegmentContent(threadText).text, "佳子様、しっかり見えますね")
})

test("scroll listener captures nested scrolling containers", () => {
  assert.deepEqual(_SCROLL_LISTENER_OPTIONS, {
    capture: true,
    passive: true,
  })
})

test("declared layout capability allows only ancestor transforms", () => {
  const xRules = createContentRulesForProfile(resolveSiteProfile("x.com"))
  const xSelectors = xRules.selectors
  const body = {}
  const parent = {
    computedStyle: {
      backdropFilter: "none",
      filter: "none",
      mixBlendMode: "normal",
      perspective: "none",
      transform: "matrix(1, 0, 0, 1, 0, 640)",
    },
    matches() {
      return false
    },
    parentElement: body,
    tagName: "DIV",
  }
  const tweetText = createFakeElement({
    matchedSelectors: [X_TWEET_TEXT_SELECTOR],
    parentElement: parent,
    tagName: "DIV",
  })

  global.document.body = body
  global.window.getComputedStyle = (element) =>
    element.computedStyle || {
      backdropFilter: "none",
      display: "block",
      filter: "none",
      mixBlendMode: "normal",
      perspective: "none",
      transform: "none",
      visibility: "visible",
    }

  assert.equal(
    _isSafeNoteInsertionTarget(tweetText, {
      ...xSelectors,
      allowAncestorTransforms: xRules.allowAncestorTransforms,
    }),
    true,
  )

  tweetText.computedStyle = {
    backdropFilter: "none",
    filter: "none",
    mixBlendMode: "normal",
    transform: "matrix(1, 0, 0, 1, 0, 12)",
  }
  assert.equal(
    _isSafeNoteInsertionTarget(tweetText, {
      ...xSelectors,
      allowAncestorTransforms: xRules.allowAncestorTransforms,
    }),
    false,
  )
})

test("perspective scroll containers do not block direct note insertion targets", () => {
  const threadsSelectors = createExtractionSelectorsForProfile(resolveSiteProfile("threads.net"))
  const body = {}
  const parent = {
    computedStyle: {
      backdropFilter: "none",
      filter: "none",
      mixBlendMode: "normal",
      perspective: "1px",
      transform: "matrix(1, 0, 0, 1, 0, 0)",
    },
    matches() {
      return false
    },
    parentElement: body,
    tagName: "DIV",
  }
  const threadText = createFakeElement({
    matchedSelectors: [THREADS_TEXT_BLOCK_SELECTOR],
    parentElement: parent,
    tagName: "DIV",
  })

  global.document.body = body
  global.window.getComputedStyle = (element) =>
    element.computedStyle || {
      backdropFilter: "none",
      display: "block",
      filter: "none",
      mixBlendMode: "normal",
      perspective: "none",
      transform: "none",
      visibility: "visible",
    }

  assert.equal(_isSafeNoteInsertionTarget(threadText, threadsSelectors), true)

  parent.computedStyle.transform = "matrix(1, 0, 0, 1, 0, 12)"
  assert.equal(_isSafeNoteInsertionTarget(threadText, threadsSelectors), false)
})

afterAll(() => {
  global.window = originalWindow
  global.document = originalDocument
  global.chrome = originalChrome
  global.Node = originalNode
})
