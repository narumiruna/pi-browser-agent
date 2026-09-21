// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { RuntimeResponse } from "../../src/browser/runtime/messages.js"
import type { JsonObject, TabContext } from "../../src/browser/runtime/types.js"

type Listener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  respond: (value: RuntimeResponse) => void,
) => boolean
let listener: Listener
let updated: (id: number, change: object) => void
let activated: () => void
let permission: boolean
let tab: { id: number; url: string; active: boolean; windowId: number }
let context: TabContext
let beforeInjection: (() => Promise<void>) | undefined
let injectionCount: number

function send(
  method: string,
  params: JsonObject = {},
  options: Record<string, unknown> = {},
): Promise<RuntimeResponse> {
  return new Promise((resolve) =>
    listener(
      {
        kind: "request",
        requestId: crypto.randomUUID(),
        method,
        params,
        tabContext: context,
        ...options,
      },
      {},
      resolve,
    ),
  )
}
async function state() {
  const value = await send("app.getState", {}, { tabContext: undefined })
  if (!value.ok) throw new Error(value.error.message)
  context = (value.result as { tabContext: TabContext }).tabContext
}
async function discover(): Promise<{ snapshotId: string; ref: string }> {
  const value = await send("page.listElements")
  if (!value.ok) throw new Error(value.error.message)
  const result = value.result as { snapshotId: string; elements: Array<{ ref: string }> }
  return { snapshotId: result.snapshotId, ref: result.elements[0]?.ref ?? "" }
}

beforeEach(async () => {
  vi.resetModules()
  permission = true
  injectionCount = 0
  beforeInjection = undefined
  tab = { id: 1, url: location.href, active: true, windowId: 1 }
  document.body.innerHTML = '<button type="button">Go</button><input aria-label="Title">'
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: undefined })
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: 20,
    bottom: 20,
    width: 20,
    height: 20,
  } as DOMRect)
  const noopEvent = { addListener: vi.fn() }
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        setAccessLevel: vi.fn(async () => {}),
        get: vi.fn(async () => ({
          piChromeApprovedHostPermissions: [`${location.protocol}//${location.hostname}/*`],
        })),
      },
    },
    permissions: {
      contains: vi.fn(async () => permission),
      getAll: vi.fn(async () => ({ origins: [] })),
    },
    runtime: {
      id: "extension",
      onInstalled: noopEvent,
      onMessage: {
        addListener: (value: Listener) => {
          listener = value
        },
      },
      sendMessage: (message: { kind?: string }) =>
        new Promise((resolve) => {
          if (message.kind === "event") {
            resolve(undefined)
            return
          }
          listener(message, { id: "extension", tab } as chrome.runtime.MessageSender, resolve)
        }),
    },
    tabs: {
      query: vi.fn(async () => [tab]),
      get: vi.fn(async () => tab),
      update: vi.fn(async (_id: number, value: { url: string }) => {
        tab.url = value.url
        return tab
      }),
      onActivated: {
        addListener: (value: () => void) => {
          activated = value
        },
      },
      onUpdated: {
        addListener: (value: typeof updated) => {
          updated = value
        },
      },
      onRemoved: noopEvent,
    },
    windows: {
      WINDOW_ID_NONE: -1,
      get: vi.fn(async () => ({ focused: true })),
      onFocusChanged: noopEvent,
    },
    contextMenus: { onClicked: noopEvent },
    scripting: {
      executeScript: vi.fn(
        async ({ func, args }: { func: (...args: unknown[]) => unknown; args: unknown[] }) => {
          injectionCount++
          const hook = beforeInjection
          beforeInjection = undefined
          await hook?.()
          return [{ result: await func(...args) }]
        },
      ),
    },
  })
  await import("../../src/browser/service-worker.js")
  await state()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe("worker element reference lifecycle", () => {
  test("discovers, types and clicks through the real injected operation", async () => {
    const target = await discover()
    expect(await send("page.type", { ...target, ref: "e2", text: "Hello" })).toMatchObject({
      ok: true,
    })
    expect((document.querySelector("input") as HTMLInputElement).value).toBe("Hello")
    const clicked = vi
      .spyOn(document.querySelector("button") as HTMLButtonElement, "click")
      .mockImplementation(() => {})
    expect(await send("page.click", target)).toMatchObject({ ok: true })
    expect(clicked).toHaveBeenCalledOnce()
  })

  test.each(["replacement", "reload", "tab", "expiry", "restart"])(
    "rejects a reference after %s without injection",
    async (reason) => {
      const target = await discover()
      if (reason === "replacement") await discover()
      if (reason === "reload") {
        updated(tab.id, { status: "loading" })
        await state()
      }
      if (reason === "tab") {
        tab = { ...tab, id: 2 }
        activated()
        await state()
      }
      if (reason === "expiry") vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300_001)
      if (reason === "restart") {
        vi.resetModules()
        await import("../../src/browser/service-worker.js")
        await state()
      }
      const count = injectionCount
      expect(await send("page.click", target)).toMatchObject({
        ok: false,
        error: { code: "STALE_CONTEXT" },
      })
      expect(injectionCount).toBe(count)
    },
  )

  test("rejects missing or revoked host permission", async () => {
    const target = await discover()
    permission = false
    const count = injectionCount
    expect(await send("page.click", target)).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    })
    expect(await send("page.listElements")).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    })
    expect(injectionCount).toBe(count)
  })

  test("rechecks permission and cancellation before the injected mutation", async () => {
    const target = await discover()
    const clicked = vi
      .spyOn(document.querySelector("button") as HTMLButtonElement, "click")
      .mockImplementation(() => {})
    beforeInjection = async () => {
      permission = false
    }
    expect(await send("page.click", target)).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    })
    permission = true
    beforeInjection = async () => {
      await send("requests.cancel", { requestId: "cancel-me" })
    }
    expect(await send("page.click", target, { requestId: "cancel-me" })).toMatchObject({
      ok: false,
      error: { code: "REQUEST_CANCELLED" },
    })
    expect(clicked).not.toHaveBeenCalled()
  })

  test("does not execute a submit before confirmation or after its target changes", async () => {
    document.body.innerHTML = "<form><button>Submit</button></form>"
    const target = await discover()
    const node = document.querySelector("button") as HTMLButtonElement
    const clicked = vi.spyOn(node, "click").mockImplementation(() => {})
    expect(await send("page.click", target)).toMatchObject({
      ok: false,
      error: { code: "CONFIRMATION_REQUIRED" },
    })
    expect(clicked).not.toHaveBeenCalled()
    node.textContent = "Changed while confirming"
    expect(await send("page.click", target, { confirmed: true })).toMatchObject({
      ok: false,
      error: { code: "STALE_CONTEXT" },
    })
    expect(clicked).not.toHaveBeenCalled()
  })

  test("rejects changed cross-origin destinations during confirmation", async () => {
    document.body.innerHTML = '<a href="https://destination.test/one">Go</a>'
    const target = await discover()
    expect(await send("page.click", target)).toMatchObject({
      ok: false,
      error: { code: "CONFIRMATION_REQUIRED" },
    })
    document.querySelector("a")?.setAttribute("href", "https://other.test/two")
    expect(await send("page.click", target, { confirmed: true })).toMatchObject({
      ok: false,
      error: { code: "STALE_CONTEXT" },
    })
    expect(chrome.tabs.update).not.toHaveBeenCalled()
  })
})
