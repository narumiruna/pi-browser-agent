import { JSDOM } from "jsdom"
import { afterEach, describe, expect, test, vi } from "vitest"
import { setLanguagePreference, t } from "../../src/browser/i18n/index.js"
import { SlashCommandMenu } from "../../src/browser/sidepanel/slash-command-menu.js"
import { SLASH_COMMANDS } from "../../src/browser/sidepanel/slash-commands.js"

function required<T extends Element>(element: T | null): T {
  if (!element) throw new Error("Missing test element")
  return element
}

function setup() {
  const dom = new JSDOM(`
    <textarea id="input" aria-label="Message"></textarea>
    <div id="commands" hidden></div>
    <button id="outside" type="button">Outside</button>
  `)
  const document = dom.window.document
  const input = required(document.querySelector<HTMLTextAreaElement>("#input"))
  const listbox = required(document.querySelector<HTMLElement>("#commands"))
  const outside = required(document.querySelector<HTMLButtonElement>("#outside"))
  const onInput = vi.fn()
  const menu = new SlashCommandMenu({ input, listbox, onInput })
  function draft(text: string, start = text.length, end = start) {
    input.value = text
    input.setSelectionRange(start, end)
    input.focus()
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
  }
  function key(key: string, init: KeyboardEventInit = {}) {
    const event = new dom.window.KeyboardEvent("keydown", { key, cancelable: true, ...init })
    const consumed = menu.handleKeyDown(event)
    return { event, consumed }
  }
  function names() {
    return [...listbox.querySelectorAll(".slash-command-name")].map((item) => item.textContent)
  }
  function activeName() {
    return listbox.querySelector("[aria-selected='true'] .slash-command-name")?.textContent
  }
  return { dom, document, input, listbox, outside, onInput, menu, draft, key, names, activeName }
}

afterEach(() => setLanguagePreference("en"))

describe("SlashCommandMenu", () => {
  test("localizes descriptions and announcements but inserts original command tokens", () => {
    setLanguagePreference("ja")
    const { input, listbox, document, draft, key, menu } = setup()
    draft("/n")
    key("ArrowDown")
    const descriptions = () =>
      [...listbox.querySelectorAll(".slash-command-description")].map((el) => el.textContent)
    expect(listbox.getAttribute("aria-label")).toBe(t("Slash commands"))
    expect(descriptions()).toEqual([t("Start a new session"), t("Rename the current session")])
    expect(descriptions()[0]).not.toBe(SLASH_COMMANDS[0].description)
    expect(document.querySelector("#commands-status")?.textContent).toBe(
      t("Command list open. {count} commands available.", { count: 2 }),
    )
    setLanguagePreference("de")
    menu.update()
    expect(listbox.getAttribute("aria-label")).toBe(t("Slash commands"))
    expect(descriptions()).toEqual([t("Start a new session"), t("Rename the current session")])
    expect(input.value).toBe("/n")
    expect(document.activeElement).toBe(input)
    key("Tab")
    expect(input.value).toBe("/name ")
    expect(document.querySelector("#commands-status")?.textContent).toBe(t("Command list closed."))
    setLanguagePreference("ja")
    menu.update()
    expect(document.querySelector("#commands-status")?.textContent).toBe(t("Command list closed."))
  })

  test("opens for a slash, renders the shared definitions, and keeps focus in the textarea", () => {
    const { input, listbox, document, draft, names } = setup()
    expect(listbox.hidden).toBe(true)
    expect(input.hasAttribute("aria-expanded")).toBe(false)
    expect(input.hasAttribute("aria-activedescendant")).toBe(false)
    draft("/")

    expect(listbox.hidden).toBe(false)
    expect(names()).toEqual(SLASH_COMMANDS.map((item) => `/${item.name}`))
    expect(
      [...listbox.querySelectorAll(".slash-command-description")].map((el) => el.textContent),
    ).toEqual(SLASH_COMMANDS.map((item) => item.description))
    expect(document.activeElement).toBe(input)
    expect(listbox.getAttribute("role")).toBe("listbox")
    expect(input.hasAttribute("role")).toBe(false)
    expect(input.getAttribute("aria-describedby")).toContain("commands-status")
    expect(document.querySelector("#commands-status")?.textContent).toBe(
      `Command list open. ${SLASH_COMMANDS.length} commands available.`,
    )
    expect(input.getAttribute("aria-controls")).toBe(listbox.id)
    expect(input.getAttribute("aria-autocomplete")).toBe("list")
    expect(input.hasAttribute("aria-expanded")).toBe(false)
    expect(input.getAttribute("aria-activedescendant")).toBe(
      listbox.querySelector("[aria-selected='true']")?.id,
    )
    expect(listbox.querySelectorAll("[role='option']")).toHaveLength(SLASH_COMMANDS.length)
    expect(listbox.querySelectorAll("[aria-selected='true']")).toHaveLength(1)
  })

  test("keeps the active command within the scrollable list", () => {
    const { dom, draft, key, listbox } = setup()
    Object.defineProperty(listbox, "clientHeight", { value: 60 })
    Object.defineProperty(dom.window.HTMLElement.prototype, "offsetTop", {
      configurable: true,
      get() {
        return [...listbox.children].indexOf(this as Element) * 40
      },
    })
    Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", {
      value: 40,
      configurable: true,
    })
    draft("/")
    key("ArrowUp")
    expect(listbox.scrollTop).toBe(SLASH_COMMANDS.length * 40 - 60)
    key("ArrowDown")
    expect(listbox.scrollTop).toBe(0)
  })

  test("filters matching commands and supports leading whitespace", () => {
    const { draft, names, listbox } = setup()
    draft("  /n")
    expect(names()).toEqual(["/new", "/name"])
    draft("/log")
    expect(names()).toEqual(["/login", "/logout"])
    draft("/resume")
    expect(names()).toEqual(["/resume"])
    draft("/unknown")
    expect(listbox.hidden).toBe(true)
  })

  test.each([
    ["", 0],
    ["ordinary /n", 11],
    ["//n", 3],
    ["/tmp/file", 4],
    ["/NEW", 4],
    ["/new123", 4],
    ["/name title", 11],
    ["/name title", 6],
    ["  /name", 1],
    ["/name", 0],
    ["/name\ntext", 3],
  ])("does not activate outside an initial command token: %j at %i", (text, caret) => {
    const { draft, listbox, key } = setup()
    draft(text, caret)
    expect(listbox.hidden).toBe(true)
    expect(key("Enter").consumed).toBe(false)
  })

  test("requires textarea focus and a collapsed selection", () => {
    const { input, draft, listbox, outside, menu } = setup()
    draft("/name", 1, 4)
    expect(listbox.hidden).toBe(true)
    draft("/name")
    expect(listbox.hidden).toBe(false)
    outside.focus()
    menu.update()
    expect(listbox.hidden).toBe(true)
    input.disabled = true
    input.focus()
    menu.update()
    expect(listbox.hidden).toBe(true)
    input.disabled = false
    input.readOnly = true
    input.focus()
    menu.update()
    expect(listbox.hidden).toBe(true)
  })

  test("navigates with Arrow keys, wraps, and updates the active descendant without moving focus", () => {
    const { draft, key, activeName, input, document, listbox } = setup()
    draft("/n")
    expect(activeName()).toBe("/new")
    expect(key("ArrowDown").consumed).toBe(true)
    expect(activeName()).toBe("/name")
    expect(input.getAttribute("aria-activedescendant")).toBe(
      listbox.querySelector("[aria-selected='true']")?.id,
    )
    const { event } = key("ArrowDown")
    expect(event.defaultPrevented).toBe(true)
    expect(activeName()).toBe("/new")
    expect(key("ArrowUp").consumed).toBe(true)
    expect(activeName()).toBe("/name")
    expect(document.activeElement).toBe(input)
    draft("/lo")
    expect(activeName()).toBe("/login")
  })

  test.each(["Enter", "Tab"])(
    "%s fills the selected command but never dispatches it",
    (acceptKey) => {
      const { draft, key, input, onInput, listbox, menu, document } = setup()
      draft("/n")
      key("ArrowDown")
      onInput.mockImplementation(() => menu.update())
      const result = key(acceptKey)
      expect(result.consumed).toBe(true)
      expect(result.event.defaultPrevented).toBe(true)
      expect(input.value).toBe("/name ")
      expect(input.selectionStart).toBe(6)
      expect(input.selectionEnd).toBe(6)
      expect(onInput).toHaveBeenCalledOnce()
      expect(document.activeElement).toBe(input)
      expect(listbox.hidden).toBe(true)
      menu.update()
      expect(listbox.hidden).toBe(true)
      expect(key("Enter").consumed).toBe(false)
      expect(onInput).toHaveBeenCalledOnce()
    },
  )

  test("replaces only the initial token and preserves existing text", () => {
    const { draft, key, input, onInput } = setup()
    draft("  /n  Saved title  ", 4)
    key("ArrowDown")
    key("Tab")
    expect(input.value).toBe("  /name  Saved title  ")
    expect(input.selectionStart).toBe(8)
    expect(onInput).toHaveBeenCalledOnce()
  })

  test("pointer selection inserts without focus transfer or command dispatch", () => {
    const { dom, draft, listbox, input, document, onInput, menu } = setup()
    draft("/lo")
    const option = listbox.querySelectorAll<HTMLElement>("[role='option']").item(1)
    const pointer = new dom.window.MouseEvent("pointerdown", { bubbles: true, cancelable: true })
    option.dispatchEvent(pointer)
    expect(pointer.defaultPrevented).toBe(true)
    const mouse = new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true })
    option.dispatchEvent(mouse)
    expect(mouse.defaultPrevented).toBe(true)
    required(option.querySelector<HTMLElement>(".slash-command-description")).click()
    expect(input.value).toBe("/logout ")
    expect(onInput).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(input)
    expect(listbox.hidden).toBe(true)
    menu.update()
    expect(listbox.hidden).toBe(true)
  })

  test("does not use a stale pointer selection after the draft changes", () => {
    const { draft, listbox, input, onInput } = setup()
    draft("/n")
    const option = required(listbox.querySelector<HTMLElement>("[role='option']"))
    input.value = "a new draft"
    option.click()
    expect(input.value).toBe("a new draft")
    expect(onInput).not.toHaveBeenCalled()
  })

  test("Escape closes before run cancellation and stays dismissed until text or caret changes", () => {
    const { draft, key, input, menu, listbox, onInput } = setup()
    draft("/n")
    const { event, consumed } = key("Escape")
    expect(consumed).toBe(true)
    expect(event.defaultPrevented).toBe(true)
    expect(listbox.hidden).toBe(true)
    expect(input.hasAttribute("aria-expanded")).toBe(false)
    expect(listbox.ownerDocument.querySelector("#commands-status")?.textContent).toBe(
      "Command list closed.",
    )
    expect(input.hasAttribute("aria-activedescendant")).toBe(false)
    expect(input.value).toBe("/n")
    expect(onInput).not.toHaveBeenCalled()
    menu.update()
    expect(listbox.hidden).toBe(true)
    expect(key("Escape").consumed).toBe(false)
    draft("/ne")
    expect(listbox.hidden).toBe(false)
    menu.close()
    menu.update()
    expect(listbox.hidden).toBe(true)
    input.setSelectionRange(1, 1)
    menu.update()
    expect(listbox.hidden).toBe(false)
  })

  test.each([
    { key: "Enter", shiftKey: true },
    { key: "Enter", altKey: true },
    { key: "Enter", ctrlKey: true },
    { key: "Enter", metaKey: true },
    { key: "Tab", shiftKey: true },
    { key: "ArrowDown", altKey: true },
    { key: "a" },
  ])("leaves modified/ordinary keys unchanged: %j", (init) => {
    const { draft, key, input, onInput } = setup()
    draft("/n")
    const result = key(init.key, init)
    expect(result.consumed).toBe(false)
    expect(result.event.defaultPrevented).toBe(false)
    expect(input.value).toBe("/n")
    expect(onInput).not.toHaveBeenCalled()
  })

  test("does not consume a key that another handler already prevented", () => {
    const { dom, draft, menu, input } = setup()
    draft("/n")
    const event = new dom.window.KeyboardEvent("keydown", { key: "Enter", cancelable: true })
    event.preventDefault()
    expect(menu.handleKeyDown(event)).toBe(false)
    expect(input.value).toBe("/n")
  })

  test.each([
    { key: "Enter", isComposing: true },
    { key: "Enter", keyCode: 229 },
    { key: "Escape", isComposing: true },
  ])(
    "skips conversation handling during IME input without preventing browser defaults: %j",
    (init) => {
      const { draft, key, input, onInput } = setup()
      draft("/n")
      const result = key(init.key, init)
      expect(result.consumed).toBe(true)
      expect(result.event.defaultPrevented).toBe(false)
      expect(input.value).toBe("/n")
      expect(onInput).not.toHaveBeenCalled()
    },
  )

  test("hides during IME composition and updates after composition ends", () => {
    const { dom, draft, key, input, listbox } = setup()
    draft("/n")
    input.dispatchEvent(new dom.window.CompositionEvent("compositionstart"))
    expect(listbox.hidden).toBe(true)
    expect(key("Enter").consumed).toBe(true)
    expect(key("Escape").consumed).toBe(true)
    input.value = "/na"
    input.dispatchEvent(new dom.window.Event("input"))
    expect(listbox.hidden).toBe(true)
    input.dispatchEvent(new dom.window.CompositionEvent("compositionend"))
    expect(listbox.hidden).toBe(false)
  })

  test("updates on caret selection and click without requiring an input edit", () => {
    const { dom, draft, input, listbox } = setup()
    draft("/name title")
    expect(listbox.hidden).toBe(true)
    input.setSelectionRange(3, 3)
    input.dispatchEvent(new dom.window.Event("select"))
    expect(listbox.hidden).toBe(false)
    input.setSelectionRange(8, 8)
    input.click()
    expect(listbox.hidden).toBe(true)
    input.setSelectionRange(3, 3)
    input.ownerDocument.dispatchEvent(new dom.window.Event("selectionchange"))
    expect(listbox.hidden).toBe(false)
  })

  test("closes on outside pointer and focus events", () => {
    const { dom, draft, outside, listbox, menu } = setup()
    draft("/")
    outside.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true }))
    expect(listbox.hidden).toBe(true)
    menu.update()
    expect(listbox.hidden).toBe(true)
    draft("/n")
    expect(listbox.hidden).toBe(false)
    outside.focus()
    expect(listbox.hidden).toBe(true)
  })

  test("closes when the textarea loses focus without a new focused element", () => {
    const { draft, input, listbox, menu } = setup()
    draft("/n")
    input.blur()
    expect(listbox.hidden).toBe(true)
    input.focus()
    menu.update()
    expect(listbox.hidden).toBe(true)
  })

  test("does not install a keydown listener; the caller owns key ordering", () => {
    const { dom, draft, input, listbox, onInput } = setup()
    draft("/n")
    const event = new dom.window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    })
    input.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(input.value).toBe("/n")
    expect(onInput).not.toHaveBeenCalled()
    expect(listbox.hidden).toBe(false)
  })

  test("creates unique listbox IDs when markup does not supply one", () => {
    const { document, input } = setup()
    const first = document.createElement("div")
    const second = document.createElement("div")
    new SlashCommandMenu({ input, listbox: first, onInput: vi.fn() })
    new SlashCommandMenu({ input, listbox: second, onInput: vi.fn() })
    expect(first.id).not.toBe("")
    expect(second.id).not.toBe(first.id)
    expect(input.getAttribute("aria-controls")).toBe(second.id)
  })
})
