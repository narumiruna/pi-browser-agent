import { afterEach, describe, expect, test, vi } from "vitest"

interface ListenerMap {
  installed?: () => void
  contextClicked?: (
    info: { menuItemId: string; selectionText?: string },
    tab?: { id?: number; url?: string; windowId?: number },
  ) => void
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

describe("service worker context menus", () => {
  test("binds the invoked tab, opens the panel, and persists a selection", async () => {
    const listeners: ListenerMap = {}
    const session: Record<string, unknown> = { piChromeBoundTabId: 1 }
    const create = vi.fn()
    const open = vi.fn(async () => undefined)
    let releaseRestore: (() => void) | undefined
    const restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve
    })
    const getTab = vi.fn(async (tabId: number) => {
      if (tabId === 1) await restoreGate
      return {
        id: tabId,
        url: tabId === 1 ? "https://old.test/page" : "https://example.test/page",
        windowId: 3,
      }
    })
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
        sendMessage: vi.fn(async () => {
          throw new Error("No Side Panel receiver")
        }),
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
      sidePanel: { setPanelBehavior: vi.fn(async () => undefined), open },
      tabs: {
        get: getTab,
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
      },
    })
    await import("../../src/browser/service-worker.js")
    await vi.waitFor(() => expect(getTab).toHaveBeenCalledWith(1))

    listeners.installed?.()
    listeners.contextClicked?.(
      { menuItemId: "pi-chrome-send-selection", selectionText: "selected text" },
      { id: 7, url: "https://example.test/page", windowId: 3 },
    )

    expect(open).toHaveBeenCalledWith({ windowId: 3 })
    expect(session.piChromeBoundTabId).toBe(1)
    releaseRestore?.()
    await vi.waitFor(() => {
      expect(session.piChromeBoundTabId).toBe(7)
      expect(session["piChromePendingSelection:3"]).toMatchObject({
        windowId: 3,
        payload: { text: "selected text", untrusted: true },
        tabContext: { tabId: 7, url: "https://example.test/page" },
      })
    })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ id: "pi-chrome-bind-tab", contexts: ["page"] }),
    )

    const takeSelection = (requestId: string, windowId: number): Promise<unknown> =>
      new Promise((resolve) => {
        const accepted = listeners.runtimeMessage?.(
          {
            kind: "request",
            requestId,
            method: "selection.takePending",
            params: { windowId },
          },
          {},
          resolve,
        )
        expect(accepted).toBe(true)
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
