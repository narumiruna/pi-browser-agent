import { afterEach, describe, expect, test, vi } from "vitest"

interface TestTab {
  id?: number
  url?: string
  windowId?: number
}

interface ListenerMap {
  installed?: () => void
  activated?: (activeInfo: { tabId: number; windowId: number }) => void
  focusChanged?: (windowId: number) => void
  contextClicked?: (info: { menuItemId: string; selectionText?: string }, tab?: TestTab) => void
  runtimeMessage?: (
    message: unknown,
    sender: unknown,
    sendResponse: (response: unknown) => void,
  ) => boolean
}

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe("service worker visible-tab targeting", () => {
  test("tracks the visible page, rejects stale contexts, and persists a sent selection", async () => {
    const listeners: ListenerMap = {}
    const session: Record<string, unknown> = {}
    const create = vi.fn()
    const open = vi.fn(async () => undefined)
    const sendMessage = vi.fn(async () => {
      throw new Error("No Side Panel receiver")
    })
    const executeScript = vi.fn()
    let activeTab: TestTab = { id: 1, url: "https://old.test/page", windowId: 3 }
    let failPendingRead = false

    vi.stubGlobal("chrome", {
      storage: {
        local: { setAccessLevel: vi.fn(async () => undefined) },
        session: {
          get: vi.fn(async (key: string) => {
            if (key === "piChromePendingSelection:3" && failPendingRead) {
              failPendingRead = false
              throw new Error("Temporary session storage failure")
            }
            return { [key]: session[key] }
          }),
          set: vi.fn(async (items: Record<string, unknown>) => Object.assign(session, items)),
          remove: vi.fn(async (key: string) => {
            delete session[key]
          }),
        },
      },
      runtime: {
        onInstalled: {
          addListener: vi.fn((listener: () => void) => (listeners.installed = listener)),
        },
        onMessage: {
          addListener: vi.fn(
            (listener: NonNullable<ListenerMap["runtimeMessage"]>) =>
              (listeners.runtimeMessage = listener),
          ),
        },
        sendMessage,
      },
      contextMenus: {
        removeAll: vi.fn((callback: () => void) => callback()),
        create,
        onClicked: {
          addListener: vi.fn(
            (listener: NonNullable<ListenerMap["contextClicked"]>) =>
              (listeners.contextClicked = listener),
          ),
        },
      },
      scripting: { executeScript },
      sidePanel: { setPanelBehavior: vi.fn(async () => undefined), open },
      tabs: {
        query: vi.fn(async () => [activeTab]),
        get: vi.fn(async () => activeTab),
        onActivated: {
          addListener: vi.fn(
            (listener: NonNullable<ListenerMap["activated"]>) => (listeners.activated = listener),
          ),
        },
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
      },
      windows: {
        WINDOW_ID_NONE: -1,
        onFocusChanged: {
          addListener: vi.fn(
            (listener: NonNullable<ListenerMap["focusChanged"]>) =>
              (listeners.focusChanged = listener),
          ),
        },
      },
    })
    await import("../../src/browser/service-worker.js")

    const request = (message: Record<string, unknown>): Promise<unknown> =>
      new Promise((resolve) => {
        const accepted = listeners.runtimeMessage?.(message, {}, resolve)
        expect(accepted).toBe(true)
      })
    const appState = (requestId: string): Promise<unknown> =>
      request({ kind: "request", requestId, method: "app.getState", params: {} })

    await expect(appState("initial-state")).resolves.toMatchObject({
      ok: true,
      result: { tabContext: { tabId: 1, url: "https://old.test/page" } },
    })

    activeTab = { id: 7, url: "https://example.test/page", windowId: 3 }
    listeners.activated?.({ tabId: 7, windowId: 3 })
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "tab.changed",
          tabContext: expect.objectContaining({ tabId: 7 }),
        }),
      ),
    )

    await expect(
      request({
        kind: "request",
        requestId: "stale-page-read",
        method: "page.getVisibleText",
        params: {},
        tabContext: { tabId: 1, url: "https://old.test/page", epoch: 0 },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "STALE_CONTEXT" } })
    expect(executeScript).not.toHaveBeenCalled()

    activeTab = { id: 8, url: "chrome://settings", windowId: 3 }
    listeners.focusChanged?.(3)
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ name: "tab.changed", tabContext: undefined }),
      ),
    )
    await expect(appState("unsupported-state")).resolves.toEqual({
      ok: true,
      result: { tabContext: null },
    })

    activeTab = { id: 7, url: "https://example.test/page", windowId: 3 }
    listeners.contextClicked?.(
      { menuItemId: "pi-chrome-send-selection", selectionText: "selected text" },
      activeTab,
    )
    expect(open).toHaveBeenCalledWith({ windowId: 3 })
    await vi.waitFor(() => {
      expect(session["piChromePendingSelection:3"]).toMatchObject({
        windowId: 3,
        payload: { text: "selected text", untrusted: true },
        tabContext: { tabId: 7, url: "https://example.test/page" },
      })
    })

    listeners.installed?.()
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ id: "pi-chrome-send-selection", contexts: ["selection"] }),
    )

    const takeSelection = (requestId: string, windowId: number): Promise<unknown> =>
      request({
        kind: "request",
        requestId,
        method: "selection.takePending",
        params: { windowId },
      })

    await expect(takeSelection("wrong-window", 4)).resolves.toEqual({ ok: true, result: null })
    expect(session["piChromePendingSelection:3"]).toBeDefined()
    failPendingRead = true
    await expect(takeSelection("first-take", 3)).resolves.toMatchObject({ ok: false })
    await expect(takeSelection("second-take", 3)).resolves.toMatchObject({
      ok: true,
      result: { payload: { text: "selected text" } },
    })
    expect(session["piChromePendingSelection:3"]).toBeUndefined()
  })
})
