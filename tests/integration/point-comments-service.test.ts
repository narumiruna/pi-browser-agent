import { afterEach, describe, expect, test, vi } from "vitest"
import type { RuntimeResponse } from "../../src/browser/runtime/messages.js"
import { deferred, pinClientId, pinContext, pointPin } from "../helpers/point-comments.js"

async function fixture() {
  let listener!: (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    reply: (value: unknown) => void,
  ) => boolean
  let token = ""
  let generation = 0
  let context = { ...pinContext, epoch: 0 }
  let targets: unknown[] = []
  let sequence = 0
  let cleanupAllowed = true
  const tab = {
    id: pinContext.tabId,
    url: pinContext.url,
    windowId: 3,
    active: true,
    title: "Fixture",
  }
  const panel = {
    id: "extension",
    frameId: 0,
    url: "chrome-extension://extension/src/browser/sidepanel/index.html",
  }
  const script = vi.fn(async (options: { func: { name: string }; args?: unknown[] }) => {
    const containsUndefined = (value: unknown): boolean =>
      value === undefined ||
      (Array.isArray(value)
        ? value.some(containsUndefined)
        : !!value && typeof value === "object" && Object.values(value).some(containsUndefined))
    // Chrome rejects undefined in scripting args. Mocks must preserve that boundary.
    expect(options.args === undefined || !containsUndefined(options.args)).toBe(true)
    if (options.func.name === "readDocumentContentType") return [{ result: "text/html" }]
    if (options.func.name === "stopPageAnnotationInjection")
      return [{ result: { ok: true, result: { active: false } } }]
    if (options.func.name === "executePointCommentsControl") {
      const [operation, , id] = options.args ?? []
      if (operation === "stop") {
        if (!cleanupAllowed) throw new Error("Cleanup denied")
        return [{ result: { active: false } }]
      }
      if (operation === "clear") targets = []
      if (operation === "remove")
        targets = targets.filter((target) => (target as { id: string }).id !== id)
      if (operation === "submit" && !cleanupAllowed) throw new Error("Cleanup denied")
      return [{ result: { active: operation !== "submit", sequence, targets } }]
    }
    if (options.func.name === "executeElementPicker" && options.args?.[4]) {
      token = String(options.args[1])
      context = options.args[2] as typeof context
      generation = (options.args[4] as { generation: number }).generation
      return [{ result: { ok: true, result: { started: true } } }]
    }
    return []
  })
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
      contains: vi.fn(async () => true),
      getAll: vi.fn(async () => ({ origins: ["https://example.test/*"] })),
      onRemoved: { addListener: vi.fn() },
    },
    runtime: {
      id: "extension",
      getURL: (path: string) => `chrome-extension://extension/${path}`,
      getManifest: () => ({ side_panel: { default_path: "src/browser/sidepanel/index.html" } }),
      onConnect: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      onMessage: {
        addListener: vi.fn((callback) => {
          listener = callback
        }),
      },
      sendMessage: vi.fn(async () => undefined),
    },
    contextMenus: { onClicked: { addListener: vi.fn() } },
    scripting: { executeScript: script },
    tabs: {
      query: vi.fn(async () => [tab]),
      get: vi.fn(async () => tab),
      sendMessage: vi.fn(async () => undefined),
      onUpdated: { addListener: vi.fn() },
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
  const message = (
    value: unknown,
    source: chrome.runtime.MessageSender = panel,
  ): Promise<RuntimeResponse> =>
    new Promise((resolve) => {
      listener(value, source, (value) => resolve(value as RuntimeResponse))
    })
  const request = (
    method: string,
    params: object,
    source = panel,
    extra: object = {},
  ): Promise<RuntimeResponse> =>
    message({ kind: "request", requestId: crypto.randomUUID(), method, params, ...extra }, source)
  await request("app.getState", {})
  const start = () =>
    request("pointComments.start", { clientId: pinClientId, capacity: 5, nextNumber: 1 })
  const select = async (number = 1) => {
    const { note: _note, ...target } = pointPin(number)
    const result = await message(
      {
        kind: "point-comments-result",
        token,
        generation,
        tabContext: context,
        sequence: ++sequence,
        status: "selected",
        target,
      },
      { id: "extension", frameId: 0, tab: { id: tab.id } } as chrome.runtime.MessageSender,
    )
    if (result.ok) targets.push(target)
    return result
  }
  return {
    request,
    start,
    select,
    script,
    panel,
    context: () => context,
    cleanup: (allowed: boolean) => {
      cleanupAllowed = allowed
    },
    message,
  }
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe("pointComments packaged sender and scripting bridge", () => {
  test("fresh start, selection, remove, clear and guarded submit use JSON-safe args", async () => {
    const f = await fixture()
    expect(await f.start()).toMatchObject({ ok: true })
    expect(await f.select()).toMatchObject({ ok: true })
    expect(
      await f.request(
        "pointComments.remove",
        { clientId: pinClientId, id: pointPin().id },
        f.panel,
        { tabContext: f.context() },
      ),
    ).toMatchObject({ ok: true })
    expect(
      await f.request("pointComments.clear", { clientId: pinClientId }, f.panel, {
        tabContext: f.context(),
      }),
    ).toMatchObject({ ok: true })
    expect(
      await f.request("pointComments.stop", { clientId: pinClientId, submit: true }, f.panel, {
        tabContext: f.context(),
      }),
    ).toMatchObject({ ok: true, result: { active: false, targets: [] } })
    expect(
      f.script.mock.calls.some(
        ([options]) =>
          options.func.name === "executePointCommentsControl" && options.args?.length === 1,
      ),
    ).toBe(true)
  })
  test("page, iframe, Settings, microphone, foreign extension and alternate path senders are rejected", async () => {
    const f = await fixture()
    for (const source of [
      { ...f.panel, id: "other" },
      { ...f.panel, frameId: 1 },
      { ...f.panel, url: "https://example.test/" },
      { ...f.panel, url: `${f.panel.url}?view=settings` },
      { ...f.panel, url: `${f.panel.url}?view=microphone` },
      { ...f.panel, url: f.panel.url.replace("index.html", "other.html") },
    ])
      expect(
        await f.request(
          "pointComments.start",
          { clientId: pinClientId, capacity: 5, nextNumber: 1 },
          source,
        ),
      ).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } })
  })
  test("repeated removal failure stays blocked and a later explicit Stop retries actual cleanup", async () => {
    const f = await fixture()
    await f.start()
    await f.select()
    f.cleanup(false)
    const params = { clientId: pinClientId }
    expect(
      await f.request("pointComments.stop", params, f.panel, { tabContext: f.context() }),
    ).toMatchObject({ ok: false })
    expect(
      await f.request("pointComments.stop", params, f.panel, { tabContext: f.context() }),
    ).toMatchObject({ ok: false })
    f.cleanup(true)
    expect(
      await f.request("pointComments.stop", params, f.panel, { tabContext: f.context() }),
    ).toMatchObject({ ok: true, result: { active: false } })
  })
  test("concurrent pin and drawing starts settle without cyclic startup waits", async () => {
    const f = await fixture()
    const gate = deferred<void>()
    const original = f.script.getMockImplementation()
    let entered = false
    f.script.mockImplementation(async (options) => {
      if (options.func.name === "executeElementPicker" && options.args?.[4]) {
        entered = true
        await gate.promise
      }
      return (await original?.(options)) ?? []
    })
    const pins = f.start()
    await vi.waitFor(() => expect(entered).toBe(true))
    const drawing = f.request("pageAnnotation.start", {
      clientId: crypto.randomUUID(),
      color: "red",
      width: 8,
    })
    gate.resolve()
    const results = await Promise.all([pins, drawing])
    expect(results.every((result) => typeof result.ok === "boolean")).toBe(true)
    await f.request("pointComments.stop", { clientId: pinClientId }, f.panel, {
      tabContext: f.context(),
    })
  })
})
