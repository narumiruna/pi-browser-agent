import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { PageAnnotationWorker } from "../../src/browser/page-annotation-worker.js"
import type { RuntimeRequest } from "../../src/browser/runtime/messages.js"
import {
  PAGE_ANNOTATION_LIMITS,
  type PageAnnotationOperation,
  type PageAnnotationState,
} from "../../src/browser/runtime/page-annotation.js"
import { RuntimeError } from "../../src/browser/runtime/types.js"

const clientId = "12345678-1234-1234-1234-123456789abc"
const otherClient = "12345678-1234-1234-1234-123456789abd"
const context = { tabId: 1, url: "https://example.test/", epoch: 1 }
const activeState = {
  active: true as const,
  hasStrokes: true,
  drawing: false,
  frozen: false,
  revision: 1,
  width: 800,
  height: 600,
}
const sender = {
  id: "extension",
  frameId: 0,
  tab: { id: 1, windowId: 3 },
} as chrome.runtime.MessageSender
const startRequest = (id = clientId): RuntimeRequest<"pageAnnotation.start"> => ({
  kind: "request",
  requestId: "start",
  method: "pageAnnotation.start",
  params: { clientId: id, color: "red", width: 8 },
  tabContext: context,
})
const stopRequest = (id = clientId): RuntimeRequest<"pageAnnotation.stop"> => ({
  kind: "request",
  requestId: "stop",
  method: "pageAnnotation.stop",
  params: { clientId: id },
  tabContext: context,
})
const captureRequest = (id = clientId): RuntimeRequest<"pageAnnotation.capture"> => ({
  kind: "request",
  requestId: "capture",
  method: "pageAnnotation.capture",
  params: { clientId: id },
  tabContext: context,
})
function deferred<T>() {
  let resolve = (_value: T): void => undefined
  let reject = (_error: unknown): void => undefined
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function fixture() {
  let token = ""
  let state: PageAnnotationState = { ...activeState }
  const deps = {
    beforeStart: vi.fn(async () => undefined),
    context: vi.fn(async () => ({ ...context })),
    windowId: vi.fn(async () => 3),
    validate: vi.fn(async () => undefined),
    execute: vi.fn(async (operation: PageAnnotationOperation, session: { token: string }) => {
      token = session.token
      if (operation === "freeze" && state.active && !state.drawing && state.hasStrokes)
        state = { ...state, frozen: true }
      if (operation === "resume" && state.active) state = { ...state, frozen: false }
      return { ok: true, result: state }
    }),
    cleanup: vi.fn(async (_context: typeof context, _token?: string): Promise<void> => undefined),
    emit: vi.fn(),
    capturePermission: vi.fn(async (_confirmed?: boolean): Promise<void> => undefined),
    capture: vi.fn(async () => ({
      dataUrl: "data:image/png;base64,cGl4ZWxz",
      mimeType: "image/png",
      tabContext: context,
    })),
  }
  const worker = new PageAnnotationWorker(deps)
  return {
    deps,
    worker,
    token: () => token,
    state: (value: PageAnnotationState) => {
      state = value
    },
    notification: (value: PageAnnotationState = state) => ({
      kind: "page-annotation-state" as const,
      token,
      tabContext: context,
      state: value,
    }),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal("chrome", { runtime: { id: "extension" } })
})
afterEach(() => {
  vi.useRealTimers()
  vi.resetModules()
  vi.unstubAllGlobals()
})

async function serviceFixture() {
  let runtimeListener:
    | ((
        message: unknown,
        sender: chrome.runtime.MessageSender,
        sendResponse: (response: unknown) => void,
      ) => boolean)
    | undefined
  let updated: ((id: number, change: { status?: string; url?: string }) => void) | undefined
  let revoked: (() => void) | undefined
  let scriptToken = ""
  let scriptContext = { ...context, epoch: 0 }
  let state = { ...activeState }
  let screenshotsAllowed = true
  const tab = { id: 1, url: context.url, windowId: 3, active: true, title: "Fixture" }
  const emit = vi.fn(async (_event: unknown) => undefined)
  const script = vi.fn(async (options: { func: { name: string }; args?: unknown[] }) => {
    if (options.func.name === "readDocumentContentType") return [{ result: "text/html" }]
    if (options.func.name === "stopPageAnnotationInjection")
      return [{ result: { ok: true, result: { active: false } } }]
    if (options.func.name === "executePageAnnotation") {
      scriptToken = options.args?.[1] as string
      scriptContext = options.args?.[2] as typeof context
      if (options.args?.[0] === "freeze") state = { ...state, frozen: true }
      if (options.args?.[0] === "resume") state = { ...state, frozen: false }
      return [{ result: { ok: true, result: state } }]
    }
    return []
  })
  const capture = vi.fn(async () => "data:image/png;base64,cGl4ZWxz")
  const panel = {
    id: "extension",
    url: "chrome-extension://extension/src/browser/sidepanel/index.html",
  }
  vi.stubGlobal("chrome", {
    commands: { onCommand: { addListener: vi.fn() } },
    storage: {
      local: {
        setAccessLevel: vi.fn(async () => undefined),
        get: vi.fn(async () => ({
          piBrowserAgentApprovedHostPermissions: ["https://example.test/*"],
        })),
      },
      onChanged: { addListener: vi.fn() },
    },
    permissions: {
      contains: vi.fn(async (permission: { origins?: string[] }) =>
        permission.origins?.includes("<all_urls>") ? screenshotsAllowed : true,
      ),
      getAll: vi.fn(async () => ({ origins: ["https://example.test/*"] })),
      onRemoved: {
        addListener: vi.fn((callback: () => void) => {
          revoked = callback
        }),
      },
    },
    runtime: {
      id: "extension",
      getURL: (path: string) => `chrome-extension://extension/${path}`,
      getManifest: () => ({ side_panel: { default_path: "src/browser/sidepanel/index.html" } }),
      onConnect: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      onMessage: {
        addListener: vi.fn((callback: NonNullable<typeof runtimeListener>) => {
          runtimeListener = callback
        }),
      },
      sendMessage: emit,
    },
    contextMenus: { onClicked: { addListener: vi.fn() } },
    scripting: { executeScript: script },
    tabs: {
      query: vi.fn(async () => [tab]),
      get: vi.fn(async () => tab),
      sendMessage: vi.fn(async () => undefined),
      captureVisibleTab: capture,
      onUpdated: {
        addListener: vi.fn((callback: NonNullable<typeof updated>) => {
          updated = callback
        }),
      },
      onActivated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    },
    windows: {
      WINDOW_ID_NONE: -1,
      get: vi.fn(async () => ({ focused: true })),
      onFocusChanged: { addListener: vi.fn() },
    },
  })
  await import("../../src/browser/service-worker.js")
  const request = (
    method: string,
    params: object,
    source: chrome.runtime.MessageSender = panel,
    extra: object = {},
  ): Promise<unknown> =>
    new Promise((resolve) => {
      runtimeListener?.(
        { kind: "request", requestId: crypto.randomUUID(), method, params, ...extra },
        source,
        resolve,
      )
    })
  await request("app.getState", {})
  return {
    request,
    emit,
    script,
    capture,
    panel,
    screenshots: (allowed: boolean) => {
      screenshotsAllowed = allowed
    },
    reload: (id = 1) => updated?.(id, { status: "loading" }),
    revoke: () => revoked?.(),
    notify: (
      source: chrome.runtime.MessageSender = sender,
      token = scriptToken,
      frameContext = scriptContext,
    ): Promise<unknown> =>
      new Promise((resolve) => {
        runtimeListener?.(
          { kind: "page-annotation-state", token, tabContext: frameContext, state },
          source,
          resolve,
        )
      }),
  }
}

describe("page annotation service worker routing", () => {
  test("requires the trusted panel and keeps drawing out of tool progress", async () => {
    const f = await serviceFixture()
    const params = startRequest().params
    for (const source of [
      sender,
      { ...f.panel, id: "other" },
      { ...f.panel, url: "chrome-extension://extension/src/browser/settings.html" },
      { ...f.panel, frameId: 1 },
      { ...f.panel, url: `${f.panel.url}?view=settings` },
      { ...f.panel, url: `${f.panel.url}?view=microphone` },
    ]) {
      await expect(f.request("pageAnnotation.start", params, source)).resolves.toMatchObject({
        ok: false,
        error: { code: "PERMISSION_DENIED" },
      })
    }
    f.emit.mockClear()
    await expect(f.request("pageAnnotation.start", params)).resolves.toMatchObject({
      ok: true,
      result: { clientId, state: activeState },
    })
    expect(
      f.emit.mock.calls.some(
        ([event]) => (event as unknown as { name: string }).name === "operation.progress",
      ),
    ).toBe(false)
    await expect(f.notify()).resolves.toMatchObject({ ok: true, result: { accepted: true } })
    await expect(f.notify({ ...sender, frameId: 1 })).resolves.toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    })
    await expect(f.notify(sender, otherClient)).resolves.toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    })
  })

  test("routes shape choices through validated fixed injection without geometry in messages", async () => {
    const f = await serviceFixture()
    await expect(
      f.request("pageAnnotation.start", { ...startRequest().params, tool: "arrow" }),
    ).resolves.toMatchObject({ ok: true })
    const injected = () =>
      f.script.mock.calls
        .filter(([options]) => options.func.name === "executePageAnnotation")
        .at(-1)?.[0].args
    expect(injected()?.[3]).toEqual({ color: "red", width: 8, tool: "arrow" })
    for (const tool of ["pen", "rectangle", "arrow"]) {
      await expect(
        f.request("pageAnnotation.update", { clientId, action: "tool", tool }),
      ).resolves.toMatchObject({ ok: true })
      expect(injected()?.[0]).toBe("tool")
      expect(injected()?.[3]).toEqual({ color: "red", width: 8, tool })
    }
    for (const params of [
      { clientId, action: "tool", tool: "line" },
      { clientId, action: "tool", tool: "arrow", points: [] },
    ]) {
      await expect(f.request("pageAnnotation.update", params)).resolves.toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST" },
      })
    }
    await expect(
      f.request("pageAnnotation.update", { clientId, action: "tool", tool: "rectangle" }, sender),
    ).resolves.toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } })
    await expect(f.request("pageAnnotation.capture", { clientId })).resolves.toMatchObject({
      ok: true,
      result: { clientId },
    })
    expect(f.capture).toHaveBeenCalledExactlyOnceWith(3, { format: "png" })
  })

  test("accepts the same packaged conversation in a trusted extension tab", async () => {
    const f = await serviceFixture()
    await expect(
      f.request("pageAnnotation.start", startRequest().params, {
        ...f.panel,
        frameId: 0,
        tab: { id: 9 } as chrome.tabs.Tab,
      }),
    ).resolves.toMatchObject({ ok: true, result: { clientId, state: activeState } })
  })

  test("uses existing screenshot confirmation and permission retry checks", async () => {
    const f = await serviceFixture()
    f.screenshots(false)
    await f.request("pageAnnotation.start", startRequest().params)
    await expect(f.request("pageAnnotation.capture", { clientId })).resolves.toMatchObject({
      ok: false,
      error: { code: "CONFIRMATION_REQUIRED", details: { requiredPermission: "<all_urls>" } },
    })
    expect(f.capture).not.toHaveBeenCalled()
    await expect(
      f.request("pageAnnotation.capture", { clientId }, f.panel, { confirmed: true }),
    ).resolves.toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } })
    f.screenshots(true)
    await expect(
      f.request("pageAnnotation.capture", { clientId }, f.panel, { confirmed: true }),
    ).resolves.toMatchObject({
      ok: true,
      result: { clientId, dataUrl: "data:image/png;base64,cGl4ZWxz" },
    })
    expect(f.capture).toHaveBeenCalledExactlyOnceWith(3, { format: "png" })
  })

  test("target reload cancels drawing but background reload does not", async () => {
    const f = await serviceFixture()
    await f.request("pageAnnotation.start", startRequest().params)
    f.reload(99)
    await expect(f.notify()).resolves.toMatchObject({ ok: true })
    f.reload()
    await expect(f.request("pageAnnotation.capture", { clientId })).resolves.toMatchObject({
      ok: false,
      error: { code: "REQUEST_CANCELLED" },
    })
    expect(f.capture).not.toHaveBeenCalled()
  })

  test("pending startup owns its target before the document lookup completes", async () => {
    const f = await serviceFixture()
    const probe = deferred<void>()
    const entered = vi.fn()
    f.script.mockImplementationOnce(async () => {
      entered()
      await probe.promise
      return [{ result: "text/html" }]
    })
    const starting = f.request("pageAnnotation.start", startRequest().params)
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
    f.reload()
    probe.resolve(undefined)
    await expect(starting).resolves.toMatchObject({
      ok: false,
      error: { code: expect.stringMatching(/STALE_CONTEXT|REQUEST_CANCELLED/) },
    })
    expect(
      f.script.mock.calls.some(([options]) => options.func.name === "executePageAnnotation"),
    ).toBe(false)
  })

  test("an unreadable document cannot install drawing", async () => {
    const f = await serviceFixture()
    f.script.mockImplementationOnce(async () => [{ result: "application/pdf" }])
    await expect(f.request("pageAnnotation.start", startRequest().params)).resolves.toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    })
    expect(
      f.script.mock.calls.some(([options]) => options.func.name === "executePageAnnotation"),
    ).toBe(false)
    expect(f.capture).not.toHaveBeenCalled()
  })

  test("a live stop acknowledgement confirms cleanup when new injection is unavailable", async () => {
    const f = await serviceFixture()
    await f.request("pageAnnotation.start", startRequest().params)
    vi.mocked(chrome.tabs.sendMessage).mockImplementation(async () => ({ active: false }))
    f.script.mockClear()
    f.script.mockRejectedValue(new Error("site permission revoked"))
    await expect(f.request("pageAnnotation.stop", { clientId })).resolves.toMatchObject({
      ok: true,
      result: { active: false },
    })
    expect(f.script).not.toHaveBeenCalled()
  })

  test.each(["same-document-url", "unknown-lookup-error"])(
    "failed cleanup stays blocked after %s",
    async (failure) => {
      const f = await serviceFixture()
      await f.request("pageAnnotation.start", startRequest().params)
      vi.mocked(chrome.tabs.sendMessage).mockRejectedValue(new Error("no receiver"))
      f.script.mockRejectedValue(new Error("injection denied"))
      if (failure === "unknown-lookup-error")
        vi.mocked(chrome.tabs.query).mockRejectedValue(new Error("transient query error"))
      else
        vi.mocked(chrome.tabs.query).mockImplementation(async () => [
          { id: 1, url: `${context.url}new-path` } as chrome.tabs.Tab,
        ])
      await expect(f.request("pageAnnotation.stop", { clientId })).resolves.toMatchObject({
        ok: false,
        error: { code: "INTERNAL_ERROR" },
      })
    },
  )

  test("a successful all-tab lookup can confirm a closed target", async () => {
    const f = await serviceFixture()
    await f.request("pageAnnotation.start", startRequest().params)
    vi.mocked(chrome.tabs.sendMessage).mockRejectedValue(new Error("closed tab"))
    f.script.mockRejectedValue(new Error("closed tab"))
    vi.mocked(chrome.tabs.query).mockImplementation(async () => [])
    await expect(f.request("pageAnnotation.stop", { clientId })).resolves.toMatchObject({
      ok: true,
      result: { active: false },
    })
  })

  test("worker startup performs both message and fixed orphan cleanup", async () => {
    const f = await serviceFixture()
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      1,
      { kind: "page-annotation-stop" },
      { frameId: 0 },
    )
    expect(f.script).toHaveBeenCalledWith(
      expect.objectContaining({ func: expect.any(Function), args: [], world: "ISOLATED" }),
    )
  })
})

describe("page annotation worker ownership and capture", () => {
  test("starts, updates settings, and stops only the owning client", async () => {
    const f = fixture()
    await expect(f.worker.start(startRequest())).resolves.toEqual({ clientId, state: activeState })
    await expect(
      f.worker.update({
        ...captureRequest(),
        method: "pageAnnotation.update",
        params: { clientId, action: "color", color: "blue" },
      }),
    ).resolves.toEqual({ clientId, state: activeState })
    expect(f.deps.execute).toHaveBeenLastCalledWith(
      "color",
      expect.objectContaining({ settings: { color: "blue", width: 8, tool: "pen" } }),
    )
    await expect(f.worker.stop(stopRequest(otherClient))).rejects.toMatchObject({
      code: "REQUEST_CANCELLED",
    })
    await expect(f.worker.stop(stopRequest())).resolves.toEqual({ active: false })
    expect(f.deps.cleanup).toHaveBeenLastCalledWith(context, f.token())
  })

  test.each([{ id: "other-extension" }, { frameId: 2 }, { tab: { id: 2 } }])(
    "rejects forged notification senders %j",
    async (change) => {
      const f = fixture()
      await f.worker.start(startRequest())
      await expect(
        f.worker.notification(f.notification(), {
          ...sender,
          ...change,
        } as chrome.runtime.MessageSender),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" })
    },
  )

  test("rejects stale tokens and exact-context mismatches", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    await expect(
      f.worker.notification({ ...f.notification(), token: otherClient }, sender),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" })
    await expect(
      f.worker.notification({ ...f.notification(), tabContext: { ...context, epoch: 2 } }, sender),
    ).rejects.toMatchObject({ code: "STALE_CONTEXT" })
  })

  test("delivers early state before startup completes and ignores older startup revisions", async () => {
    const f = fixture()
    const setup = deferred<unknown>()
    f.deps.execute.mockImplementationOnce(async (_operation, session) => {
      await f.worker.notification(
        {
          kind: "page-annotation-state",
          token: session.token,
          tabContext: context,
          state: { ...activeState, revision: 2 },
        },
        sender,
      )
      await setup.promise
      return { ok: true, result: activeState }
    })
    const starting = f.worker.start(startRequest())
    await vi.waitFor(() =>
      expect(f.deps.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "pageAnnotation.changed",
          payload: { clientId, state: { ...activeState, revision: 2 } },
        }),
      ),
    )
    setup.resolve(undefined)
    await expect(starting).resolves.toMatchObject({ state: { revision: 2 } })
  })

  test("acknowledges early cancellation without waiting for startup's paint reply", async () => {
    const f = fixture()
    f.deps.execute.mockImplementationOnce(async (_operation, session) => {
      await expect(
        f.worker.notification(
          {
            kind: "page-annotation-state",
            token: session.token,
            tabContext: context,
            state: { active: false },
            reason: "user",
          },
          sender,
        ),
      ).resolves.toEqual({ accepted: true })
      return { ok: true, result: { active: false } }
    })
    await expect(f.worker.start(startRequest())).rejects.toMatchObject({
      code: "REQUEST_CANCELLED",
    })
    expect(f.deps.cleanup).toHaveBeenCalledWith(context, expect.any(String))
  })

  test("stop invalidates pending lookup before a token exists", async () => {
    const f = fixture()
    const lookup = deferred<{ tabId: number; url: string; epoch: number }>()
    f.deps.context.mockReturnValueOnce(lookup.promise)
    const starting = f.worker.start(startRequest())
    const rejected = expect(starting).rejects.toMatchObject({ code: "REQUEST_CANCELLED" })
    await vi.waitFor(() => expect(f.deps.context).toHaveBeenCalled())
    const stopping = f.worker.stop(stopRequest())
    lookup.resolve(context)
    await rejected
    await expect(stopping).resolves.toEqual({ active: false })
    expect(f.deps.execute).not.toHaveBeenCalled()
  })

  test("stop waits for late setup cleanup before a replacement can start", async () => {
    const f = fixture()
    const setup = deferred<{ ok: true; result: PageAnnotationState }>()
    f.deps.execute.mockImplementationOnce(async () => setup.promise)
    const old = f.worker.start(startRequest())
    const rejected = expect(old).rejects.toMatchObject({ code: "REQUEST_CANCELLED" })
    await vi.waitFor(() => expect(f.deps.execute).toHaveBeenCalled())
    const firstToken = f.deps.execute.mock.calls[0]?.[1].token
    const stopping = f.worker.stop(stopRequest())
    const replacement = f.worker.start(startRequest(otherClient))
    expect(f.deps.execute).toHaveBeenCalledTimes(1)
    setup.resolve({ ok: true, result: activeState })
    await rejected
    await stopping
    await replacement
    const replacementToken = f.token()
    expect(replacementToken).not.toBe(firstToken)
    expect(
      f.deps.cleanup.mock.calls.filter((call) => call[1] === firstToken).length,
    ).toBeGreaterThanOrEqual(2)
    await expect(
      f.worker.notification({ ...f.notification(), token: firstToken as string }, sender),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" })
    expect(f.deps.cleanup).not.toHaveBeenCalledWith(context, replacementToken)
  })

  test("disconnect during window lookup cancels pending startup", async () => {
    const f = fixture()
    const lookup = deferred<number>()
    f.deps.windowId.mockReturnValueOnce(lookup.promise)
    const starting = f.worker.start(startRequest())
    const rejected = expect(starting).rejects.toMatchObject({ code: "REQUEST_CANCELLED" })
    await vi.waitFor(() => expect(f.deps.windowId).toHaveBeenCalled())
    f.worker.disconnect(3)
    lookup.resolve(3)
    await rejected
    expect(f.deps.execute).not.toHaveBeenCalled()
  })

  test("ignores unrelated navigation but cancels same-URL reload and expiry", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    f.worker.navigation(99)
    await expect(f.worker.notification(f.notification(), sender)).resolves.toEqual({
      accepted: true,
    })
    f.worker.navigation(1)
    await expect(f.worker.capture(captureRequest())).rejects.toMatchObject({
      code: "REQUEST_CANCELLED",
    })
    await f.worker.start(startRequest())
    await vi.advanceTimersByTimeAsync(PAGE_ANNOTATION_LIMITS.lifetimeMs)
    expect(f.deps.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "pageAnnotation.cancelled",
        payload: expect.objectContaining({ reason: "timeout" }),
      }),
    )
    await expect(f.worker.capture(captureRequest())).rejects.toMatchObject({
      code: "REQUEST_CANCELLED",
    })
  })

  test("reversed notification validation cannot restore an older pointer-start state", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    const gate = deferred<undefined>()
    f.deps.validate.mockReturnValueOnce(gate.promise)
    const older = f.worker.notification(
      f.notification({ ...activeState, drawing: true, revision: 2 }),
      sender,
    )
    await f.worker.notification(
      f.notification({ ...activeState, drawing: false, revision: 3 }),
      sender,
    )
    gate.resolve(undefined)
    await older
    expect(f.deps.emit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          state: expect.objectContaining({ drawing: false, revision: 3 }),
        }),
      }),
    )
  })

  test("denied site access prevents setup and capture", async () => {
    const f = fixture()
    f.deps.validate.mockRejectedValueOnce(new RuntimeError("PERMISSION_DENIED", "denied"))
    await expect(f.worker.start(startRequest())).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    })
    expect(f.deps.execute).not.toHaveBeenCalled()
    await f.worker.start(startRequest())
    f.deps.validate.mockRejectedValueOnce(new RuntimeError("PERMISSION_DENIED", "denied"))
    await expect(f.worker.capture(captureRequest())).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    })
    expect(f.deps.capture).not.toHaveBeenCalled()
  })

  test.each(["tab-activated", "window-focus-changed"] as const)(
    "%s invalidates capture ownership",
    async (reason) => {
      const f = fixture()
      await f.worker.start(startRequest())
      f.worker.contextChanged(reason)
      await expect(f.worker.capture(captureRequest())).rejects.toMatchObject({
        code: "REQUEST_CANCELLED",
      })
      expect(f.deps.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "pageAnnotation.cancelled",
          payload: expect.objectContaining({ reason }),
        }),
      )
    },
  )

  test("cancels when access is revoked", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    f.deps.validate.mockRejectedValueOnce(new RuntimeError("PERMISSION_DENIED", "denied"))
    await f.worker.accessChanged()
    await expect(f.worker.capture(captureRequest())).rejects.toMatchObject({
      code: "REQUEST_CANCELLED",
    })
    expect(f.deps.cleanup).toHaveBeenLastCalledWith(context, f.token())
  })

  test("a restarted worker cleans the original window rather than its new visible target", async () => {
    const f = fixture()
    f.deps.context.mockResolvedValue({ ...context, tabId: 99, url: "https://other-window.test/" })
    await expect(f.worker.stop(stopRequest())).resolves.toEqual({ active: false })
    expect(f.deps.cleanup).toHaveBeenCalledWith(context)
    expect(f.deps.context).not.toHaveBeenCalled()
  })

  test("reports failed cleanup explicitly and permits a later cleanup retry", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    f.deps.cleanup.mockRejectedValueOnce(new RuntimeError("INTERNAL_ERROR", "cleanup failed"))
    await expect(f.worker.stop(stopRequest())).rejects.toMatchObject({ code: "INTERNAL_ERROR" })
    await expect(f.worker.stop(stopRequest())).resolves.toEqual({ active: false })
  })

  test("captures a completed mixed-tool revision and retains owner/context checks", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    for (const tool of ["pen", "arrow", "rectangle"] as const) {
      await f.worker.update({
        ...captureRequest(),
        method: "pageAnnotation.update",
        params: { clientId, action: "tool", tool },
      })
      expect(f.deps.execute).toHaveBeenLastCalledWith(
        "tool",
        expect.objectContaining({ settings: { tool, color: "red", width: 8 } }),
      )
    }
    await expect(
      f.worker.update({
        ...captureRequest(otherClient),
        method: "pageAnnotation.update",
        params: { clientId: otherClient, action: "tool", tool: "arrow" },
      }),
    ).rejects.toMatchObject({ code: "REQUEST_CANCELLED" })
    await expect(
      f.worker.update({
        ...captureRequest(),
        tabContext: { ...context, epoch: 2 },
        method: "pageAnnotation.update",
        params: { clientId, action: "tool", tool: "arrow" },
      }),
    ).rejects.toMatchObject({ code: "STALE_CONTEXT" })
    f.state({ ...activeState, revision: 9 })
    await expect(f.worker.capture(captureRequest())).resolves.toMatchObject({ clientId })
    expect(f.deps.execute).toHaveBeenLastCalledWith(
      "state",
      expect.objectContaining({ settings: { tool: "rectangle", color: "red", width: 8 } }),
    )
    expect(f.deps.capture).toHaveBeenCalledOnce()
  })

  test("a late shape update cannot change or revive a replacement surface", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    const gate = deferred<{ ok: true; result: PageAnnotationState }>()
    f.deps.execute.mockReturnValueOnce(gate.promise)
    const updating = f.worker.update({
      ...captureRequest(),
      method: "pageAnnotation.update",
      params: { clientId, action: "tool", tool: "arrow" },
    })
    const rejected = expect(updating).rejects.toMatchObject({ code: "REQUEST_CANCELLED" })
    await vi.waitFor(() =>
      expect(f.deps.execute).toHaveBeenLastCalledWith("tool", expect.anything()),
    )
    await f.worker.stop(stopRequest())
    await f.worker.start({
      ...startRequest(otherClient),
      params: { ...startRequest(otherClient).params, tool: "rectangle" },
    })
    gate.resolve({ ok: true, result: activeState })
    await rejected
    await expect(f.worker.capture(captureRequest(otherClient))).resolves.toMatchObject({
      clientId: otherClient,
    })
    expect(f.deps.execute).toHaveBeenLastCalledWith(
      "state",
      expect.objectContaining({ settings: { tool: "rectangle", color: "red", width: 8 } }),
    )
  })

  test("freezes and revalidates protection before and after one capture", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    await expect(f.worker.capture(captureRequest())).resolves.toMatchObject({
      clientId,
      dataUrl: "data:image/png;base64,cGl4ZWxz",
    })
    expect(f.deps.execute.mock.calls.map(([operation]) => operation)).toEqual([
      "start",
      "state",
      "freeze",
      "state",
      "state",
    ])
    expect(f.deps.capture).toHaveBeenCalledTimes(1)
    expect(f.deps.capturePermission).toHaveBeenCalledTimes(2)
  })

  test("missing screenshot permission preserves editable drawing without capture", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    f.deps.capturePermission.mockRejectedValueOnce(
      new RuntimeError("CONFIRMATION_REQUIRED", "confirm", { requiredPermission: "<all_urls>" }),
    )
    await expect(f.worker.capture(captureRequest())).rejects.toMatchObject({
      code: "CONFIRMATION_REQUIRED",
      details: { requiredPermission: "<all_urls>" },
    })
    expect(f.deps.capture).not.toHaveBeenCalled()
    expect(f.deps.execute).not.toHaveBeenCalledWith("freeze", expect.anything())
    await expect(
      f.worker.capture({ ...captureRequest(), confirmed: true }),
    ).resolves.toHaveProperty("clientId", clientId)
  })

  test.each([
    { ...activeState, drawing: true },
    { ...activeState, hasStrokes: false },
  ])("does not capture an incomplete or empty drawing %j", async (state) => {
    const f = fixture()
    await f.worker.start(startRequest())
    f.state(state)
    await expect(f.worker.capture(captureRequest())).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    })
    expect(f.deps.capture).not.toHaveBeenCalled()
  })

  test("rejects a freeze that did not freeze the surface", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    f.deps.execute.mockImplementation(async () => ({ ok: true, result: activeState }))
    await expect(f.worker.capture(captureRequest())).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    })
    expect(f.deps.capture).not.toHaveBeenCalled()
  })

  test("recovers editable drawing after capture failure without replay", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    f.deps.capture.mockRejectedValueOnce(new RuntimeError("INTERNAL_ERROR", "capture failed"))
    await expect(f.worker.capture(captureRequest())).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    })
    expect(f.deps.capture).toHaveBeenCalledTimes(1)
    expect(f.deps.execute).toHaveBeenLastCalledWith("resume", expect.anything())
    await expect(f.worker.capture(captureRequest())).resolves.toHaveProperty("clientId", clientId)
  })

  test("screenshot access revoked during capture rejects the image and resumes safely", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    f.deps.capturePermission
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new RuntimeError("PERMISSION_DENIED", "revoked"))
    await expect(f.worker.capture({ ...captureRequest(), confirmed: true })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    })
    expect(f.deps.capture).toHaveBeenCalledTimes(1)
    expect(f.deps.execute).toHaveBeenLastCalledWith("resume", expect.anything())
  })

  test.each([{ action: "clear" }, { action: "tool", tool: "arrow" }] as const)(
    "does not overlap %j with pending capture",
    async (update) => {
      const f = fixture()
      const image = deferred<{ dataUrl: string; mimeType: string; tabContext: typeof context }>()
      await f.worker.start(startRequest())
      f.deps.capture.mockReturnValueOnce(image.promise)
      const capturing = f.worker.capture(captureRequest())
      await vi.waitFor(() => expect(f.deps.capture).toHaveBeenCalled())
      await expect(
        f.worker.update({
          ...captureRequest(),
          method: "pageAnnotation.update",
          params: { clientId, ...update },
        }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" })
      image.resolve({
        dataUrl: "data:image/png;base64,cGl4ZWxz",
        mimeType: "image/png",
        tabContext: context,
      })
      await capturing
      expect(f.deps.execute.mock.calls.some(([operation]) => operation === update.action)).toBe(
        false,
      )
    },
  )

  test("rejects oversized image output and resumes drawing", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    f.deps.capture.mockResolvedValueOnce({
      dataUrl: `data:image/png;base64,${"a".repeat(3_000_000)}`,
      mimeType: "image/png",
      tabContext: context,
    })
    await expect(f.worker.capture(captureRequest())).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    })
    expect(f.deps.execute).toHaveBeenLastCalledWith("resume", expect.anything())
  })

  test("rejects changed geometry and protection after screenshot", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    f.deps.capture.mockImplementationOnce(async () => {
      f.state({ ...activeState, frozen: true, width: 900 })
      return {
        dataUrl: "data:image/png;base64,cGl4ZWxz",
        mimeType: "image/png",
        tabContext: context,
      }
    })
    await expect(f.worker.capture(captureRequest())).rejects.toMatchObject({
      code: "STALE_CONTEXT",
    })
    expect(f.deps.cleanup).toHaveBeenLastCalledWith(context, f.token())
  })

  test("stop during pending capture rejects its late result and never resumes a replacement", async () => {
    const f = fixture()
    const image = deferred<{ dataUrl: string; mimeType: string; tabContext: typeof context }>()
    await f.worker.start(startRequest())
    f.deps.capture.mockReturnValueOnce(image.promise)
    const capturing = f.worker.capture(captureRequest())
    const rejected = expect(capturing).rejects.toMatchObject({ code: "REQUEST_CANCELLED" })
    await vi.waitFor(() => expect(f.deps.capture).toHaveBeenCalled())
    await f.worker.stop(stopRequest())
    await f.worker.start(startRequest(otherClient))
    image.resolve({
      dataUrl: "data:image/png;base64,cGl4ZWxz",
      mimeType: "image/png",
      tabContext: context,
    })
    await rejected
    expect(f.deps.execute.mock.calls.filter(([operation]) => operation === "resume")).toHaveLength(
      0,
    )
  })

  test("late screenshot permission replies cannot revive a cancelled token", async () => {
    const f = fixture()
    const permission = deferred<void>()
    await f.worker.start(startRequest())
    f.deps.capturePermission.mockReturnValueOnce(permission.promise)
    const capturing = f.worker.capture(captureRequest())
    const rejected = expect(capturing).rejects.toMatchObject({ code: "REQUEST_CANCELLED" })
    await vi.waitFor(() => expect(f.deps.capturePermission).toHaveBeenCalled())
    await f.worker.stop(stopRequest())
    permission.resolve(undefined)
    await rejected
    expect(f.deps.capture).not.toHaveBeenCalled()
  })
})
