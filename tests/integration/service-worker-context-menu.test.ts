import { afterEach, describe, expect, test, vi } from "vitest"

interface ListenerMap {
  installed?: () => void
  contextClicked?: (
    info: { menuItemId: string; selectionText?: string },
    tab?: { id?: number; url?: string; windowId?: number },
  ) => void
}

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe("service worker context menus", () => {
  test("binds the invoked tab, opens the panel, and persists a selection", async () => {
    const listeners: ListenerMap = {}
    const session: Record<string, unknown> = {}
    const create = vi.fn()
    const open = vi.fn(async () => undefined)
    vi.stubGlobal("chrome", {
      storage: {
        local: { setAccessLevel: vi.fn(async () => undefined) },
        session: {
          get: vi.fn(async (key: string) => ({ [key]: session[key] })),
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
        onMessage: { addListener: vi.fn() },
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
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
      },
    })
    await import("../../src/browser/service-worker.js")

    listeners.installed?.()
    listeners.contextClicked?.(
      { menuItemId: "pi-chrome-send-selection", selectionText: "selected text" },
      { id: 7, url: "https://example.test/page", windowId: 3 },
    )

    await vi.waitFor(() => {
      expect(session.piChromeBoundTabId).toBe(7)
      expect(session.piChromePendingSelection).toMatchObject({
        payload: { text: "selected text", untrusted: true },
        tabContext: { tabId: 7, url: "https://example.test/page" },
      })
    })
    expect(open).toHaveBeenCalledWith({ windowId: 3 })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ id: "pi-chrome-bind-tab", contexts: ["page"] }),
    )
  })
})
