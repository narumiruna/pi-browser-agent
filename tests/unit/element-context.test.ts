import { describe, expect, test } from "vitest"
import {
  ELEMENT_PICKER_LIMITS,
  parseSelectedElementContext,
  type SelectedElementContext,
  selectedElementContextBytes,
} from "../../src/browser/runtime/element-context.js"

function context(overrides: Partial<SelectedElementContext> = {}): SelectedElementContext {
  return {
    version: 1,
    pageUrl: "https://example.test/page",
    tagName: "div",
    id: "target",
    classNames: ["card"],
    text: "Visible text",
    role: "",
    ariaLabel: "",
    attributes: {
      alt: "",
      href: "",
      name: "",
      placeholder: "",
      src: "",
      title: "",
      type: "",
    },
    rect: { x: 1, y: 2, top: 2, right: 11, bottom: 12, left: 1, width: 10, height: 10 },
    viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 0 },
    cssSelector: "#target",
    selectorUnique: true,
    capturedAt: 1,
    ...overrides,
  }
}

describe("selected element context", () => {
  test("accepts and clones a bounded exact context", () => {
    const source = context()
    const parsed = parseSelectedElementContext(source)
    expect(parsed).toEqual(source)
    expect(parsed).not.toBe(source)
  })

  test("rejects extra, sensitive, reserved, and credential-bearing fields", () => {
    const cases: unknown[] = [
      { ...context(), outerHTML: "<div>private</div>" },
      { ...context(), value: "private" },
      {
        ...context(),
        attributes: { ...context().attributes, value: "private" },
      },
      context({ pageUrl: "https://user:secret@example.test/" }),
      {
        ...context(),
        attributes: { ...context().attributes, href: "https://user:secret@example.test/" },
      },
      JSON.parse(`{"__proto__":null,${JSON.stringify(context()).slice(1)}`),
    ]
    for (const value of cases) expect(() => parseSelectedElementContext(value)).toThrow()
  })

  test("rejects malformed and oversized scalar and geometry values", () => {
    for (const value of [
      context({ pageUrl: "javascript:alert(1)" }),
      context({ tagName: "DIV SCRIPT" }),
      context({ text: "x".repeat(ELEMENT_PICKER_LIMITS.text + 1) }),
      context({ classNames: Array(ELEMENT_PICKER_LIMITS.classes + 1).fill("x") }),
      context({ capturedAt: -1 }),
      context({ rect: { ...context().rect, width: -1 } }),
      context({ viewport: { ...context().viewport, width: 0 } }),
    ]) {
      expect(() => parseSelectedElementContext(value)).toThrow()
    }
  })

  test("measures the combined composer context boundary", () => {
    const large = context({
      pageUrl: `https://example.test/${"x".repeat(3_900)}`,
      cssSelector: `div.${"x".repeat(1_900)}`,
    })
    expect(() => parseSelectedElementContext(large)).not.toThrow()
    expect(selectedElementContextBytes([large])).toBeLessThan(ELEMENT_PICKER_LIMITS.composerBytes)
    expect(selectedElementContextBytes([large, large, large])).toBeGreaterThan(
      ELEMENT_PICKER_LIMITS.composerBytes,
    )
  })
})
