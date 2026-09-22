import { JSDOM } from "jsdom"
import { describe, expect, test, vi } from "vitest"
import { SessionPicker } from "../../src/browser/sidepanel/session-picker.js"

function required<T extends Element>(element: T | null): T {
  if (!element) throw new Error("Missing test element")
  return element
}

function setup() {
  const dom = new JSDOM(`
    <div id="picker">
      <button id="trigger" type="button" aria-expanded="false">
        <span id="label"></span>
      </button>
      <select id="select"></select>
      <div id="menu" hidden>
        <div id="options" role="listbox"></div>
      </div>
    </div>
    <button id="outside" type="button">Outside</button>
  `)
  const document = dom.window.document
  const container = required(document.querySelector<HTMLElement>("#picker"))
  const trigger = required(document.querySelector<HTMLButtonElement>("#trigger"))
  const triggerLabel = required(document.querySelector<HTMLElement>("#label"))
  const select = required(document.querySelector<HTMLSelectElement>("#select"))
  const menu = required(document.querySelector<HTMLElement>("#menu"))
  const listbox = required(document.querySelector<HTMLElement>("#options"))
  const picker = new SessionPicker({
    container,
    trigger,
    triggerLabel,
    select,
    menu,
    listbox,
    emptyText: "New session",
  })
  return { dom, trigger, triggerLabel, select, menu, listbox, picker }
}

const options = [
  { value: "first", label: "First session" },
  { value: "second", label: "A very long session title", statusLabel: "Interrupted" },
]

describe("SessionPicker", () => {
  test("renders a selected, low-noise session list and exposes full titles", () => {
    const { trigger, triggerLabel, select, menu, listbox, picker } = setup()
    picker.setOptions(options, "second")

    expect(select.options).toHaveLength(2)
    expect(select.value).toBe("second")
    expect(triggerLabel.textContent).toBe("A very long session title")
    expect(trigger.title).toBe("A very long session title")

    trigger.click()

    expect(menu.hidden).toBe(false)
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    const renderedOptions = listbox.querySelectorAll<HTMLButtonElement>("[role='option']")
    expect(renderedOptions).toHaveLength(2)
    expect(renderedOptions.item(1).getAttribute("aria-selected")).toBe("true")
    expect(renderedOptions.item(1).title).toBe("A very long session title")
    expect(renderedOptions.item(1).textContent).toContain("Interrupted")
  })

  test("chooses a session and mirrors the selection through the native control", () => {
    const { trigger, triggerLabel, select, listbox, menu, picker } = setup()
    const changed = vi.fn()
    select.addEventListener("change", changed)
    picker.setOptions(options, "first")
    trigger.click()

    listbox.querySelectorAll<HTMLButtonElement>("[role='option']").item(1).click()

    expect(select.value).toBe("second")
    expect(triggerLabel.textContent).toBe("A very long session title")
    expect(menu.hidden).toBe(true)
    expect(trigger.ownerDocument.activeElement).toBe(trigger)
    expect(changed).toHaveBeenCalledOnce()
  })

  test("supports keyboard navigation and closes when focus leaves", () => {
    const { dom, trigger, menu, listbox, picker } = setup()
    picker.setOptions(options, "first")
    trigger.focus()
    trigger.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    )

    expect(menu.hidden).toBe(false)
    expect(trigger.ownerDocument.activeElement).toBe(
      listbox.querySelectorAll<HTMLButtonElement>("[role='option']").item(0),
    )

    trigger.ownerDocument.activeElement?.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    )
    expect(trigger.ownerDocument.activeElement).toBe(
      listbox.querySelectorAll<HTMLButtonElement>("[role='option']").item(1),
    )

    required(trigger.ownerDocument.querySelector<HTMLButtonElement>("#outside")).focus()
    expect(menu.hidden).toBe(true)
  })

  test("keeps the custom trigger in sync with programmatic select changes", () => {
    const { dom, triggerLabel, select, picker } = setup()
    picker.setOptions(options, "first")

    select.value = "second"
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }))

    expect(triggerLabel.textContent).toBe("A very long session title")
  })
})
