import type { ElementSnapshot, JsonObject, JsonValue, TabContext } from "../runtime/types.js"

export type PageOperation =
  | "click"
  | "getSelection"
  | "getVisibleText"
  | "listElements"
  | "inspectClick"
  | "type"

export interface PageOperationSuccess {
  ok: true
  result: JsonValue
}

export interface PageOperationFailure {
  ok: false
  error: {
    code:
      | "CONFIRMATION_REQUIRED"
      | "INTERNAL_ERROR"
      | "INVALID_REQUEST"
      | "NOT_SUPPORTED"
      | "PERMISSION_DENIED"
      | "REQUEST_CANCELLED"
      | "STALE_CONTEXT"
    message: string
    details?: JsonObject
  }
}

export type PageOperationResult = PageOperationFailure | PageOperationSuccess

/**
 * This function is passed directly to chrome.scripting.executeScript. Keep every helper inside the
 * function because the page execution world cannot access the extension bundle's module scope.
 */
export async function executePageOperation(
  operation: PageOperation,
  params: JsonObject,
  confirmed: boolean,
  trustedLinkTargetUrl: string | null = null,
  expectedContext: TabContext | null = null,
  snapshot: ElementSnapshot | null = null,
  requestId: string | null = null,
): Promise<PageOperationResult> {
  type Entry = {
    element: HTMLElement
    fingerprint: string
    form: HTMLFormElement | null
    labelControl: HTMLElement | null
  }
  type Registry = { snapshot: ElementSnapshot; nodes: Map<string, Entry> }
  const isolated = globalThis as typeof globalThis & { __piChromeElements?: Registry }
  const staleReference = (): PageOperationFailure =>
    failure(
      "STALE_CONTEXT",
      "Element reference expired or changed; call browser_list_elements again",
    )
  const success = (result: JsonValue): PageOperationSuccess => ({ ok: true, result })
  const failure = (
    code: PageOperationFailure["error"]["code"],
    message: string,
    details?: JsonObject,
  ): PageOperationFailure => ({
    ok: false,
    error: { code, message, ...(details ? { details } : {}) },
  })
  const getSelector = (): string | undefined => {
    const value = params.selector
    return typeof value === "string" && value.length > 0 && value.length <= 2048 ? value : undefined
  }
  const findElement = (): Element | PageOperationFailure => {
    if ("snapshotId" in params || "ref" in params) {
      const registry = isolated.__piChromeElements
      if (
        "selector" in params ||
        !snapshot ||
        !registry ||
        params.snapshotId !== snapshot.id ||
        registry.snapshot.id !== snapshot.id ||
        Date.now() >= snapshot.expiresAt ||
        JSON.stringify(expectedContext) !== JSON.stringify(snapshot.context) ||
        JSON.stringify(registry.snapshot.context) !== JSON.stringify(snapshot.context)
      )
        return staleReference()
      const entry = typeof params.ref === "string" ? registry.nodes.get(params.ref) : undefined
      if (
        !entry?.element.isConnected ||
        entry.element.ownerDocument !== document ||
        entry.form !== formFor(entry.element) ||
        entry.labelControl !== labelControlFor(entry.element) ||
        entry.fingerprint !== fingerprint(entry.element)
      )
        return staleReference()
      return entry.element
    }
    const selector = getSelector()
    if (!selector) return failure("INVALID_REQUEST", "A non-empty CSS selector is required")
    try {
      const element = document.querySelector(selector)
      return element ?? failure("INVALID_REQUEST", `No element matches selector: ${selector}`)
    } catch {
      return failure("INVALID_REQUEST", `Invalid CSS selector: ${selector}`)
    }
  }
  const isFailure = (value: Element | PageOperationFailure): value is PageOperationFailure =>
    "ok" in value
  const hasVisiblePoint = (rect: DOMRect, acceptsHit: (hit: Element) => boolean): boolean => {
    const left = Math.max(0, rect.left)
    const right = Math.min(window.innerWidth, rect.right)
    const top = Math.max(0, rect.top)
    const bottom = Math.min(window.innerHeight, rect.bottom)
    if (left >= right || top >= bottom) return false
    if (typeof document.elementFromPoint !== "function") return true
    const insetX = Math.min(1, (right - left) / 2)
    const insetY = Math.min(1, (bottom - top) / 2)
    const points: [number, number][] = [
      [(left + right) / 2, (top + bottom) / 2],
      [left + insetX, top + insetY],
      [right - insetX, top + insetY],
      [left + insetX, bottom - insetY],
      [right - insetX, bottom - insetY],
    ]
    return points.some(([x, y]) => {
      const hit = document.elementFromPoint(x, y)
      return hit !== null && acceptsHit(hit)
    })
  }
  const isVisible = (element: Element, requireTargetHit = false): boolean => {
    if (!(element instanceof HTMLElement)) return false
    const selectedStyle = getComputedStyle(element)
    if (selectedStyle.visibility === "hidden" || selectedStyle.visibility === "collapse") {
      return false
    }
    for (let current: HTMLElement | null = element; current; current = current.parentElement) {
      const style = getComputedStyle(current)
      if (style.display === "none" || Number.parseFloat(style.opacity || "1") <= 0) {
        return false
      }
    }

    const clientRects = Array.from(element.getClientRects())
    const rects = clientRects.length > 0 ? clientRects : [element.getBoundingClientRect()]
    return rects.some((rect) =>
      hasVisiblePoint(
        rect,
        // Ancestor hits support legacy nested selectors, not discovery/reference visibility.
        (hit) => element.contains(hit) || (!requireTargetHit && hit.contains(element)),
      ),
    )
  }
  const labelControlFor = (element: Element): HTMLElement | null =>
    element.closest("label")?.control ?? null
  const submitControlFor = (element: Element): HTMLButtonElement | HTMLInputElement | null => {
    const labelControl = labelControlFor(element)
    const ancestorButton = element.closest("button")
    const ancestorInput = element.closest("input")
    const button =
      ancestorButton instanceof HTMLButtonElement
        ? ancestorButton
        : labelControl instanceof HTMLButtonElement
          ? labelControl
          : null
    const input =
      ancestorInput instanceof HTMLInputElement
        ? ancestorInput
        : labelControl instanceof HTMLInputElement
          ? labelControl
          : null
    if (button?.type === "submit") return button
    if (input && ["image", "submit"].includes(input.type)) return input
    return null
  }
  const sensitiveControl = (element: Element): boolean => {
    const control = labelControlFor(element)
    return [element, control].some(
      (node) => node instanceof HTMLInputElement && ["password", "file"].includes(node.type),
    )
  }
  const formFor = (element: HTMLElement): HTMLFormElement | null => {
    const control = submitControlFor(element) ?? element
    if (
      control instanceof HTMLInputElement ||
      control instanceof HTMLButtonElement ||
      control instanceof HTMLTextAreaElement ||
      control instanceof HTMLSelectElement
    )
      return control.form
    return element.closest("form")
  }
  const canType = (element: HTMLElement): boolean => {
    if (element.matches(":disabled") || element.getAttribute("aria-disabled") === "true")
      return false
    if (element instanceof HTMLInputElement)
      return (
        ["email", "number", "search", "tel", "text", "url"].includes(element.type) &&
        !element.disabled &&
        !element.readOnly
      )
    if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly
    return element.isContentEditable
  }
  const visibleText = (element: Element): string => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    let text = ""
    let inspected = 0
    for (let count = 0; count < 100 && text.length < 256 && inspected < 256; count++) {
      const node = walker.nextNode()
      if (!node) break
      const parent = node.parentElement
      if (
        !parent ||
        parent.closest(
          "input, textarea, select, [contenteditable], [hidden], [aria-hidden='true']",
        ) ||
        !isVisible(parent, true)
      )
        continue
      text += " "
      let offset = 0
      // Bound layout work even for long, fully clipped text. Inspect code points, not half-surrogates.
      for (const character of node.textContent ?? "") {
        if (inspected + character.length > 256) break
        inspected += character.length
        range.setStart(node, offset)
        offset += character.length
        range.setEnd(node, offset)
        // Whitespace may have no box at a line wrap, but must still separate visible words.
        if (
          /\s/.test(character) ||
          Array.from(range.getClientRects()).some((rect) =>
            hasVisiblePoint(rect, (hit) => hit === parent),
          )
        )
          text += character
      }
    }
    return text.replace(/\s+/g, " ").trim().slice(0, 256)
  }
  const elementName = (element: HTMLElement): string => {
    const labelled = (element.getAttribute("aria-labelledby") ?? "")
      .slice(0, 2048)
      .split(/\s+/)
      .slice(0, 8)
      .map((id) => document.getElementById(id))
      .filter((node): node is HTMLElement => node !== null)
      .map(visibleText)
      .join(" ")
      .trim()
    const labels =
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
        ? Array.from(element.labels ?? [])
            .slice(0, 8)
            .map(visibleText)
            .join(" ")
            .trim()
        : ""
    return (
      labelled ||
      element.getAttribute("aria-label") ||
      labels ||
      visibleText(element) ||
      element.getAttribute("placeholder") ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, snapshot?.limits.name ?? 256)
  }
  const fingerprint = (element: HTMLElement): string => {
    const anchor = element.closest("a")
    const form = formFor(element)
    const submitControl = submitControlFor(element)
    const actionControl = submitControl ?? element
    return JSON.stringify([
      element.tagName,
      elementName(element),
      element.getAttribute("role"),
      element.getAttribute("type"),
      element.getAttribute("disabled"),
      element.getAttribute("readonly"),
      element.getAttribute("aria-disabled"),
      element.isContentEditable,
      anchor?.href,
      anchor?.getAttribute("download"),
      anchor?.getAttribute("target"),
      form?.action,
      form?.method,
      form?.target,
      form?.enctype,
      form?.noValidate,
      // Submitter payload metadata is private revalidation state, never discovery output.
      submitControl?.name,
      submitControl?.value,
      submitControl?.formAction,
      actionControl.getAttribute("formaction"),
      actionControl.getAttribute("formmethod"),
      actionControl.getAttribute("formtarget"),
      actionControl.getAttribute("formenctype"),
      actionControl.hasAttribute("formnovalidate"),
    ])
  }
  const targetResult = (): JsonObject =>
    typeof params.ref === "string"
      ? { snapshotId: String(params.snapshotId), ref: params.ref }
      : { selector: getSelector() ?? "" }
  const setNativeValue = (element: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
    const prototype =
      element instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set
    if (!setter) throw new Error("The browser does not expose a native value setter")
    setter.call(element, value)
  }
  try {
    if (
      expectedContext !== null &&
      (location.href !== expectedContext.url || document.visibilityState !== "visible")
    ) {
      return failure(
        "STALE_CONTEXT",
        "The page is no longer the visible target for this browser operation",
      )
    }
    if (expectedContext !== null && (operation === "click" || operation === "type")) {
      const assertion = (await chrome.runtime.sendMessage({
        kind: "assert-current-mutation-target",
        tabContext: expectedContext,
        requestId,
        snapshotId: snapshot?.id,
      })) as { ok?: boolean; error?: { code?: string; message?: string } } | undefined
      if (!assertion?.ok) {
        return failure(
          assertion?.error?.code === "REQUEST_CANCELLED"
            ? "REQUEST_CANCELLED"
            : assertion?.error?.code === "PERMISSION_DENIED"
              ? "PERMISSION_DENIED"
              : "STALE_CONTEXT",
          assertion?.error?.message ?? "The page is no longer in the focused browser window",
        )
      }
    }
    switch (operation) {
      case "listElements": {
        if (!snapshot || !expectedContext)
          return failure("INVALID_REQUEST", "A snapshot context is required")
        const registry: Registry = { snapshot, nodes: new Map() }
        isolated.__piChromeElements = registry
        const result: { snapshotId: string; elements: JsonObject[]; truncated: boolean } = {
          snapshotId: snapshot.id,
          elements: [],
          truncated: false,
        }
        const walker = document.createTreeWalker(
          document.body ?? document.documentElement,
          NodeFilter.SHOW_ELEMENT,
        )
        const candidates =
          "a[href], button, input, textarea, select, [contenteditable], [role='button'], [role='link'], [role='textbox']"
        let count = 0
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (
            ++count > snapshot.limits.candidates ||
            result.elements.length >= snapshot.limits.results
          ) {
            result.truncated = true
            break
          }
          if (
            !(node instanceof HTMLElement) ||
            !node.matches(candidates) ||
            sensitiveControl(node) ||
            !isVisible(node, true)
          )
            continue
          const disabled =
            node.matches(":disabled") || node.getAttribute("aria-disabled") === "true"
          const ref = `e${result.elements.length + 1}`
          const entry: JsonObject = {
            ref,
            name: elementName(node),
            tag: node.tagName.toLowerCase(),
            role: (node.getAttribute("role") ?? "").slice(0, snapshot.limits.role),
            type:
              node instanceof HTMLInputElement || node instanceof HTMLButtonElement
                ? node.type
                : "",
            disabled,
            readOnly:
              node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
                ? node.readOnly
                : false,
            actions: disabled ? [] : canType(node) ? ["click", "type"] : ["click"],
          }
          result.elements.push(entry)
          if (
            new TextEncoder().encode(JSON.stringify(result, null, 2)).byteLength >
            snapshot.limits.bytes
          ) {
            result.elements.pop()
            result.truncated = true
            break
          }
          registry.nodes.set(ref, {
            element: node,
            fingerprint: fingerprint(node),
            form: formFor(node),
            labelControl: labelControlFor(node),
          })
        }
        return success(result)
      }
      case "getVisibleText": {
        const text = document.body?.innerText ?? ""
        return success({
          text: text.replace(/\n{3,}/g, "\n\n").trim(),
          title: document.title,
          url: location.href,
        })
      }
      case "getSelection":
        return success({ text: window.getSelection()?.toString().trim() ?? "", url: location.href })
      case "inspectClick": {
        const found = findElement()
        if (isFailure(found)) return found
        const anchor = found.closest("a")
        return success({
          download: anchor instanceof HTMLAnchorElement && anchor.hasAttribute("download"),
          targetUrl: anchor instanceof HTMLAnchorElement && anchor.href ? anchor.href : null,
        })
      }
      case "click": {
        const found = findElement()
        if (isFailure(found)) return found
        if (!(found instanceof HTMLElement) || !isVisible(found, snapshot !== null)) {
          return failure("INVALID_REQUEST", "The selected element is not visible or clickable")
        }
        if (
          sensitiveControl(found) ||
          found.matches(":disabled") ||
          found.getAttribute("aria-disabled") === "true"
        )
          return failure("PERMISSION_DENIED", "The selected control is sensitive or disabled")

        const anchor = found.closest("a")
        const submitControl = submitControlFor(found) !== null
        const crossOrigin =
          anchor instanceof HTMLAnchorElement && anchor.href
            ? new URL(anchor.href, location.href).origin !== location.origin
            : false
        const download = Boolean(anchor?.hasAttribute("download"))
        const nativeDownload =
          download &&
          anchor instanceof HTMLAnchorElement &&
          ["blob:", "data:"].includes(new URL(anchor.href, location.href).protocol)
        const sensitive = submitControl || download || crossOrigin
        if (sensitive && !confirmed) {
          return failure(
            "CONFIRMATION_REQUIRED",
            "This click may submit a form, download a file, or navigate across origins",
            {
              action: "click",
              ...targetResult(),
              ...(anchor instanceof HTMLAnchorElement ? { targetUrl: anchor.href } : {}),
            },
          )
        }
        if (
          trustedLinkTargetUrl !== null &&
          (!(anchor instanceof HTMLAnchorElement) || anchor.href !== trustedLinkTargetUrl)
        ) {
          return failure(
            "PERMISSION_DENIED",
            "The link target was not authorized or changed before the click",
          )
        }
        if (crossOrigin && !nativeDownload && trustedLinkTargetUrl === null) {
          return failure("PERMISSION_DENIED", "The cross-origin link target was not authorized")
        }
        if (crossOrigin && !nativeDownload) {
          return success({ clicked: true, navigationAllowed: true, ...targetResult() })
        }
        found.click()
        return success({ clicked: true, ...targetResult() })
      }
      case "type": {
        const found = findElement()
        if (isFailure(found)) return found
        const text = params.text
        if (typeof text !== "string") {
          return failure("INVALID_REQUEST", "The text parameter must be a string")
        }
        if (
          found instanceof HTMLInputElement &&
          (found.type === "password" || found.type === "file")
        ) {
          return failure("PERMISSION_DENIED", `Typing into ${found.type} inputs is disabled`)
        }
        if (!(found instanceof HTMLElement) || !isVisible(found, snapshot !== null)) {
          return failure("INVALID_REQUEST", "The selected element is not visible or editable")
        }
        if (found instanceof HTMLInputElement) {
          const editableTypes = new Set(["email", "number", "search", "tel", "text", "url"])
          if (!editableTypes.has(found.type) || found.disabled || found.readOnly) {
            return failure("PERMISSION_DENIED", `Input type ${found.type} is not editable`)
          }
        } else if (found instanceof HTMLTextAreaElement) {
          if (found.disabled || found.readOnly) {
            return failure("PERMISSION_DENIED", "The text area is disabled or read-only")
          }
        } else if (!found.isContentEditable) {
          return failure("INVALID_REQUEST", "Selector must target an editable text element")
        }
        found.focus()
        if (
          !canType(found) ||
          !isVisible(found, snapshot !== null) ||
          (snapshot && findElement() !== found)
        )
          return staleReference()
        if (found instanceof HTMLInputElement || found instanceof HTMLTextAreaElement)
          setNativeValue(found, text)
        else found.textContent = text
        found.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }))
        found.dispatchEvent(new Event("change", { bubbles: true }))
        return success({ ...targetResult(), typed: true })
      }
    }
  } catch (error) {
    return failure(
      "INTERNAL_ERROR",
      error instanceof Error ? error.message : "Page operation failed",
    )
  }
}
