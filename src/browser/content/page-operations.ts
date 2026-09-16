import type { JsonObject, JsonValue } from "../../protocol/index.js"

export type PageOperation = "click" | "getSelection" | "getVisibleText" | "inspectClick" | "type"

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
  trustedCrossOriginTargetUrl: string | null = null,
): Promise<PageOperationResult> {
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
  const isVisible = (element: Element): boolean => {
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
    const visibleRects = rects
      .map((rect) => ({
        bottom: Math.min(window.innerHeight, rect.bottom),
        left: Math.max(0, rect.left),
        right: Math.min(window.innerWidth, rect.right),
        top: Math.max(0, rect.top),
      }))
      .filter((rect) => rect.left < rect.right && rect.top < rect.bottom)
    if (visibleRects.length === 0) return false

    if (typeof document.elementFromPoint !== "function") return true
    return visibleRects.some((rect) => {
      const insetX = Math.min(1, (rect.right - rect.left) / 2)
      const insetY = Math.min(1, (rect.bottom - rect.top) / 2)
      const points: [number, number][] = [
        [(rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2],
        [rect.left + insetX, rect.top + insetY],
        [rect.right - insetX, rect.top + insetY],
        [rect.left + insetX, rect.bottom - insetY],
        [rect.right - insetX, rect.bottom - insetY],
      ]
      return points.some(([x, y]) => {
        const hit = document.elementFromPoint(x, y)
        return Boolean(hit && (element.contains(hit) || hit.contains(element)))
      })
    })
  }
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
    switch (operation) {
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
          targetUrl: anchor instanceof HTMLAnchorElement && anchor.href ? anchor.href : null,
        })
      }
      case "click": {
        const found = findElement()
        if (isFailure(found)) return found
        if (!(found instanceof HTMLElement) || !isVisible(found)) {
          return failure("INVALID_REQUEST", "The selected element is not visible or clickable")
        }

        const anchor = found.closest("a")
        const label = found.closest("label")
        const labelControl = label instanceof HTMLLabelElement ? label.control : null
        const ancestorButton = found.closest("button")
        const ancestorInput = found.closest("input")
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
        const submitControl =
          (button instanceof HTMLButtonElement && button.type === "submit") ||
          (input instanceof HTMLInputElement && ["image", "submit"].includes(input.type))
        const crossOrigin =
          anchor instanceof HTMLAnchorElement && anchor.href
            ? new URL(anchor.href, location.href).origin !== location.origin
            : false
        const sensitive = submitControl || Boolean(anchor?.hasAttribute("download")) || crossOrigin
        if (sensitive && !confirmed) {
          return failure(
            "CONFIRMATION_REQUIRED",
            "This click may submit a form, download a file, or navigate across origins",
            {
              action: "click",
              selector: getSelector() ?? "",
              ...(anchor instanceof HTMLAnchorElement ? { targetUrl: anchor.href } : {}),
            },
          )
        }
        if (
          crossOrigin &&
          (!(anchor instanceof HTMLAnchorElement) || anchor.href !== trustedCrossOriginTargetUrl)
        ) {
          return failure(
            "PERMISSION_DENIED",
            "The cross-origin link target was not authorized or changed before the click",
          )
        }
        if (crossOrigin) {
          const event = new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            composed: true,
          })
          event.preventDefault()
          found.dispatchEvent(event)
        } else {
          found.click()
        }
        return success({ clicked: true, selector: getSelector() ?? "" })
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
        if (!(found instanceof HTMLElement) || !isVisible(found)) {
          return failure("INVALID_REQUEST", "The selected element is not visible or editable")
        }
        if (found instanceof HTMLInputElement) {
          const editableTypes = new Set(["email", "number", "search", "tel", "text", "url"])
          if (!editableTypes.has(found.type) || found.disabled || found.readOnly) {
            return failure("PERMISSION_DENIED", `Input type ${found.type} is not editable`)
          }
          found.focus()
          setNativeValue(found, text)
        } else if (found instanceof HTMLTextAreaElement) {
          if (found.disabled || found.readOnly) {
            return failure("PERMISSION_DENIED", "The text area is disabled or read-only")
          }
          found.focus()
          setNativeValue(found, text)
        } else if (found instanceof HTMLElement && found.isContentEditable) {
          found.focus()
          found.textContent = text
        } else {
          return failure("INVALID_REQUEST", "Selector must target an editable text element")
        }
        found.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }))
        found.dispatchEvent(new Event("change", { bubbles: true }))
        return success({ selector: getSelector() ?? "", typed: true })
      }
    }
  } catch (error) {
    return failure(
      "INTERNAL_ERROR",
      error instanceof Error ? error.message : "Page operation failed",
    )
  }
}
