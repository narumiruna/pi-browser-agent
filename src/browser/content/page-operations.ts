import type { ElementSnapshot, JsonObject, JsonValue, TabContext } from "../runtime/types.js"

export type PageOperation =
  | "click"
  | "getSelection"
  | "getVisibleText"
  | "listElements"
  | "inspectClick"
  | "type"
  | "scroll"
  | "selectOption"
  | "getElementDetails"

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
  const isolated = globalThis as typeof globalThis & { __piBrowserAgentElements?: Registry }
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
      const registry = isolated.__piBrowserAgentElements
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
  // Share filter parsing within a synchronous validation phase only.
  let blockedFilters = new WeakMap<Element, boolean>()
  const filterBlocksVisibility = (element: Element, style: CSSStyleDeclaration): boolean => {
    const cached = blockedFilters.get(element)
    if (cached !== undefined) return cached
    const filter = style.filter
    // Bound parsing even for distinct controls sharing a large declaration. Fail closed, not partial.
    let blocked = filter.length > 4096
    if (!blocked) {
      // Computed styles resolve CSS math/variables; URL contents are not opacity functions.
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
  const filterParent = (element: Element): Element | null => {
    if ((element instanceof HTMLElement || element instanceof SVGElement) && element.assignedSlot)
      return element.assignedSlot
    const parent = element.parentNode
    return parent instanceof ShadowRoot ? parent.host : element.parentElement
  }
  const isVisible = (
    element: Element,
    requireTargetHit = false,
    filterStart: Element = element,
  ): boolean => {
    if (!(element instanceof HTMLElement)) return false
    const selectedStyle = getComputedStyle(element)
    if (selectedStyle.visibility === "hidden" || selectedStyle.visibility === "collapse") {
      return false
    }
    for (let current: HTMLElement | null = element; current; current = current.parentElement) {
      const style = getComputedStyle(current)
      if (style.display === "none" || Number.parseFloat(style.opacity || "1") <= 0) return false
    }
    if (requireTargetHit) {
      // Slotted controls and text are also filtered by their slot's shadow-tree ancestors.
      for (let current: Element | null = filterStart; current; current = filterParent(current)) {
        const style = getComputedStyle(current)
        // Boxless ancestors (including default slots) do not apply their own filters.
        if (style.display !== "contents" && filterBlocksVisibility(current, style)) return false
        // Include the active top-layer root, but not its outside filtering ancestors.
        if (current.matches(":modal, :popover-open, :fullscreen")) break
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
  const scrollability = (element: HTMLElement): JsonObject => {
    const style = getComputedStyle(element)
    return {
      vertical:
        /^(auto|scroll|overlay)$/.test(style.overflowY || style.overflow) &&
        element.scrollHeight > element.clientHeight &&
        element.clientHeight > 0,
      horizontal:
        /^(auto|scroll|overlay)$/.test(style.overflowX || style.overflow) &&
        element.scrollWidth > element.clientWidth &&
        element.clientWidth > 0,
      scrollTop: element.scrollTop,
      scrollLeft: element.scrollLeft,
      scrollHeight: element.scrollHeight,
      scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight,
      clientWidth: element.clientWidth,
    }
  }
  const ariaState = (element: HTMLElement, name: string): string | null => {
    const value = element.getAttribute(name)
    return value !== null && ["true", "false", "mixed"].includes(value) ? value : null
  }
  const elementRole = (element: HTMLElement): string => {
    const explicit = element.getAttribute("role")
    if (explicit) return explicit.slice(0, 64)
    if (element instanceof HTMLSelectElement)
      return element.multiple || element.size > 1 ? "listbox" : "combobox"
    if (element instanceof HTMLButtonElement) return "button"
    if (element instanceof HTMLAnchorElement && element.hasAttribute("href")) return "link"
    if (element instanceof HTMLTextAreaElement || element.isContentEditable) return "textbox"
    if (element instanceof HTMLInputElement) {
      if (["checkbox", "radio"].includes(element.type)) return element.type
      if (["button", "submit", "reset", "image"].includes(element.type)) return "button"
      if (element.type === "range") return "slider"
      if (element.type === "number") return "spinbutton"
      if (element.type === "search") return "searchbox"
      return "textbox"
    }
    return "generic"
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
      // Directly slotted text has filter ancestry distinct from its parent host.
      const slot = node instanceof Text ? node.assignedSlot : null
      if (
        !parent ||
        parent.closest(
          "input, textarea, select, [contenteditable], [hidden], [aria-hidden='true']",
        ) ||
        !isVisible(parent, true, slot ?? parent)
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
      element.matches(":disabled"),
      element.getAttribute("readonly"),
      element.getAttribute("aria-disabled"),
      element.isContentEditable,
      element instanceof HTMLSelectElement
        ? [
            element.multiple,
            element.size,
            element.options.length,
            ...Array.from({ length: Math.min(element.options.length, 2000) }, (_, index) => {
              const option = element.options.item(index)
              if (!option) return null
              return [
                option.value,
                option.label,
                option.disabled,
                option.parentElement instanceof HTMLOptGroupElement &&
                  option.parentElement.disabled,
              ]
            }),
          ]
        : null,
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
    if (
      expectedContext !== null &&
      ["click", "type", "scroll", "selectOption"].includes(operation)
    ) {
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
        isolated.__piBrowserAgentElements = registry
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
        // The body can scroll independently when the viewport has no overflow.
        const root = walker.root
        const first =
          root instanceof HTMLElement && scrollability(root).vertical ? root : walker.nextNode()
        for (let node: Node | null = first; node; node = walker.nextNode()) {
          if (
            ++count > snapshot.limits.candidates ||
            result.elements.length >= snapshot.limits.results
          ) {
            result.truncated = true
            break
          }
          if (
            !(node instanceof HTMLElement) ||
            (!node.matches(candidates) &&
              (node === document.documentElement || !scrollability(node).vertical)) ||
            sensitiveControl(node) ||
            !isVisible(node, true)
          )
            continue
          const disabled =
            node.matches(":disabled") || node.getAttribute("aria-disabled") === "true"
          const scrolling = scrollability(node)
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
            actions: disabled
              ? []
              : [
                  ...(node.matches(candidates)
                    ? canType(node)
                      ? ["click", "type"]
                      : ["click"]
                    : []),
                  ...(node instanceof HTMLSelectElement && !node.multiple ? ["selectOption"] : []),
                  ...(scrolling.vertical ? ["scroll"] : []),
                ],
            scrollability: scrolling,
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
      case "scroll": {
        if (
          (params.direction !== "up" && params.direction !== "down") ||
          (params.amount !== "page" &&
            params.amount !== "half-page" &&
            params.amount !== "pixels") ||
          (params.amount === "pixels"
            ? !Number.isSafeInteger(params.pixels) ||
              Number(params.pixels) < 1 ||
              Number(params.pixels) > 10_000
            : "pixels" in params) ||
          "selector" in params
        )
          return failure("INVALID_REQUEST", "Use up/down and page, half-page, or 1–10000 pixels")
        const inner = "snapshotId" in params || "ref" in params
        const found = inner ? findElement() : document.scrollingElement
        if (found && isFailure(found)) return found
        if (!(found instanceof HTMLElement))
          return failure("NOT_SUPPORTED", "This document has no scrollable viewport")
        if (inner && (!isVisible(found, true) || sensitiveControl(found)))
          return failure("INVALID_REQUEST", "The scroll container is not visible or supported")
        if (inner && !scrollability(found).vertical)
          return failure(
            "NOT_SUPPORTED",
            "The referenced element is not a vertical scroll container",
          )
        const height = inner ? found.clientHeight : window.innerHeight
        const distance =
          params.amount === "pixels"
            ? Number(params.pixels)
            : height * (params.amount === "half-page" ? 0.5 : 1)
        const before = found.scrollTop
        const style = getComputedStyle(found)
        // The viewport uses non-negative coordinates even when its root is reverse-flex.
        const reversed =
          found !== document.scrollingElement &&
          ["flex", "inline-flex"].includes(style.display) &&
          style.flexDirection === "column-reverse"
        const range = Math.max(0, found.scrollHeight - found.clientHeight)
        const min = reversed ? -range : 0
        const max = reversed ? 0 : range
        found.scrollTo({
          top: Math.max(
            min,
            Math.min(max, before + distance * (params.direction === "up" ? -1 : 1)),
          ),
          left: found.scrollLeft,
          behavior: "instant",
        })
        delete isolated.__piBrowserAgentElements
        const position = found.scrollTop
        const currentRange = Math.max(0, found.scrollHeight - found.clientHeight)
        const minPosition = reversed ? -currentRange : 0
        const maxPosition = reversed ? 0 : currentRange
        return success({
          distance: position - before,
          position,
          minPosition,
          maxPosition,
          atTop: position <= minPosition,
          atBottom: position >= maxPosition - 1,
          viewport: {
            width: window.innerWidth,
            height: window.innerHeight,
            scrollX: window.scrollX,
            scrollY: window.scrollY,
          },
          title: document.title.slice(0, 256),
          url: location.href,
          snapshotInvalidated: true,
        })
      }
      case "getElementDetails": {
        if (!("snapshotId" in params) || "selector" in params)
          return failure("INVALID_REQUEST", "Element details require snapshotId and ref")
        const found = findElement()
        if (isFailure(found)) return found
        if (!(found instanceof HTMLElement) || sensitiveControl(found))
          return failure("PERMISSION_DENIED", "Sensitive or unsupported element")
        const rect = found.getBoundingClientRect()
        return success({
          name: elementName(found),
          role: elementRole(found),
          visible: isVisible(found, true),
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            left: rect.left,
          },
          state: {
            disabled: found.matches(":disabled") || found.getAttribute("aria-disabled") === "true",
            readOnly:
              found instanceof HTMLInputElement || found instanceof HTMLTextAreaElement
                ? found.readOnly
                : found.getAttribute("aria-readonly") === "true",
            checked:
              found instanceof HTMLInputElement && ["checkbox", "radio"].includes(found.type)
                ? found.checked
                : ariaState(found, "aria-checked"),
            expanded: ariaState(found, "aria-expanded"),
            selected: ariaState(found, "aria-selected"),
            required: found.matches(":required") || found.getAttribute("aria-required") === "true",
            focused: document.activeElement === found,
          },
          scrollability: scrollability(found),
        })
      }
      case "selectOption": {
        if (
          !("snapshotId" in params) ||
          "selector" in params ||
          "value" in params === "label" in params ||
          typeof (params.value ?? params.label) !== "string" ||
          String(params.value ?? params.label).length > 256
        )
          return failure(
            "INVALID_REQUEST",
            "Use snapshotId/ref and exactly one option value or label",
          )
        const found = findElement()
        if (isFailure(found)) return found
        if (!(found instanceof HTMLSelectElement) || found.multiple || found.options.length > 2000)
          return failure(
            "NOT_SUPPORTED",
            "Target must be a native single select with at most 2000 options",
          )
        if (!isVisible(found, true))
          return failure("INVALID_REQUEST", "The select control is not visible")
        if (found.matches(":disabled") || found.getAttribute("aria-disabled") === "true")
          return failure("PERMISSION_DENIED", "The select control is disabled")
        const options = Array.from(found.options).filter((option) =>
          "value" in params ? option.value === params.value : option.label === params.label,
        )
        const option = options[0]
        if (options.length !== 1 || !option)
          return failure(
            "INVALID_REQUEST",
            "The option value or label must match exactly one option",
          )
        if (
          option.disabled ||
          (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled)
        )
          return failure("PERMISSION_DENIED", "The selected option is disabled")
        if (!confirmed)
          return failure(
            "CONFIRMATION_REQUIRED",
            "Changing this option can submit a form or run page actions",
            {
              action: "selectOption",
              ...targetResult(),
              ...("value" in params
                ? { value: String(params.value) }
                : { label: String(params.label) }),
            },
          )
        const setter = Object.getOwnPropertyDescriptor(
          HTMLSelectElement.prototype,
          "selectedIndex",
        )?.set
        if (!setter) return failure("NOT_SUPPORTED", "Native select changes are unavailable")
        setter.call(found, option.index)
        delete isolated.__piBrowserAgentElements
        found.dispatchEvent(new Event("input", { bubbles: true }))
        found.dispatchEvent(new Event("change", { bubbles: true }))
        return success({ selected: true, ...targetResult(), snapshotInvalidated: true })
      }
      case "getVisibleText": {
        let root: HTMLElement | null = document.body
        if (typeof params.selector === "string") {
          try {
            const match = document.querySelector(params.selector)
            if (!match) return failure("INVALID_REQUEST", "No element matches the page selector")
            if (!(match instanceof HTMLElement))
              return failure("INVALID_REQUEST", "The page selector must match an HTML element")
            if (match.matches("input, textarea, select, option"))
              return failure("PERMISSION_DENIED", "Form field contents cannot be read")
            const style = getComputedStyle(match)
            if (["hidden", "collapse"].includes(style.visibility))
              return failure("INVALID_REQUEST", "The selected page element is not rendered")
            if (match.getClientRects().length === 0) {
              if (style.display !== "contents")
                return failure("INVALID_REQUEST", "The selected page element is not rendered")
              const range = document.createRange()
              range.selectNodeContents(match)
              if (range.getClientRects().length === 0)
                return failure("INVALID_REQUEST", "The selected page element is not rendered")
            }
            root = match
          } catch (error) {
            if (error instanceof DOMException && error.name === "SyntaxError")
              return failure("INVALID_REQUEST", "Invalid CSS selector for page text")
            throw error
          }
        }
        const text = (root?.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim()
        let offset = typeof params.offset === "number" ? params.offset : 0
        if (offset > text.length)
          return failure("INVALID_REQUEST", "Page text offset exceeds the available text")
        // If a caller supplies an offset inside a surrogate pair, start at its first code unit.
        if (
          offset > 0 &&
          offset < text.length &&
          /[\uD800-\uDBFF]/.test(text[offset - 1] ?? "") &&
          /[\uDC00-\uDFFF]/.test(text[offset] ?? "")
        )
          offset -= 1
        return success({
          text: text.slice(offset),
          offset,
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
              submit: submitControl,
              download,
              crossOrigin,
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
        // Page focus handlers can change styles; post-focus validation needs a fresh cache.
        blockedFilters = new WeakMap()
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
