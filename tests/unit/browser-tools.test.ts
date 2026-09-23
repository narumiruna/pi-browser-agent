import { Value } from "typebox/value"
import { afterEach, describe, expect, test, vi } from "vitest"
import { createBrowserTools } from "../../src/browser/agent/browser-tools.js"
import { SCREENSHOT_HOST_PERMISSION } from "../../src/browser/permissions.js"
import { MAX_TEXT_RESULT_BYTES } from "../../src/browser/runtime/types.js"

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

  test.each([
    ["browser_click", "selector", 2048, {}],
    ["browser_type", "selector", 2048, { text: "" }],
    ["browser_type", "text", 50_000, { selector: "#x" }],
    ["browser_navigate", "url", 16_384, {}],
    ["browser_search_bookmarks", "query", 500, {}],
    ["browser_webmcp", "name", 256, { action: "call" }],
  ] as const)("preserves %s schema bounds for %s", (name, key, limit, rest) => {
    const tool = createBrowserTools(vi.fn()).find((candidate) => candidate.name === name)
    if (!tool) throw new Error(`Missing tool: ${name}`)
    expect(Value.Check(tool.parameters, { ...rest, [key]: "x".repeat(limit) })).toBe(true)
    expect(Value.Check(tool.parameters, { ...rest, [key]: "x".repeat(limit + 1) })).toBe(false)
  })

  test("accepts exactly one bounded element target in tool schemas", () => {
    const tools = createBrowserTools(vi.fn())
    const reference = { snapshotId: "11111111-1111-1111-1111-111111111111", ref: "e1" }
    for (const name of ["browser_click", "browser_type"]) {
      const tool = tools.find((item) => item.name === name)
      if (!tool) throw new Error(name)
      const args = (target: object) => ({
        ...target,
        ...(name === "browser_type" ? { text: "value" } : {}),
      })
      for (const target of [reference, { selector: "#x" }])
        expect(Value.Check(tool.parameters, args(target))).toBe(true)
      for (const target of [
        {},
        { ref: "e1" },
        { snapshotId: reference.snapshotId },
        { ...reference, selector: "#x" },
        { ...reference, extra: true },
        { ...reference, ref: "e0" },
      ])
        expect(Value.Check(tool.parameters, args(target))).toBe(false)
    }
    expect(tools.find((item) => item.name === "browser_list_elements")).toMatchObject({
      executionMode: "sequential",
      replay: "safe",
    })
  })

  test.each(["decline", "abort", "confirm"])(
    "preserves reference and context across confirmation %s",
    async (outcome) => {
      const tabContext = { tabId: 1, url: "https://example.test/", epoch: 1 }
      const target = { snapshotId: "11111111-1111-1111-1111-111111111111", ref: "e1" }
      const signal = new AbortController()
      const sendMessage = vi.fn(async (message: { method: string; confirmed?: boolean }) => {
        if (message.method === "app.getState") return { ok: true, result: { tabContext } }
        if (!message.confirmed)
          return {
            ok: false,
            error: { code: "CONFIRMATION_REQUIRED", message: "Submit?", details: target },
          }
        return { ok: false, error: { code: "STALE_CONTEXT", message: "Target changed" } }
      })
      vi.stubGlobal("chrome", { runtime: { sendMessage } })
      const confirm = vi.fn(async () => {
        if (outcome === "abort") signal.abort()
        return outcome !== "decline"
      })
      const tool = createBrowserTools(confirm).find((item) => item.name === "browser_click")
      if (!tool) throw new Error("click")
      await expect(tool.execute("call", target, signal.signal)).rejects.toThrow(
        outcome === "confirm" ? "Target changed" : outcome === "abort" ? "cancelled" : "declined",
      )
      expect(sendMessage).toHaveBeenCalledTimes(outcome === "confirm" ? 3 : 2)
      if (outcome === "confirm")
        expect(sendMessage).toHaveBeenLastCalledWith(
          expect.objectContaining({ params: target, confirmed: true, tabContext }),
        )
    },
  )

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
    expect(tools.find((tool) => tool.name === "browser_capture_visible")).toMatchObject({
      replay: "safe",
      executionMode: "sequential",
    })
  })

  test("confirms optional screenshot access and returns PNG content", async () => {
    const tabContext = { tabId: 1, url: "https://example.test/", epoch: 0 }
    const sendMessage = vi.fn(async (message: { confirmed?: boolean; method: string }) => {
      if (message.method === "app.getState") {
        return { ok: true, result: { tabContext } }
      }
      if (message.method === "page.captureVisible" && !message.confirmed) {
        return {
          ok: false,
          error: {
            code: "CONFIRMATION_REQUIRED",
            message: "Allow screenshots?",
            details: { requiredPermission: SCREENSHOT_HOST_PERMISSION },
          },
        }
      }
      return {
        ok: true,
        result: {
          dataUrl: "data:image/png;base64,iVBORw==",
          mimeType: "image/png",
          tabContext,
        },
      }
    })
    vi.stubGlobal("chrome", { runtime: { sendMessage } })
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "request-id") })
    const confirm = vi.fn().mockResolvedValue(true)
    const tool = createBrowserTools(confirm).find(
      (candidate) => candidate.name === "browser_capture_visible",
    )
    if (!tool) throw new Error("Missing screenshot tool")

    const result = await tool.execute("tool-id", {}, undefined)

    expect(confirm).toHaveBeenCalledWith(
      "Allow screenshots?",
      { requiredPermission: SCREENSHOT_HOST_PERMISSION },
      undefined,
    )
    expect(sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: "page.captureVisible",
        confirmed: true,
        tabContext,
      }),
    )
    expect(result.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining("Untrusted browser screenshot metadata"),
      },
      { type: "image", data: "iVBORw==", mimeType: "image/png" },
    ])
  })

  test.each(["list", "call"] as const)(
    "confirms WebMCP %s before any worker execution, retaining captured context",
    async (action) => {
      const tabContext = { tabId: 1, url: "https://example.test/", epoch: 0 }
      const order: string[] = []
      const sendMessage = vi.fn(async (message: { method: string }) => {
        order.push(message.method)
        if (message.method === "app.getState") return { ok: true, result: { tabContext } }
        // Each worker request emits progress; there must be no unconfirmed preflight request.
        return { ok: false, error: { code: "PERMISSION_DENIED", message: "Missing host access" } }
      })
      vi.stubGlobal("chrome", { runtime: { sendMessage } })
      const controller = new AbortController()
      const confirm = vi.fn(async () => {
        order.push("confirm")
        return true
      })
      const tool = createBrowserTools(confirm).find(
        (candidate) => candidate.name === "browser_webmcp",
      )
      if (!tool) throw new Error("Missing WebMCP tool")
      const params =
        action === "list" ? { action } : { action, name: "lookup", arguments: { id: 1 } }

      await expect(tool.execute("tool-id", params, controller.signal)).rejects.toThrow(
        "Missing host access",
      )

      expect(order).toEqual([
        "app.getState",
        "confirm",
        action === "list" ? "webmcp.listTools" : "webmcp.callTool",
      ])
      expect(confirm).toHaveBeenCalledExactlyOnceWith(
        action === "list"
          ? "List the tools provided by this page through WebMCP?"
          : "Call this page-provided WebMCP tool?",
        { action, name: action === "list" ? "" : "lookup" },
        controller.signal,
      )
      expect(sendMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          confirmed: true,
          tabContext,
          params: action === "list" ? {} : { name: "lookup", arguments: { id: 1 } },
        }),
      )
    },
  )

  test.each(["decline", "abort"])(
    "does not execute WebMCP after confirmation %s",
    async (outcome) => {
      const sendMessage = vi.fn(async () => ({
        ok: true,
        result: { tabContext: { tabId: 1, url: "https://example.test/", epoch: 0 } },
      }))
      vi.stubGlobal("chrome", { runtime: { sendMessage } })
      const controller = new AbortController()
      const tool = createBrowserTools(async () => {
        if (outcome === "abort") controller.abort()
        return outcome !== "decline"
      }).find((candidate) => candidate.name === "browser_webmcp")
      if (!tool) throw new Error("Missing WebMCP tool")

      await expect(tool.execute("tool-id", { action: "list" }, controller.signal)).rejects.toThrow(
        outcome === "decline" ? "WebMCP access was declined" : "cancelled",
      )
      expect(sendMessage).toHaveBeenCalledOnce()
    },
  )

  test("caps the final formatted bookmark text after JSON escaping", async () => {
    const sendMessage = vi.fn(async () => ({
      ok: true,
      result: {
        text: `{"title":"${'\\"'.repeat(MAX_TEXT_RESULT_BYTES)}"}`,
        truncated: true,
      },
    }))
    vi.stubGlobal("chrome", { runtime: { sendMessage } })
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "request-id") })
    const tool = createBrowserTools(vi.fn()).find(
      (candidate) => candidate.name === "browser_search_bookmarks",
    )
    if (!tool) throw new Error("Missing bookmark search tool")

    const result = await tool.execute("tool-id", { query: "large" }, undefined)
    const content = result.content[0]
    if (content?.type !== "text") throw new Error("Missing bookmark text result")

    expect(new TextEncoder().encode(content.text).byteLength).toBeLessThanOrEqual(
      MAX_TEXT_RESULT_BYTES,
    )
    expect(content.text).toMatch(/\[truncated\]$/)
  })

  test("blocks every page tool in a no-page turn even when a web tab is active", async () => {
    let enabled = false
    const sendMessage = vi.fn(async (message: { method: string }) =>
      message.method === "app.getState"
        ? { ok: true, result: { tabContext: { tabId: 1, url: "https://example.test", epoch: 0 } } }
        : { ok: true, result: {} },
    )
    vi.stubGlobal("chrome", { runtime: { sendMessage } })
    const tools = createBrowserTools(vi.fn(), () => enabled)
    for (const [name, params] of [
      ["browser_get_active_tab", {}],
      ["browser_read_page", {}],
      ["browser_capture_visible", {}],
      ["browser_list_elements", {}],
      ["browser_get_selection", {}],
      ["browser_click", { selector: "#x" }],
      ["browser_type", { selector: "#x", text: "x" }],
      ["browser_navigate", { url: "https://example.test" }],
      ["browser_webmcp", { action: "list" }],
    ] as const) {
      const tool = tools.find((candidate) => candidate.name === name)
      if (!tool) throw new Error(name)
      await expect(tool.execute("id", params, undefined)).rejects.toThrow(
        "does not use page context",
      )
    }
    expect(sendMessage).not.toHaveBeenCalled()
    const bookmark = tools.find((candidate) => candidate.name === "browser_get_recent_bookmarks")
    if (!bookmark) throw new Error("Missing bookmark tool")
    await bookmark.execute("id", {}, undefined)
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ method: "bookmarks.getRecent" }),
    )
    enabled = true
    await tools
      .find((candidate) => candidate.name === "browser_get_active_tab")
      ?.execute("id", {}, undefined)
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ method: "tabs.getActive" }))
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
