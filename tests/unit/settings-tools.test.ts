import { JSDOM } from "jsdom"
import { describe, expect, test } from "vitest"
import { BROWSER_TOOL_OPTIONS } from "../../src/browser/agent/browser-tools.js"
import { renderToolOptions, TOOL_GROUPS } from "../../src/browser/sidepanel/settings-tools.js"

describe("Settings tool groups", () => {
  test("assigns every browser tool to exactly one named group", () => {
    const names = TOOL_GROUPS.flatMap((group) => group.tools.map(([name]) => name))
    expect(new Set(names).size).toBe(names.length)
    expect([...names].sort()).toEqual(BROWSER_TOOL_OPTIONS.map((tool) => tool.name).sort())
    expect(TOOL_GROUPS.map((group) => group.name)).toEqual([
      "Read",
      "Interact",
      "Navigate",
      "Bookmarks",
      "WebMCP",
    ])
  })

  test("renders named controls, associated short descriptions, and optional technical IDs", () => {
    const dom = new JSDOM('<fieldset id="tools"></fieldset>')
    try {
      const container = dom.window.document.getElementById("tools")
      if (!container) throw new Error("Missing tools fixture")
      const checkboxes = renderToolOptions(container)
      expect(checkboxes).toHaveLength(BROWSER_TOOL_OPTIONS.length)
      expect(container.querySelectorAll("fieldset legend")).toHaveLength(TOOL_GROUPS.length)
      for (const input of checkboxes) {
        const description = dom.window.document.getElementById(
          input.getAttribute("aria-describedby") ?? "",
        )
        expect(description?.textContent?.length).toBeGreaterThan(0)
        expect(description?.textContent?.length).toBeLessThan(90)
        expect(input.closest("label")?.textContent).not.toContain(input.value)
        const details = input.closest(".tool-option")?.querySelector("details")
        expect(details?.open).toBe(false)
        expect(details?.querySelector("code")?.textContent).toBe(input.value)
      }
    } finally {
      dom.window.close()
    }
  })
})
