import { Value } from "typebox/value"
import { describe, expect, test, vi } from "vitest"
import { createBrowserTools } from "../../src/browser/agent/browser-tools.js"

describe("browser agent tools", () => {
  test("schemas reject malformed arguments before execution", () => {
    const tools = createBrowserTools(vi.fn().mockResolvedValue(false))
    const click = tools.find((tool) => tool.name === "browser_click")
    const type = tools.find((tool) => tool.name === "browser_type")
    const navigate = tools.find((tool) => tool.name === "browser_navigate")
    expect(click && Value.Check(click.parameters, { selector: 42 })).toBe(false)
    expect(click && Value.Check(click.parameters, { selector: "#go", extra: true })).toBe(false)
    expect(type && Value.Check(type.parameters, { selector: "#input", text: "ok" })).toBe(true)
    expect(type && Value.Check(type.parameters, { selector: "#input" })).toBe(false)
    expect(navigate && Value.Check(navigate.parameters, { url: "https://example.test" })).toBe(true)
  })

  test("marks mutating tools as never replayable and sequential", () => {
    const tools = createBrowserTools(vi.fn().mockResolvedValue(false))
    for (const name of ["browser_click", "browser_type", "browser_navigate", "browser_webmcp"]) {
      expect(tools.find((tool) => tool.name === name)).toMatchObject({
        replay: "never",
        executionMode: "sequential",
      })
    }
  })
})
