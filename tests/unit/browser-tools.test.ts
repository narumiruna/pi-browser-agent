import { Value } from "typebox/value"
import { afterEach, describe, expect, test, vi } from "vitest"
import { createBrowserTools } from "../../src/browser/agent/browser-tools.js"
import { SCREENSHOT_HOST_PERMISSION } from "../../src/browser/permissions.js"
import { MAX_TEXT_RESULT_BYTES } from "../../src/browser/runtime/types.js"

function tabBrowser(initial: chrome.tabs.Tab[]) {
  const tabs = new Map(initial.map((tab) => [tab.id, tab]))
  const state: {
    active: chrome.tabs.Tab | undefined
    focusedWindowId: number
    workerState?: unknown
  } = { active: initial.find((tab) => tab.active) ?? initial[0], focusedWindowId: 1 }
  const query = vi.fn(async (options: chrome.tabs.QueryInfo) =>
    options.active
      ? state.active
        ? [state.active]
        : []
      : [...tabs.values()].filter((tab) => tab.windowId === options.windowId),
  )
  const get = vi.fn(async (id: number) => {
    const tab = tabs.get(id)
    if (!tab) throw new Error("No tab")
    return tab
  })
  const update = vi.fn(async (id: number) => {
    const tab = { ...(await get(id)), active: true }
    tabs.set(id, tab)
    state.active = tab
    return tab
  })
  const create = vi.fn(async (options: chrome.tabs.CreateProperties) => {
    const tab = {
      id: 4,
      url: options.url,
      windowId: options.windowId ?? 99,
      active: true,
    } as chrome.tabs.Tab
    tabs.set(4, tab)
    state.active = tab
    return tab
  })
  const sendMessage = vi.fn(async (message: { method: string }) => ({
    ok: true,
    result:
      message.method === "app.getState"
        ? (state.workerState ?? {
            tabContext: { tabId: state.active?.id, url: state.active?.url, epoch: 1 },
            contextState: "available",
            windowId: state.active?.windowId,
          })
        : { text: "Intended page" },
  }))
  const getWindow = vi.fn(async (id: number) => ({ id, focused: id === state.focusedWindowId }))
  vi.stubGlobal("chrome", {
    tabs: { query, get, update, create },
    windows: { get: getWindow },
    runtime: { sendMessage },
  })
  return { state, tabs, query, get, update, create, sendMessage, getWindow }
}

const activeTab = {
  id: 1,
  url: "https://active.test/",
  windowId: 1,
  active: true,
} as chrome.tabs.Tab
const targetTab = {
  id: 2,
  url: "https://target.test/",
  windowId: 1,
  active: false,
} as chrome.tabs.Tab

function browserTool(
  name: string,
  confirm = vi.fn(async () => true),
  enabled = () => true,
  enablePage = vi.fn(),
) {
  const tool = createBrowserTools(confirm, enabled, enablePage).find((item) => item.name === name)
  if (!tool) throw new Error(name)
  return tool
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("browser agent tools", () => {
  test("schemas reject malformed arguments before execution", () => {
    const tools = createBrowserTools(vi.fn().mockResolvedValue(false))
    const read = tools.find((tool) => tool.name === "browser_read_page")
    expect(read && Value.Check(read.parameters, {})).toBe(true)
    expect(read && Value.Check(read.parameters, { selector: "main", offset: 42 })).toBe(true)
    for (const params of [
      { selector: "" },
      { offset: -1 },
      { offset: 1.5 },
      { offset: "1" },
      { extra: true },
    ])
      expect(read && Value.Check(read.parameters, params)).toBe(false)
    const click = tools.find((tool) => tool.name === "browser_click")
    const type = tools.find((tool) => tool.name === "browser_type")
    const navigate = tools.find((tool) => tool.name === "browser_navigate")
    const open = tools.find((tool) => tool.name === "browser_open_website")
    const switchTab = tools.find((tool) => tool.name === "browser_switch_tab")
    expect(open && Value.Check(open.parameters, { url: "chrome://settings/" })).toBe(true)
    expect(open && Value.Check(open.parameters, { url: "" })).toBe(false)
    expect(switchTab && Value.Check(switchTab.parameters, { id: 1 })).toBe(true)
    expect(switchTab && Value.Check(switchTab.parameters, { id: -1 })).toBe(false)
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
    ["browser_read_page", "selector", 2048, {}],
    ["browser_click", "selector", 2048, {}],
    ["browser_type", "selector", 2048, { text: "" }],
    ["browser_type", "text", 50_000, { selector: "#x" }],
    ["browser_navigate", "url", 16_384, {}],
    ["browser_open_website", "url", 16_384, {}],
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

  test.each(["dispatched", "outcome_unknown"])(
    "does not replay a confirmation error after %s",
    async (mutationOutcome) => {
      const sendMessage = vi.fn(async (message: { method: string }) =>
        message.method === "app.getState"
          ? {
              ok: true,
              result: { tabContext: { tabId: 1, url: "https://example.test/", epoch: 1 } },
            }
          : {
              ok: false,
              error: {
                code: "CONFIRMATION_REQUIRED",
                message: "Do not repeat",
                details: { mutationOutcome },
              },
            },
      )
      vi.stubGlobal("chrome", { runtime: { sendMessage } })
      const confirm = vi.fn(async () => true)
      await expect(
        browserTool("browser_click", confirm).execute("call", { selector: "button" }, undefined),
      ).rejects.toMatchObject({ details: { mutationOutcome } })
      expect(sendMessage).toHaveBeenCalledTimes(2)
      expect(confirm).not.toHaveBeenCalled()
    },
  )

  test.each([
    [
      { submit: false, download: false, crossOrigin: true, targetUrl: "https://other.test/next" },
      true,
    ],
    [{ submit: true, download: false, crossOrigin: false }, false],
    [
      { submit: false, download: true, crossOrigin: true, targetUrl: "https://other.test/file" },
      false,
    ],
    [{ submit: false, download: false, crossOrigin: false }, false],
  ] as const)("only reuses cross-origin link confirmation for %j", async (details, reusable) => {
    const tabContext = { tabId: 1, url: "https://example.test/", epoch: 1 }
    const sendMessage = vi.fn(async (message: { method: string; confirmed?: boolean }) => {
      if (message.method === "app.getState") return { ok: true, result: { tabContext } }
      if (!message.confirmed)
        return { ok: false, error: { code: "CONFIRMATION_REQUIRED", message: "Click?", details } }
      return { ok: true, result: { clicked: true } }
    })
    vi.stubGlobal("chrome", { runtime: { sendMessage } })
    const confirm = vi.fn().mockResolvedValue(true)
    const click = createBrowserTools(confirm).find((tool) => tool.name === "browser_click")
    if (!click) throw new Error("Missing click tool")
    await click.execute("id", { selector: "a" }, undefined)
    const args = confirm.mock.calls[0]
    if (!args) throw new Error("Missing confirmation")
    expect(args).toHaveLength(reusable ? 4 : 3)
    if (reusable)
      expect(args[3]).toEqual({
        operation: "page.click.link",
        identity: ["https://example.test", "https://other.test/next"],
        permissionUrl: "https://other.test/next",
      })
    expect(sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ confirmed: true, tabContext }),
    )
  })

  test("marks mutating and confirmation-gated tools as never replayable and sequential", () => {
    const tools = createBrowserTools(vi.fn().mockResolvedValue(false))
    for (const name of [
      "browser_switch_tab",
      "browser_open_website",
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

  test("lists only bounded web tab metadata and switches only after confirmation", async () => {
    const web = {
      id: 2,
      url: "https://example.test/private?q=secret",
      title: "Example",
      windowId: 1,
      active: false,
    }
    const restricted = { id: 3, url: "chrome://settings/", title: "Settings", windowId: 1 }
    const { update, query } = tabBrowser([
      web,
      { ...restricted, active: true },
    ] as chrome.tabs.Tab[])
    const confirm = vi.fn().mockResolvedValue(false)
    const enablePage = vi.fn()
    const tools = createBrowserTools(confirm, () => false, enablePage)
    const list = tools.find((tool) => tool.name === "browser_list_tabs")
    const switchTab = tools.find((tool) => tool.name === "browser_switch_tab")
    if (!list || !switchTab) throw new Error("Missing tab tools")
    const metadata = await list.execute("id", {}, undefined)
    expect(metadata.details).toEqual({
      tabs: [{ id: 2, title: "Example", origin: "https://example.test", active: false }],
      truncated: false,
    })
    await expect(switchTab.execute("id", { id: 2 }, undefined)).rejects.toThrow("declined")
    expect(update).not.toHaveBeenCalled()
    expect(enablePage).not.toHaveBeenCalled()
    confirm.mockResolvedValue(true)
    await expect(switchTab.execute("id", { id: 2 }, undefined)).resolves.toMatchObject({
      details: { id: 2, active: true, mutationOutcome: "dispatched" },
    })
    expect(confirm).toHaveBeenCalledWith(expect.any(String), { targetUrl: web.url }, undefined, {
      operation: "tabs.switch",
      identity: ["2", web.url],
      permissionUrl: web.url,
    })
    expect(update).toHaveBeenCalledWith(2, { active: true })
    expect(enablePage).toHaveBeenCalledOnce()
    expect(query).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true })
    expect(query).toHaveBeenCalledWith({ windowId: 1 })
    expect(query).not.toHaveBeenCalledWith({ currentWindow: true })
  })

  test("requires confirmation and a safe URL before opening a website", async () => {
    const { create } = tabBrowser([activeTab])
    const confirm = vi.fn().mockResolvedValue(false)
    const enablePage = vi.fn()
    const tool = createBrowserTools(confirm, () => false, enablePage).find(
      (item) => item.name === "browser_open_website",
    )
    if (!tool) throw new Error("Missing website tool")
    for (const url of [
      "chrome://settings/",
      "file:///private",
      "https://user:pass@example.test/",
    ]) {
      await expect(tool.execute("id", { url }, undefined)).rejects.toThrow()
    }
    expect(confirm).not.toHaveBeenCalled()
    await expect(tool.execute("id", { url: "https://example.test/" }, undefined)).rejects.toThrow(
      "declined",
    )
    expect(create).not.toHaveBeenCalled()
    confirm.mockResolvedValue(true)
    await expect(
      tool.execute("id", { url: "https://example.test/" }, undefined),
    ).resolves.toMatchObject({ details: { id: 4, opened: true, mutationOutcome: "dispatched" } })
    expect(create).toHaveBeenCalledWith({ url: "https://example.test/", active: true, windowId: 1 })
    expect(enablePage).toHaveBeenCalledOnce()
  })

  test.each([
    [
      { contextState: "missing", tabContext: null, page: { kind: "none" } },
      "TAB_NOT_BOUND",
      "missing",
    ],
    [{ contextState: "unsupported_url", tabContext: null }, "UNSUPPORTED_URL", "unsupported_url"],
    [
      { contextState: "permission_denied", tabContext: null, page: { kind: "restricted" } },
      "PERMISSION_DENIED",
      "permission_denied",
    ],
    [{ tabContext: null, page: { kind: "restricted" } }, "UNSUPPORTED_URL", "unsupported_url"],
    [{ tabContext: null, page: { kind: "pdf" } }, "UNSUPPORTED_URL", "unsupported_url"],
    [{ tabContext: null, page: { kind: "file" } }, "UNSUPPORTED_URL", "unsupported_url"],
    [
      { tabContext: { tabId: 1, url: "chrome://settings/", epoch: 0 } },
      "UNSUPPORTED_URL",
      "unsupported_url",
    ],
  ])("reports unavailable context accurately for %j", async (workerState, code, contextState) => {
    const { state, sendMessage } = tabBrowser([activeTab])
    state.workerState = workerState
    const read = browserTool("browser_read_page")
    await expect(read.execute("safe-call-id", {}, undefined)).rejects.toMatchObject({
      code,
      details: {
        requestId: "safe-call-id",
        toolName: "browser_read_page",
        contextState,
        targetResolutionSource: "app.getState",
        actionStage: "target_resolution",
      },
    })
    expect(sendMessage).toHaveBeenCalledOnce()
    await expect(read.execute("safe-call-id", {}, undefined)).rejects.not.toThrow(
      "Open an HTTP or HTTPS page",
    )
  })

  test("reports disabled context separately without worker access", async () => {
    const { sendMessage } = tabBrowser([activeTab])
    await expect(
      browserTool("browser_read_page", vi.fn(), () => false).execute("call", {}, undefined),
    ).rejects.toMatchObject({
      code: "PAGE_CONTEXT_DISABLED",
      details: {
        requestId: "call",
        toolName: "browser_read_page",
        contextState: "disabled",
        targetResolutionSource: "turn_policy",
        actionStage: "validation",
      },
    })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  test.each(["browser_list_tabs", "browser_switch_tab", "browser_open_website"])(
    "%s does not fall back when the last-focused window is not focused",
    async (name) => {
      const { state, create, update } = tabBrowser([activeTab, targetTab])
      state.focusedWindowId = 9
      const confirm = vi.fn(async () => true)
      await expect(
        browserTool(name, confirm).execute("call", { id: 2, url: targetTab.url }, undefined),
      ).rejects.toMatchObject({
        code: "STALE_CONTEXT",
        details: { targetResolutionSource: "focused_visible_tab" },
      })
      expect(confirm).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
      expect(update).not.toHaveBeenCalled()
    },
  )

  test.each(["browser_switch_tab", "browser_open_website"])(
    "%s rejects a focused-window change during confirmation",
    async (name) => {
      const { state, create, update } = tabBrowser([activeTab, targetTab])
      const confirm = vi.fn(async () => {
        state.active = { ...activeTab, windowId: 7 }
        state.focusedWindowId = 7
        return true
      })
      await expect(
        browserTool(name, confirm).execute("call", { id: 2, url: targetTab.url }, undefined),
      ).rejects.toMatchObject({ code: "STALE_CONTEXT", details: { actionStage: "confirmation" } })
      expect(create).not.toHaveBeenCalled()
      expect(update).not.toHaveBeenCalled()
    },
  )

  test.each(["browser_switch_tab", "browser_open_website"])(
    "%s rejects an active-tab change during confirmation",
    async (name) => {
      const { state, create, update } = tabBrowser([activeTab, targetTab])
      const confirm = vi.fn(async () => {
        state.active = targetTab
        return true
      })
      await expect(
        browserTool(name, confirm).execute("call", { id: 2, url: targetTab.url }, undefined),
      ).rejects.toMatchObject({ code: "STALE_CONTEXT" })
      expect(create).not.toHaveBeenCalled()
      expect(update).not.toHaveBeenCalled()
    },
  )

  test.each(["url", "windowId", "closed"])(
    "switch rejects target %s changes during confirmation",
    async (change) => {
      const { tabs, update } = tabBrowser([activeTab, targetTab])
      const confirm = vi.fn(async () => {
        if (change === "closed") tabs.delete(2)
        else
          tabs.set(2, {
            ...targetTab,
            ...(change === "url" ? { url: "https://changed.test/" } : { windowId: 9 }),
          })
        return true
      })
      await expect(
        browserTool("browser_switch_tab", confirm).execute("call", { id: 2 }, undefined),
      ).rejects.toMatchObject({ code: change === "closed" ? "TAB_NOT_FOUND" : "STALE_CONTEXT" })
      expect(update).not.toHaveBeenCalled()
    },
  )

  test.each(["browser_switch_tab", "browser_open_website"])(
    "%s cancels before dispatch when confirmation loses focus",
    async (name) => {
      const { state, create, update } = tabBrowser([activeTab, targetTab])
      const confirm = vi.fn(async () => {
        state.focusedWindowId = 9
        return true
      })
      await expect(
        browserTool(name, confirm).execute("call", { id: 2, url: targetTab.url }, undefined),
      ).rejects.toMatchObject({
        code: "STALE_CONTEXT",
        details: { mutationOutcome: "not_dispatched" },
      })
      expect(create).not.toHaveBeenCalled()
      expect(update).not.toHaveBeenCalled()
    },
  )

  test.each(["browser_switch_tab", "browser_open_website"])(
    "%s does not run after confirmation cancellation",
    async (name) => {
      const { create, update } = tabBrowser([activeTab, targetTab])
      const controller = new AbortController()
      const confirm = vi.fn(async () => {
        controller.abort()
        return true
      })
      await expect(
        browserTool(name, confirm).execute(
          "call",
          { id: 2, url: targetTab.url },
          controller.signal,
        ),
      ).rejects.toMatchObject({
        code: "REQUEST_CANCELLED",
        details: { mutationOutcome: "not_dispatched" },
      })
      expect(create).not.toHaveBeenCalled()
      expect(update).not.toHaveBeenCalled()
    },
  )

  test.each(["browser_switch_tab", "browser_open_website"])(
    "%s checks cancellation after the final asynchronous focus check",
    async (name) => {
      const { query, create, update } = tabBrowser([activeTab, targetTab])
      const controller = new AbortController()
      const originalQuery = query.getMockImplementation()
      if (!originalQuery) throw new Error("Missing query")
      let activeQueries = 0
      query.mockImplementation(async (options) => {
        const result = await originalQuery(options)
        if (options.active && ++activeQueries === 4) controller.abort()
        return result
      })
      await expect(
        browserTool(name).execute("call", { id: 2, url: targetTab.url }, controller.signal),
      ).rejects.toMatchObject({
        code: "REQUEST_CANCELLED",
        details: { mutationOutcome: "not_dispatched" },
      })
      expect(create).not.toHaveBeenCalled()
      expect(update).not.toHaveBeenCalled()
    },
  )

  test("cancellation after a completed switch does not claim that no action ran", async () => {
    const { update } = tabBrowser([activeTab, targetTab])
    const originalUpdate = update.getMockImplementation()
    if (!originalUpdate) throw new Error("Missing update")
    const controller = new AbortController()
    update.mockImplementationOnce(async (id) => {
      const result = await originalUpdate(id)
      controller.abort()
      return result
    })
    await expect(
      browserTool("browser_switch_tab").execute("call", { id: 2 }, controller.signal),
    ).rejects.toMatchObject({
      details: {
        mutationOutcome: "dispatched",
        actionStage: "completed",
        toolName: "browser_switch_tab",
        requestId: "call",
      },
    })
    expect(update).toHaveBeenCalledOnce()
  })

  test("switch rejects a tab in another window before confirmation", async () => {
    tabBrowser([activeTab, { ...targetTab, windowId: 9 }])
    const confirm = vi.fn(async () => true)
    await expect(
      browserTool("browser_switch_tab", confirm).execute("call", { id: 2 }, undefined),
    ).rejects.toMatchObject({ code: "STALE_CONTEXT" })
    expect(confirm).not.toHaveBeenCalled()
  })

  test.each(["browser_switch_tab", "browser_open_website"])(
    "%s makes the intended target ready for the next read",
    async (name) => {
      const { sendMessage, create, update } = tabBrowser([activeTab, targetTab])
      let enabled = false
      const tools = createBrowserTools(
        vi.fn(async () => true),
        () => enabled,
        () => {
          enabled = true
        },
      )
      await tools
        .find((tool) => tool.name === name)
        ?.execute("call", { id: 2, url: targetTab.url }, undefined)
      await expect(
        tools.find((tool) => tool.name === "browser_read_page")?.execute("read", {}, undefined),
      ).resolves.toMatchObject({ details: { text: "Intended page" } })
      expect(sendMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          method: "page.getVisibleText",
          tabContext: {
            tabId: name === "browser_switch_tab" ? 2 : 4,
            url: targetTab.url,
            epoch: 1,
          },
        }),
      )
      expect(name === "browser_switch_tab" ? update : create).toHaveBeenCalledOnce()
    },
  )

  test("an unavailable turn can read its approved pending tab after commit without reopening", async () => {
    const { state, tabs, create, sendMessage } = tabBrowser([activeTab])
    create.mockImplementationOnce(async (options) => {
      const pending = {
        id: 4,
        windowId: 1,
        active: true,
        url: "about:blank",
        pendingUrl: options.url,
      } as chrome.tabs.Tab
      tabs.set(4, pending)
      state.active = pending
      return pending
    })
    let enabled = false
    const tools = createBrowserTools(
      vi.fn(async () => true),
      () => enabled,
      () => {
        enabled = true
      },
    )
    await expect(
      tools
        .find((tool) => tool.name === "browser_open_website")
        ?.execute("open", { url: targetTab.url }, undefined),
    ).rejects.toMatchObject({ details: { mutationOutcome: "dispatched" } })
    expect(enabled).toBe(true)
    await expect(
      tools.find((tool) => tool.name === "browser_read_page")?.execute("early-read", {}, undefined),
    ).rejects.toMatchObject({ code: "STALE_CONTEXT" })
    expect(sendMessage).not.toHaveBeenCalled()
    const committed = {
      ...tabs.get(4),
      url: targetTab.url,
      pendingUrl: undefined,
      status: "complete",
    } as chrome.tabs.Tab
    tabs.set(4, committed)
    state.active = committed
    await expect(
      tools.find((tool) => tool.name === "browser_read_page")?.execute("read", {}, undefined),
    ).resolves.toMatchObject({ details: { text: "Intended page" } })
    expect(create).toHaveBeenCalledOnce()
  })

  test.each(["browser_switch_tab", "browser_open_website"])(
    "%s does not read an old worker target or repeat a completed tab action",
    async (name) => {
      const { state, sendMessage, update, create } = tabBrowser([activeTab, targetTab])
      state.workerState = {
        tabContext: { tabId: 1, url: activeTab.url, epoch: 0 },
        contextState: "available",
      }
      const tools = createBrowserTools(vi.fn(async () => true))
      await expect(
        tools
          .find((tool) => tool.name === name)
          ?.execute("call", { id: 2, url: targetTab.url }, undefined),
      ).rejects.toThrow("tab action completed, but the intended page context is not ready")
      await expect(
        tools.find((tool) => tool.name === "browser_read_page")?.execute("read", {}, undefined),
      ).rejects.toThrow("No other page was used")
      expect(sendMessage.mock.calls.every(([message]) => message.method === "app.getState")).toBe(
        true,
      )
      expect(name === "browser_switch_tab" ? update : create).toHaveBeenCalledOnce()
    },
  )

  test("does not accept worker state from a different window after a switch", async () => {
    const { state, update } = tabBrowser([activeTab, targetTab])
    state.workerState = {
      tabContext: { tabId: 2, url: targetTab.url, epoch: 1 },
      contextState: "available",
      windowId: 9,
    }
    const enablePage = vi.fn()
    await expect(
      browserTool(
        "browser_switch_tab",
        vi.fn(async () => true),
        () => false,
        enablePage,
      ).execute("call", { id: 2 }, undefined),
    ).rejects.toMatchObject({ code: "STALE_CONTEXT", details: { mutationOutcome: "dispatched" } })
    expect(update).toHaveBeenCalledOnce()
    expect(enablePage).toHaveBeenCalledOnce()
  })

  test("a closed selected tab reports TAB_NOT_FOUND before a page read", async () => {
    const { tabs, sendMessage } = tabBrowser([activeTab, targetTab])
    const tools = createBrowserTools(vi.fn(async () => true))
    await tools
      .find((tool) => tool.name === "browser_switch_tab")
      ?.execute("switch", { id: 2 }, undefined)
    sendMessage.mockClear()
    tabs.delete(2)
    await expect(
      tools.find((tool) => tool.name === "browser_read_page")?.execute("read", {}, undefined),
    ).rejects.toMatchObject({ code: "TAB_NOT_FOUND" })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  test("does not read an unrelated target after a successful switch", async () => {
    const { state, sendMessage } = tabBrowser([activeTab, targetTab])
    const tools = createBrowserTools(vi.fn(async () => true))
    await tools
      .find((tool) => tool.name === "browser_switch_tab")
      ?.execute("switch", { id: 2 }, undefined)
    state.active = activeTab
    sendMessage.mockClear()
    await expect(
      tools.find((tool) => tool.name === "browser_read_page")?.execute("read", {}, undefined),
    ).rejects.toMatchObject({ code: "STALE_CONTEXT" })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  test.each(["missing", "unsupported_url", "permission_denied"])(
    "open reports completed action but %s context without reading another page",
    async (contextState) => {
      const { state, create } = tabBrowser([activeTab])
      state.workerState = { tabContext: null, contextState }
      const enablePage = vi.fn()
      await expect(
        browserTool(
          "browser_open_website",
          vi.fn(async () => true),
          () => false,
          enablePage,
        ).execute("call", { url: targetTab.url }, undefined),
      ).rejects.toThrow("tab action completed, but the intended page context is not ready")
      expect(create).toHaveBeenCalledOnce()
      expect(enablePage).toHaveBeenCalledOnce()
    },
  )

  test("unknown open outcome blocks unrelated page reads and exposes no raw Chrome error", async () => {
    const { create, sendMessage } = tabBrowser([activeTab])
    create.mockRejectedValueOnce(new Error("https://secret.test/?token=secret page text"))
    const tools = createBrowserTools(vi.fn(async () => true))
    const action = tools
      .find((tool) => tool.name === "browser_open_website")
      ?.execute("call", { url: targetTab.url }, undefined)
    await expect(action).rejects.toMatchObject({
      code: "ACTION_OUTCOME_UNKNOWN",
      details: { requestId: "call", toolName: "browser_open_website", actionStage: "dispatch" },
    })
    await expect(action).rejects.not.toThrow("secret")
    await expect(
      tools.find((tool) => tool.name === "browser_read_page")?.execute("read", {}, undefined),
    ).rejects.toMatchObject({ code: "ACTION_OUTCOME_UNKNOWN" })
    expect(sendMessage).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledOnce()
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
      expect.objectContaining({ requiredPermission: SCREENSHOT_HOST_PERMISSION }),
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
          : "Call this page-provided WebMCP tool? It may have side effects, even when called again with identical arguments.",
        action === "list"
          ? { action, name: "", pageUrl: tabContext.url }
          : { action, name: "lookup", pageUrl: tabContext.url, arguments: { id: 1 } },
        controller.signal,
        {
          operation: action === "list" ? "webmcp.listTools" : "webmcp.callTool",
          identity: action === "list" ? [tabContext.url] : [tabContext.url, "lookup", '{"id":1}'],
          permissionUrl: tabContext.url,
        },
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

  test("forwards scoped page reads using the current bound tab", async () => {
    const tabContext = { tabId: 1, url: "https://example.test/", epoch: 0 }
    const sendMessage = vi.fn(async (message: { method: string }) =>
      message.method === "app.getState"
        ? { ok: true, result: { tabContext } }
        : { ok: true, result: { text: "Article text", offset: 10, truncated: false } },
    )
    vi.stubGlobal("chrome", { runtime: { sendMessage } })
    const tool = createBrowserTools(vi.fn()).find((item) => item.name === "browser_read_page")
    if (!tool) throw new Error("Missing page read tool")
    const result = await tool.execute("id", { selector: "article", offset: 10 }, undefined)
    expect(sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: "page.getVisibleText",
        params: { selector: "article", offset: 10 },
        tabContext,
      }),
    )
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("Untrusted browser page content"),
    })
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
      expect.objectContaining({ requiredPermission: "bookmarks" }),
      undefined,
      {
        operation: "bookmarks.search",
        identity: ['{"limit":20,"query":"docs"}'],
        bookmarkPermission: true,
      },
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
