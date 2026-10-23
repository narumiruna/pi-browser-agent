import type { MutationOutcome } from "../runtime/action-diagnostics.js"
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
  | "findText"
  | "probeCondition"
  | "getSelectOptions"
  | "setChecked"

export interface PageOperationSuccess {
  ok: true
  mutationOutcome?: MutationOutcome
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
    checkedState: string | null
    radioGroup: RadioGroup | null
  }
  type RadioGroup = { root: Node; members: HTMLInputElement[]; states: string[]; complete: boolean }
  type Registry = { snapshot: ElementSnapshot; nodes: Map<string, Entry> }
  const isolated = globalThis as typeof globalThis & { __piBrowserAgentElements?: Registry }
  const staleReference = (): PageOperationFailure =>
    failure(
      "STALE_CONTEXT",
      "Element reference expired or changed; call browser_list_elements again",
    )
  const mutation = ["click", "type", "scroll", "selectOption", "setChecked"].includes(operation)
  let mutationOutcome: MutationOutcome = "not_dispatched"
  const success = (result: JsonValue): PageOperationSuccess => ({
    ok: true,
    result:
      mutation && typeof result === "object" && result !== null && !Array.isArray(result)
        ? { ...result, mutationOutcome }
        : result,
  })
  const failure = (
    code: PageOperationFailure["error"]["code"],
    message: string,
    details?: JsonObject,
  ): PageOperationFailure => ({
    ok: false,
    error: {
      code,
      message,
      ...(details || mutation
        ? { details: { ...details, ...(mutation ? { mutationOutcome } : {}) } }
        : {}),
    },
  })
  const boundedString = (value: unknown, maximum: number, minimum = 0): value is string => {
    if (typeof value !== "string" || value.length > maximum * 2) return false
    const length = Array.from(value).length
    return length >= minimum && length <= maximum
  }
  const getSelector = (): string | undefined => {
    const value = params.selector
    const valid =
      operation === "findText" || operation === "probeCondition"
        ? boundedString(value, 2048, 1)
        : typeof value === "string" && value.length > 0 && value.length <= 2048
    return valid ? (value as string) : undefined
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
                optionHidden(option),
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
  // A radio group is identified by the live form owner, tree root, and exact name. The entry
  // separately checks form object identity; this state also binds approval to the checked state.
  const checkedState = (element: HTMLElement): string | null =>
    element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)
      ? JSON.stringify([
          element.type,
          element.checked,
          element.indeterminate,
          element.name,
          element.value,
        ])
      : null
  const radioGroup = (element: HTMLElement): RadioGroup | null => {
    if (!(element instanceof HTMLInputElement) || element.type !== "radio") return null
    const root = element.getRootNode()
    const group: RadioGroup = { root, members: [], states: [], complete: true }
    if (!element.name) {
      group.members.push(element)
      group.states.push(String(element.checked))
      return group
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
    let inspected = 0
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (inspected++ >= 2000) {
        group.complete = false
        break
      }
      if (
        node instanceof HTMLInputElement &&
        node.type === "radio" &&
        node.name === element.name &&
        node.form === element.form
      ) {
        group.members.push(node)
        group.states.push(
          JSON.stringify([
            node.checked,
            node.value,
            node.matches(":disabled"),
            node.getAttribute("aria-disabled"),
          ]),
        )
      }
    }
    return group
  }
  const sameRadioGroup = (before: RadioGroup | null, after: RadioGroup | null): boolean =>
    before === null
      ? after === null
      : after !== null &&
        before.complete &&
        after.complete &&
        before.root === after.root &&
        before.members.length === after.members.length &&
        before.members.every(
          (node, index) =>
            node === after.members[index] && before.states[index] === after.states[index],
        )
  const optionHidden = (option: HTMLOptionElement): boolean => {
    for (
      let node: HTMLElement | null = option;
      node && !(node instanceof HTMLSelectElement);
      node = node.parentElement
    ) {
      const style = getComputedStyle(node)
      if (
        node.hidden ||
        node.getAttribute("aria-hidden") === "true" ||
        style.display === "none" ||
        style.contentVisibility === "hidden" ||
        ["hidden", "collapse"].includes(style.visibility) ||
        Number.parseFloat(style.opacity || "1") <= 0 ||
        filterBlocksVisibility(node, style) ||
        (style.display !== "contents" && masksText(style))
      )
        return true
    }
    return false
  }
  const validOffset = (maximum: number): boolean =>
    !("offset" in params) ||
    (Number.isSafeInteger(params.offset) &&
      Number(params.offset) >= 0 &&
      Number(params.offset) <= maximum)
  const fitsResponse = (value: JsonValue, maximum = 48 * 1024): boolean =>
    new TextEncoder().encode(JSON.stringify(value, null, 2)).byteLength <= maximum - 256
  const readScope = (): HTMLElement | PageOperationFailure => {
    if (!("selector" in params)) return document.body ?? document.documentElement
    const selector = getSelector()
    if (!selector) return failure("INVALID_REQUEST", "A non-empty CSS selector is required")
    try {
      const found = document.querySelector(selector)
      if (!(found instanceof HTMLElement))
        return failure("INVALID_REQUEST", "The selector must match an HTML element")
      if (
        found.isContentEditable ||
        (document.designMode ?? "").toLowerCase() === "on" ||
        found.closest("input, textarea, select, option, [contenteditable]")
      )
        return failure("PERMISSION_DENIED", "Form field contents cannot be read")
      if (
        found.closest("[hidden], [aria-hidden='true'], script, style, noscript, template") ||
        ["hidden", "collapse"].includes(getComputedStyle(found).visibility)
      )
        return failure("INVALID_REQUEST", "The selected scope is not rendered")
      for (let node: Element | null = found; node; node = filterParent(node)) {
        const style = getComputedStyle(node)
        if (
          node.matches("[hidden], [aria-hidden='true']") ||
          style.display === "none" ||
          (style.display !== "contents" &&
            (style.contentVisibility === "hidden" ||
              Number.parseFloat(style.opacity || "1") <= 0 ||
              !axisAlignedText(style) ||
              filterBlocksVisibility(node, style) ||
              masksText(style)))
        )
          return failure("INVALID_REQUEST", "The selected scope is not rendered")
      }
      const box = found.getBoundingClientRect()
      if (box.width > 0 && box.height > 0) return found
      // Boxless containers can still render children. Never enumerate the geometry of the
      // whole subtree: probe single source units in the same bounded text-node prefix.
      const walker = document.createTreeWalker(found, NodeFilter.SHOW_TEXT)
      const range = document.createRange()
      let nodes = 0
      let units = 0
      for (
        let next = walker.nextNode();
        next && nodes < 2000 && units < 100000;
        next = walker.nextNode()
      ) {
        nodes++
        const node = next as Text
        const length = Math.min(node.length, 100000 - units)
        units += length
        if (length === 0 || !renderedTextParent(node)) continue
        for (let index = 0; index < length; index++) {
          range.setStart(node, index)
          range.setEnd(node, index + 1)
          if (readRects(range, node.parentElement as HTMLElement).length > 0) return found
        }
      }
      return failure("INVALID_REQUEST", "The selected scope is not rendered")
    } catch {
      return failure("INVALID_REQUEST", "Invalid CSS selector")
    }
  }
  // Fail closed for arbitrary CSS masking rather than approximate page-controlled clip shapes.
  const masksText = (style: CSSStyleDeclaration): boolean =>
    Boolean(
      (style.clipPath && style.clipPath !== "none") ||
        (style.clip && style.clip !== "auto") ||
        (style.maskImage && style.maskImage !== "none") ||
        (style.getPropertyValue("-webkit-mask-image") &&
          style.getPropertyValue("-webkit-mask-image") !== "none"),
    )
  const axisAlignedText = (style: CSSStyleDeclaration): boolean => {
    if (style.rotate && style.rotate !== "none") return false
    if (
      style.scale &&
      style.scale !== "none" &&
      style.scale.split(/\s+/).some((part) => !(Number.parseFloat(part) > 0))
    )
      return false
    if (!style.transform || style.transform === "none") return true
    const matrix = /^matrix\(([^)]+)\)$/.exec(style.transform)
    if (!matrix?.[1]) return false
    const values = matrix[1].split(",").map(Number)
    return (
      values.length === 6 &&
      values.every(Number.isFinite) &&
      (values[0] ?? 0) > 0 &&
      values[1] === 0 &&
      values[2] === 0 &&
      (values[3] ?? 0) > 0
    )
  }
  const textExcluded =
    "input, textarea, select, option, [contenteditable], [hidden], [aria-hidden='true'], script, style, noscript, template"
  // Read visibility does not require viewport intersection or hit testing. Clip text against
  // non-root overflow boxes instead, so offscreen page text remains readable.
  const renderedTextParent = (node: Text): boolean => {
    const parent = node.parentElement
    if (
      !parent ||
      parent.isContentEditable ||
      (document.designMode ?? "").toLowerCase() === "on" ||
      parent.closest(textExcluded)
    )
      return false
    if (["hidden", "collapse"].includes(getComputedStyle(node.assignedSlot ?? parent).visibility))
      return false
    for (
      let current: Element | null = node.assignedSlot ?? parent;
      current;
      current = filterParent(current)
    ) {
      const style = getComputedStyle(current)
      if (
        current.matches(textExcluded) ||
        style.display === "none" ||
        (style.display !== "contents" &&
          (style.contentVisibility === "hidden" ||
            Number.parseFloat(style.opacity || "1") <= 0 ||
            !axisAlignedText(style) ||
            filterBlocksVisibility(current, style) ||
            masksText(style)))
      )
        return false
    }
    return true
  }
  const readRects = (range: Range, parent: HTMLElement): DOMRect[] => {
    return Array.from(range.getClientRects()).filter((rect) => {
      let left = rect.left
      let right = rect.right
      let top = rect.top
      let bottom = rect.bottom
      if (left >= right || top >= bottom) return false
      const text = range.startContainer
      for (
        let current: Element | null = text instanceof Text ? (text.assignedSlot ?? parent) : parent;
        current && current !== document.documentElement;
        current = filterParent(current)
      ) {
        const style = getComputedStyle(current)
        if (style.display === "contents" || current === document.scrollingElement) continue
        if (current === document.body) {
          // Body overflow propagates to the viewport only when both root axes are visible.
          // Otherwise body is an independent clip/scroll container and must be checked.
          const rootStyle = getComputedStyle(document.documentElement)
          if (
            [
              rootStyle.overflowX || rootStyle.overflow || "visible",
              rootStyle.overflowY || rootStyle.overflow || "visible",
            ].every((overflow) => overflow === "visible")
          )
            continue
        }
        const clipX = /^(hidden|clip|scroll|auto|overlay)$/.test(style.overflowX || style.overflow)
        const clipY = /^(hidden|clip|scroll|auto|overlay)$/.test(style.overflowY || style.overflow)
        if (!clipX && !clipY) continue
        // Overflow clips at the client/padding box, not the visible border box. Rounded
        // clipping is not approximated: reject it rather than disclose a clipped corner.
        if (
          !(current instanceof HTMLElement) ||
          current.offsetWidth <= 0 ||
          current.offsetHeight <= 0
        )
          return false
        if (
          [
            style.borderTopLeftRadius,
            style.borderTopRightRadius,
            style.borderBottomLeftRadius,
            style.borderBottomRightRadius,
          ].some(
            (radius) =>
              Boolean(radius) && radius.split(/\s+/).some((part) => Number.parseFloat(part) !== 0),
          )
        )
          return false
        const box = current.getBoundingClientRect()
        const scaleX = box.width / current.offsetWidth
        const scaleY = box.height / current.offsetHeight
        const clipLeft = box.left + current.clientLeft * scaleX
        const clipTop = box.top + current.clientTop * scaleY
        if (clipX) {
          left = Math.max(left, clipLeft)
          right = Math.min(right, clipLeft + current.clientWidth * scaleX)
        }
        if (clipY) {
          top = Math.max(top, clipTop)
          bottom = Math.min(bottom, clipTop + current.clientHeight * scaleY)
        }
        if (left >= right || top >= bottom) return false
      }
      return true
    })
  }
  /**
   * Search each Text node separately; collapse each whitespace run to one ASCII space, without
   * trimming. Never match across nodes or excluded/clipped runs. Match offsets are UTF-16 offsets
   * in the raw scope traversal, including excluded nodes, and are valid only for this DOM read.
   * Both traversal budgets include excluded nodes. Result offsets are non-overlapping match ordinals.
   */
  const searchText = (
    root: HTMLElement,
    query: string,
    offset: number,
    probe = false,
  ): JsonObject => {
    const result: JsonObject = {
      matches: [],
      offset,
      scanTruncated: false,
      hasMore: false,
      truncated: false,
    }
    const matches: JsonObject[] = []
    result.matches = matches
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    let nodes = 0
    let inspected = 0
    let ordinal = 0
    let pageFull = false
    for (let next = walker.nextNode(); next; next = walker.nextNode()) {
      if (nodes >= 2000 || inspected >= 100000) {
        result.scanTruncated = true
        break
      }
      nodes++
      const node = next as Text
      const base = inspected
      const length = Math.min(node.length, 100000 - inspected)
      inspected += length
      if (length < node.length) result.scanTruncated = true
      if (pageFull || !renderedTextParent(node)) continue
      const parent = node.parentElement as HTMLElement
      let text = ""
      let starts: number[] = []
      let ends: number[] = []
      let hasRenderedText = false
      // Per-code-point layout prevents a partly clipped node from exposing its clipped text.
      const flush = (): boolean => {
        if (!hasRenderedText) {
          text = ""
          starts = []
          ends = []
          return false
        }
        let from = 0
        for (
          let index = text.indexOf(query, from);
          index !== -1;
          index = text.indexOf(query, from)
        ) {
          from = index + query.length
          if (ordinal++ < offset) continue
          if (probe) {
            matches.push({})
            return true
          }
          if (matches.length >= 50) {
            result.hasMore = true
            return true
          }
          let snippetStart = Math.max(0, Math.min(index, text.length - 256))
          let snippetEnd = Math.min(text.length, snippetStart + 256)
          if (
            /[\uDC00-\uDFFF]/.test(text[snippetStart] ?? "") &&
            /[\uD800-\uDBFF]/.test(text[snippetStart - 1] ?? "")
          )
            snippetStart++
          if (
            /[\uD800-\uDBFF]/.test(text[snippetEnd - 1] ?? "") &&
            /[\uDC00-\uDFFF]/.test(text[snippetEnd] ?? "")
          )
            snippetEnd--
          const match: JsonObject = {
            snippet: text.slice(snippetStart, snippetEnd),
            start: base + (starts[index] ?? 0),
            end: base + (ends[from - 1] ?? 0),
          }
          range.setStart(node, starts[index] ?? 0)
          range.setEnd(node, ends[from - 1] ?? 0)
          const rect = readRects(range, parent)[0]
          if (rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite))
            match.rect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          matches.push(match)
          result.hasMore = true
          result.nextOffset = offset + matches.length
          if (!fitsResponse(result)) {
            matches.pop()
            result.hasMore = true
            return true
          }
          result.hasMore = false
          delete result.nextOffset
        }
        text = ""
        starts = []
        ends = []
        hasRenderedText = false
        return false
      }
      for (let index = 0; index < length; ) {
        const character = String.fromCodePoint(node.data.codePointAt(index) ?? 0)
        if (index + character.length > length) break
        range.setStart(node, index)
        range.setEnd(node, index + character.length)
        const whitespace = /\s/.test(character)
        const rendered = readRects(range, parent).length > 0
        hasRenderedText ||= rendered
        if (!rendered && !whitespace) {
          if (flush()) break
        } else if (whitespace && text.endsWith(" ")) {
          ends[ends.length - 1] = index + character.length
        } else {
          text += whitespace ? " " : character
          for (let unit = 0; unit < (whitespace ? 1 : character.length); unit++) {
            starts.push(index)
            ends.push(index + character.length)
          }
        }
        index += character.length
      }
      if (probe && matches.length > 0) break
      pageFull = Boolean(result.hasMore || flush())
      if (probe && matches.length > 0) break
    }
    if (result.hasMore) result.nextOffset = offset + matches.length
    result.truncated = Boolean(result.scanTruncated || result.hasMore)
    return result
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
      ["click", "type", "scroll", "selectOption", "setChecked"].includes(operation)
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
    // The worker assertion is asynchronous. Recheck the document after it replies.
    if (
      expectedContext !== null &&
      (location.href !== expectedContext.url || document.visibilityState !== "visible")
    )
      return failure(
        "STALE_CONTEXT",
        "The page changed before dispatch. Read the intended page again.",
      )
    switch (operation) {
      case "listElements": {
        if (!snapshot || !expectedContext)
          return failure("INVALID_REQUEST", "A snapshot context is required")
        if (
          !validOffset(2000) ||
          ["role", "type", "name"].some(
            (key) => key in params && !boundedString(params[key], key === "name" ? 256 : 64),
          )
        )
          return failure("INVALID_REQUEST", "Invalid discovery filters or offset")
        const offset = Number(params.offset ?? 0)
        const registry: Registry = { snapshot, nodes: new Map() }
        isolated.__piBrowserAgentElements = registry
        const result = {
          snapshotId: snapshot.id,
          elements: [] as JsonObject[],
          offset,
          scanTruncated: false,
          hasMore: false,
          truncated: false,
          nextOffset: offset,
        }
        const walker = document.createTreeWalker(
          document.body ?? document.documentElement,
          NodeFilter.SHOW_ELEMENT,
        )
        const candidates =
          "a[href], button, input, textarea, select, [contenteditable], [role='button'], [role='link'], [role='textbox']"
        let count = 0
        let matched = 0
        // The body can scroll independently when the viewport has no overflow.
        const root = walker.root
        const first =
          root instanceof HTMLElement && scrollability(root).vertical ? root : walker.nextNode()
        for (let node: Node | null = first; node; node = walker.nextNode()) {
          if (++count > Math.min(2000, snapshot.limits.candidates)) {
            result.scanTruncated = true
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
          const role = elementRole(node)
          const type =
            node instanceof HTMLInputElement || node instanceof HTMLButtonElement ? node.type : ""
          if (
            (typeof params.role === "string" && params.role !== role) ||
            (typeof params.type === "string" && params.type !== type)
          )
            continue
          const name = elementName(node)
          if (typeof params.name === "string" && !name.includes(params.name)) continue
          if (matched++ < offset) continue
          if (result.hasMore || result.elements.length >= Math.min(50, snapshot.limits.results)) {
            result.hasMore = true
            continue
          }
          const disabled =
            node.matches(":disabled") || node.getAttribute("aria-disabled") === "true"
          const scrolling = scrollability(node)
          const ref = `e${result.elements.length + 1}`
          const entry: JsonObject = {
            ref,
            name,
            tag: node.tagName.toLowerCase(),
            role: role.slice(0, snapshot.limits.role),
            type,
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
          result.nextOffset = offset + result.elements.length
          if (!fitsResponse(result, Math.min(48 * 1024, snapshot.limits.bytes))) {
            result.elements.pop()
            result.hasMore = true
            continue
          }
          registry.nodes.set(ref, {
            element: node,
            fingerprint: fingerprint(node),
            form: formFor(node),
            labelControl: labelControlFor(node),
            checkedState: checkedState(node),
            radioGroup: radioGroup(node),
          })
        }
        result.truncated = result.scanTruncated || result.hasMore
        const { nextOffset: _, ...page } = result
        return success(
          result.hasMore ? { ...page, nextOffset: offset + result.elements.length } : page,
        )
      }
      case "findText": {
        if (!boundedString(params.query, 256, 1) || !validOffset(100000))
          return failure(
            "INVALID_REQUEST",
            "Use a non-empty literal query of at most 256 characters and a valid offset",
          )
        const root = readScope()
        if (isFailure(root)) return root
        return success(searchText(root, params.query, Number(params.offset ?? 0)))
      }
      case "probeCondition": {
        if (
          "timeoutMs" in params &&
          (!Number.isSafeInteger(params.timeoutMs) ||
            Number(params.timeoutMs) < 1 ||
            Number(params.timeoutMs) > 10000)
        )
          return failure("INVALID_REQUEST", "Invalid condition timeout")
        if ("text" in params) {
          if ("state" in params || !boundedString(params.text, 256, 1))
            return failure("INVALID_REQUEST", "Use one non-empty literal text condition")
          const root = readScope()
          if (isFailure(root)) return root
          const result = searchText(root, params.text, 0, true)
          return success({ matched: Array.isArray(result.matches) && result.matches.length > 0 })
        }
        const selector = getSelector()
        if (
          !selector ||
          !["present", "absent", "visible", "hidden", "enabled", "disabled"].includes(
            String(params.state),
          )
        )
          return failure("INVALID_REQUEST", "Use a selector and a supported condition state")
        let found: Element | null
        try {
          found = document.querySelector(selector)
        } catch {
          return failure("INVALID_REQUEST", "Invalid CSS selector")
        }
        if (found && sensitiveControl(found))
          return failure("PERMISSION_DENIED", "Sensitive controls cannot be probed")
        if (!found)
          return success({ matched: params.state === "absent" || params.state === "hidden" })
        if (params.state === "present" || params.state === "absent")
          return success({ matched: params.state === "present" })
        const visible = isVisible(found, true)
        const disabled =
          found.matches(":disabled") || found.getAttribute("aria-disabled") === "true"
        return success({
          matched:
            params.state === "visible"
              ? visible
              : params.state === "hidden"
                ? !visible
                : visible && (params.state === "disabled" ? disabled : !disabled),
        })
      }
      case "getSelectOptions": {
        if (
          !("snapshotId" in params) ||
          !("ref" in params) ||
          "selector" in params ||
          !validOffset(2000)
        )
          return failure("INVALID_REQUEST", "Use snapshotId/ref and a valid option offset")
        const found = findElement()
        if (isFailure(found)) return found
        if (
          !(found instanceof HTMLSelectElement) ||
          found.multiple ||
          found.size > 1 ||
          found.options.length > 2000
        )
          return failure(
            "NOT_SUPPORTED",
            "Target must be a native single select with at most 2000 options",
          )
        if (!isVisible(found, true))
          return failure("INVALID_REQUEST", "The select control is not visible")
        const offset = Number(params.offset ?? 0)
        const result: JsonObject = {
          options: [],
          offset,
          scanTruncated: false,
          hasMore: false,
          truncated: false,
        }
        const options: JsonObject[] = []
        result.options = options
        const disabled =
          found.matches(":disabled") || found.getAttribute("aria-disabled") === "true"
        for (let index = offset; index < found.options.length; index++) {
          const option = found.options.item(index)
          if (!option) break
          if (optionHidden(option)) continue
          if (options.length >= 50) {
            result.hasMore = true
            result.nextOffset = index
            break
          }
          let label = option.label.slice(0, 256)
          if (
            label.length < option.label.length &&
            /[\uD800-\uDBFF]/.test(label.at(-1) ?? "") &&
            /[\uDC00-\uDFFF]/.test(option.label[256] ?? "")
          )
            label = label.slice(0, -1)
          options.push({
            index,
            label,
            labelTruncated: label.length < option.label.length,
            disabled:
              disabled ||
              option.disabled ||
              (option.parentElement instanceof HTMLOptGroupElement &&
                option.parentElement.disabled),
          })
          result.hasMore = true
          result.nextOffset = index + 1
          if (!fitsResponse(result)) {
            options.pop()
            result.nextOffset = index
            break
          }
          result.hasMore = false
          delete result.nextOffset
        }
        result.truncated = Boolean(result.hasMore)
        return success(result)
      }
      case "setChecked": {
        if (
          expectedContext &&
          (location.href !== expectedContext.url || document.visibilityState !== "visible")
        )
          return failure("STALE_CONTEXT", "The page changed before checked-state activation")
        if (
          !("snapshotId" in params) ||
          !("ref" in params) ||
          "selector" in params ||
          typeof params.checked !== "boolean"
        )
          return failure("INVALID_REQUEST", "Use snapshotId/ref and a boolean checked state")
        const found = findElement()
        if (isFailure(found)) return found
        if (!(found instanceof HTMLInputElement) || !["checkbox", "radio"].includes(found.type))
          return failure("NOT_SUPPORTED", "Target must be a native checkbox or radio")
        if (found.type === "radio" && !params.checked)
          return failure("NOT_SUPPORTED", "Native radio deselection is not supported")
        if (!isVisible(found, true)) return failure("INVALID_REQUEST", "The control is not visible")
        if (found.matches(":disabled") || found.getAttribute("aria-disabled") === "true")
          return failure("PERMISSION_DENIED", "The control is disabled")
        const entry = isolated.__piBrowserAgentElements?.nodes.get(String(params.ref))
        if (!entry || entry.checkedState !== checkedState(found)) return staleReference()
        if (found.checked === params.checked)
          return success({
            ...targetResult(),
            changed: false,
            activated: false,
            requestedReached: true,
            finalStateVerified: true,
            checked: found.checked,
            snapshotInvalidated: false,
          })
        if (entry.radioGroup && !entry.radioGroup.complete)
          return failure("NOT_SUPPORTED", "Radio group exceeds the bounded validation scan")
        if (!sameRadioGroup(entry.radioGroup, radioGroup(found))) return staleReference()
        if (!confirmed)
          return failure(
            "CONFIRMATION_REQUIRED",
            "Changing checked state can submit a form or run page actions",
            { action: "setChecked", ...targetResult(), checked: params.checked },
          )
        // There is no await between the worker assertion, live reference/state checks, and this
        // single native activation. Never re-resolve a reference after page handlers have run.
        const beforeUrl = location.href
        const beforeType = found.type
        try {
          mutationOutcome = "outcome_unknown"
          HTMLElement.prototype.click.call(found)
          mutationOutcome = "dispatched"
        } catch {
          delete isolated.__piBrowserAgentElements
          return success({
            ...targetResult(),
            changed: true,
            activated: true,
            requestedReached: null,
            finalStateVerified: false,
            snapshotInvalidated: true,
          })
        }
        delete isolated.__piBrowserAgentElements
        const verified =
          found.isConnected &&
          found.ownerDocument === document &&
          found.type === beforeType &&
          location.href === beforeUrl &&
          document.visibilityState === "visible"
        return success({
          ...targetResult(),
          changed: true,
          activated: true,
          requestedReached: verified ? found.checked === params.checked : null,
          finalStateVerified: verified,
          ...(verified ? { checked: found.checked } : {}),
          snapshotInvalidated: true,
        })
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
        mutationOutcome = "outcome_unknown"
        found.scrollTo({
          top: Math.max(
            min,
            Math.min(max, before + distance * (params.direction === "up" ? -1 : 1)),
          ),
          left: found.scrollLeft,
          behavior: "instant",
        })
        mutationOutcome = "dispatched"
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
        mutationOutcome = "outcome_unknown"
        setter.call(found, option.index)
        delete isolated.__piBrowserAgentElements
        found.dispatchEvent(new Event("input", { bubbles: true }))
        found.dispatchEvent(new Event("change", { bubbles: true }))
        mutationOutcome = "dispatched"
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
        mutationOutcome = "outcome_unknown"
        found.click()
        mutationOutcome = "dispatched"
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
        mutationOutcome = "outcome_unknown"
        found.focus()
        // Page focus handlers can change styles; post-focus validation needs a fresh cache.
        blockedFilters = new WeakMap()
        if (
          (expectedContext !== null &&
            (location.href !== expectedContext.url || document.visibilityState !== "visible")) ||
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
        mutationOutcome = "dispatched"
        return success({ ...targetResult(), typed: true })
      }
    }
  } catch {
    return failure(
      "INTERNAL_ERROR",
      mutationOutcome === "outcome_unknown"
        ? "The page action may have run. Inspect current state before a new action; do not resubmit automatically."
        : "The page operation failed before dispatch. Read the intended page again before a new request.",
    )
  }
}
