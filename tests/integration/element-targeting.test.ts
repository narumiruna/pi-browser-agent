// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  ELEMENT_PICKER_LIMITS,
  type SelectedElementContext,
} from "../../src/browser/runtime/element-context.js"
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
let focusChanged: (windowId: number) => void
let permissionRemoved: () => void
let permission: boolean
let tab: { id: number; url: string; active: boolean; windowId: number }
let context: TabContext
let beforeInjection: (() => Promise<void>) | undefined
let afterInjection: (() => Promise<void>) | undefined
let injectionCount: number
let emittedEvents: Array<{ name?: string; payload?: unknown }>

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
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: 20,
    bottom: 20,
    width: 20,
    height: 20,
  } as DOMRect)
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
  vi.stubGlobal("chrome", {
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
    scripting: {
      executeScript: vi.fn(
        async ({ func, args }: { func: (...args: unknown[]) => unknown; args?: unknown[] }) => {
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
