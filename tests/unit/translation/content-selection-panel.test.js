import assert from "node:assert/strict"
import { test } from "vitest"

import {
  createSelectionPanelRenderer,
  getSelectionPanelWidth,
  normalizeSelectionAnchorRect,
  normalizeSelectionRequestId,
  shouldCloseSelectionPanelOnKey,
} from "../../../src/browser/translation/content/selection/panel.js"
import { normalizeSelectionPanelPositionMode } from "../../../src/browser/translation/shared/settings.js"

class FakeClassList {
  constructor() {
    this.values = new Set()
  }

  add(...values) {
    for (const value of values) {
      this.values.add(value)
    }
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase()
    this.attributes = {}
    this.children = []
    this.classList = new FakeClassList()
    this.eventListeners = new Map()
    this.hidden = false
    this.parentNode = null
    this.style = {}
    this._textContent = ""
    this.clientHeight = 80
    this.clientWidth = 256
    this.offsetHeight = 160
    this.offsetWidth = 280
    this.scrollHeight = 80
    this.scrollWidth = 256
  }

  addEventListener(type, listener) {
    this.eventListeners.set(type, listener)
  }

  appendChild(child) {
    child.parentNode = this
    this.children.push(child)
    return child
  }

  click() {
    this.eventListeners.get("click")?.({ currentTarget: this })
  }

  getAttribute(name) {
    return this.attributes[name] ?? null
  }

  querySelector(selector) {
    const match = selector.match(/^\[([^=]+)="([^"]+)"\]$/)

    if (!match) {
      return null
    }

    const [, name, value] = match
    const queue = [...this.children]

    while (queue.length > 0) {
      const child = queue.shift()

      if (child.getAttribute?.(name) === value) {
        return child
      }

      queue.push(...(child.children || []))
    }

    return null
  }

  querySelectorAll(selector) {
    if (selector === "br") {
      return []
    }

    return []
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.children = this.parentNode.children.filter((child) => child !== this)
      this.parentNode = null
    }
  }

  replaceChildren(...children) {
    this.children = []
    this._textContent = ""

    for (const child of children) {
      this.appendChild(child)
    }
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value)
  }

  get textContent() {
    return this.children.length > 0
      ? this.children.map((child) => child.textContent).join("")
      : this._textContent
  }

  set textContent(value) {
    this.children = []
    this._textContent = String(value)
  }
}

function createRendererHarness(options = {}) {
  const documentElement = new FakeElement("html")
  const body = new FakeElement("body")
  const listeners = new Map()
  const viewportListeners = new Map()

  documentElement.clientHeight = 600
  documentElement.clientWidth = 800
  documentElement.appendChild(body)

  const document = {
    body,
    documentElement,
    addEventListener(type, listener) {
      listeners.set(type, listener)
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) {
        listeners.delete(type)
      }
    },
    createElement(tagName) {
      return new FakeElement(tagName)
    },
    createTextNode(text) {
      const node = new FakeElement("#text")

      node.textContent = text
      return node
    },
    querySelector(selector) {
      return documentElement.querySelector(selector)
    },
  }
  const retries = []
  const window = {
    innerHeight: 600,
    innerWidth: 800,
    addEventListener(type, listener) {
      viewportListeners.set(type, listener)
    },
    removeEventListener(type, listener) {
      if (viewportListeners.get(type) === listener) {
        viewportListeners.delete(type)
      }
    },
  }
  const renderer = createSelectionPanelRenderer({
    document,
    window,
    appendFormattedText(container, text) {
      container.textContent = text
    },
    onRetry(payload) {
      retries.push(payload)
    },
    withObserverPaused(callback) {
      return callback()
    },
    ...options,
  })

  return {
    document,
    listeners,
    renderer,
    retries,
    viewportListeners,
    window,
  }
}

test("normalizeSelectionPanelPositionMode falls back to near-selection", () => {
  assert.equal(normalizeSelectionPanelPositionMode("bottom-right"), "bottom-right")
  assert.equal(normalizeSelectionPanelPositionMode(" NEAR-SELECTION "), "near-selection")
  assert.equal(normalizeSelectionPanelPositionMode("unknown"), "near-selection")
})

test("normalizeSelectionAnchorRect requires finite rectangle values", () => {
  assert.deepEqual(
    normalizeSelectionAnchorRect({
      top: "10",
      right: 90,
      bottom: 30,
      left: 20,
      width: 70,
      height: 20,
    }),
    {
      top: 10,
      right: 90,
      bottom: 30,
      left: 20,
      width: 70,
      height: 20,
    },
  )
  assert.equal(normalizeSelectionAnchorRect(null), null)
  assert.equal(
    normalizeSelectionAnchorRect({
      top: 10,
      right: Number.NaN,
      bottom: 30,
      left: 20,
      width: 70,
      height: 20,
    }),
    null,
  )
})

test("getSelectionPanelWidth keeps one stable width within viewport margins", () => {
  assert.equal(getSelectionPanelWidth(1024), 280)
  assert.equal(getSelectionPanelWidth(300), 276)
  assert.equal(getSelectionPanelWidth(1024, 360), 360)
  assert.equal(getSelectionPanelWidth(1024, 480), 480)
  for (const [requested, expected] of [
    [239, 240],
    [240, 240],
    [481, 480],
    [undefined, 280],
    [Number.NaN, 280],
    [Infinity, 280],
    ["360", 360],
    [null, 240],
    [300.5, 300.5],
  ]) {
    assert.equal(getSelectionPanelWidth(1024, requested), expected)
  }
  assert.equal(getSelectionPanelWidth(200, 480), 176)
  assert.equal(getSelectionPanelWidth(20), 0)
})

test("normalizeSelectionRequestId trims valid ids and rejects empty ids", () => {
  assert.equal(normalizeSelectionRequestId(" request-1 "), "request-1")
  assert.equal(normalizeSelectionRequestId(""), "")
  assert.equal(normalizeSelectionRequestId(null), "")
})

test("shouldCloseSelectionPanelOnKey only accepts plain Escape", () => {
  assert.equal(shouldCloseSelectionPanelOnKey({ key: "Escape" }), true)
  assert.equal(shouldCloseSelectionPanelOnKey({ key: "Escape", defaultPrevented: true }), false)
  assert.equal(shouldCloseSelectionPanelOnKey({ key: "Escape", isComposing: true }), false)
  assert.equal(shouldCloseSelectionPanelOnKey({ key: "Enter" }), false)
  assert.equal(shouldCloseSelectionPanelOnKey(null), false)
})

test("selection panel renderer cleanup removes lifecycle handlers", () => {
  const harness = createRendererHarness()

  harness.renderer.renderPlaceholder({
    requestId: "request-cleanup",
    sourceText: "Hello",
    targetLanguage: "日本語",
  })

  assert.equal(harness.listeners.has("keydown"), true)
  assert.equal(harness.viewportListeners.has("resize"), true)
  assert.equal(
    harness.document.querySelector('[data-ot-role="selection-panel-icon"]')?.textContent,
    "TR",
  )

  harness.renderer.cleanup()

  assert.equal(harness.listeners.has("keydown"), false)
  assert.equal(harness.viewportListeners.has("resize"), false)
  assert.equal(harness.document.querySelector('[data-ot-role="selection-panel"]'), null)
})

test("selection panel renderer close reports cleared panels", () => {
  let removed = false
  const panel = {
    remove() {
      removed = true
    },
  }
  const renderer = createSelectionPanelRenderer({
    document: {
      querySelector(selector) {
        return selector === '[data-ot-role="selection-panel"]' ? panel : null
      },
    },
    window: {},
    withObserverPaused(callback) {
      return callback()
    },
  })

  assert.deepEqual(renderer.close(), { cleared: 1 })
  assert.equal(removed, true)
})

test("selection panel renderer ignores stale and dismissed request results", () => {
  const { document, renderer } = createRendererHarness()

  renderer.renderPlaceholder({
    requestId: "request-a",
    sourceText: "Alpha",
    targetLanguage: "台灣正體中文",
  })
  const panel = document.querySelector('[data-ot-role="selection-panel"]')
  const body = panel.querySelector('[data-ot-role="selection-panel-body"]')

  assert.equal(panel.getAttribute("data-state"), "loading")
  assert.equal(body.getAttribute("role"), "status")
  assert.deepEqual(
    renderer.renderTranslation({
      requestId: "request-b",
      translation: "Stale result",
    }),
    { rendered: "stale" },
  )
  assert.equal(body.getAttribute("data-state"), "pending")

  renderer.close()
  assert.deepEqual(
    renderer.renderTranslation({
      requestId: "request-a",
      translation: "Dismissed result",
    }),
    { rendered: "dismissed" },
  )
  assert.equal(document.querySelector('[data-ot-role="selection-panel"]'), null)
})

test("selection panel renderer exposes an actionable error and explicit retry", () => {
  const { document, renderer, retries } = createRendererHarness()
  const payload = {
    requestId: "request-a",
    selectionAnchor: { top: 10, right: 90, bottom: 30, left: 20 },
    sourceText: "Alpha",
    targetLanguage: "台灣正體中文",
  }

  renderer.renderPlaceholder(payload)
  assert.deepEqual(
    renderer.renderError({
      ...payload,
      error: "The translation service is unavailable.",
    }),
    { rendered: "floating" },
  )

  const panel = document.querySelector('[data-ot-role="selection-panel"]')
  const body = panel.querySelector('[data-ot-role="selection-panel-body"]')
  const retry = panel.querySelector('[data-ot-role="selection-panel-retry"]')

  assert.equal(panel.getAttribute("data-state"), "error")
  assert.equal(body.getAttribute("role"), "alert")
  assert.match(body.textContent, /translation service is unavailable/i)
  assert.equal(retry.hidden, false)

  retry.click()
  assert.equal(retry.disabled, true)
  assert.deepEqual(retries, [
    {
      selectionAnchor: payload.selectionAnchor,
      sourceText: "Alpha",
      targetLanguage: "台灣正體中文",
    },
  ])
})

test("selection panel consumes normalized near-selection and bottom-right modes", () => {
  const { document, renderer } = createRendererHarness()
  const selectionAnchor = {
    top: 100,
    right: 240,
    bottom: 120,
    left: 120,
    width: 120,
    height: 20,
  }

  renderer.renderPlaceholder({
    requestId: "request-near",
    selectionAnchor,
    selectionPanelPositionMode: " NEAR-SELECTION ",
    targetLanguage: "日本語",
  })
  const panel = document.querySelector('[data-ot-role="selection-panel"]')

  assert.notEqual(panel.style.left, "")
  renderer.renderPlaceholder({
    requestId: "request-corner",
    selectionAnchor,
    selectionPanelPositionMode: " BOTTOM-RIGHT ",
    targetLanguage: "日本語",
  })
  assert.equal(panel.style.left, "")
  assert.equal(panel.style.bottom, "")
})

test("selection panel expansion keeps the configured width stable", () => {
  const { document, renderer } = createRendererHarness()

  renderer.renderPlaceholder({
    requestId: "request-a",
    targetLanguage: "日本語",
    translationAppearance: { selection: { widthPx: 360 } },
  })
  const panel = document.querySelector('[data-ot-role="selection-panel"]')
  const body = panel.querySelector('[data-ot-role="selection-panel-body"]')

  body.scrollHeight = 240
  Object.defineProperty(body, "clientHeight", {
    get: () => (panel.getAttribute("data-expanded") === "true" ? 320 : 132),
  })
  renderer.renderTranslation({
    requestId: "request-a",
    targetLanguage: "日本語",
    translation: "A long translated result that needs more vertical room.",
    translationAppearance: { selection: { widthPx: 360 } },
  })
  const expand = panel.querySelector('[data-ot-role="selection-panel-expand"]')

  assert.equal(panel.style.width, "360px")
  assert.equal(expand.hidden, false)
  expand.click()
  assert.equal(panel.style.width, "360px")
  assert.equal(panel.getAttribute("data-expanded"), "true")
  assert.equal(expand.textContent, "Show less")
})

test("selection panel reflows from an anchored desktop position on resize", () => {
  const { document, renderer, viewportListeners, window } = createRendererHarness()

  renderer.renderPlaceholder({
    requestId: "request-a",
    selectionAnchor: {
      top: 100,
      right: 240,
      bottom: 120,
      left: 120,
      width: 120,
      height: 20,
    },
    targetLanguage: "日本語",
  })
  const panel = document.querySelector('[data-ot-role="selection-panel"]')

  assert.notEqual(panel.style.left, "")
  window.innerWidth = 320
  document.documentElement.clientWidth = 320
  viewportListeners.get("resize")()
  assert.equal(panel.style.left, "")
  assert.equal(panel.style.width, "")
})

test("selection panel renderer measures reused content in collapsed state", () => {
  let measuredExpandedState = ""
  const attributes = {
    "data-expanded": "true",
  }
  const title = {}
  const expandButton = {
    hidden: true,
    setAttribute(name, value) {
      this[name] = value
    },
    textContent: "",
  }
  const body = {
    _textContent: "",
    clientWidth: 180,
    get clientHeight() {
      measuredExpandedState = attributes["data-expanded"]
      return 80
    },
    querySelectorAll() {
      return []
    },
    replaceChildren() {
      this._textContent = ""
    },
    scrollHeight: 160,
    scrollWidth: 180,
    setAttribute() {},
    get textContent() {
      return this._textContent
    },
    set textContent(value) {
      this._textContent = value
    },
  }
  const panel = {
    offsetHeight: 120,
    offsetWidth: 280,
    querySelector(selector) {
      if (selector === '[data-ot-role="selection-panel-title"]') {
        return title
      }

      if (selector === '[data-ot-role="selection-panel-body"]') {
        return body
      }

      if (selector === '[data-ot-role="selection-panel-expand"]') {
        return expandButton
      }

      return null
    },
    setAttribute(name, value) {
      attributes[name] = value
    },
    style: {},
  }
  const renderer = createSelectionPanelRenderer({
    appendFormattedText(container, text) {
      container.textContent = text
    },
    document: {
      documentElement: { clientHeight: 600, clientWidth: 800 },
      querySelector(selector) {
        return selector === '[data-ot-role="selection-panel"]' ? panel : null
      },
    },
    window: { innerHeight: 600, innerWidth: 800 },
    withObserverPaused(callback) {
      return callback()
    },
  })

  renderer.update({
    pending: false,
    selectionPanelPositionMode: "bottom-right",
    targetLanguage: "日本語",
    translation: "Short text that overflows only in compact mode.",
  })

  assert.equal(measuredExpandedState, "false")
  assert.equal(expandButton.hidden, false)
})
