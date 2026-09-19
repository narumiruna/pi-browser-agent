import { Value } from "typebox/value"
import { afterEach, describe, expect, test, vi } from "vitest"
import { createBrowserTools } from "../../src/browser/agent/browser-tools.js"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("browser agent tools", () => {
  test("schemas reject malformed arguments before execution", () => {
    const tools = createBrowserTools(vi.fn().mockResolvedValue(false))
    const click = tools.find((tool) => tool.name === "browser_click")
    const type = tools.find((tool) => tool.name === "browser_type")
    const navigate = tools.find((tool) => tool.name === "browser_navigate")
    const bookmarkSearch = tools.find((tool) => tool.name === "browser_search_bookmarks")
    const recentBookmarks = tools.find((tool) => tool.name === "browser_get_recent_bookmarks")
    expect(click && Value.Check(click.parameters, { selector: 42 })).toBe(false)
    expect(click && Value.Check(click.parameters, { selector: "#go", extra: true })).toBe(false)
    expect(type && Value.Check(type.parameters, { selector: "#input", text: "ok" })).toBe(true)
    expect(type && Value.Check(type.parameters, { selector: "#input" })).toBe(false)
    expect(navigate && Value.Check(navigate.parameters, { url: "https://example.test" })).toBe(true)
    expect(bookmarkSearch && Value.Check(bookmarkSearch.parameters, { query: "docs" })).toBe(true)
    expect(bookmarkSearch && Value.Check(bookmarkSearch.parameters, { query: "   " })).toBe(false)
    expect(
      bookmarkSearch && Value.Check(bookmarkSearch.parameters, { query: "docs", limit: 51 }),
    ).toBe(false)
    expect(recentBookmarks && Value.Check(recentBookmarks.parameters, { limit: 1 })).toBe(true)
    expect(recentBookmarks && Value.Check(recentBookmarks.parameters, { limit: 0 })).toBe(false)
  })

  test("marks mutating and confirmation-gated tools as never replayable and sequential", () => {
    const tools = createBrowserTools(vi.fn().mockResolvedValue(false))
    for (const name of [
      "browser_click",
      "browser_type",
      "browser_navigate",
      "browser_webmcp",
      "browser_search_bookmarks",
      "browser_get_recent_bookmarks",
    ]) {
      expect(tools.find((tool) => tool.name === name)).toMatchObject({
        replay: "never",
        executionMode: "sequential",
      })
    }
  })

  test("confirms bookmark reads without requesting active-tab state", async () => {
    const sendMessage = vi.fn(async (message: { confirmed?: boolean; method: string }) => {
      if (message.method === "app.getState") throw new Error("unexpected active-tab request")
      if (!message.confirmed) {
        return {
          ok: false,
          error: {
            code: "CONFIRMATION_REQUIRED",
            message: "Confirm bookmark read",
            details: { requiredPermission: "bookmarks" },
          },
        }
      }
      return {
        ok: true,
        result: {
          items: [{ id: "1", title: "Docs", type: "bookmark", url: "https://docs.test" }],
          limit: 20,
          truncated: false,
        },
      }
    })
    vi.stubGlobal("chrome", { runtime: { sendMessage } })
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "request-id") })
    const confirm = vi.fn().mockResolvedValue(true)
    const tool = createBrowserTools(confirm).find(
      (candidate) => candidate.name === "browser_search_bookmarks",
    )
    if (!tool) throw new Error("Missing bookmark search tool")

    const result = await tool.execute("tool-id", { query: "docs" }, undefined)

    expect(confirm).toHaveBeenCalledWith(
      "Confirm bookmark read",
      { requiredPermission: "bookmarks" },
      undefined,
    )
    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "app.getState" }),
    )
    expect(sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: "bookmarks.search",
        params: { query: "docs", limit: 20 },
        confirmed: true,
      }),
    )
    expect(sendMessage.mock.calls.some(([message]) => "tabContext" in message)).toBe(false)
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Untrusted browser bookmark data"),
    })
  })
})
