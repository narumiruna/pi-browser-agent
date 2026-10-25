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

function setup() {
  const dom = new JSDOM(html)
  environments.push(dom)
  const document = dom.window.document
  function get<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id)
    if (!element) throw new Error(`Missing test element: ${id}`)
    return element as T
  }
  const page = get<HTMLElement>("settings-page")
  page.hidden = false
  initializeSettingsTabs(page)
  const tabs = [...page.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  const panels = [...page.querySelectorAll<HTMLElement>('[role="tabpanel"]')]
  const tab = (name: string) => get<HTMLButtonElement>(`settings-tab-${name.toLowerCase()}`)
  const panel = (name: string) => get<HTMLElement>(`settings-panel-${name.toLowerCase()}`)
  return { dom, page, get, tabs, panels, tab, panel }
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
    ["Model", "ArrowRight", "Tools"],
    ["Tools", "ArrowLeft", "Model"],
    ["Model", "ArrowLeft", "Instructions"],
    ["Instructions", "ArrowRight", "Model"],
    ["Skills", "Home", "Model"],
    ["Model", "End", "Instructions"],
  ])("%s + %s activates and focuses %s", (initial, key, expected) => {
    const env = setup()
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
    { key: "ArrowDown" },
    { key: "ArrowLeft", altKey: true },
    { key: "ArrowRight", ctrlKey: true },
    { key: "Home", metaKey: true },
    { key: "End", shiftKey: true },
  ])("does not intercept unrelated or modified keys: %j", (options) => {
    const env = setup()
    env.tab("Skills").click()
    const event = new env.dom.window.KeyboardEvent("keydown", {
      ...options,
      bubbles: true,
      cancelable: true,
    })
    env.tab("Skills").dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expectActive(env, "Skills")
  })

  test("keeps unsaved controls mounted without emitting input or change events", () => {
    const env = setup()
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
    expect(env.get("system-prompt")).toBe(systemPrompt)
    expect(env.get("mcp-name")).toBe(serverName)
    expect(systemPrompt.value).toBe("Unsubmitted instructions")
    expect(serverName.value).toBe("Unsaved server")
    expect(token.value).toBe("unsaved-private-token")
    expect(changed).not.toHaveBeenCalled()
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
