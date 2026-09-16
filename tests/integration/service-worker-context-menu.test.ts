import { afterEach, describe, expect, test, vi } from "vitest"

interface TestTab {
  id?: number
  url?: string
  windowId?: number
}

interface ListenerMap {
  installed?: () => void
  activated?: (activeInfo: { tabId: number; windowId: number }) => void
  updated?: (tabId: number, changeInfo: { status?: string; url?: string }, tab: TestTab) => void
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
    const updateTab = vi.fn(async () => activeTab)
    let permissionCheck: Promise<boolean> | undefined
    const contains = vi.fn(async () => permissionCheck ?? true)
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
      permissions: { contains },
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
        update: updateTab,
        onActivated: {
          addListener: vi.fn(
            (listener: NonNullable<ListenerMap["activated"]>) => (listeners.activated = listener),
          ),
        },
        onUpdated: {
          addListener: vi.fn(
            (listener: NonNullable<ListenerMap["updated"]>) => (listeners.updated = listener),
          ),
        },
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

    activeTab = { id: 8, url: "https://recovered.test/page", windowId: 3 }
    listeners.updated?.(8, { status: "loading", url: activeTab.url }, activeTab)
    await vi.waitFor(async () => {
      await expect(appState("recovered-state")).resolves.toMatchObject({
        ok: true,
        result: { tabContext: { tabId: 8, url: "https://recovered.test/page" } },
      })
    })

    activeTab = { id: 8, url: "chrome://settings", windowId: 3 }
    listeners.updated?.(8, { url: activeTab.url }, activeTab)
    await vi.waitFor(async () => {
      await expect(appState("unsupported-update-state")).resolves.toEqual({
        ok: true,
        result: { tabContext: null },
      })
    })

    activeTab = { id: 7, url: "https://example.test/page", windowId: 3 }
    listeners.activated?.({ tabId: 7, windowId: 3 })
    const currentResponse = await vi.waitFor(async () => {
      const response = (await appState("current-before-navigation")) as {
        result?: { tabContext?: { tabId: number; url: string; epoch: number } }
      }
      expect(response.result?.tabContext?.tabId).toBe(7)
      return response
    })
    let releasePermission: ((value: boolean) => void) | undefined
    permissionCheck = new Promise<boolean>((resolve) => {
      releasePermission = resolve
    })
    const navigation = request({
      kind: "request",
      requestId: "in-flight-navigation",
      method: "tabs.navigate",
      params: { url: "https://destination.test/page" },
      confirmed: true,
      tabContext: currentResponse.result?.tabContext,
    })
    await vi.waitFor(() => expect(contains).toHaveBeenCalled())
    activeTab = { id: 9, url: "https://other.test/page", windowId: 3 }
    listeners.activated?.({ tabId: 9, windowId: 3 })
    releasePermission?.(true)
    await expect(navigation).resolves.toMatchObject({
      ok: false,
      error: { code: "STALE_CONTEXT" },
    })
    expect(updateTab).not.toHaveBeenCalled()
    permissionCheck = undefined

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
