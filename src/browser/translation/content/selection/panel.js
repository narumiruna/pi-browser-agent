import { APPEARANCE_LIMITS, DEFAULT_TRANSLATION_APPEARANCE } from "../../shared/appearance.js"
import { normalizeSelectionPanelPositionMode } from "../../shared/settings.js"
import { ui } from "../../shared/ui.js"

const SELECTION_PANEL_MARGIN = 12
const SELECTION_PANEL_GAP = 12
const SELECTION_PANEL_COMPACT_WIDTH = DEFAULT_TRANSLATION_APPEARANCE.selection.widthPx
const [SELECTION_PANEL_MIN_WIDTH, SELECTION_PANEL_MAX_WIDTH] = APPEARANCE_LIMITS.selection.widthPx
const SELECTION_PANEL_MOBILE_BREAKPOINT = 640

function normalizeSelectionRequestId(value) {
  return String(value || "").trim()
}

function normalizeSelectionAnchorRect(rect) {
  if (!rect || typeof rect !== "object") {
    return null
  }

  const top = Number(rect.top)
  const right = Number(rect.right)
  const bottom = Number(rect.bottom)
  const left = Number(rect.left)
  const width = Number(rect.width)
  const height = Number(rect.height)

  if (![top, right, bottom, left, width, height].every((value) => Number.isFinite(value))) {
    return null
  }

  return { top, right, bottom, left, width, height }
}

function clampSelectionPanelValue(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function getSelectionPanelWidth(viewportWidth, compactWidth = SELECTION_PANEL_COMPACT_WIDTH) {
  const numericWidth = Number(compactWidth)
  const preferredWidth = Number.isFinite(numericWidth)
    ? clampSelectionPanelValue(numericWidth, SELECTION_PANEL_MIN_WIDTH, SELECTION_PANEL_MAX_WIDTH)
    : SELECTION_PANEL_COMPACT_WIDTH

  return Math.min(preferredWidth, Math.max(0, viewportWidth - SELECTION_PANEL_MARGIN * 2))
}

function shouldCloseSelectionPanelOnKey(event) {
  return Boolean(event && event.key === "Escape" && !event.defaultPrevented && !event.isComposing)
}

function createSelectionPanelRenderer(options = {}) {
  const rootAttr = options.rootAttr || "data-ot-role"
  const doc = options.document || globalThis.document
  const win = options.window || globalThis.window || globalThis
  const ensureStyles = typeof options.ensureStyles === "function" ? options.ensureStyles : () => {}
  const ensureObserver =
    typeof options.ensureObserver === "function" ? options.ensureObserver : () => {}
  const withObserverPaused =
    typeof options.withObserverPaused === "function"
      ? options.withObserverPaused
      : (callback) => callback()
  const appendFormattedText =
    typeof options.appendFormattedText === "function"
      ? options.appendFormattedText
      : (container, text) => {
          container.appendChild(doc.createTextNode(String(text || "")))
        }
  const onRetry = typeof options.onRetry === "function" ? options.onRetry : () => {}
  const onClose = typeof options.onClose === "function" ? options.onClose : () => {}
  let keyboardHandler = null
  let viewportHandler = null
  const state = {
    activeRequestId: "",
    anchorRect: null,
    compactWidth: SELECTION_PANEL_COMPACT_WIDTH,
    dismissed: false,
    expanded: false,
    keyboardHandlerInstalled: false,
    positionMode: "near-selection",
    viewportHandlerInstalled: false,
    retryPayload: null,
  }

  function isExpanded() {
    return Boolean(state.expanded)
  }

  function getRequestDisposition(payload) {
    const requestId = normalizeSelectionRequestId(payload?.requestId)

    if (state.dismissed && requestId === state.activeRequestId) {
      return "dismissed"
    }

    if (state.activeRequestId && requestId && requestId !== state.activeRequestId) {
      return "stale"
    }

    return "current"
  }

  function updateLayoutState(panel, body, expandButton, panelState) {
    if (!panel || !body || !expandButton) {
      return
    }

    panel.setAttribute("data-expanded", isExpanded() ? "true" : "false")

    const normalizedText = String(body.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
    const lineBreakCount = body.querySelectorAll("br").length
    const canExpand =
      panelState === "ready" &&
      (isExpanded() ||
        normalizedText.length > 140 ||
        lineBreakCount >= 3 ||
        body.scrollHeight > body.clientHeight + 1 ||
        body.scrollWidth > body.clientWidth + 1)

    if (!canExpand && isExpanded()) {
      state.expanded = false
    }

    panel.setAttribute("data-expanded", isExpanded() ? "true" : "false")
    expandButton.hidden = !canExpand
    expandButton.textContent = ui(isExpanded() ? "Show less" : "Show more")
    expandButton.setAttribute("aria-label", ui(isExpanded() ? "Show less" : "Show more"))
    expandButton.setAttribute("aria-expanded", isExpanded() ? "true" : "false")
  }

  function applyPosition(panel) {
    if (!panel) {
      return
    }

    const viewportWidth = Math.max(win.innerWidth || 0, doc.documentElement?.clientWidth || 0)
    const viewportHeight = Math.max(win.innerHeight || 0, doc.documentElement?.clientHeight || 0)

    panel.style.left = ""
    panel.style.right = ""
    panel.style.top = ""
    panel.style.bottom = ""
    panel.style.width = ""
    panel.style.maxWidth = ""

    if (viewportWidth > SELECTION_PANEL_MOBILE_BREAKPOINT) {
      const targetWidth = getSelectionPanelWidth(viewportWidth, state.compactWidth)

      panel.style.width = `${targetWidth}px`
      panel.style.maxWidth = `${targetWidth}px`
    }

    if (
      viewportWidth <= SELECTION_PANEL_MOBILE_BREAKPOINT ||
      state.positionMode !== "near-selection" ||
      !state.anchorRect
    ) {
      return
    }

    const maxPanelWidth = Math.max(0, viewportWidth - SELECTION_PANEL_MARGIN * 2)
    const targetWidth = getSelectionPanelWidth(viewportWidth, state.compactWidth)
    const measuredWidth = panel.offsetWidth || targetWidth
    const measuredHeight = panel.offsetHeight || 0
    const panelWidth = Math.min(targetWidth, maxPanelWidth, measuredWidth)
    const minLeft = SELECTION_PANEL_MARGIN
    const maxLeft = Math.max(minLeft, viewportWidth - panelWidth - minLeft)
    const preferredLeft = Math.min(state.anchorRect.left, state.anchorRect.right - panelWidth)
    const left = clampSelectionPanelValue(preferredLeft, minLeft, maxLeft)
    const belowTop = state.anchorRect.bottom + SELECTION_PANEL_GAP
    const aboveTop = state.anchorRect.top - measuredHeight - SELECTION_PANEL_GAP
    const fitsBelow = belowTop + measuredHeight <= viewportHeight - SELECTION_PANEL_MARGIN
    const fitsAbove = aboveTop >= SELECTION_PANEL_MARGIN
    let top = belowTop

    if (!fitsBelow && fitsAbove) {
      top = aboveTop
    }

    top = clampSelectionPanelValue(
      top,
      SELECTION_PANEL_MARGIN,
      Math.max(SELECTION_PANEL_MARGIN, viewportHeight - measuredHeight - SELECTION_PANEL_MARGIN),
    )

    panel.style.right = "auto"
    panel.style.bottom = "auto"
    panel.style.left = `${left}px`
    panel.style.top = `${top}px`
    panel.style.width = `${panelWidth}px`
    panel.style.maxWidth = `${panelWidth}px`
  }

  function close() {
    const panel = doc.querySelector(`[${rootAttr}="selection-panel"]`)

    state.dismissed = true
    state.retryPayload = null

    if (!panel) {
      return { cleared: 0 }
    }

    withObserverPaused(() => {
      panel.remove()
    })

    onClose(state.activeRequestId)
    return { cleared: 1 }
  }

  function ensureKeyboardHandler() {
    if (state.keyboardHandlerInstalled || typeof doc.addEventListener !== "function") {
      return
    }

    keyboardHandler = (event) => {
      if (shouldCloseSelectionPanelOnKey(event)) {
        close()
      }
    }
    doc.addEventListener("keydown", keyboardHandler)
    state.keyboardHandlerInstalled = true
  }

  function ensureViewportHandler() {
    if (state.viewportHandlerInstalled || typeof win.addEventListener !== "function") {
      return
    }

    viewportHandler = () => {
      applyPosition(doc.querySelector(`[${rootAttr}="selection-panel"]`))
    }
    win.addEventListener("resize", viewportHandler)
    state.viewportHandlerInstalled = true
  }

  function createTextElement(tagName, role, text) {
    const element = doc.createElement(tagName)

    element.setAttribute(rootAttr, role)
    element.textContent = ui(text)
    return element
  }

  function getPanel() {
    ensureStyles()
    ensureKeyboardHandler()
    ensureViewportHandler()
    let panel = doc.querySelector(`[${rootAttr}="selection-panel"]`)

    if (panel) {
      return panel
    }

    panel = doc.createElement("aside")
    const header = doc.createElement("div")
    const identity = doc.createElement("div")
    const icon = createTextElement("span", "selection-panel-icon", "TR")
    const title = createTextElement("p", "selection-panel-title", "Translation")
    const language = createTextElement("span", "selection-panel-language", "Target language")
    const closeButton = doc.createElement("button")
    const body = doc.createElement("div")
    const footer = doc.createElement("div")
    const expandButton = doc.createElement("button")
    const retryButton = doc.createElement("button")

    panel.classList.add("translation")
    panel.setAttribute(rootAttr, "selection-panel")
    panel.setAttribute("data-expanded", "false")
    panel.setAttribute("data-state", "loading")
    panel.setAttribute("role", "region")
    panel.setAttribute("aria-label", ui("Selected text translation"))
    header.setAttribute(rootAttr, "selection-panel-header")
    identity.setAttribute(rootAttr, "selection-panel-identity")
    icon.setAttribute("aria-hidden", "true")
    closeButton.setAttribute(rootAttr, "selection-panel-close")
    closeButton.setAttribute("type", "button")
    closeButton.setAttribute("aria-label", ui("Dismiss translation"))
    closeButton.textContent = "×"
    closeButton.addEventListener("click", close)
    body.setAttribute(rootAttr, "selection-panel-body")
    body.setAttribute("data-state", "pending")
    footer.setAttribute(rootAttr, "selection-panel-footer")
    expandButton.setAttribute(rootAttr, "selection-panel-expand")
    expandButton.setAttribute("type", "button")
    expandButton.setAttribute("aria-expanded", "false")
    expandButton.hidden = true
    expandButton.textContent = ui("Show more")
    expandButton.addEventListener("click", () => {
      state.expanded = !state.expanded
      updateLayoutState(panel, body, expandButton, "ready")
      applyPosition(panel)
    })
    retryButton.setAttribute(rootAttr, "selection-panel-retry")
    retryButton.setAttribute("type", "button")
    retryButton.hidden = true
    retryButton.textContent = ui("Try again")
    retryButton.addEventListener("click", () => {
      if (!state.retryPayload || retryButton.disabled) {
        return
      }

      retryButton.disabled = true
      onRetry({ ...state.retryPayload })
    })

    identity.appendChild(icon)
    identity.appendChild(title)
    identity.appendChild(language)
    header.appendChild(identity)
    header.appendChild(closeButton)
    footer.appendChild(expandButton)
    footer.appendChild(retryButton)
    panel.appendChild(header)
    panel.appendChild(body)
    panel.appendChild(footer)

    withObserverPaused(() => {
      if (doc.body) {
        doc.body.appendChild(panel)
      } else {
        doc.documentElement.appendChild(panel)
      }
    })

    return panel
  }

  function renderLoadingBody(body, targetLanguage) {
    const status = createTextElement(
      "span",
      "selection-panel-status",
      targetLanguage ? `Translating to ${targetLanguage}…` : "Translating selected text…",
    )
    const skeleton = doc.createElement("span")

    skeleton.setAttribute(rootAttr, "selection-panel-skeleton")
    skeleton.setAttribute("aria-hidden", "true")
    for (let index = 0; index < 3; index += 1) {
      skeleton.appendChild(doc.createElement("span"))
    }
    body.appendChild(status)
    body.appendChild(skeleton)
  }

  function update(payload, panelState = "ready") {
    const requestedWidth = Number(payload.translationAppearance?.selection?.widthPx)
    state.compactWidth = Number.isFinite(requestedWidth)
      ? clampSelectionPanelValue(
          requestedWidth,
          SELECTION_PANEL_MIN_WIDTH,
          SELECTION_PANEL_MAX_WIDTH,
        )
      : SELECTION_PANEL_COMPACT_WIDTH
    state.positionMode = normalizeSelectionPanelPositionMode(payload.selectionPanelPositionMode)
    state.anchorRect = normalizeSelectionAnchorRect(payload.selectionAnchor)
    state.expanded = false

    const panel = getPanel()
    const title = panel.querySelector(`[${rootAttr}="selection-panel-title"]`)
    const language = panel.querySelector(`[${rootAttr}="selection-panel-language"]`)
    const body = panel.querySelector(`[${rootAttr}="selection-panel-body"]`)
    const footer = panel.querySelector(`[${rootAttr}="selection-panel-footer"]`)
    const expandButton = panel.querySelector(`[${rootAttr}="selection-panel-expand"]`)
    const retryButton = panel.querySelector(`[${rootAttr}="selection-panel-retry"]`)

    panel.setAttribute("data-state", panelState)
    if (title) {
      title.textContent = ui(panelState === "error" ? "Translation failed" : "Translation")
    }
    if (language) {
      language.textContent = payload.targetLanguage || ui("Target language")
    }
    if (!body) {
      return panel
    }

    withObserverPaused(() => {
      body.setAttribute("data-state", panelState === "loading" ? "pending" : panelState)
      body.setAttribute("aria-atomic", "true")
      body.setAttribute("aria-live", panelState === "error" ? "assertive" : "polite")
      body.setAttribute("role", panelState === "error" ? "alert" : "status")
      body.replaceChildren()

      if (panelState === "loading") {
        renderLoadingBody(body, payload.targetLanguage)
        return
      }

      if (panelState === "error") {
        body.appendChild(
          createTextElement(
            "p",
            "selection-panel-error-message",
            payload.error || "The translation could not be completed. Try again.",
          ),
        )
        return
      }

      appendFormattedText(body, payload.translation || "", payload.protectedFragments)
    })

    if (retryButton) {
      retryButton.hidden = panelState !== "error"
      retryButton.disabled = false
    }
    updateLayoutState(panel, body, expandButton, panelState)
    if (footer) {
      footer.hidden = Boolean(expandButton?.hidden && retryButton?.hidden)
    }
    applyPosition(panel)
    return panel
  }

  function renderPlaceholder(payload) {
    ensureStyles(payload?.translationAppearance)
    ensureObserver()
    state.activeRequestId = normalizeSelectionRequestId(payload?.requestId)
    state.dismissed = false
    state.retryPayload = {
      selectionAnchor: payload?.selectionAnchor,
      sourceText: String(payload?.sourceText || ""),
      targetLanguage: payload?.targetLanguage,
    }
    update(payload || {}, "loading")
    return { rendered: "floating" }
  }

  function renderTranslation(payload) {
    ensureStyles(payload?.translationAppearance)
    ensureObserver()
    const disposition = getRequestDisposition(payload)

    if (disposition !== "current") {
      return { rendered: disposition }
    }

    update(payload || {}, "ready")
    return { rendered: "floating" }
  }

  function cleanup() {
    close()
    if (keyboardHandler) {
      doc.removeEventListener?.("keydown", keyboardHandler)
      keyboardHandler = null
    }
    if (viewportHandler) {
      win.removeEventListener?.("resize", viewportHandler)
      viewportHandler = null
    }
    state.keyboardHandlerInstalled = false
    state.viewportHandlerInstalled = false
  }

  function renderError(payload) {
    ensureStyles(payload?.translationAppearance)
    ensureObserver()
    const disposition = getRequestDisposition(payload)

    if (disposition !== "current") {
      return { rendered: disposition }
    }

    state.retryPayload = {
      selectionAnchor: payload?.selectionAnchor,
      sourceText: String(payload?.sourceText || ""),
      targetLanguage: payload?.targetLanguage,
    }
    update(payload || {}, "error")
    return { rendered: "floating" }
  }

  return {
    applyPosition,
    cleanup,
    close,
    renderError,
    renderPlaceholder,
    renderTranslation,
    update,
  }
}

export {
  createSelectionPanelRenderer,
  getSelectionPanelWidth,
  normalizeSelectionAnchorRect,
  normalizeSelectionRequestId,
  SELECTION_PANEL_COMPACT_WIDTH,
  SELECTION_PANEL_MAX_WIDTH,
  SELECTION_PANEL_MOBILE_BREAKPOINT,
  shouldCloseSelectionPanelOnKey,
}
