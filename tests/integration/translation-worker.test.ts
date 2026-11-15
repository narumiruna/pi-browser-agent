import { afterEach, expect, test, vi } from "vitest"
import { hasApprovedHostPermission } from "../../src/browser/permissions.js"
import type { TabContext } from "../../src/browser/runtime/types.js"
import { installTranslationWorker } from "../../src/browser/translation-worker.js"

vi.mock("../../src/browser/permissions.js", () => ({
  hasApprovedHostPermission: vi.fn(async () => true),
}))
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.mocked(hasApprovedHostPermission).mockResolvedValue(true)
})
function event() {
  const listeners: Array<(...args: unknown[]) => unknown> = []
  return {
    addListener: (fn: (...args: unknown[]) => unknown) => listeners.push(fn),
    emit: (...args: unknown[]) =>
      listeners.forEach((fn) => {
        fn(...args)
      }),
  }
}
function setup() {
  const menus = event()
  const connect = event()
  const activated = event()
  const updated = event()
  const removed = event()
  const focus = event()
  const permissions = event()
  const session: Record<string, unknown> = {}
  let context: TabContext = { tabId: 7, url: "https://owned.example/article", epoch: 1 }
  let documentId = "web-document"
  const sender: chrome.runtime.MessageSender = {
    id: "extension",
    url: "chrome-extension://extension/sidebar/index.html",
    documentId: "ui-document",
    frameId: 0,
  }
  const executeScript = vi.fn(async () => [
    { documentId, result: { url: context.url, contentType: "text/html", owned: true } },
  ])
  const sendMessage = vi.fn(async (_message: unknown) => ({ ok: true }))
  vi.stubGlobal("chrome", {
    runtime: {
      id: "extension",
      getManifest: () => ({ side_panel: { default_path: "sidebar/index.html" } }),
      getURL: (path: string) => `chrome-extension://extension/${path}`,
      onConnect: connect,
      sendMessage,
    },
    sidePanel: { open: vi.fn(async () => undefined) },
    contextMenus: { onClicked: menus },
    scripting: { executeScript },
    action: { setBadgeText: vi.fn(async () => undefined) },
    tabs: {
      get: async () => ({ id: 7, url: context.url, windowId: 3 }),
      sendMessage,
      onActivated: activated,
      onUpdated: updated,
      onRemoved: removed,
    },
    windows: { onFocusChanged: focus },
    permissions: { onRemoved: permissions },
    storage: {
      session: {
        get: async (key: string | null) => (key ? { [key]: session[key] } : { ...session }),
        set: async (values: Record<string, unknown>) => Object.assign(session, values),
        remove: async (key: string | string[]) => {
          for (const value of Array.isArray(key) ? key : [key]) delete session[value]
        },
      },
    },
  })
  const options = {
    initialize: Promise.resolve(),
    current: async () => ({ ...context }),
    validate: async (expected: TabContext) => {
      if (
        JSON.stringify(expected) !== JSON.stringify(context) ||
        !(await hasApprovedHostPermission(context.url))
      )
        throw Error("Stale or unapproved context")
    },
    invalidateReferences: vi.fn(),
  }
  const worker = installTranslationWorker(options)
  const packet = (operation: string, payload: Record<string, unknown> = {}, owner?: string) => ({
    kind: "translation",
    operation,
    payload,
    owner: owner ?? "",
  })
  const request = (
    operation: string,
    payload: Record<string, unknown> = {},
    owner?: string,
    from = sender,
  ) => worker.handle(packet(operation, payload, owner), from)
  async function intent() {
    menus.emit(
      { menuItemId: "pi-translate-page", frameId: 0 },
      { id: 7, url: context.url, windowId: 3 },
    )
    return (await request("take", { windowId: 3 })) as { id: string }
  }
  async function claim() {
    const pending = await intent()
    return (await request("claim", { intentId: pending.id, context: { ...context } })) as {
      owner: string
    }
  }
  return {
    worker,
    options,
    packet,
    request,
    intent,
    claim,
    sender,
    session,
    menus,
    executeScript,
    sendMessage,
    context: () => context,
    setContext: (next: TabContext) => {
      context = next
    },
    replaceDocument: () => {
      documentId = "replacement-document"
    },
    activated,
    updated,
  }
}
test("content, Settings, foreign-extension, iframe and spoofed UI senders cannot administer translation", async () => {
  const f = setup()
  for (const sender of [
    { ...f.sender, id: "other-extension" },
    { ...f.sender, url: "https://owned.example/article", tab: { id: 7 } as chrome.tabs.Tab },
    { ...f.sender, url: "chrome-extension://extension/sidebar/index.html?view=settings" },
    { ...f.sender, url: "chrome-extension://extension/sidebar/index.html#spoof" },
    { ...f.sender, url: "data:text/plain,sidebar/index.html" },
    { ...f.sender, frameId: 2 },
  ])
    await expect(f.request("boot", {}, undefined, sender)).rejects.toThrow()
  expect(f.executeScript).not.toHaveBeenCalled()
  await expect(f.request("claim", { intentId: "forged", context: f.context() })).rejects.toThrow(
    "expired",
  )
})
test("a native intent is consumed once and its capability is bound to the UI and web document", async () => {
  const f = setup()
  const pending = await f.intent()
  expect(await f.request("take", { windowId: 3 })).toBeNull()
  const claimed = (await f.request("claim", { intentId: pending.id, context: f.context() })) as {
    owner: string
  }
  await expect(f.request("claim", { intentId: pending.id, context: f.context() })).rejects.toThrow(
    "expired",
  )
  await expect(
    f.request("validate", {}, claimed.owner, { ...f.sender, documentId: "other-ui" }),
  ).rejects.toThrow("owner")
  expect(
    await f.request("validate", { frameId: 0, documentId: "web-document" }, claimed.owner),
  ).toEqual(f.context())
  f.replaceDocument()
  await expect(
    f.request("validate", { frameId: 0, documentId: "web-document" }, claimed.owner),
  ).rejects.toThrow("frame changed")
})
test("wrong windows, expired intents and changed tabs cannot claim a native action", async () => {
  const f = setup()
  const pending = await f.intent()
  await expect(
    f.request("claim", { intentId: pending.id, context: f.context() }, undefined, {
      ...f.sender,
      tab: { windowId: 9 } as chrome.tabs.Tab,
    }),
  ).rejects.toThrow("window")
  const fresh = await f.intent()
  const now = Date.now()
  vi.spyOn(Date, "now").mockReturnValue(now + 300001)
  await expect(f.request("claim", { intentId: fresh.id, context: f.context() })).rejects.toThrow(
    "expired",
  )
})
test("revocation, stale context and protected capture withdrawal suppress later content publication", async () => {
  const f = setup()
  const owner = (await f.claim()).owner
  vi.mocked(hasApprovedHostPermission).mockResolvedValue(false)
  await expect(
    f.request(
      "message",
      { message: { type: "render-page-placeholders", payload: { items: [] } } },
      owner,
    ),
  ).rejects.toThrow()
  expect(
    f.sendMessage.mock.calls.some(
      ([message]) => (message as { type?: string }).type === "render-page-placeholders",
    ),
  ).toBe(false)
  vi.mocked(hasApprovedHostPermission).mockResolvedValue(true)
  f.setContext({ ...f.context(), epoch: 2 })
  await expect(f.request("validate", {}, owner)).rejects.toThrow("Stale")
  await f.worker.stopForCapture()
  await expect(f.request("validate", {}, owner)).rejects.toThrow("expired")
  expect(Object.keys(f.session)).toEqual([])
})
test("a resumed routing claim cannot overtake a replacement owner after its async freshness check", async () => {
  const f = setup()
  const oldOwner = (await f.claim()).owner
  const restarted = installTranslationWorker(f.options)
  const originalCurrent = f.options.current
  let first = true
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  f.options.current = async () => {
    if (first) {
      first = false
      await gate
    }
    return originalCurrent()
  }
  const resume = restarted
    .handle(f.packet("resume", { context: f.context() }, oldOwner), f.sender)
    .then(
      () => null,
      (error) => error,
    )
  await vi.waitFor(() => expect(first).toBe(false))
  const replacement = { ...f.sender, documentId: "replacement-ui" }
  f.menus.emit(
    { menuItemId: "pi-translate-page", frameId: 0 },
    { id: 7, url: f.context().url, windowId: 3 },
  )
  const pending = (await restarted.handle(f.packet("take", { windowId: 3 }), replacement)) as {
    id: string
  }
  const claimed = (await restarted.handle(
    f.packet("claim", { intentId: pending.id, context: f.context() }),
    replacement,
  )) as { owner: string }
  release()
  expect(await resume).toBeInstanceOf(Error)
  expect(Object.keys(f.session)).toEqual([`piBrowserAgentTranslationOwnerV1:${claimed.owner}`])
  await expect(
    restarted.handle(f.packet("validate", {}, claimed.owner), replacement),
  ).resolves.toEqual(f.context())
})
test("unrelated background navigation preserves ownership, but target navigation withdraws it", async () => {
  const f = setup()
  const owner = (await f.claim()).owner
  f.updated.emit(99, { status: "loading", url: "https://background.example/" })
  await expect(f.request("validate", {}, owner)).resolves.toEqual(f.context())
  f.updated.emit(7, { status: "loading" })
  await expect(f.request("validate", {}, owner)).rejects.toThrow("expired")
})
test.each([7, 99])(
  "navigation during a pending claim is scoped to its target: %s",
  async (tabId) => {
    const f = setup()
    let release = () => {}
    let entered = false
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    f.options.current = async () => {
      entered = true
      await gate
      return f.context()
    }
    const claim = f.claim().then(
      (value) => value,
      (error) => error,
    )
    await vi.waitFor(() => expect(entered).toBe(true))
    f.updated.emit(tabId, { status: "loading" })
    release()
    const result = await claim
    if (tabId === 7) {
      expect(result).toBeInstanceOf(Error)
      expect(Object.keys(f.session)).toEqual([])
    } else {
      expect(result.owner).toBeTypeOf("string")
      await expect(f.request("validate", {}, result.owner)).resolves.toEqual(f.context())
    }
  },
)
test("restart restores routing only for the same live UI and web document, never a dead owner", async () => {
  const f = setup()
  const owner = (await f.claim()).owner
  const restarted = installTranslationWorker(f.options)
  const result = await restarted.handle(
    f.packet("resume", { context: f.context() }, owner),
    f.sender,
  )
  expect(result).toMatchObject({ context: f.context() })
  await restarted.stopForCapture()
  const next = installTranslationWorker(f.options)
  await expect(
    next.handle(f.packet("resume", { context: f.context() }, owner), f.sender),
  ).rejects.toThrow()
  expect(Object.keys(f.session)).toEqual([])
})
