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
export function executeElementPicker(
  operation: ElementPickerOperation,
  token: string,
  expectedContext: TabContext,
  limits: {
    attributes: number
    className: number
    classes: number
    id: number
    lifetimeMs: number
    pageUrl: number
    selector: number
    text: number
  },
): ElementPickerOperationResult {
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
      return bounded(url.href, limits.attributes)
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
  const selectorCount = (selector: string): number => {
    try {
      return document.querySelectorAll(selector).length
    } catch {
      return 0
    }
  }
  const selectorFor = (element: Element): { selector: string; unique: boolean } => {
    const tag = element.tagName.toLowerCase()
    const id = bounded(element.id, limits.id)
    if (id) {
      const selector = `#${identifier(id)}`
      if (selector.length <= limits.selector && selectorCount(selector) === 1)
        return { selector, unique: true }
    }
    for (const name of ["data-testid", "data-test", "aria-label", "name"] as const) {
      const value = bounded(element.getAttribute(name), limits.attributes)
      if (!value) continue
      const selector = `${tag}[${name}="${attributeValue(value)}"]`
      if (selector.length <= limits.selector && selectorCount(selector) === 1)
        return { selector, unique: true }
    }

    const parts: string[] = []
    let current: Element | null = element
    for (let depth = 0; current && depth < 6; depth += 1) {
      let part = current.tagName.toLowerCase()
      const currentId = bounded(current.id, limits.id)
      if (currentId) part += `#${identifier(currentId)}`
      else {
        const classes = Array.from(current.classList)
          .map((name) => bounded(name, limits.className))
          .filter(Boolean)
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
      if (selector.length <= limits.selector && selectorCount(selector) === 1)
        return { selector, unique: true }
      current = current.parentElement
    }
    const selector = parts.join(" > ")
    return selector.length <= limits.selector
      ? { selector, unique: selectorCount(selector) === 1 }
      : { selector: tag, unique: selectorCount(tag) === 1 }
  }
  const visibleText = (element: Element): string => {
    if (element.matches("input, textarea, select, [contenteditable]")) return ""
    const blockedFilters = new WeakMap<Element, boolean>()
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
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let text = ""
    for (let inspected = 0; inspected < 100 && text.length < limits.text; inspected += 1) {
      const node = walker.nextNode()
      if (!node) break
      const parent = node.parentElement
      if (
        !parent ||
        parent.closest(
          "input, textarea, select, [contenteditable], [hidden], [aria-hidden='true'], script, style",
        )
      )
        continue
      if (!hasVisibleAncestors(parent)) continue
      const visible = Array.from(parent.getClientRects()).some(
        (rect) =>
          rect.right > 0 &&
          rect.bottom > 0 &&
          rect.left < window.innerWidth &&
          rect.top < window.innerHeight,
      )
      if (!visible) continue
      text += ` ${node.textContent ?? ""}`
    }
    return bounded(text, limits.text)
  }
  const contextFor = (element: Element): SelectedElementContext => {
    const rectangle = element.getBoundingClientRect()
    const selector = selectorFor(element)
    const attribute = (name: string): string =>
      bounded(element.getAttribute(name), limits.attributes)
    return {
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
  }

  const host = document.createElement("div")
  host.dataset.piBrowserAgentElementPicker = ""
  Object.assign(host.style, {
    all: "initial",
    contain: "strict",
    cursor: "crosshair",
    display: "block",
    height: "100vh",
    inset: "0",
    margin: "0",
    padding: "0",
    pointerEvents: "auto",
    position: "fixed",
    touchAction: "pan-x pan-y",
    width: "100vw",
    zIndex: "2147483647",
  })
  const shadow = host.attachShadow({ mode: "closed" })
  const style = document.createElement("style")
  style.textContent = `
    :host { all: initial; }
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
  document.documentElement.append(host)

  const controller = new AbortController()
  let current: Element | null = null
  let lastPoint: { x: number; y: number } | undefined
  let frame = 0
  let expiryTimer = 0
  let finished = false
  let cleaned = false
  let runtimeStopListener:
    | ((message: unknown, sender: chrome.runtime.MessageSender) => false)
    | undefined
  const observer = new MutationObserver((records) => {
    if (!host.isConnected) {
      notify("cancelled", undefined, "overlay-detached")
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
  const hitTest = (x: number, y: number): Element | null => {
    host.style.pointerEvents = "none"
    const hit = document.elementFromPoint(x, y)
    host.style.pointerEvents = "auto"
    return hit && hit !== host && !host.contains(hit) ? hit : null
  }
  const render = (element: Element | null): void => {
    if (!element?.isConnected) {
      hide()
      return
    }
    const rectangle = element.getBoundingClientRect()
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
    if (frame) cancelAnimationFrame(frame)
    if (expiryTimer) clearTimeout(expiryTimer)
    controller.abort()
    observer.disconnect()
    if (runtimeStopListener) chrome.runtime.onMessage.removeListener(runtimeStopListener)
    host.remove()
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
    void chrome.runtime
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
    const selected = hitTest(event.clientX, event.clientY) ?? current
    if (selected) notify("selected", contextFor(selected))
  }
  const blockPointer = (event: PointerEvent): void => {
    if (event.pointerType === "touch") event.stopImmediatePropagation()
    else block(event)
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
  host.addEventListener("pointermove", track, { signal: controller.signal })
  host.addEventListener("pointerdown", blockPointer, { signal: controller.signal })
  host.addEventListener("pointerup", blockPointer, { signal: controller.signal })
  host.addEventListener("click", select, { signal: controller.signal })
  for (const name of ["auxclick", "dblclick", "contextmenu", "dragstart"])
    host.addEventListener(name, block, { signal: controller.signal })
  window.addEventListener("scroll", scheduleRefresh, { capture: true, signal: controller.signal })
  window.addEventListener("resize", scheduleRefresh, { signal: controller.signal })
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape") return
      block(event)
      notify("cancelled", undefined, "escape")
    },
    { capture: true, signal: controller.signal },
  )
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
  return { ok: true, result: { started: true } }
}
