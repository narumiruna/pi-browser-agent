import type { SelectedElementContext } from "../../src/browser/runtime/element-context.js"
import type { PointCommentPin } from "../../src/browser/runtime/point-comments.js"

export const pinClientId = "12345678-1234-4123-8123-123456789abc"
export const pinContext = { tabId: 7, url: "https://example.test/", epoch: 2 }
export function pointContext(
  overrides: Partial<SelectedElementContext> = {},
): SelectedElementContext {
  return {
    version: 1,
    pageUrl: pinContext.url,
    tagName: "button",
    id: "target",
    classNames: [],
    text: "Visible target",
    role: "",
    ariaLabel: "",
    attributes: { alt: "", href: "", name: "", placeholder: "", src: "", title: "", type: "" },
    rect: { x: 20, y: 30, top: 30, right: 220, bottom: 130, left: 20, width: 200, height: 100 },
    viewport: { width: 1024, height: 768, scrollX: 0, scrollY: 0 },
    cssSelector: "#target",
    selectorUnique: true,
    capturedAt: 1,
    ...overrides,
  }
}
export function pointPin(number = 1, overrides: Partial<PointCommentPin> = {}): PointCommentPin {
  return {
    id: `12345678-1234-4123-8123-${String(number).padStart(12, "0")}`,
    number,
    note: `Note ${number}`,
    context: pointContext(),
    ...overrides,
  }
}
export function deferred<T>() {
  let resolve = (_value: T): void => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
