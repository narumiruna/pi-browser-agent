import type { SelectedElementContext } from "../../src/browser/runtime/element-context.js"

export function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Missing test value")
  return value
}

export function selectedTarget(): SelectedElementContext {
  return {
    version: 1,
    pageUrl: "https://example.test/",
    tagName: "button",
    id: "buy",
    classNames: [],
    text: "Buy",
    role: "button",
    ariaLabel: "Buy",
    attributes: {
      alt: "",
      href: "",
      name: "",
      placeholder: "",
      src: "",
      title: "",
      type: "button",
    },
    rect: { x: 1, y: 2, top: 2, right: 21, bottom: 12, left: 1, width: 20, height: 10 },
    viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 0 },
    cssSelector: "#buy",
    selectorUnique: true,
    capturedAt: 1,
  }
}
