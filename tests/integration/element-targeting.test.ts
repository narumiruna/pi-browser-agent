// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, type Mock, test, vi } from "vitest"
import {
  ELEMENT_PICKER_LIMITS,
  type SelectedElementContext,
} from "../../src/browser/runtime/element-context.js"
import type { RuntimeResponse } from "../../src/browser/runtime/messages.js"
import type { JsonObject, TabContext } from "../../src/browser/runtime/types.js"
import { mockElementPickerSurface } from "../helpers/element-picker-surface.js"

type Listener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  respond: (value: RuntimeResponse) => void,
) => boolean
let listener: Listener
let executeScript: Mock<
  (injection: {
    func: (...args: unknown[]) => unknown
    args?: unknown[]
  }) => Promise<Array<{ result: unknown }>>
>
let updated: (id: number, change: object) => void
let activated: () => void
let focusChanged: (windowId: number) => void
let permissionRemoved: () => void
let panelConnected: (port: chrome.runtime.Port) => void
let permission: boolean
let tab: { id: number; url: string; active: boolean; windowId: number }
let context: TabContext
let beforeInjection: (() => Promise<void>) | undefined
let afterInjection: (() => Promise<void>) | undefined
let injectionCount: number
let emittedEvents: Array<{ name?: string; payload?: unknown }>
let restoreSurface: () => void

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
function startPickerRequest(): Promise<RuntimeResponse> {
  return send("elementPicker.start", { clientId: crypto.randomUUID() })
}
function selectedElement(): SelectedElementContext {
  return {
    version: 1,
    pageUrl: location.href,
    tagName: "button",
    id: "",
    classNames: [],
    text: "Go",
    role: "",
    ariaLabel: "",
    attributes: {
      alt: "",
      href: "",
      name: "",
      placeholder: "",
      src: "",
      title: "",
      type: "button",
    },
    rect: { x: 0, y: 0, top: 0, right: 20, bottom: 20, left: 0, width: 20, height: 20 },
    viewport: { width: 1024, height: 768, scrollX: 0, scrollY: 0 },
    cssSelector: "button",
    selectorUnique: true,
    capturedAt: Date.now(),
  }
}
async function state() {
  const value = await send("app.getState", {}, { tabContext: undefined })
  if (!value.ok) throw new Error(value.error.message)
  context = (value.result as { tabContext: TabContext }).tabContext
}
async function discover(name?: string): Promise<{ snapshotId: string; ref: string }> {
  const value = await send("page.listElements")
  if (!value.ok) throw new Error(value.error.message)
  const result = value.result as {
    snapshotId: string
    elements: Array<{ ref: string; name: string }>
  }
  const element = name
    ? result.elements.find((element) => element.name === name)
    : result.elements[0]
  return { snapshotId: result.snapshotId, ref: element?.ref ?? "" }
}

beforeEach(async () => {
  vi.resetModules()
  permission = true
  injectionCount = 0
  emittedEvents = []
  beforeInjection = undefined
  afterInjection = undefined
  tab = { id: 1, url: location.href, active: true, windowId: 1 }
  document.body.innerHTML = '<button type="button">Go</button><input aria-label="Title">'
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: undefined })
  restoreSurface = mockElementPickerSurface()
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const shield = this.hasAttribute("data-pi-browser-agent-element-picker")
    const width = shield ? window.innerWidth : 20
    const height = shield ? window.innerHeight : 20
    return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height } as DOMRect
  })
  // jsdom has no text layout; mirror the fixture's element geometry for text ranges.
  vi.spyOn(document, "createRange").mockImplementation(() => {
    const range = new Range()
    range.getClientRects = () =>
      [range.startContainer.parentElement?.getBoundingClientRect()].filter(
        (rect): rect is DOMRect => rect !== undefined,
      ) as unknown as DOMRectList
    return range
  })
  const noopEvent = { addListener: vi.fn() }
  executeScript = vi.fn(async ({ func, args }) => {
    if (func.name === "readDocumentContentType") return [{ result: document.contentType }]
    injectionCount++
    const hook = beforeInjection
    beforeInjection = undefined
    await hook?.()
    const result = await func(...(args ?? []))
    const after = afterInjection
    afterInjection = undefined
    await after?.()
    return [{ result }]
  })
  vi.stubGlobal("chrome", {
    commands: { onCommand: noopEvent },
    storage: {
      local: {
        setAccessLevel: vi.fn(async () => {}),
        get: vi.fn(async () => ({
          piBrowserAgentApprovedHostPermissions: [`${location.protocol}//${location.hostname}/*`],
        })),
      },
    },
    permissions: {
      contains: vi.fn(async () => permission),
      getAll: vi.fn(async () => ({ origins: [] })),
      onRemoved: {
        addListener: (value: typeof permissionRemoved) => {
          permissionRemoved = value
        },
      },
    },
    runtime: {
      id: "extension",
      onConnect: {
        addListener: (value: typeof panelConnected) => {
          panelConnected = value
        },
      },
      getManifest: () => ({ side_panel: { default_path: "panel.html" } }),
      onInstalled: noopEvent,
      onMessage: {
        addListener: (value: Listener) => {
          listener = value
        },
      },
      sendMessage: (message: { kind?: string; name?: string; payload?: unknown }) =>
        new Promise((resolve) => {
          if (message.kind === "event") {
            emittedEvents.push(message)
            resolve(undefined)
            return
          }
          listener(
            message,
            { id: "extension", tab, frameId: 0 } as chrome.runtime.MessageSender,
            resolve,
          )
        }),
    },
    tabs: {
      query: vi.fn(async () => [tab]),
      sendMessage: vi.fn(async () => undefined),
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
      onFocusChanged: {
        addListener: (value: typeof focusChanged) => {
          focusChanged = value
        },
      },
    },
    contextMenus: { onClicked: noopEvent },
    scripting: { executeScript },
  })
  await import("../../src/browser/service-worker.js")
  await state()
})
afterEach(() => {
  restoreSurface()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.resetModules()
})

function connectPanel(windowId: number): () => void {
  let message: (value: unknown) => void = () => undefined
  let disconnected: () => void = () => undefined
  chrome.runtime.getURL = (path) => `chrome-extension://extension/${path}`
  panelConnected({
    name: "element-picker-shortcut",
    sender: {
      id: "extension",
      url: "chrome-extension://extension/panel.html",
      tab: { windowId },
    },
    onMessage: {
      addListener: (value: typeof message) => {
        message = value
      },
    },
    onDisconnect: {
      addListener: (value: typeof disconnected) => {
        disconnected = value
      },
    },
    disconnect: () => disconnected(),
    postMessage: vi.fn(),
  } as unknown as chrome.runtime.Port)
  Reflect.deleteProperty(chrome.runtime, "getURL")
  message({ kind: "ready", windowId })
  return () => disconnected()
}

test("panel disconnect stops only the picker in that panel's window", async () => {
  const host = "[data-pi-browser-agent-element-picker]"
  await expect(startPickerRequest()).resolves.toMatchObject({ ok: true, result: { active: true } })
  expect(document.querySelector(host)).not.toBeNull()
  connectPanel(2)()
  await Promise.resolve()
  await Promise.resolve()
  expect(document.querySelector(host)).not.toBeNull()
  connectPanel(1)()
  await vi.waitFor(() => expect(document.querySelector(host)).toBeNull())
})

describe("panel disconnect during picker preflight", () => {
  for (const stage of [
    "tab refresh",
    "window lookup",
    "permission",
    "document validation",
  ] as const) {
    for (const windowId of [1, 2]) {
      test(`${stage}: disconnect in window ${windowId} affects only its own start`, async () => {
        const disconnect = connectPanel(windowId)
        let release: () => void = () => undefined
        let markEntered: () => void = () => undefined
        const entered = new Promise<void>((resolve) => {
          markEntered = resolve
        })
        const gate = new Promise<void>((resolve) => {
          release = resolve
        })
        if (stage === "tab refresh") {
          vi.mocked(chrome.tabs.query).mockImplementationOnce(async () => {
            markEntered()
            await gate
            return [tab] as chrome.tabs.Tab[]
          })
        } else if (stage === "window lookup") {
          vi.mocked(chrome.tabs.get).mockImplementationOnce(async () => {
            markEntered()
            await gate
            return tab as chrome.tabs.Tab
          })
        } else if (stage === "permission") {
          vi.mocked(chrome.permissions.contains).mockImplementationOnce(async () => {
            markEntered()
            await gate
            return permission
          })
        } else {
          const original = executeScript.getMockImplementation()
          executeScript.mockImplementationOnce(async (injection) => {
            expect(injection.func.name).toBe("readDocumentContentType")
            markEntered()
            await gate
            return original?.(injection) ?? []
          })
        }
        const starting = startPickerRequest()
        try {
          await entered
          disconnect()
        } finally {
          release()
        }
        await expect(starting).resolves.toMatchObject({
          ok: true,
          result: { active: windowId !== tab.windowId },
        })
        expect(document.querySelector("[data-pi-browser-agent-element-picker]") !== null).toBe(
          windowId !== tab.windowId,
        )
        if (windowId !== tab.windowId) {
          connectPanel(tab.windowId)()
          await vi.waitFor(() =>
            expect(document.querySelector("[data-pi-browser-agent-element-picker]")).toBeNull(),
          )
        }
      })
    }
  }
})

describe("picker startup navigation races", () => {
  for (const stage of [
    "tab refresh",
    "window lookup",
    "permission",
    "document validation",
  ] as const) {
    test.each([
      ["background loading", true],
      ["background URL", true],
      ["target title", true],
      ["target URL", false],
      ["target same-URL reload", false],
      ["stop", false],
      ["tab activation", false],
      ["window focus", false],
    ] as const)(`${stage}: %s`, async (event, shouldStart) => {
      let release: () => void = () => undefined
      let markEntered: () => void = () => undefined
      const entered = new Promise<void>((resolve) => {
        markEntered = resolve
      })
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const pause = async () => {
        markEntered()
        await gate
      }
      if (stage === "tab refresh") {
        vi.mocked(chrome.tabs.query).mockImplementationOnce(async () => {
          await pause()
          return [tab] as chrome.tabs.Tab[]
        })
      } else if (stage === "window lookup") {
        vi.mocked(chrome.tabs.get).mockImplementationOnce(async () => {
          await pause()
          return tab as chrome.tabs.Tab
        })
      } else if (stage === "permission") {
        vi.mocked(chrome.permissions.contains).mockImplementationOnce(async () => {
          await pause()
          return permission
        })
      } else {
        const original = executeScript.getMockImplementation()
        executeScript.mockImplementationOnce(async (injection) => {
          expect(injection.func.name).toBe("readDocumentContentType")
          await pause()
          return original?.(injection) ?? []
        })
      }
      const starting = startPickerRequest()
      try {
        await entered
        if (event === "background loading") updated(2, { status: "loading" })
        else if (event === "background URL") updated(2, { url: "https://background.test/next" })
        else if (event === "target title") updated(tab.id, { title: "New title" })
        else if (event === "target URL") {
          tab = { ...tab, url: `${tab.url}next` }
          updated(tab.id, { url: tab.url })
        } else if (event === "target same-URL reload") updated(tab.id, { status: "loading" })
        else if (event === "stop") {
          expect(await send("elementPicker.stop")).toMatchObject({ ok: true })
        } else if (event === "tab activation") activated()
        else focusChanged(2)
      } finally {
        release()
      }
      try {
        const response = await starting
        if (shouldStart) {
          expect(response).toMatchObject({ ok: true, result: { active: true } })
        } else {
          expect(response).toMatchObject(
            response.ok ? { result: { active: false } } : { error: { code: "STALE_CONTEXT" } },
          )
        }
        const starts = executeScript.mock.calls.filter(
          ([injection]) =>
            injection.func.name === "executeElementPicker" && injection.args?.[0] === "start",
        )
        expect(starts).toHaveLength(shouldStart ? 1 : 0)
        expect(document.querySelectorAll("[data-pi-browser-agent-element-picker]")).toHaveLength(
          shouldStart ? 1 : 0,
        )
        expect(
          emittedEvents.filter((event) => event.name === "elementPicker.started"),
        ).toHaveLength(shouldStart ? 1 : 0)
      } finally {
        await send("elementPicker.stop", {}, { tabContext: undefined })
      }
    })
  }
})

test.each([false, true])(
  "navigation cleanup precedes replacement (panel disconnect: %s)",
  async (disconnectWhileWaiting) => {
    const disconnect = connectPanel(tab.windowId)
    await expect(startPickerRequest()).resolves.toMatchObject({
      ok: true,
      result: { active: true },
    })
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.mocked(chrome.tabs.sendMessage).mockImplementationOnce(async () => {
      await gate
    })
    const operations: string[] = []
    const original = executeScript.getMockImplementation()
    executeScript.mockImplementation(async (injection) => {
      if (injection.func.name === "stopElementPickerInjection") operations.push("cleanup")
      if (injection.func.name === "executeElementPicker" && injection.args?.[0] === "start") {
        operations.push("start")
      }
      return original?.(injection) ?? []
    })
    updated(tab.id, { status: "loading" })
    await state()
    const starting = startPickerRequest()
    // Drain the resolved preflight promises while the older cleanup remains blocked.
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (disconnectWhileWaiting) disconnect()
    release()
    await expect(starting).resolves.toMatchObject({
      ok: true,
      result: { active: !disconnectWhileWaiting },
    })
    await vi.waitFor(() => expect(operations).toContain("cleanup"))
    expect(operations).toEqual(disconnectWhileWaiting ? ["cleanup"] : ["cleanup", "start"])
    expect(document.querySelector("[data-pi-browser-agent-element-picker]") !== null).toBe(
      !disconnectWhileWaiting,
    )
    await send("elementPicker.stop")
  },
)

describe("worker injection failures", () => {
  const paths = [
    ["document probe", "page.getVisibleText", {}],
    ["DOM operation", "page.getVisibleText", {}],
    ["WebMCP", "webmcp.listTools", {}],
    ["picker", "elementPicker.start", { clientId: "11111111-1111-4111-8111-111111111111" }],
  ] as const

  for (const error of [new Error("Chrome denied injection"), undefined]) {
    test.each(paths)(
      `marks the unchanged tab inaccessible after %s failure (${error ? "Error" : "no Error"})`,
      async (path, method, params) => {
        if (path !== "document probe")
          executeScript.mockResolvedValueOnce([{ result: "text/html" }])
        executeScript.mockRejectedValueOnce(error)

        expect(await send(method, params, { confirmed: true })).toMatchObject({
          ok: false,
          error: {
            code: "PERMISSION_DENIED",
            message:
              path === "WebMCP"
                ? "Chrome denied WebMCP access"
                : "Chrome denied access to the current tab",
            details: { diagnostics: { contextState: "permission_denied", toolName: method } },
          },
        })
        expect(await send("app.getState", {}, { tabContext: undefined })).toMatchObject({
          ok: true,
          result: { page: { kind: "restricted" }, tabContext: null },
        })
        expect(executeScript).toHaveBeenCalledTimes(path === "document probe" ? 1 : 2)
        expect(emittedEvents.some((event) => event.name === "elementPicker.started")).toBe(false)

        updated(tab.id, { status: "loading" })
        await vi.waitFor(async () => {
          expect(await send("app.getState", {}, { tabContext: undefined })).toMatchObject({
            ok: true,
            result: { page: { kind: "web" }, tabContext: { tabId: tab.id, url: tab.url } },
          })
        })
        if (path === "picker") {
          const token = executeScript.mock.calls[1]?.[0].args?.[1]
          expect(token).toBeTypeOf("string")
          const response = await new Promise<RuntimeResponse>((resolve) =>
            listener(
              {
                kind: "element-picker-result",
                token,
                status: "cancelled",
                tabContext: context,
              },
              { id: "extension", tab, frameId: 0 } as chrome.runtime.MessageSender,
              resolve,
            ),
          )
          expect(response).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } })
        }
      },
    )
  }

  for (const change of ["tab", "URL", "epoch", "unsupported page"] as const) {
    test.each(paths)(
      `rejects a stale %s failure after a ${change} change without marking the new context inaccessible`,
      async (path, method, params) => {
        const expected = { ...context }
        if (path !== "document probe")
          executeScript.mockResolvedValueOnce([{ result: "text/html" }])
        executeScript.mockImplementationOnce(async () => {
          if (change === "tab") tab = { ...tab, id: tab.id + 1 }
          else if (change === "URL") tab = { ...tab, url: `${tab.url}next` }
          else if (change === "unsupported page") tab = { ...tab, url: "chrome://settings/" }
          else focusChanged(-1)
          const current = await send("app.getState", {}, { tabContext: undefined })
          expect(current).toMatchObject({ ok: true })
          throw new Error("Chrome denied injection")
        })

        const response = await send(method, params, { confirmed: true })
        const current = await send("app.getState", {}, { tabContext: undefined })
        if (!current.ok) throw new Error(current.error.message)
        const actual = (current.result as { tabContext: TabContext | null }).tabContext
        expect(response).toMatchObject({
          ok: false,
          error: {
            code: "STALE_CONTEXT",
            message: "The visible tab changed or navigated while the browser operation was running",
            details: {
              expected: { tabId: expected.tabId, documentEpoch: expected.epoch },
              ...(actual ? { actual: { tabId: actual.tabId, documentEpoch: actual.epoch } } : {}),
            },
          },
        })
        expect(JSON.stringify(response)).not.toContain(expected.url)
        expect(current).toMatchObject({
          result:
            change === "unsupported page"
              ? { page: { kind: "restricted" }, tabContext: null }
              : { page: { kind: "web" }, tabContext: { tabId: tab.id, url: tab.url } },
        })
        if (change === "epoch") expect(actual?.epoch).toBeGreaterThan(expected.epoch)
        expect(executeScript).toHaveBeenCalledTimes(
          path === "document probe" ? 1 : path === "picker" ? 3 : 2,
        )
        if (path === "picker")
          expect(executeScript.mock.calls.at(-1)?.[0].func.name).toBe("stopElementPickerInjection")
      },
    )
  }
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

  test.each(["click", "type"])(
    "reports successful %s when the mutation invalidates its own snapshot",
    async (operation) => {
      const target = await discover()
      const node = document.querySelector(operation === "click" ? "button" : "input") as HTMLElement
      const mutate = vi.fn(() => updated(tab.id, { status: "loading" }))
      node.addEventListener(operation === "click" ? "click" : "input", mutate)
      const params = operation === "click" ? target : { ...target, ref: "e2", text: "Written once" }
      expect(await send(`page.${operation}`, params)).toMatchObject({ ok: true })
      expect(mutate).toHaveBeenCalledOnce()
      if (operation === "type") expect((node as HTMLInputElement).value).toBe("Written once")
      await state()
      expect(await send(`page.${operation}`, params)).toMatchObject({
        ok: false,
        error: { code: "STALE_CONTEXT" },
      })
      expect(mutate).toHaveBeenCalledOnce()
    },
  )

  test("keeps successful confirmed submissions while rejecting navigation before mutation", async () => {
    document.body.innerHTML = "<form><button>Submit</button></form>"
    let target = await discover()
    const submitted = vi.fn((event: Event) => {
      event.preventDefault()
      updated(tab.id, { status: "loading" })
    })
    document.querySelector("form")?.addEventListener("submit", submitted)
    expect(await send("page.click", target)).toMatchObject({
      ok: false,
      error: { code: "CONFIRMATION_REQUIRED" },
    })
    expect(await send("page.click", target, { confirmed: true })).toMatchObject({
      ok: true,
      result: { clicked: true },
    })
    expect(submitted).toHaveBeenCalledOnce()
    await state()
    target = await discover()
    beforeInjection = async () => {
      updated(tab.id, { status: "loading" })
    }
    expect(await send("page.click", target)).toMatchObject({
      ok: false,
      error: { code: "STALE_CONTEXT" },
    })
    expect(submitted).toHaveBeenCalledOnce()
  })

  test("recovers the reported read/type/submit/list/switch/open sequence without an unrelated page", async () => {
    document.body.innerHTML =
      '<p>Local context fixture</p><form><input id="title"><textarea id="notes"></textarea><button>Save</button></form>'
    const submitted = vi.fn((event: Event) => event.preventDefault())
    document.querySelector("form")?.addEventListener("submit", submitted)
    let pageEnabled = true
    let interruptSubmit = true
    const { createBrowserTools } = await import("../../src/browser/agent/browser-tools.js")
    const tools = createBrowserTools(
      async (message) => {
        if (interruptSubmit && message.includes("submit")) {
          interruptSubmit = false
          focusChanged(-1)
        }
        return true
      },
      () => pageEnabled,
      () => {
        pageEnabled = true
      },
    )
    const run = async (name: string, params: JsonObject = {}) => {
      const tool = tools.find((tool) => tool.name === name)
      if (!tool) throw new Error("Missing fixture tool")
      return tool.execute("fixture-call", params, undefined)
    }
    expect(await run("browser_read_page")).toMatchObject({ details: { url: location.href } })
    await run("browser_type", { selector: "#title", text: "Local title" })
    await run("browser_type", { selector: "#notes", text: "Local notes" })
    await expect(run("browser_click", { selector: "button" })).rejects.toMatchObject({
      code: "STALE_CONTEXT",
      details: { mutationOutcome: "not_dispatched" },
    })
    expect(submitted).not.toHaveBeenCalled()
    pageEnabled = false
    await expect(run("browser_get_active_tab")).rejects.toMatchObject({
      code: "PAGE_CONTEXT_DISABLED",
    })
    expect(await run("browser_list_tabs")).toMatchObject({
      details: { tabs: [{ id: 1, active: true }] },
    })
    vi.mocked(chrome.tabs.update).mockImplementation(async () => tab as chrome.tabs.Tab)
    expect(await run("browser_switch_tab", { id: 1 })).toMatchObject({
      details: { active: true, mutationOutcome: "dispatched" },
    })
    expect(await run("browser_read_page")).toMatchObject({ details: { url: location.href } })
    chrome.tabs.create = vi.fn(async () => {
      tab = { ...tab, id: 2 }
      activated()
      return tab as chrome.tabs.Tab
    }) as typeof chrome.tabs.create
    expect(await run("browser_open_website", { url: location.href })).toMatchObject({
      details: { opened: true, mutationOutcome: "dispatched" },
    })
    expect(await run("browser_read_page")).toMatchObject({ details: { url: location.href } })
    expect((document.querySelector("#title") as HTMLInputElement).value).toBe("Local title")
    expect(submitted).not.toHaveBeenCalled()
  })

  test.each(["success", "unknown", "unserializable"] as const)(
    "preserves WebMCP %s outcome through cancellation or response failure",
    async (mode) => {
      const executeTool = vi.fn(async () => {
        if (mode === "unknown") throw new Error("private-tool-data")
        if (mode === "unserializable") return { saved: true, value: 1n }
        await send("requests.cancel", { requestId: "webmcp-once" }, { tabContext: undefined })
        return { saved: true }
      })
      Object.defineProperty(document, "modelContext", {
        configurable: true,
        value: {
          getTools: async () => [{ name: "save_fixture", inputSchema: { type: "object" } }],
          executeTool,
        },
      })
      try {
        const response = await send(
          "webmcp.callTool",
          { name: "save_fixture", arguments: {} },
          { confirmed: true, requestId: "webmcp-once" },
        )
        expect(response).toMatchObject(
          mode === "success"
            ? { ok: true, mutationOutcome: "dispatched", result: { saved: true } }
            : mode === "unserializable"
              ? {
                  ok: false,
                  error: { code: "INTERNAL_ERROR", details: { mutationOutcome: "dispatched" } },
                }
              : {
                  ok: false,
                  error: {
                    code: "ACTION_OUTCOME_UNKNOWN",
                    details: { mutationOutcome: "outcome_unknown" },
                  },
                },
        )
        expect(JSON.stringify(response)).not.toContain("private-tool-data")
        if (mode === "unserializable")
          expect(JSON.stringify(response)).not.toContain("page changed")
        expect(executeTool).toHaveBeenCalledOnce()
      } finally {
        Reflect.deleteProperty(document, "modelContext")
      }
    },
  )

  test("does not navigate after cancellation during the final target lookup", async () => {
    let lookups = 0
    vi.mocked(chrome.windows.get).mockImplementation(async () => {
      if (++lookups === 3)
        await send("requests.cancel", { requestId: "navigate-once" }, { tabContext: undefined })
      return { focused: true } as chrome.windows.Window
    })
    expect(
      await send("tabs.navigate", { url: location.href }, { requestId: "navigate-once" }),
    ).toMatchObject({
      ok: false,
      error: { code: "REQUEST_CANCELLED", details: { mutationOutcome: "not_dispatched" } },
    })
    expect(chrome.tabs.update).not.toHaveBeenCalled()
  })

  test("sanitizes raw target-assertion failures before returning them to the page", async () => {
    const target = await discover()
    ;(chrome.tabs.get as unknown as Mock<(id: number) => Promise<chrome.tabs.Tab>>)
      .mockResolvedValueOnce(tab as chrome.tabs.Tab)
      .mockRejectedValueOnce(new Error("private-token-from-Chrome"))
    const response = await send("page.click", target)
    expect(response).toMatchObject({
      ok: false,
      error: { details: { mutationOutcome: "not_dispatched" } },
    })
    expect(JSON.stringify(response)).not.toContain("private-token-from-Chrome")
  })

  test("retains dispatched submission outcome when cancellation arrives after execution", async () => {
    document.body.innerHTML = "<form><button>Submit</button></form>"
    const submitted = vi.fn((event: Event) => {
      event.preventDefault()
      updated(tab.id, { status: "loading" })
    })
    document.querySelector("form")?.addEventListener("submit", submitted)
    const target = await discover()
    // Confirmed click first inspects the link. Install cancellation on the actual click injection.
    const original = executeScript.getMockImplementation()
    executeScript.mockImplementation(async (injection) => {
      const result = (await original?.(injection)) ?? []
      if (injection.func.name === "executePageOperation" && injection.args?.[0] === "click")
        await send("requests.cancel", { requestId: "late-cancel" }, { tabContext: undefined })
      return result
    })
    expect(
      await send("page.click", target, { confirmed: true, requestId: "late-cancel" }),
    ).toMatchObject({ ok: true, result: { clicked: true, mutationOutcome: "dispatched" } })
    expect(submitted).toHaveBeenCalledOnce()
  })

  test("reports a lost navigation-causing click response as unknown without replay", async () => {
    const target = await discover()
    const clicked = vi.fn(() => updated(tab.id, { status: "loading" }))
    document.querySelector("button")?.addEventListener("click", clicked)
    afterInjection = async () => {
      throw new Error("private-page-token-and-form-text")
    }
    const result = await send("page.click", target)
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "ACTION_OUTCOME_UNKNOWN",
        details: {
          mutationOutcome: "outcome_unknown",
          diagnostics: { actionStage: "dispatch", toolName: "page.click" },
        },
      },
    })
    expect(JSON.stringify(result)).not.toContain("private-page-token-and-form-text")
    expect(clicked).toHaveBeenCalledOnce()
    await state()
    expect(await send("page.getVisibleText")).toMatchObject({ ok: true })
    expect(clicked).toHaveBeenCalledOnce()
  })

  test("rejects closed tabs distinctly before dispatch", async () => {
    vi.mocked(chrome.tabs.get).mockRejectedValueOnce(new Error("private closed tab URL"))
    const clicked = vi.fn()
    document.querySelector("button")?.addEventListener("click", clicked)
    expect(await send("page.click", { selector: "button" })).toMatchObject({
      ok: false,
      error: { code: "TAB_NOT_FOUND", details: { mutationOutcome: "not_dispatched" } },
    })
    expect(clicked).not.toHaveBeenCalled()
  })

  test.each(["activation", "focus"] as const)(
    "rejects an old selector after a rapid %s round trip before dispatch",
    async (event) => {
      const original = { ...context }
      if (event === "activation") {
        activated()
        activated()
      } else {
        focusChanged(-1)
        focusChanged(1)
      }
      await state()
      const clicked = vi.fn()
      document.querySelector("button")?.addEventListener("click", clicked)
      expect(
        await send("page.click", { selector: "button" }, { tabContext: original }),
      ).toMatchObject({
        ok: false,
        error: { code: "STALE_CONTEXT", details: { mutationOutcome: "not_dispatched" } },
      })
      expect(clicked).not.toHaveBeenCalled()
    },
  )

  test("keeps action progress free of typed contents", async () => {
    expect(await send("page.type", { selector: "input", text: "private-form-text" })).toMatchObject(
      { ok: true, result: { mutationOutcome: "dispatched" } },
    )
    await vi.waitFor(() =>
      expect(emittedEvents).toContainEqual(
        expect.objectContaining({
          name: "operation.progress",
          payload: expect.objectContaining({
            toolName: "page.type",
            actionStage: "completed",
            mutationOutcome: "dispatched",
            windowId: 1,
            documentEpoch: 0,
          }),
        }),
      ),
    )
    const progress = emittedEvents.filter((event) => event.name === "operation.progress")
    expect(JSON.stringify(progress)).not.toMatch(/private-form-text|http:|selector/)
  })

  test("keeps same-URL navigation stale when a newer state lookup supersedes navigation sync", async () => {
    const original = { ...context }
    let release: (() => void) | undefined
    vi.mocked(chrome.tabs.query).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve([tab] as chrome.tabs.Tab[])
        }),
    )
    updated(tab.id, { status: "loading" })
    await vi.waitFor(() => expect(release).toBeTypeOf("function"))
    await state()
    release?.()
    expect(context.epoch).toBeGreaterThan(original.epoch)
    const clicked = vi.fn()
    document.querySelector("button")?.addEventListener("click", clicked)
    expect(
      await send("page.click", { selector: "button" }, { tabContext: original, confirmed: true }),
    ).toMatchObject({
      ok: false,
      error: { code: "STALE_CONTEXT" },
    })
    expect(clicked).not.toHaveBeenCalled()
  })

  test("rejects discovery replaced while its result is returning", async () => {
    afterInjection = async () => {
      await discover()
    }
    expect(await send("page.listElements")).toMatchObject({
      ok: false,
      error: { code: "STALE_CONTEXT" },
    })
  })

  test("rejects replaced references before deferred cross-origin navigation", async () => {
    document.body.innerHTML = '<a href="https://destination.test/next">Go</a>'
    vi.mocked(chrome.storage.local.get).mockImplementation(async () => ({
      piBrowserAgentApprovedHostPermissions: [
        `${location.protocol}//${location.hostname}/*`,
        "https://destination.test/*",
      ],
    }))
    const target = await discover()
    // Let inspectClick finish, then replace the snapshot after click authorizes—but has not performed—navigation.
    afterInjection = async () => {
      afterInjection = async () => {
        await discover()
      }
    }
    expect(await send("page.click", target, { confirmed: true })).toMatchObject({
      ok: false,
      error: { code: "STALE_CONTEXT" },
    })
    expect(chrome.tabs.update).not.toHaveBeenCalled()
  })

  test.each([
    '<button id="control" aria-label="Target" formaction="relative-submit">Submit</button>',
    '<input id="control" aria-label="Target" type="submit" formaction="relative-submit">',
    '<label role="button" aria-label="Target" for="control">Submit</label><button id="control" formaction="relative-submit">Control</button>',
    '<button id="control" formaction="relative-submit"><span role="button" aria-label="Target">Submit</span></button>',
  ])("rejects a changed resolved submit override during confirmation: %s", async (markup) => {
    document.body.innerHTML = `<form action="https://fixed.test/submit">${markup}</form>`
    const base = document.createElement("base")
    base.href = "https://first.test/"
    document.head.append(base)
    const control = document.querySelector("#control") as HTMLButtonElement | HTMLInputElement
    // jsdom lacks formAction; reproduce the native reflected URL getter (also tested in Chrome).
    Object.defineProperty(control, "formAction", {
      get: () => new URL(control.getAttribute("formaction") as string, document.baseURI).href,
    })
    const node = document.querySelector('[aria-label="Target"]') as HTMLElement
    const clicked = vi.spyOn(node, "click").mockImplementation(() => {})
    try {
      const target = await discover("Target")
      expect(await send("page.click", target)).toMatchObject({
        ok: false,
        error: { code: "CONFIRMATION_REQUIRED" },
      })
      base.href = "https://changed.test/"
      expect(control.formAction).toBe("https://changed.test/relative-submit")
      expect(control.form?.action).toBe("https://fixed.test/submit")
      expect(await send("page.click", target, { confirmed: true })).toMatchObject({
        ok: false,
        error: { code: "STALE_CONTEXT" },
      })
      expect(clicked).not.toHaveBeenCalled()
    } finally {
      base.remove()
    }
  })

  test.each([
    ["button", "name", "changed-action"],
    ["button", "value", "delete"],
    ["button", "formenctype", "multipart/form-data"],
    ["button", "formnovalidate", ""],
    ["form", "enctype", "multipart/form-data"],
    ["form", "novalidate", ""],
  ])(
    "rejects changed submit payload metadata %s.%s without exposing values",
    async (selector, attribute, value) => {
      document.body.innerHTML =
        '<form><label role="button" aria-label="Target" for="control">Save</label><button id="control" name="private-submit-name" value="private-submit-value">Save</button></form>'
      const discovery = await send("page.listElements")
      expect(discovery.ok).toBe(true)
      expect(JSON.stringify(discovery)).not.toContain("private-submit-")
      const target = await discover("Target")
      const label = document.querySelector("label") as HTMLLabelElement
      const clicked = vi.spyOn(label, "click").mockImplementation(() => {})
      expect(await send("page.click", target)).toMatchObject({
        ok: false,
        error: { code: "CONFIRMATION_REQUIRED" },
      })
      document.querySelector(selector)?.setAttribute(attribute, value)
      expect(await send("page.click", target, { confirmed: true })).toMatchObject({
        ok: false,
        error: { code: "STALE_CONTEXT" },
      })
      expect(clicked).not.toHaveBeenCalled()
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

describe("worker browser interactions", () => {
  function viewportFixture() {
    const root = document.documentElement
    const scrollTo = vi.fn((options: ScrollToOptions) => {
      root.scrollTop = Number(options.top ?? 0)
    })
    Object.defineProperty(document, "scrollingElement", { configurable: true, value: root })
    Object.defineProperties(root, {
      clientHeight: { configurable: true, value: 700 },
      scrollHeight: { configurable: true, value: 700 },
      scrollTo: { configurable: true, value: scrollTo },
    })
    return scrollTo
  }

  afterEach(() => {
    Reflect.deleteProperty(document, "scrollingElement")
    for (const property of ["clientHeight", "scrollHeight", "scrollTo"]) {
      Reflect.deleteProperty(document.documentElement, property)
    }
    document.documentElement.scrollTop = 0
  })

  function selectFixture(): HTMLSelectElement {
    document.body.innerHTML =
      '<select aria-label="Choice"><option value="private-first">First</option><option value="private-second">Second</option><option disabled value="private-disabled">Disabled</option></select>'
    return document.querySelector("select") as HTMLSelectElement
  }

  test.each(["page.scroll", "page.selectOption", "page.getElementDetails"])(
    "%s rejects denied site access before injection",
    async (method) => {
      selectFixture()
      const target = await discover("Choice")
      permission = false
      const count = executeScript.mock.calls.length
      const params: JsonObject =
        method === "page.scroll"
          ? { direction: "down", amount: "page" }
          : method === "page.selectOption"
            ? { ...target, label: "Second" }
            : target
      expect(await send(method, params, { confirmed: true })).toMatchObject({
        ok: false,
        error: { code: "PERMISSION_DENIED" },
      })
      expect(executeScript).toHaveBeenCalledTimes(count)
    },
  )

  test("details returns geometry and state without field values or mutation", async () => {
    document.body.innerHTML =
      '<input aria-label="Private title" role="textbox" value="private-field-value" readonly required>'
    const input = document.querySelector("input") as HTMLInputElement
    input.focus()
    const events = vi.fn()
    input.addEventListener("input", events)
    input.addEventListener("change", events)
    const target = await discover("Private title")
    const result = await send("page.getElementDetails", target)
    expect(result).toMatchObject({
      ok: true,
      result: {
        name: "Private title",
        role: "textbox",
        visible: true,
        rect: { x: 0, y: 0, top: 0, right: 20, bottom: 20, left: 0, width: 20, height: 20 },
        state: { disabled: false, readOnly: true, required: true, focused: true },
        scrollability: {
          vertical: false,
          horizontal: false,
          scrollTop: 0,
          scrollLeft: 0,
          scrollHeight: 0,
          scrollWidth: 0,
          clientHeight: 0,
          clientWidth: 0,
        },
      },
    })
    expect(JSON.stringify(result)).not.toContain("private-field-value")
    expect(JSON.stringify(result)).not.toContain('"value":')
    expect(input.value).toBe("private-field-value")
    expect(events).not.toHaveBeenCalled()
    expect(await send("page.getElementDetails", target)).toMatchObject({ ok: true })
  })

  test("details reports native and ARIA states without checkbox values", async () => {
    document.body.innerHTML =
      '<input type="checkbox" aria-label="Enabled" role="checkbox" value="private-checkbox-value" checked disabled required aria-expanded="false" aria-selected="true">'
    const details = await send("page.getElementDetails", await discover("Enabled"))
    expect(details).toMatchObject({
      ok: true,
      result: {
        role: "checkbox",
        state: {
          disabled: true,
          readOnly: false,
          checked: true,
          expanded: "false",
          selected: "true",
          required: true,
          focused: false,
        },
      },
    })
    expect(JSON.stringify(details)).not.toContain("private-checkbox-value")
  })

  test.each(["up", "down"])(
    "zero-distance viewport scroll %s invalidates worker and isolated snapshots",
    async (direction) => {
      const scrollTo = viewportFixture()
      const target = await discover("Go")
      expect(await send("page.getElementDetails", target)).toMatchObject({ ok: true })
      const detailsInjection = executeScript.mock.calls.at(-1)?.[0]
      expect(await send("page.scroll", { direction, amount: "page" })).toMatchObject({
        ok: true,
        result: {
          distance: 0,
          atTop: true,
          atBottom: true,
          position: 0,
          maxPosition: 0,
          snapshotInvalidated: true,
        },
      })
      expect(scrollTo).toHaveBeenCalledOnce()
      const count = injectionCount
      expect(await send("page.getElementDetails", target)).toMatchObject({
        ok: false,
        error: { code: "STALE_CONTEXT" },
      })
      expect(injectionCount).toBe(count)
      expect(await detailsInjection?.func(...(detailsInjection.args ?? []))).toMatchObject({
        ok: false,
        error: { code: "STALE_CONTEXT" },
      })
    },
  )

  test.each(["value", "label"] as const)(
    "selects by %s only after confirmation, uses the native setter and invalidates both registries",
    async (option) => {
      const select = selectFixture()
      const nativeSetterTrap = vi.fn()
      Object.defineProperty(select, "value", {
        configurable: true,
        get: () => select.options[select.selectedIndex]?.value,
        set: nativeSetterTrap,
      })
      const events: Array<{ type: string; value: string; bubbles: boolean }> = []
      for (const type of ["input", "change"]) {
        document.body.addEventListener(type, (event) => {
          events.push({ type: event.type, value: select.value, bubbles: event.bubbles })
        })
      }
      const target = await discover("Choice")
      expect(await send("page.getElementDetails", target)).toMatchObject({ ok: true })
      const detailsInjection = executeScript.mock.calls.at(-1)?.[0]
      const params = { ...target, [option]: option === "value" ? "private-second" : "Second" }
      expect(await send("page.selectOption", params)).toMatchObject({
        ok: false,
        error: { code: "CONFIRMATION_REQUIRED" },
      })
      expect(select.value).toBe("private-first")
      expect(events).toEqual([])
      expect(await send("page.selectOption", params, { confirmed: true })).toMatchObject({
        ok: true,
      })
      expect(nativeSetterTrap).not.toHaveBeenCalled()
      expect(select.value).toBe("private-second")
      expect(events).toEqual([
        { type: "input", value: "private-second", bubbles: true },
        { type: "change", value: "private-second", bubbles: true },
      ])
      const count = injectionCount
      expect(await send("page.getElementDetails", target)).toMatchObject({
        ok: false,
        error: { code: "STALE_CONTEXT" },
      })
      expect(injectionCount).toBe(count)
      // Replay the old read directly, without worker snapshot validation.
      expect(await detailsInjection?.func(...(detailsInjection.args ?? []))).toMatchObject({
        ok: false,
        error: { code: "STALE_CONTEXT" },
      })
      expect(await send("page.getElementDetails", await discover("Choice"))).toMatchObject({
        ok: true,
      })
    },
  )

  test("selecting the current option still requires confirmation and invalidates references", async () => {
    const select = selectFixture()
    const events = vi.fn()
    select.addEventListener("input", events)
    select.addEventListener("change", events)
    const target = await discover("Choice")
    expect(await send("page.selectOption", { ...target, label: "First" })).toMatchObject({
      ok: false,
      error: { code: "CONFIRMATION_REQUIRED" },
    })
    expect(events).not.toHaveBeenCalled()
    expect(
      await send("page.selectOption", { ...target, label: "First" }, { confirmed: true }),
    ).toMatchObject({ ok: true })
    expect(select.value).toBe("private-first")
    expect(events).toHaveBeenCalledTimes(2)
    expect(await send("page.getElementDetails", target)).toMatchObject({
      ok: false,
      error: { code: "STALE_CONTEXT" },
    })
  })

  test.each([
    '<select aria-label="Choice" disabled><option>First</option></select>',
    '<select aria-label="Choice" multiple><option>First</option></select>',
    '<button aria-label="Choice">First</button>',
  ])("does not select unsupported or disabled controls: %s", async (markup) => {
    document.body.innerHTML = markup
    const events = vi.fn()
    document.querySelector("[aria-label]")?.addEventListener("input", events)
    document.querySelector("[aria-label]")?.addEventListener("change", events)
    const result = await send(
      "page.selectOption",
      { ...(await discover("Choice")), label: "First" },
      { confirmed: true },
    )
    expect(result).toMatchObject({
      ok: false,
      error: { code: expect.stringMatching(/^(NOT_SUPPORTED|PERMISSION_DENIED)$/) },
    })
    expect(events).not.toHaveBeenCalled()
  })

  test("does not select missing or disabled options or a changed confirmation target", async () => {
    const select = selectFixture()
    const events = vi.fn()
    select.addEventListener("input", events)
    select.addEventListener("change", events)
    const target = await discover("Choice")
    for (const label of ["Missing", "Disabled"]) {
      expect(
        await send("page.selectOption", { ...target, label }, { confirmed: true }),
      ).toMatchObject({
        ok: false,
      })
      expect(select.value).toBe("private-first")
    }
    expect(await send("page.selectOption", { ...target, label: "Second" })).toMatchObject({
      ok: false,
      error: { code: "CONFIRMATION_REQUIRED" },
    })
    select.setAttribute("aria-label", "Changed")
    expect(
      await send("page.selectOption", { ...target, label: "Second" }, { confirmed: true }),
    ).toMatchObject({ ok: false, error: { code: "STALE_CONTEXT" } })
    expect(events).not.toHaveBeenCalled()
  })

  for (const method of ["page.scroll", "page.selectOption"] as const) {
    test.each(["permission", "cancellation", "focus"] as const)(
      `${method} rechecks %s immediately before mutation`,
      async (guard) => {
        const select = selectFixture()
        const target = await discover("Choice")
        const events = vi.fn()
        select.addEventListener("input", events)
        select.addEventListener("change", events)
        const scroll = viewportFixture()
        beforeInjection = async () => {
          if (guard === "permission") permission = false
          if (guard === "cancellation") {
            await send("requests.cancel", { requestId: "interaction-cancel" })
          }
          if (guard === "focus") {
            // Lose focus at the final window lookup, after the visible-tab refresh.
            vi.mocked(chrome.windows.get)
              .mockImplementationOnce((async () => ({
                focused: true,
              })) as unknown as typeof chrome.windows.get)
              .mockImplementationOnce((async () => ({
                focused: false,
              })) as unknown as typeof chrome.windows.get)
          }
        }
        const params: JsonObject =
          method === "page.scroll"
            ? { direction: "down", amount: "page" }
            : { ...target, label: "Second" }
        expect(
          await send(method, params, { confirmed: true, requestId: "interaction-cancel" }),
        ).toMatchObject({
          ok: false,
          error: {
            code:
              guard === "permission"
                ? "PERMISSION_DENIED"
                : guard === "cancellation"
                  ? "REQUEST_CANCELLED"
                  : "STALE_CONTEXT",
          },
        })
        expect(select.value).toBe("private-first")
        expect(events).not.toHaveBeenCalled()
        expect(scroll).not.toHaveBeenCalled()
      },
    )
  }
})

describe("worker condition waits", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test("waits for a delayed visible control without replacing an existing snapshot", async () => {
    const target = await discover("Go")
    const waiting = send("page.waitFor", { selector: "#delayed", state: "visible" })
    await vi.advanceTimersByTimeAsync(0)
    const before = injectionCount
    document.body.insertAdjacentHTML("beforeend", '<button id="delayed">Ready</button>')
    await vi.advanceTimersByTimeAsync(250)
    expect(await waiting).toMatchObject({ ok: true, result: { matched: true, elapsedMs: 250 } })
    expect(injectionCount).toBe(before + 1)
    expect(await send("page.getElementDetails", target)).toMatchObject({ ok: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  test("binds a context-free wait once to the original active document", async () => {
    expect(
      await send(
        "page.waitFor",
        { selector: "button", state: "visible" },
        {
          tabContext: undefined,
        },
      ),
    ).toMatchObject({ ok: true, result: { matched: true } })
    const waiting = send(
      "page.waitFor",
      { selector: "#delayed", state: "visible" },
      {
        tabContext: undefined,
      },
    )
    await vi.advanceTimersByTimeAsync(0)
    tab.id = 2
    activated()
    document.body.insertAdjacentHTML("beforeend", '<button id="delayed">Ready</button>')
    await vi.advanceTimersByTimeAsync(250)
    expect(await waiting).toMatchObject({ ok: false, error: { code: "STALE_CONTEXT" } })
  })

  test("context-free initial lookup stays inside the timeout budget", async () => {
    let release: (tabs: chrome.tabs.Tab[]) => void = () => undefined
    vi.mocked(chrome.tabs.query).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const waiting = send(
      "page.waitFor",
      { selector: "button", state: "visible", timeoutMs: 100 },
      {
        tabContext: undefined,
      },
    )
    await vi.advanceTimersByTimeAsync(100)
    expect(await waiting).toMatchObject({ ok: false, error: { code: "TIMEOUT" } })
    release([tab as chrome.tabs.Tab])
    await vi.advanceTimersByTimeAsync(0)
    expect(await send("page.getElementDetails", await discover("Go"))).toMatchObject({ ok: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  test("condition probes do not renew snapshot expiry", async () => {
    const target = await discover("Go")
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 100)
    const waiting = send("page.waitFor", { selector: "#delayed", state: "visible" })
    await vi.advanceTimersByTimeAsync(0)
    document.body.insertAdjacentHTML("beforeend", '<button id="delayed">Ready</button>')
    await vi.advanceTimersByTimeAsync(250)
    expect(await waiting).toMatchObject({ ok: true, result: { matched: true } })
    expect(await send("page.getElementDetails", target)).toMatchObject({
      ok: false,
      error: { code: "STALE_CONTEXT" },
    })
  })

  test("timeout is distinct from injection denial and keeps the page and snapshot readable", async () => {
    const target = await discover("Go")
    const waiting = send("page.waitFor", {
      selector: "#never",
      state: "visible",
      timeoutMs: 501,
    })
    await vi.advanceTimersByTimeAsync(501)
    expect(await waiting).toMatchObject({ ok: false, error: { code: "TIMEOUT" } })
    expect(await send("page.getElementDetails", target)).toMatchObject({ ok: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  test.each(["delay", "injection"] as const)("cancels during %s without replay", async (stage) => {
    let release: () => void = () => undefined
    if (stage === "injection") {
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      beforeInjection = () => gate
    }
    const waiting = send(
      "page.waitFor",
      {
        selector: "#never",
        state: "visible",
      },
      { requestId: "wait-to-cancel" },
    )
    await vi.advanceTimersByTimeAsync(0)
    const count = injectionCount
    await send("requests.cancel", { requestId: "wait-to-cancel" })
    expect(await waiting).toMatchObject({ ok: false, error: { code: "REQUEST_CANCELLED" } })
    release()
    await vi.advanceTimersByTimeAsync(10000)
    expect(injectionCount).toBe(count)
    expect(vi.getTimerCount()).toBe(0)
  })

  test("late rejection after a deadline does not mark the page inaccessible", async () => {
    let reject: (reason: Error) => void = () => undefined
    const gate = new Promise<void>((_resolve, rejectPromise) => {
      reject = rejectPromise
    })
    beforeInjection = () => gate
    const waiting = send("page.waitFor", { selector: "button", state: "visible", timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(100)
    expect(await waiting).toMatchObject({ ok: false, error: { code: "TIMEOUT" } })
    reject(new Error("Late injection failure"))
    await vi.advanceTimersByTimeAsync(0)
    expect(await send("page.getElementDetails", await discover("Go"))).toMatchObject({ ok: true })
  })

  test.each(["permission", "navigation", "focus", "activation"] as const)(
    "fails closed on %s changes between probes",
    async (change) => {
      const waiting = send("page.waitFor", { selector: "#never", state: "visible" })
      await vi.advanceTimersByTimeAsync(0)
      if (change === "permission") permission = false
      if (change === "navigation") {
        tab.url = `${location.origin}/replacement`
        updated(tab.id, { url: tab.url, status: "loading" })
      }
      if (change === "focus") {
        vi.mocked(chrome.windows.get).mockImplementation((async () => ({
          focused: false,
        })) as unknown as typeof chrome.windows.get)
        focusChanged(-1)
      }
      if (change === "activation") {
        tab.id = 2
        activated()
      }
      await vi.advanceTimersByTimeAsync(1000)
      expect(await waiting).toMatchObject({
        ok: false,
        error: {
          code:
            change === "permission"
              ? "PERMISSION_DENIED"
              : expect.stringMatching(/STALE_CONTEXT|TAB_NOT_BOUND/),
        },
      })
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  test.each(["activation", "focus", "same-URL reload"] as const)(
    "remembers intervening %s even if the same tab is active at the next probe",
    async (event) => {
      const waiting = send("page.waitFor", { selector: "#delayed", state: "visible" })
      await vi.advanceTimersByTimeAsync(0)
      if (event === "activation") activated()
      if (event === "focus") focusChanged(1)
      if (event === "same-URL reload") updated(tab.id, { status: "loading" })
      document.body.insertAdjacentHTML("beforeend", '<button id="delayed">Ready</button>')
      await vi.advanceTimersByTimeAsync(250)
      expect(await waiting).toMatchObject({ ok: false, error: { code: "STALE_CONTEXT" } })
    },
  )

  test("rechecks context events arriving during a matching injection", async () => {
    afterInjection = async () => {
      activated()
    }
    expect(await send("page.waitFor", { selector: "button", state: "visible" })).toMatchObject({
      ok: false,
      error: { code: "STALE_CONTEXT" },
    })
  })

  test("rechecks revoked site access after an otherwise matching injection", async () => {
    afterInjection = async () => {
      permission = false
    }
    expect(await send("page.waitFor", { selector: "button", state: "visible" })).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    })
  })

  test("invalid selectors fail without entering the polling delay", async () => {
    expect(await send("page.waitFor", { selector: "[", state: "absent" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    })
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe("worker checked-state and option-read guards", () => {
  function checkbox() {
    document.body.innerHTML = '<input type="checkbox" aria-label="Accept">'
    return document.querySelector("input") as HTMLInputElement
  }

  test("no-op checked state requires no confirmation or snapshot invalidation", async () => {
    const input = checkbox()
    const clicked = vi.fn()
    input.addEventListener("click", clicked)
    const target = await discover("Accept")
    expect(await send("page.setChecked", { ...target, checked: false })).toMatchObject({
      ok: true,
      result: { changed: false, activated: false, finalStateVerified: true },
    })
    expect(clicked).not.toHaveBeenCalled()
    expect(await send("page.getElementDetails", target)).toMatchObject({ ok: true })
  })

  test("actual activation requires fresh confirmation and invalidates both registries", async () => {
    const input = checkbox()
    const clicked = vi.fn()
    input.addEventListener("click", clicked)
    const target = await discover("Accept")
    expect(await send("page.setChecked", { ...target, checked: true })).toMatchObject({
      ok: false,
      error: { code: "CONFIRMATION_REQUIRED" },
    })
    expect(input.checked).toBe(false)
    expect(
      await send("page.setChecked", { ...target, checked: true }, { confirmed: true }),
    ).toMatchObject({
      ok: true,
      result: { activated: true, requestedReached: true, checked: true, snapshotInvalidated: true },
    })
    expect(clicked).toHaveBeenCalledOnce()
    expect(await send("page.getElementDetails", target)).toMatchObject({
      ok: false,
      error: { code: "STALE_CONTEXT" },
    })
  })

  test.each(["permission", "cancellation", "focus", "metadata"] as const)(
    "rechecks %s at the final checked-state mutation boundary",
    async (guard) => {
      const input = checkbox()
      const clicked = vi.fn()
      input.addEventListener("click", clicked)
      const target = await discover("Accept")
      beforeInjection = async () => {
        if (guard === "permission") permission = false
        if (guard === "cancellation") await send("requests.cancel", { requestId: "check-cancel" })
        if (guard === "metadata") input.setAttribute("aria-label", "Changed")
        if (guard === "focus") {
          vi.mocked(chrome.windows.get)
            .mockImplementationOnce((async () => ({
              focused: true,
            })) as unknown as typeof chrome.windows.get)
            .mockImplementationOnce((async () => ({
              focused: false,
            })) as unknown as typeof chrome.windows.get)
        }
      }
      expect(
        await send(
          "page.setChecked",
          { ...target, checked: true },
          {
            confirmed: true,
            requestId: "check-cancel",
          },
        ),
      ).toMatchObject({ ok: false })
      expect(input.checked).toBe(false)
      expect(clicked).not.toHaveBeenCalled()
    },
  )

  test("preserves performed activation when its own handler navigates", async () => {
    const input = checkbox()
    const target = await discover("Accept")
    input.addEventListener("click", () => {
      updated(tab.id, { status: "loading" })
    })
    expect(
      await send("page.setChecked", { ...target, checked: true }, { confirmed: true }),
    ).toMatchObject({
      ok: true,
      result: { activated: true, snapshotInvalidated: true },
    })
  })

  test("option reads and filtered discovery retain normal freshness and privacy checks", async () => {
    document.body.innerHTML =
      '<select aria-label="Choice"><option value="private-value">Public label</option></select><button type="button">Go</button>'
    const target = await discover("Choice")
    const result = await send("page.getSelectOptions", target)
    expect(result).toMatchObject({ ok: true, result: { options: [{ label: "Public label" }] } })
    expect(JSON.stringify(result)).not.toContain("private-value")
    expect(await send("page.getElementDetails", target)).toMatchObject({ ok: true })
    expect(await send("page.listElements", { role: "button", name: "Go" })).toMatchObject({
      ok: true,
      result: { elements: [{ name: "Go" }] },
    })
    expect(await send("page.getSelectOptions", target)).toMatchObject({
      ok: false,
      error: { code: "STALE_CONTEXT" },
    })
    const fresh = await discover("Choice")
    permission = false
    expect(await send("page.getSelectOptions", fresh)).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    })
  })
})

describe("worker element picker lifecycle", () => {
  const host = (): HTMLElement | null =>
    document.querySelector("[data-pi-browser-agent-element-picker]")

  test("rejects synthetic shield clicks and accepts a validated top-frame result", async () => {
    const button = document.querySelector("button") as HTMLButtonElement
    const clicked = vi.fn()
    button.addEventListener("click", clicked)
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => button,
    })

    expect(await startPickerRequest()).toMatchObject({
      ok: true,
      result: { active: true },
    })
    expect(host()).not.toBeNull()
    expect(emittedEvents).toContainEqual(expect.objectContaining({ name: "elementPicker.started" }))

    const synthetic = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX: 10,
      clientY: 10,
    })
    host()?.dispatchEvent(synthetic)
    await Promise.resolve()
    expect(synthetic.isTrusted).toBe(false)
    expect(host()).not.toBeNull()
    expect(emittedEvents.some((event) => event.name === "elementPicker.selected")).toBe(false)

    const isolated = globalThis as typeof globalThis & {
      __piBrowserAgentElementPicker?: { cleanup: () => void; token: string }
    }
    const token = isolated.__piBrowserAgentElementPicker?.token
    expect(token).toBeTypeOf("string")
    isolated.__piBrowserAgentElementPicker?.cleanup()
    const accepted = await new Promise<RuntimeResponse>((resolve) => {
      listener(
        {
          kind: "element-picker-result",
          status: "selected",
          token,
          tabContext: context,
          element: selectedElement(),
        },
        { id: "extension", tab, frameId: 0 } as chrome.runtime.MessageSender,
        resolve,
      )
    })

    expect(accepted).toMatchObject({ ok: true, result: { accepted: true } })
    await vi.waitFor(() => {
      expect(emittedEvents).toContainEqual(
        expect.objectContaining({
          name: "elementPicker.selected",
          payload: expect.objectContaining({
            element: expect.objectContaining({ tagName: "button", pageUrl: location.href }),
          }),
        }),
      )
    })
    expect(clicked).not.toHaveBeenCalled()
  })

  test.each(["unsafe outcome", "injection rejection", "failure classification"] as const)(
    "a late old %s cannot clean or invalidate a replacement picker",
    async (failure) => {
      const original = executeScript.getMockImplementation()
      let release: () => void = () => undefined
      let markEntered: () => void = () => undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const entered = new Promise<void>((resolve) => {
        markEntered = resolve
      })
      executeScript.mockImplementation(async (injection) => {
        const result = (await original?.(injection)) ?? []
        if (injection.args?.[0] !== "start") return result
        executeScript.mockImplementation(original ?? (async () => []))
        if (failure === "failure classification") {
          vi.mocked(chrome.tabs.query).mockImplementationOnce(async () => {
            markEntered()
            await gate
            return [tab] as chrome.tabs.Tab[]
          })
          throw new Error("Obsolete injection failure")
        }
        markEntered()
        await gate
        if (failure === "injection rejection") throw new Error("Obsolete injection failure")
        return [{ result: { ok: true, result: { started: false, reason: "overlay-unavailable" } } }]
      })
      const old = startPickerRequest()
      await entered
      try {
        expect(await send("elementPicker.stop")).toMatchObject({ ok: true })
        expect(await startPickerRequest()).toMatchObject({ ok: true, result: { active: true } })
        const isolated = globalThis as typeof globalThis & {
          __piBrowserAgentElementPicker?: { token: string }
        }
        const replacement = isolated.__piBrowserAgentElementPicker?.token
        expect(replacement).toBeTypeOf("string")
        release()
        expect(await old).toMatchObject({ ok: false })
        expect(isolated.__piBrowserAgentElementPicker?.token).toBe(replacement)
        expect(host()).not.toBeNull()
        expect(await send("app.getState", {}, { tabContext: undefined })).toMatchObject({
          ok: true,
          result: { tabContext: context },
        })
      } finally {
        release()
        await send("elementPicker.stop", {}, { tabContext: undefined })
      }
    },
  )

  test("rejects picker start when exact-origin access was revoked", async () => {
    permission = false
    const count = injectionCount
    expect(await startPickerRequest()).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    })
    expect(injectionCount).toBe(count)
    expect(host()).toBeNull()
  })

  test("rejects an over-limit page URL before injecting the picker", async () => {
    tab.url = `https://example.test/?q=${"x".repeat(ELEMENT_PICKER_LIMITS.pageUrl)}`
    await state()
    const count = injectionCount

    expect(await startPickerRequest()).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("URL") },
    })
    expect(injectionCount).toBe(count)
    expect(host()).toBeNull()
  })

  test.each([
    ["accepts an authenticated timeout cancellation", "cancelled", true],
    ["rejects an expired selection", "selected", false],
  ] as const)("%s while releasing Side Panel state", async (_label, status, accepted) => {
    expect(await startPickerRequest()).toMatchObject({ ok: true })
    const isolated = globalThis as typeof globalThis & {
      __piBrowserAgentElementPicker?: { cleanup: () => void; token: string }
    }
    const token = isolated.__piBrowserAgentElementPicker?.token
    expect(token).toBeTypeOf("string")
    isolated.__piBrowserAgentElementPicker?.cleanup()
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + ELEMENT_PICKER_LIMITS.lifetimeMs + 1_000)

    const response = await new Promise<RuntimeResponse>((resolve) => {
      listener(
        {
          kind: "element-picker-result",
          status,
          token,
          tabContext: context,
          ...(status === "cancelled" ? { reason: "timeout" } : { element: selectedElement() }),
        },
        { id: "extension", tab, frameId: 0 } as chrome.runtime.MessageSender,
        resolve,
      )
    })

    expect(response).toMatchObject(
      accepted
        ? { ok: true, result: { accepted: true } }
        : { ok: false, error: { code: "PERMISSION_DENIED" } },
    )
    await vi.waitFor(() => {
      expect(emittedEvents).toContainEqual(
        expect.objectContaining({
          name: "elementPicker.cancelled",
          payload: expect.objectContaining({ reason: "timeout" }),
        }),
      )
    })
    expect(emittedEvents.some((event) => event.name === "elementPicker.selected")).toBe(false)
  })

  test("rejects a selection after exact-origin access is revoked", async () => {
    expect(await startPickerRequest()).toMatchObject({ ok: true })
    const isolated = globalThis as typeof globalThis & {
      __piBrowserAgentElementPicker?: { cleanup: () => void; token: string }
    }
    const token = isolated.__piBrowserAgentElementPicker?.token
    expect(token).toBeTypeOf("string")
    isolated.__piBrowserAgentElementPicker?.cleanup()
    permission = false

    const response = await new Promise<RuntimeResponse>((resolve) => {
      listener(
        {
          kind: "element-picker-result",
          status: "selected",
          token,
          tabContext: context,
          element: selectedElement(),
        },
        { id: "extension", tab, frameId: 0 } as chrome.runtime.MessageSender,
        resolve,
      )
    })

    expect(response).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } })
    await vi.waitFor(() => {
      expect(host()).toBeNull()
      expect(emittedEvents).toContainEqual(
        expect.objectContaining({
          name: "elementPicker.cancelled",
          payload: expect.objectContaining({ reason: "access-revoked" }),
        }),
      )
    })
    expect(emittedEvents.some((event) => event.name === "elementPicker.selected")).toBe(false)
  })

  test("cancels an active picker when exact-origin access is revoked", async () => {
    expect(await startPickerRequest()).toMatchObject({ ok: true })
    permission = false

    permissionRemoved()

    await vi.waitFor(() => {
      expect(host()).toBeNull()
      expect(emittedEvents).toContainEqual(
        expect.objectContaining({
          name: "elementPicker.cancelled",
          payload: expect.objectContaining({ reason: "access-revoked" }),
        }),
      )
    })
  })

  test("does not start after a concurrent stop wins permission preflight", async () => {
    let enterPermission: () => void = () => undefined
    let releasePermission: () => void = () => undefined
    const entered = new Promise<void>((resolve) => {
      enterPermission = resolve
    })
    const gate = new Promise<void>((resolve) => {
      releasePermission = resolve
    })
    vi.mocked(chrome.permissions.contains).mockImplementationOnce(async () => {
      enterPermission()
      await gate
      return true
    })

    const starting = startPickerRequest()
    await entered
    expect(await send("elementPicker.stop")).toMatchObject({ ok: true })
    releasePermission()

    await expect(starting).resolves.toMatchObject({ ok: true, result: { active: false } })
    expect(host()).toBeNull()
  })

  test("cancels and removes the injected picker when navigation starts", async () => {
    expect(await startPickerRequest()).toMatchObject({ ok: true })
    expect(host()).not.toBeNull()

    updated(tab.id, { status: "loading" })

    await vi.waitFor(() => {
      expect(host()).toBeNull()
      expect(emittedEvents).toContainEqual(
        expect.objectContaining({
          name: "elementPicker.cancelled",
          payload: expect.objectContaining({ reason: "navigation" }),
        }),
      )
    })
  })

  test.each([
    ["tab activation", () => activated(), "tab-activated"],
    ["window focus change", () => focusChanged(-1), "window-focus-changed"],
  ])("cancels on %s", async (_label, cancel, reason) => {
    expect(await startPickerRequest()).toMatchObject({ ok: true })
    cancel()
    await vi.waitFor(() => {
      expect(host()).toBeNull()
      expect(emittedEvents).toContainEqual(
        expect.objectContaining({
          name: "elementPicker.cancelled",
          payload: expect.objectContaining({ reason }),
        }),
      )
    })
  })

  test("rejects forged picker tokens and senders", async () => {
    expect(await startPickerRequest()).toMatchObject({ ok: true })
    const isolated = globalThis as typeof globalThis & {
      __piBrowserAgentElementPicker?: { token: string }
    }
    const token = isolated.__piBrowserAgentElementPicker?.token
    expect(token).toBeTypeOf("string")
    const result = (overrides: Record<string, unknown>, sender: chrome.runtime.MessageSender) =>
      new Promise<RuntimeResponse>((resolve) => {
        listener(
          {
            kind: "element-picker-result",
            status: "cancelled",
            token,
            tabContext: context,
            ...overrides,
          },
          sender,
          resolve,
        )
      })

    await expect(
      result({ token: "00000000-0000-4000-8000-000000000000" }, {
        id: "extension",
        tab,
        frameId: 0,
      } as chrome.runtime.MessageSender),
    ).resolves.toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } })
    await expect(
      result({}, { id: "other-extension", tab, frameId: 0 } as chrome.runtime.MessageSender),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    })
    expect(host()).not.toBeNull()
  })

  test("stop cleans an orphaned overlay after a service-worker restart", async () => {
    expect(await startPickerRequest()).toMatchObject({ ok: true })
    expect(host()).not.toBeNull()

    vi.resetModules()
    await import("../../src/browser/service-worker.js")
    await state()
    expect(await send("elementPicker.stop")).toMatchObject({
      ok: true,
      result: { active: false },
    })

    expect(host()).toBeNull()
  })
})
