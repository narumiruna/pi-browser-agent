import { JSDOM } from "jsdom"
import { describe, expect, test, vi } from "vitest"
import { SearchableSelect } from "../../src/browser/sidepanel/searchable-select.js"

function required<T extends Element>(element: T | null): T {
  if (!element) throw new Error("Missing test element")
  return element
}

function setup(useInteractionBoundary = false) {
  const dom = new JSDOM(`
    <div id="boundary">
      <div id="picker">
        <input id="search" data-placeholder="Search items" />
        <select id="value"></select>
        <div id="options" hidden></div>
      </div>
      <button id="action">Continue</button>
    </div>
    <button id="outside">Outside</button>
  `)
  const document = dom.window.document
  const interactionBoundary = required(document.querySelector<HTMLElement>("#boundary"))
  const container = required(document.querySelector<HTMLElement>("#picker"))
  const input = required(document.querySelector<HTMLInputElement>("#search"))
  const select = required(document.querySelector<HTMLSelectElement>("#value"))
  const listbox = required(document.querySelector<HTMLElement>("#options"))
  const action = required(document.querySelector<HTMLButtonElement>("#action"))
  const outside = required(document.querySelector<HTMLButtonElement>("#outside"))
  const picker = new SearchableSelect({
    container,
    input,
    select,
    listbox,
    emptyText: "No items available",
    interactionBoundary: useInteractionBoundary ? interactionBoundary : undefined,
  })
  return { dom, input, select, listbox, action, outside, picker }
}

describe("SearchableSelect", () => {
  test("filters options and selects the active result with the keyboard", () => {
    const { dom, input, select, listbox, picker } = setup()
    const changed = vi.fn()
    select.addEventListener("change", changed)
    picker.setOptions(
      [
        { value: "first", label: "First item" },
        { value: "second", label: "Second item", keywords: ["alternate"] },
      ],
      "first",
    )

    input.focus()
    input.value = "alternate"
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }))

    expect(listbox.hidden).toBe(false)
    expect(listbox.querySelectorAll("[role='option']")).toHaveLength(1)
    expect(listbox.textContent).toContain("Second item")

    input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }))

    expect(select.value).toBe("second")
    expect(input.value).toBe("Second item")
    expect(listbox.hidden).toBe(true)
    expect(changed).toHaveBeenCalledOnce()
  })

  test("does not emit change when choosing the selected option", () => {
    const { dom, input, select, listbox, picker } = setup()
    const changed = vi.fn()
    select.addEventListener("change", changed)
    picker.setOptions(
      [
        { value: "first", label: "First item" },
        { value: "second", label: "Second item" },
      ],
      "second",
    )

    input.focus()
    input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }))

    expect(select.value).toBe("second")
    expect(input.value).toBe("Second item")
    expect(listbox.hidden).toBe(true)
    expect(changed).not.toHaveBeenCalled()
  })

  test("reopens after a mouse selection leaves the input focused", () => {
    const { dom, input, listbox, picker } = setup()
    picker.setOptions([
      { value: "first", label: "First item" },
      { value: "second", label: "Second item" },
    ])

    input.focus()
    const secondOption = listbox.querySelectorAll<HTMLElement>("[role='option']").item(1)
    secondOption.dispatchEvent(
      new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    )

    expect(input.ownerDocument.activeElement).toBe(input)
    expect(listbox.hidden).toBe(true)

    input.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }))

    expect(listbox.hidden).toBe(false)
    expect(listbox.querySelectorAll("[role='option']")).toHaveLength(2)
  })

  test("keeps options open while focus moves within an interaction boundary", () => {
    const { dom, input, listbox, action, outside, picker } = setup(true)
    picker.setOptions([{ value: "first", label: "First item" }], "first")

    input.focus()
    action.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true }))
    action.focus()

    expect(listbox.hidden).toBe(false)

    outside.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true }))

    expect(listbox.hidden).toBe(true)
  })

  test("restores the selected label and consumes Escape when a search is cancelled", () => {
    const { dom, input, select, listbox, picker } = setup()
    const documentKeyDown = vi.fn()
    input.ownerDocument.addEventListener("keydown", documentKeyDown)
    picker.setOptions([{ value: "first", label: "First item" }], "first")

    input.focus()
    input.value = "missing"
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
    const emptyOption = listbox.querySelector("[role='option']")
    expect(emptyOption?.textContent).toBe("No matches")
    expect(emptyOption?.getAttribute("aria-disabled")).toBe("true")

    input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }))

    expect(select.value).toBe("first")
    expect(input.value).toBe("First item")
    expect(listbox.hidden).toBe(true)
    expect(documentKeyDown).not.toHaveBeenCalled()
  })
})
