import type { SelectedElementContext } from "../runtime/element-context.js"
import type { JsonObject, TabContext } from "../runtime/types.js"

export type ElementPickerOperation = "start" | "stop"

export interface ElementPickerOperationResult {
  ok: true
  result: JsonObject
}

/** Keep this stop path independent so a restarted worker can remove an orphaned picker. */
export function stopElementPickerInjection(): ElementPickerOperationResult {
  const isolated = globalThis as typeof globalThis & {
    __piBrowserAgentElementPicker?: { cleanup: () => void }
  }
  isolated.__piBrowserAgentElementPicker?.cleanup()
  delete isolated.__piBrowserAgentElementPicker
  return { ok: true, result: { stopped: true } }
}

/**
 * This function is passed directly to chrome.scripting.executeScript. Keep every runtime helper
 * inside the function because the isolated execution world cannot access module scope.
 */
export async function executeElementPicker(
  operation: ElementPickerOperation,
  token: string,
  expectedContext: TabContext,
  limits: {
    attributes: number
    className: number
    classes: number
    contextBytes: number
    id: number
    lifetimeMs: number
    pageUrl: number
    selector: number
    text: number
  },
): Promise<ElementPickerOperationResult> {
  type PickerState = {
    cleanup: () => void
    currentTag: string
    token: string
  }
  const isolated = globalThis as typeof globalThis & {
    __piBrowserAgentElementPicker?: PickerState
  }
  const previous = isolated.__piBrowserAgentElementPicker
  if (previous) previous.cleanup()
  if (operation === "stop") return { ok: true, result: { stopped: true } }

  if (
    location.href !== expectedContext.url ||
    document.visibilityState !== "visible" ||
    !document.documentElement
  ) {
    return { ok: true, result: { started: false, reason: "stale-context" } }
  }

  const bounded = (value: string | null | undefined, length: number): string =>
    (value ?? "").replace(/\s+/g, " ").trim().slice(0, length)
  const finite = (value: number, minimum = -10_000_000): number =>
    Math.round(Math.max(minimum, Math.min(10_000_000, Number.isFinite(value) ? value : 0)) * 100) /
    100
  const safePageUrl = (): string => {
    try {
      const url = new URL(location.href)
      url.username = ""
      url.password = ""
      return url.href.length <= limits.pageUrl ? url.href : ""
    } catch {
      return ""
    }
  }
  const safeResourceUrl = (value: string | null): string => {
    if (!value) return ""
    try {
      const url = new URL(value, location.href)
      if (!["http:", "https:"].includes(url.protocol)) return ""
      url.username = ""
      url.password = ""
      return url.href.length <= limits.attributes ? url.href : ""
    } catch {
      return ""
    }
  }
  const identifier = (value: string): string => {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value)
    return value.replace(/[^a-zA-Z0-9_-]/g, (character) => {
      const code = character.codePointAt(0)?.toString(16) ?? "0"
      return `\\${code} `
    })
  }
  const attributeValue = (value: string): string =>
    value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/[\r\n\f]/g, " ")
  const uniquelySelects = (selector: string, element: Element): boolean => {
    try {
      const matches = document.querySelectorAll(selector)
      return matches.length === 1 && matches[0] === element
    } catch {
      return false
    }
  }
  const selectorFor = (element: Element): { selector: string; unique: boolean } => {
    const tag = element.tagName.toLowerCase()
    const id = element.id.length <= limits.id ? element.id : ""
    if (id) {
      const selector = `#${identifier(id)}`
      if (selector.length <= limits.selector && uniquelySelects(selector, element))
        return { selector, unique: true }
    }
    for (const name of ["data-testid", "data-test", "aria-label", "name"] as const) {
      const value = element.getAttribute(name)
      if (!value || value.length > limits.attributes) continue
      const selector = `${tag}[${name}="${attributeValue(value)}"]`
      if (selector.length <= limits.selector && uniquelySelects(selector, element))
        return { selector, unique: true }
    }

    const parts: string[] = []
    let current: Element | null = element
    for (let depth = 0; current && depth < 6; depth += 1) {
      let part = current.tagName.toLowerCase()
      const currentId = current.id.length <= limits.id ? current.id : ""
      if (currentId) part += `#${identifier(currentId)}`
      else {
        const classes = Array.from(current.classList)
          .filter((name) => name.length <= limits.className)
          .slice(0, 2)
        if (classes.length > 0) part += classes.map((name) => `.${identifier(name)}`).join("")
        const parent = current.parentElement
        if (parent) {
          const siblings = Array.from(parent.children).filter(
            (candidate) => candidate.tagName === current?.tagName,
          )
          if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`
        }
      }
      parts.unshift(part)
      const selector = parts.join(" > ")
      if (selector.length <= limits.selector && uniquelySelects(selector, element))
        return { selector, unique: true }
      current = current.parentElement
    }
    const selector = parts.join(" > ")
    return selector.length <= limits.selector
      ? { selector, unique: uniquelySelects(selector, element) }
      : { selector: tag, unique: uniquelySelects(tag, element) }
  }
  const visibleText = (element: Element): string => {
    if (element.matches("input, textarea, select, [contenteditable]")) return ""
    const blockedFilters = new WeakMap<Element, boolean>()
    const zoomScales = new WeakMap<Element, number>()
    const filterBlocksVisibility = (element: Element, style: CSSStyleDeclaration): boolean => {
      const cached = blockedFilters.get(element)
      if (cached !== undefined) return cached
      const filter = style.filter
      let blocked = filter.length > 4_096
      if (!blocked) {
        for (const [, amount] of filter.matchAll(/url\("(?:[^"\\]|\\.)*"\)|opacity\(([^)]+)\)/g)) {
          if (Number.parseFloat(amount ?? "") === 0) {
            blocked = true
            break
          }
        }
      }
      blockedFilters.set(element, blocked)
      return blocked
    }
    const hasVisibleAncestors = (element: Element): boolean => {
      let current: Element | null = element
      for (let depth = 0; current && depth < 64; depth += 1) {
        if (current.matches("[hidden], [aria-hidden='true'], script, style")) return false
        const style = getComputedStyle(current)
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse" ||
          Number.parseFloat(style.opacity || "1") <= 0 ||
          (style.display !== "contents" && filterBlocksVisibility(current, style))
        ) {
          return false
        }
        current = current.parentElement
      }
      return current === null
    }
    const hasVisiblePoint = (raw: DOMRect, parent: Element): boolean => {
      let scale = zoomScales.get(parent)
      if (scale === undefined) {
        scale = legacyZoomGeometry ? cssZoom(parent) : 1
        zoomScales.set(parent, scale)
      }
      const rect = viewportRect(raw, scale)
      const left = Math.max(0, rect.left)
      const right = Math.min(window.innerWidth, rect.right)
      const top = Math.max(0, rect.top)
      const bottom = Math.min(window.innerHeight, rect.bottom)
      if (left >= right || top >= bottom) return false
      if (typeof document.elementsFromPoint !== "function") return false
      const insetX = Math.min(1, (right - left) / 2)
      const insetY = Math.min(1, (bottom - top) / 2)
      return [
        [(left + right) / 2, (top + bottom) / 2],
        [left + insetX, top + insetY],
        [right - insetX, top + insetY],
        [left + insetX, bottom - insetY],
        [right - insetX, bottom - insetY],
      ].some(([x, y]) => hitTest(x ?? 0, y ?? 0) === parent)
    }
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    const inspectionLimit = Math.min(2_048, limits.text * 4)
    let text = ""
    let inspected = 0
    for (let count = 0; count < 100 && text.length < limits.text; count += 1) {
      const node = walker.nextNode()
      if (!node || inspected >= inspectionLimit) break
      const parent = node.parentElement
      if (
        !parent ||
        parent.closest(
          "input, textarea, select, [contenteditable], [hidden], [aria-hidden='true'], script, style",
        ) ||
        !hasVisibleAncestors(parent)
      )
        continue
      text += " "
      let offset = 0
      for (const character of node.textContent ?? "") {
        if (inspected + character.length > inspectionLimit) break
        inspected += character.length
        range.setStart(node, offset)
        offset += character.length
        range.setEnd(node, offset)
        if (
          /\s/.test(character) ||
          Array.from(range.getClientRects()).some((rect) => hasVisiblePoint(rect, parent))
        ) {
          text += character
        }
      }
    }
    return bounded(text, limits.text)
  }
  const contextFor = (element: Element): SelectedElementContext => {
    const rectangle = boundsFor(element)
    const selector = selectorFor(element)
    const attribute = (name: string): string =>
      bounded(element.getAttribute(name), limits.attributes)
    const context: SelectedElementContext = {
      version: 1,
      pageUrl: safePageUrl(),
      tagName: element.tagName.toLowerCase().slice(0, 64),
      id: bounded(element.id, limits.id),
      classNames: Array.from(element.classList)
        .map((name) => bounded(name, limits.className))
        .filter(Boolean)
        .slice(0, limits.classes),
      text: visibleText(element),
      role: attribute("role"),
      ariaLabel: attribute("aria-label"),
      attributes: {
        alt: attribute("alt"),
        href: safeResourceUrl(element.getAttribute("href")),
        name: attribute("name"),
        placeholder: attribute("placeholder"),
        src: safeResourceUrl(element.getAttribute("src")),
        title: attribute("title"),
        type: attribute("type"),
      },
      rect: {
        x: finite(rectangle.x),
        y: finite(rectangle.y),
        top: finite(rectangle.top),
        right: finite(rectangle.right),
        bottom: finite(rectangle.bottom),
        left: finite(rectangle.left),
        width: finite(rectangle.width, 0),
        height: finite(rectangle.height, 0),
      },
      viewport: {
        width: finite(window.innerWidth, 1),
        height: finite(window.innerHeight, 1),
        scrollX: finite(window.scrollX),
        scrollY: finite(window.scrollY),
      },
      cssSelector: selector.selector,
      selectorUnique: selector.unique,
      capturedAt: Date.now(),
    }
    // A valid selection should not disappear just because its optional metadata exceeds the
    // worker's context budget. Keep the page identity and geometry while dropping hints.
    const withinBudget = (): boolean =>
      new TextEncoder().encode(JSON.stringify(context)).byteLength <= limits.contextBytes
    for (const name of ["src", "href", "title", "placeholder", "name", "type", "alt"] as const) {
      if (withinBudget()) break
      context.attributes[name] = ""
    }
    while (!withinBudget() && context.classNames.length > 0) context.classNames.pop()
    if (!withinBudget()) {
      context.cssSelector = ""
      context.selectorUnique = false
    }
    if (!withinBudget()) context.text = ""
    if (!withinBudget()) context.ariaLabel = ""
    if (!withinBudget()) context.role = ""
    if (!withinBudget()) context.id = ""
    return context
  }

  // A root popover is inert while a page modal is open. Place our non-modal surface
  // inside the active light-DOM modal, without closing or changing page surfaces.
  const parent =
    (typeof document.elementFromPoint === "function"
      ? document
          .elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)
          ?.closest("dialog:modal")
      : null) ?? document.documentElement
  const previousFocus = document.activeElement
  const host = document.createElement("div")
  host.dataset.piBrowserAgentElementPicker = ""
  host.popover = "manual"
  host.tabIndex = -1
  for (const [name, value] of Object.entries({
    all: "initial",
    // A fully transparent surface can be omitted from OOPIF compositor hit testing.
    // Keep a painted, very light background (alpha must survive 8-bit quantization).
    "background-color": "rgba(0, 0, 0, 0.01)",
    contain: "strict",
    cursor: "crosshair",
    display: "block",
    "forced-color-adjust": "none",
    height: "calc(100vh + 1px)",
    inset: "0",
    margin: "0",
    opacity: "1",
    filter: "none",
    outline: "none",
    padding: "0",
    "pointer-events": "auto",
    position: "fixed",
    "touch-action": "pan-x pan-y",
    visibility: "visible",
    width: "calc(100vw + 1px)",
    zoom: "1",
  })) {
    host.style.setProperty(name, value, "important")
  }
  const cssZoom = (element: Element): number => {
    let scale = 1
    for (let current: Element | null = element; current; current = current.parentElement) {
      const value = getComputedStyle(current).zoom
      const zoom = Number.parseFloat(value)
      if (Number.isFinite(zoom) && zoom > 0) scale *= value.endsWith("%") ? zoom / 100 : zoom
    }
    return scale
  }
  let legacyZoomGeometry = false
  const fitShield = (): void => {
    // Top-layer positioning escapes ancestor transforms, but not CSS zoom. Chrome
    // before 128 omits absolute zoom from DOM rectangles; probe our owned surface
    // at a known scale instead of using user-agent checks or newer currentCSSZoom.
    const scale = cssZoom(parent)
    host.style.setProperty("zoom", String(2 / scale), "important")
    const width = Number.parseFloat(getComputedStyle(host).width)
    legacyZoomGeometry = Math.abs(host.getBoundingClientRect().width / width - 1) < 0.1
    host.style.setProperty("zoom", String(1 / scale), "important")
  }
  const viewportRect = (rectangle: DOMRect, scale: number): DOMRect =>
    legacyZoomGeometry
      ? new DOMRect(
          rectangle.x * scale,
          rectangle.y * scale,
          rectangle.width * scale,
          rectangle.height * scale,
        )
      : rectangle
  const boundsFor = (element: Element): DOMRect =>
    viewportRect(element.getBoundingClientRect(), legacyZoomGeometry ? cssZoom(element) : 1)
  const shieldIntact = (): boolean => {
    const computed = getComputedStyle(host)
    const rectangle = boundsFor(host)
    return (
      host.isConnected &&
      host.parentElement === parent &&
      host.matches(":popover-open") &&
      !host.hidden &&
      computed.display !== "none" &&
      computed.visibility !== "hidden" &&
      computed.visibility !== "collapse" &&
      host.style.pointerEvents === "auto" &&
      host.style.getPropertyPriority("pointer-events") === "important" &&
      computed.pointerEvents === "auto" &&
      computed.backgroundColor === "rgba(0, 0, 0, 0.01)" &&
      computed.position === "fixed" &&
      ["", "none"].includes(computed.transform) &&
      ["", "none"].includes(computed.clipPath) &&
      ["", "none"].includes(computed.getPropertyValue("mask-image")) &&
      ["", "none"].includes(computed.getPropertyValue("-webkit-mask-image")) &&
      computed.filter === "none" &&
      computed.opacity === "1" &&
      rectangle.left <= 0 &&
      rectangle.top <= 0 &&
      rectangle.right >= window.innerWidth &&
      rectangle.bottom >= window.innerHeight &&
      [0.05, 0.5, 0.95].every((x) =>
        [0.05, 0.5, 0.95].every(
          (y) => document.elementFromPoint(window.innerWidth * x, window.innerHeight * y) === host,
        ),
      )
    )
  }
  const shadow = host.attachShadow({ mode: "closed" })
  const style = document.createElement("style")
  style.textContent = `
    :host::backdrop { background: transparent !important; pointer-events: none !important; }
    #highlight {
      position: fixed; display: none; pointer-events: none; box-sizing: border-box;
      border: 2px solid #5b5bd6; background: rgb(91 91 214 / 16%);
      box-shadow: 0 0 0 1px rgb(255 255 255 / 80%); border-radius: 2px;
    }
    #label {
      position: fixed; display: none; pointer-events: none; max-width: min(360px, 90vw);
      padding: 4px 7px; border-radius: 4px; color: white; background: #20212a;
      font: 12px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
  `
  const highlight = document.createElement("div")
  highlight.id = "highlight"
  const label = document.createElement("div")
  label.id = "label"
  shadow.append(style, highlight, label)

  const controller = new AbortController()
  let current: Element | null = null
  let lastPoint: { x: number; y: number } | undefined
  let frame = 0
  let expiryTimer = 0
  let finished = false
  let cleaned = false
  let finishStartup: (() => void) | undefined
  let resultDelivery: Promise<unknown> | undefined
  let runtimeStopListener:
    | ((message: unknown, sender: chrome.runtime.MessageSender) => false)
    | undefined
  const observer = new MutationObserver((records) => {
    if (!host.isConnected) {
      notify("cancelled", undefined, "overlay-detached")
      return
    }
    if (!shieldIntact()) {
      notify("cancelled", undefined, "overlay-tampered")
      return
    }
    if (records.some((record) => record.target !== host && !host.contains(record.target))) {
      scheduleRefresh()
    }
  })
  const hide = (): void => {
    current = null
    highlight.style.display = "none"
    label.style.display = "none"
    if (isolated.__piBrowserAgentElementPicker?.token === token)
      isolated.__piBrowserAgentElementPicker.currentTag = ""
  }
  const hitTest = (x: number, y: number): Element | null =>
    document.elementsFromPoint(x, y).find((hit) => hit !== host && !host.contains(hit)) ?? null
  const render = (element: Element | null): void => {
    if (!element?.isConnected) {
      hide()
      return
    }
    const rectangle = boundsFor(element)
    if (
      rectangle.width <= 0 ||
      rectangle.height <= 0 ||
      rectangle.right <= 0 ||
      rectangle.bottom <= 0 ||
      rectangle.left >= window.innerWidth ||
      rectangle.top >= window.innerHeight
    ) {
      hide()
      return
    }
    current = element
    const left = Math.max(0, rectangle.left)
    const top = Math.max(0, rectangle.top)
    const width = Math.min(window.innerWidth, rectangle.right) - left
    const height = Math.min(window.innerHeight, rectangle.bottom) - top
    Object.assign(highlight.style, {
      display: "block",
      height: `${height}px`,
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
    })
    const identity = `${element.tagName.toLowerCase()}${element.id ? `#${bounded(element.id, 40)}` : ""}${Array.from(
      element.classList,
    )
      .slice(0, 2)
      .map((name) => `.${bounded(name, 30)}`)
      .join("")}`
    label.textContent = `${identity}  ${Math.round(rectangle.width)} × ${Math.round(rectangle.height)}`
    label.style.display = "block"
    label.style.left = `${Math.max(4, Math.min(window.innerWidth - 220, left))}px`
    label.style.top = `${Math.max(4, top >= 30 ? top - 28 : top + height + 4)}px`
    if (isolated.__piBrowserAgentElementPicker?.token === token)
      isolated.__piBrowserAgentElementPicker.currentTag = element.tagName.toLowerCase()
  }
  const refresh = (): void => {
    frame = 0
    if (!lastPoint) return
    render(hitTest(lastPoint.x, lastPoint.y))
  }
  function scheduleRefresh(): void {
    if (!frame) frame = requestAnimationFrame(refresh)
  }
  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    finishStartup?.()
    if (frame) cancelAnimationFrame(frame)
    if (expiryTimer) clearTimeout(expiryTimer)
    controller.abort()
    observer.disconnect()
    if (runtimeStopListener) chrome.runtime.onMessage.removeListener(runtimeStopListener)
    const restoreFocus = document.activeElement === host
    try {
      host.hidePopover()
    } catch {
      // A removed or changed popover can already be closed.
    }
    host.remove()
    if (restoreFocus && previousFocus instanceof HTMLElement && previousFocus.isConnected)
      previousFocus.focus({ preventScroll: true })
    if (isolated.__piBrowserAgentElementPicker?.token === token)
      delete isolated.__piBrowserAgentElementPicker
  }
  function notify(
    status: "cancelled" | "selected",
    element?: SelectedElementContext,
    reason?: string,
  ): void {
    if (finished) return
    finished = true
    cleanup()
    resultDelivery = chrome.runtime
      .sendMessage({
        kind: "element-picker-result",
        token,
        tabContext: expectedContext,
        status,
        ...(element ? { element } : {}),
        ...(reason ? { reason } : {}),
      })
      .catch(() => undefined)
  }
  const track = (event: MouseEvent): void => {
    if (!shieldIntact()) {
      notify("cancelled", undefined, "overlay-tampered")
      return
    }
    lastPoint = { x: event.clientX, y: event.clientY }
    render(hitTest(event.clientX, event.clientY))
  }
  const block = (event: Event): void => {
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  const select = (event: MouseEvent): void => {
    block(event)
    if (!event.isTrusted) return
    if (!shieldIntact()) {
      notify("cancelled", undefined, "overlay-tampered")
      return
    }
    const eventTarget =
      event.target instanceof Element && event.target !== host && !host.contains(event.target)
        ? event.target
        : null
    const selected = hitTest(event.clientX, event.clientY) ?? eventTarget ?? current
    if (selected) {
      try {
        notify("selected", contextFor(selected))
      } catch {
        notify("cancelled", undefined, "capture-failed")
      }
    }
  }
  const blockPointer = (event: PointerEvent): void => {
    if (event.pointerType === "touch") event.stopImmediatePropagation()
    else block(event)
  }

  try {
    parent.append(host)
    host.showPopover()
    fitShield()
    host.focus({ preventScroll: true })
    if (!shieldIntact() || document.activeElement !== host) {
      cleanup()
      return { ok: true, result: { started: false, reason: "overlay-unavailable" } }
    }
  } catch {
    cleanup()
    return { ok: true, result: { started: false, reason: "overlay-unavailable" } }
  }

  if (
    typeof chrome.runtime.getURL === "function" &&
    typeof chrome.runtime.onMessage?.addListener === "function"
  ) {
    runtimeStopListener = (message, sender) => {
      if (
        sender.id === chrome.runtime.id &&
        typeof message === "object" &&
        message !== null &&
        "kind" in message &&
        message.kind === "element-picker-stop"
      ) {
        cleanup()
      }
      return false
    }
    chrome.runtime.onMessage.addListener(runtimeStopListener)
  }
  window.addEventListener("pointermove", track, { capture: true, signal: controller.signal })
  window.addEventListener("pointerdown", blockPointer, {
    capture: true,
    signal: controller.signal,
  })
  window.addEventListener("pointerup", blockPointer, { capture: true, signal: controller.signal })
  window.addEventListener("click", select, { capture: true, signal: controller.signal })
  for (const name of ["auxclick", "dblclick", "contextmenu", "dragstart"])
    window.addEventListener(name, block, { capture: true, signal: controller.signal })
  window.addEventListener("scroll", scheduleRefresh, { capture: true, signal: controller.signal })
  window.addEventListener(
    "resize",
    () => {
      fitShield()
      if (!shieldIntact()) notify("cancelled", undefined, "overlay-tampered")
      else scheduleRefresh()
    },
    { signal: controller.signal },
  )
  for (const name of ["blur", "focus"]) {
    window.addEventListener(
      name,
      (event) => {
        // A child document has no top-frame focusin event. Recheck on return from
        // the panel too; do not fight cross-process focus changes with repeated focus().
        if (event.target !== window) return
        queueMicrotask(() => {
          if (!cleaned && document.hasFocus() && document.activeElement !== host)
            notify("cancelled", undefined, "overlay-obscured")
        })
      },
      { capture: true, signal: controller.signal },
    )
  }
  window.addEventListener(
    "beforetoggle",
    (event) => {
      const state = (event as ToggleEvent).newState
      if (
        (event.target === host && state === "closed") ||
        (event.target !== host && state === "open")
      )
        notify("cancelled", undefined, "overlay-obscured")
    },
    { capture: true, signal: controller.signal },
  )
  document.addEventListener(
    "fullscreenchange",
    () => notify("cancelled", undefined, "overlay-obscured"),
    { signal: controller.signal },
  )
  window.addEventListener(
    "keydown",
    (event) => {
      block(event)
      if (event.key === "Escape") notify("cancelled", undefined, "escape")
    },
    { capture: true, signal: controller.signal },
  )
  window.addEventListener("keypress", block, { capture: true, signal: controller.signal })
  window.addEventListener("keyup", block, { capture: true, signal: controller.signal })
  window.addEventListener("pagehide", () => notify("cancelled", undefined, "pagehide"), {
    signal: controller.signal,
  })
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState !== "visible") notify("cancelled", undefined, "hidden")
    },
    { signal: controller.signal },
  )
  observer.observe(document.documentElement, {
    attributes: true,
    childList: true,
    subtree: true,
  })
  expiryTimer = window.setTimeout(
    () => notify("cancelled", undefined, "timeout"),
    Math.max(1_000, limits.lifetimeMs),
  )
  isolated.__piBrowserAgentElementPicker = { cleanup, currentTag: "", token }
  // Out-of-process iframe input routing uses the last committed compositor frame.
  // Do not acknowledge startup until a frame containing the shield can be committed.
  await new Promise<void>((resolve) => {
    finishStartup = resolve
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        frame = 0
        finishStartup = undefined
        resolve()
      })
    })
  })
  frame = 0
  if (!cleaned) {
    if (lastPoint) refresh()
    if (!shieldIntact()) notify("cancelled", undefined, "overlay-tampered")
  }
  // A selection or final protection failure can finish during startup. Let the
  // worker publish that result before the start response clears the UI client.
  if (resultDelivery) await resultDelivery
  if (cleaned) return { ok: true, result: { started: false, reason: "cancelled" } }
  return { ok: true, result: { started: true } }
}
