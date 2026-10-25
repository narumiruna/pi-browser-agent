import { readFileSync } from "node:fs"
import { JSDOM } from "jsdom"
import { afterEach, describe, expect, test, vi } from "vitest"
import { initializeSettingsTabs } from "../../src/browser/sidepanel/settings-tabs.js"

const html = readFileSync(
  new URL("../../src/browser/sidepanel/index.html", import.meta.url),
  "utf8",
)
const names = ["Model", "Tools", "MCP", "Skills", "Appearance", "Instructions"]
const environments: JSDOM[] = []

afterEach(() => {
  for (const dom of environments.splice(0)) dom.window.close()
})

function setup(width = 1280) {
  const dom = new JSDOM(html)
  environments.push(dom)
  const desktop = Object.assign(new dom.window.EventTarget(), { matches: width >= 800 })
  const matchMedia = vi.fn(() => desktop)
  Object.defineProperty(dom.window, "matchMedia", { value: matchMedia })
  function resize(width: number): void {
    const matches = width >= 800
    if (desktop.matches === matches) return
    desktop.matches = matches
    desktop.dispatchEvent(new dom.window.Event("change"))
  }
  const document = dom.window.document
  function get<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id)
    if (!element) throw new Error(`Missing test element: ${id}`)
    return element as T
  }
  const page = get<HTMLElement>("settings-page")
  page.hidden = false
  initializeSettingsTabs(page)
  const tablist = page.querySelector<HTMLElement>('[role="tablist"]')
  if (!tablist) throw new Error("Missing Settings tablist")
  const tabs = [...page.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  const panels = [...page.querySelectorAll<HTMLElement>('[role="tabpanel"]')]
  const tab = (name: string) => get<HTMLButtonElement>(`settings-tab-${name.toLowerCase()}`)
  const panel = (name: string) => get<HTMLElement>(`settings-panel-${name.toLowerCase()}`)
  return { dom, page, get, tablist, tabs, panels, tab, panel, matchMedia, resize }
}

function expectActive(env: ReturnType<typeof setup>, name: string): void {
  expect(env.tabs.filter((tab) => tab.getAttribute("aria-selected") === "true")).toEqual([
    env.tab(name),
  ])
  expect(env.tabs.filter((tab) => tab.tabIndex === 0)).toEqual([env.tab(name)])
  expect(env.panels.filter((panel) => !panel.hidden)).toEqual([env.panel(name)])
}

describe("Settings tabs", () => {
  test("links six tabs to named panels and selects Model by default", () => {
    const env = setup()
    expect(env.tabs.map((tab) => tab.textContent)).toEqual(names)
    expect(env.panels).toHaveLength(names.length)
    for (const name of names) {
      expect(env.tab(name).getAttribute("aria-controls")).toBe(env.panel(name).id)
      expect(env.panel(name).getAttribute("aria-labelledby")).toBe(env.tab(name).id)
      expect(env.panel(name).tabIndex).toBe(0)
    }
    expectActive(env, "Model")
  })

  test("clicking a tab selects only its panel and keeps both browser sections together", () => {
    const env = setup()
    for (const name of names) {
      env.tab(name).click()
      expectActive(env, name)
    }
    env.tab("Tools").click()
    expect(env.panel("Tools").querySelector("#available-tools")).not.toBeNull()
    expect(env.panel("Tools").querySelector("#confirmation-mode")).not.toBeNull()
  })

  test.each([
    [320, "horizontal"],
    [799, "horizontal"],
    [800, "vertical"],
    [1280, "vertical"],
  ] as const)("uses %s px navigation with %s orientation", (width, orientation) => {
    const env = setup(width)
    expect(env.matchMedia).toHaveBeenCalledExactlyOnceWith("(min-width: 800px)")
    expect(env.tablist.getAttribute("aria-orientation")).toBe(orientation)
    expectActive(env, "Model")
  })

  describe.each([
    { width: 799, previous: "ArrowLeft", next: "ArrowRight", unrelated: ["ArrowUp", "ArrowDown"] },
    { width: 800, previous: "ArrowUp", next: "ArrowDown", unrelated: ["ArrowLeft", "ArrowRight"] },
  ])("at $width px", ({ width, previous, next, unrelated }) => {
    test.each([
      ["Model", next, "Tools"],
      ["Tools", previous, "Model"],
      ["Model", previous, "Instructions"],
      ["Instructions", next, "Model"],
      ["Skills", "Home", "Model"],
      ["Model", "End", "Instructions"],
    ])("%s + %s activates and focuses %s", (initial, key, expected) => {
      const env = setup(width)
      env.tab(initial).click()
      env.tab(initial).focus()
      const event = new env.dom.window.KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      })
      env.tab(initial).dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
      expectActive(env, expected)
      expect(env.dom.window.document.activeElement).toBe(env.tab(expected))
    })

    test.each([
      { key: "Tab" },
      { key: "Escape" },
      ...unrelated.map((key) => ({ key })),
      { key: previous, altKey: true },
      { key: next, ctrlKey: true },
      { key: "Home", metaKey: true },
      { key: "End", shiftKey: true },
    ])("does not intercept unrelated or modified keys: %j", (options) => {
      const env = setup(width)
      env.tab("Skills").click()
      env.tab("Skills").focus()
      const event = new env.dom.window.KeyboardEvent("keydown", {
        ...options,
        bubbles: true,
        cancelable: true,
      })
      env.tab("Skills").dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
      expectActive(env, "Skills")
      expect(env.dom.window.document.activeElement).toBe(env.tab("Skills"))
    })
  })

  test.each([1280, 320])(
    "keeps focus and mounted drafts without emitting edits across navigation and resize from %s px",
    (width) => {
      const env = setup(width)
      const systemPrompt = env.get<HTMLTextAreaElement>("system-prompt")
      const serverName = env.get<HTMLInputElement>("mcp-name")
      const token = env.get<HTMLInputElement>("mcp-token")
      systemPrompt.value = "Unsubmitted instructions"
      serverName.value = "Unsaved server"
      token.value = "unsaved-private-token"
      const changed = vi.fn()
      env.page.addEventListener("input", changed)
      env.page.addEventListener("change", changed)
      for (const name of names) env.tab(name).click()
      for (const [name, key] of [
        ["Instructions", "Home"],
        ["Model", "End"],
      ] as const) {
        env
          .tab(name)
          .dispatchEvent(new env.dom.window.KeyboardEvent("keydown", { key, bubbles: true }))
      }
      const content = env.page.querySelector<HTMLElement>(".settings-content")
      if (!content) throw new Error("Missing Settings content")
      content.scrollTop = 250
      for (const focused of [env.tab("Instructions"), systemPrompt]) {
        focused.focus()
        for (const width of [799, 800, 320, 1280]) {
          env.resize(width)
          expect(env.tablist.getAttribute("aria-orientation")).toBe(
            width >= 800 ? "vertical" : "horizontal",
          )
          expectActive(env, "Instructions")
          expect(env.dom.window.document.activeElement).toBe(focused)
          expect(content.scrollTop).toBe(250)
        }
      }
      expect([...env.page.querySelectorAll('[role="tabpanel"]')]).toEqual(env.panels)
      expect(env.get("system-prompt")).toBe(systemPrompt)
      expect(env.get("mcp-name")).toBe(serverName)
      expect(env.get("mcp-token")).toBe(token)
      expect(systemPrompt.value).toBe("Unsubmitted instructions")
      expect(serverName.value).toBe("Unsaved server")
      expect(token.value).toBe("unsaved-private-token")
      expect(changed).not.toHaveBeenCalled()
    },
  )

  test("uses the new orientation for keyboard navigation after resizing", () => {
    const env = setup(1280)
    env.tab("Skills").click()
    env.tab("Skills").focus()
    for (const [width, key, initial, expected] of [
      [799, "ArrowRight", "Skills", "Appearance"],
      [800, "ArrowUp", "Appearance", "Skills"],
    ] as const) {
      env.resize(width)
      const event = new env.dom.window.KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      })
      env.tab(initial).dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
      expectActive(env, expected)
      expect(env.dom.window.document.activeElement).toBe(env.tab(expected))
    }
  })

  test("scrolls the selected tab into nearest view on click, key navigation, and resize", () => {
    const env = setup()
    const scroll = vi.fn()
    for (const tab of env.tabs) {
      Object.defineProperty(tab, "scrollIntoView", { value: scroll })
    }
    env.tab("Skills").click()
    expect(scroll).toHaveBeenLastCalledWith({ block: "nearest", inline: "nearest" })
    expect(scroll.mock.contexts.at(-1)).toBe(env.tab("Skills"))
    env
      .tab("Skills")
      .dispatchEvent(
        new env.dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      )
    expect(scroll.mock.contexts.at(-1)).toBe(env.tab("Appearance"))
    env.resize(320)
    expect(scroll.mock.contexts.at(-1)).toBe(env.tab("Appearance"))
    expect(scroll).toHaveBeenCalledTimes(3)
    for (const [options] of scroll.mock.calls) {
      expect(options).toEqual({ block: "nearest", inline: "nearest" })
    }
  })

  test("starts each selected panel at the top of the shared content area", () => {
    const env = setup()
    const content = env.page.querySelector<HTMLElement>(".settings-content")
    if (!content) throw new Error("Missing Settings content")
    content.scrollTop = 500
    env.tab("Tools").click()
    expect(content.scrollTop).toBe(0)
    content.scrollTop = 300
    env.tab("MCP").click()
    expect(content.scrollTop).toBe(0)
  })
})
