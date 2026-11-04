import { readFileSync } from "node:fs"
import { JSDOM } from "jsdom"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { LocalApi, LocalConnection } from "../../src/browser/coding-agent/protocol.js"
import * as store from "../../src/browser/coding-agent/store.js"
import { setLanguagePreference } from "../../src/browser/i18n/index.js"
import { initializeCodingConnectionSettings } from "../../src/browser/sidepanel/coding-connection-settings.js"
import type { ConfirmSettingsAction } from "../../src/browser/sidepanel/settings-confirmation.js"

const html = readFileSync(
  new URL("../../src/browser/sidepanel/index.html", import.meta.url),
  "utf8",
)
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const connection = (patch: Partial<LocalConnection> = {}): LocalConnection => ({
  clientId: id(1),
  generation: id(2),
  windowId: 7,
  state: "pending",
  ...patch,
})
const environments: JSDOM[] = []

afterEach(async () => {
  for (const dom of environments.splice(0)) {
    dom.window.dispatchEvent(new dom.window.Event("pagehide"))
    await settle()
    dom.window.close()
  }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function setup(initial?: LocalConnection) {
  setLanguagePreference("en")
  const data: Record<string, unknown> = initial
    ? { [store.CODING_CONNECTION_KEY]: structuredClone(initial) }
    : {}
  const storageListeners = new Set<
    (changes: Record<string, chrome.storage.StorageChange>, area: string) => void
  >()
  const emit = (changes: Record<string, chrome.storage.StorageChange>, area = "session") => {
    for (const listener of storageListeners) listener(changes, area)
  }
  const session = {
    get: vi.fn(async (key: string) => ({ [key]: data[key] })),
    set: vi.fn(async (values: Record<string, unknown>) => {
      const changes: Record<string, chrome.storage.StorageChange> = {}
      for (const [key, value] of Object.entries(values)) {
        changes[key] = { oldValue: data[key], newValue: structuredClone(value) }
        data[key] = structuredClone(value)
      }
      emit(changes)
    }),
    setAccessLevel: vi.fn(async () => undefined),
  }
  const local = {
    get: vi.fn(async () => ({
      piBrowserAgentCodingConnectionV1: {
        version: 1,
        connection: { state: "paired" },
        credential: { token: "obsolete-token" },
      },
    })),
    set: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  }
  const open = vi.fn(async (_options: { windowId: number }): Promise<void> => undefined)
  const getCurrent = vi.fn(async () => ({ id: 7 }))
  const removeWindow = vi.fn()
  const removeTab = vi.fn()
  const fetch = vi.fn(() => {
    throw new Error("Unexpected network request")
  })
  const permissions = { request: vi.fn(), contains: vi.fn(), getAll: vi.fn() }
  vi.stubGlobal("chrome", {
    storage: {
      session,
      local,
      onChanged: {
        addListener: vi.fn((listener) => storageListeners.add(listener)),
        removeListener: vi.fn((listener) => storageListeners.delete(listener)),
      },
    },
    windows: { getCurrent, remove: removeWindow },
    tabs: { remove: removeTab },
    sidePanel: { open },
    permissions,
  })
  vi.stubGlobal("navigator", {})
  vi.stubGlobal("fetch", fetch)
  const dom = new JSDOM(html)
  const close = vi.spyOn(dom.window, "close")
  environments.push(dom)
  vi.stubGlobal("window", dom.window)
  vi.stubGlobal("document", dom.window.document)
  const get = <T extends HTMLElement>(name: string): T => {
    const element = dom.window.document.getElementById(name)
    if (!element) throw new Error(`Missing test element: ${name}`)
    return element as T
  }
  get("settings-page").hidden = false
  get("settings-panel-model").hidden = true
  get("settings-panel-tools").hidden = false
  const send = vi.fn()
  get("send").addEventListener("click", send)
  const confirm = vi.fn<ConfirmSettingsAction>().mockResolvedValue(true)
  const changed = vi.fn()
  const state = await initializeCodingConnectionSettings(confirm, changed)
  const api: LocalApi | undefined = dom.window.__piBrowserLocal
  if (!api) throw new Error("Missing local Settings API")
  return {
    data,
    session,
    local,
    storageListeners,
    emit,
    open,
    getCurrent,
    removeWindow,
    removeTab,
    close,
    fetch,
    permissions,
    dom,
    document: dom.window.document,
    get,
    confirm,
    send,
    changed,
    state,
    api,
    allow: get<HTMLButtonElement>("coding-allow"),
    disconnect: get<HTMLButtonElement>("coding-disconnect"),
    status: get("coding-status"),
    pagehide: () => dom.window.dispatchEvent(new dom.window.Event("pagehide")),
  }
}

type Environment = Awaited<ReturnType<typeof setup>>

async function connect(env: Environment): Promise<LocalConnection> {
  const response = await env.api.dispatch({ method: "connect", clientId: id(1) })
  expect(response).toMatchObject({
    ok: true,
    value: { clientId: id(1), windowId: 7, state: "pending" },
  })
  const value = await store.getLocalConnection()
  if (!value) throw new Error("Missing local request")
  return value
}

async function approve(env: Environment): Promise<LocalConnection> {
  env.allow.click()
  await vi.waitFor(() => expect(env.status.textContent).toBe("Connected to local Pi Coding Agent"))
  await vi.waitFor(() => expect(env.state.isBusy()).toBe(false))
  const value = await store.getLocalConnection()
  if (!value) throw new Error("Missing local connection")
  return value
}

describe("local coding connection Settings", () => {
  test.each([undefined, "pending", "approved", "rejected"] as const)(
    "loads %s without network, automatic approval, or persistent drafts",
    async (state) => {
      const env = await setup(state ? connection({ state }) : undefined)
      expect(env.getCurrent).toHaveBeenCalledOnce()
      expect(env.fetch).not.toHaveBeenCalled()
      expect(env.open).not.toHaveBeenCalled()
      expect(env.confirm).not.toHaveBeenCalled()
      expect(env.session.set).not.toHaveBeenCalled()
      expect(env.local.get).not.toHaveBeenCalled()
      expect(env.local.set).not.toHaveBeenCalled()
      expect(env.local.remove).not.toHaveBeenCalled()
      expect(env.permissions.request).not.toHaveBeenCalled()
      expect(env.permissions.contains).not.toHaveBeenCalled()
      expect(env.state.hasDraft()).toBe(false)
      expect(env.state.isBusy()).toBe(false)
      expect(env.allow.hidden).toBe(state !== "pending")
      expect(env.disconnect.hidden).toBe(state !== "pending" && state !== "approved")
      const section = env.get("coding-connection-title").closest("section")
      expect(section?.querySelector("input, textarea")).toBeNull()
      expect(section?.textContent).not.toContain("obsolete-token")
      for (const obsolete of [
        "coding-endpoint",
        "coding-link",
        "coding-invitation",
        "coding-copy",
      ]) {
        expect(env.document.getElementById(obsolete)).toBeNull()
      }
    },
  )

  test("exposes only a versioned Settings role; connect creates pending metadata, not approval", async () => {
    const env = await setup()
    expect(env.api.version).toBe(2)
    expect(env.api.role).toBe("settings")
    expect(Object.isFrozen(env.api)).toBe(true)
    expect(Object.keys(env.api).sort()).toEqual(["dispatch", "role", "version"])
    expect(await env.api.dispatch({ method: "status", clientId: id(1) })).toEqual({
      ok: true,
      value: null,
    })
    const pending = await connect(env)
    expect(env.allow.hidden).toBe(false)
    expect(env.allow.disabled).toBe(false)
    expect(env.status.textContent).toBe("Waiting for local approval")
    expect(env.open).not.toHaveBeenCalled()
    expect(env.confirm).not.toHaveBeenCalled()
    expect(await env.api.dispatch({ method: "connect", clientId: id(1) })).toEqual({
      ok: true,
      value: pending,
    })
    expect(await env.api.dispatch({ method: "status", clientId: id(1) })).toEqual({
      ok: true,
      value: pending,
    })
    expect(await env.api.dispatch({ method: "status", clientId: id(3) })).toEqual({
      ok: true,
      value: null,
    })
    expect(await env.api.dispatch({ method: "connect", clientId: id(3) })).toMatchObject({
      ok: false,
    })
    expect(env.session.set).toHaveBeenCalledExactlyOnceWith({
      [store.CODING_CONNECTION_KEY]: pending,
    })
    expect(Object.keys(pending).sort()).toEqual(["clientId", "generation", "state", "windowId"])
    expect(env.get("coding-task-chip").hidden).toBe(true)
    expect(env.get<HTMLTextAreaElement>("prompt").value).toBe("")
    expect(env.send).not.toHaveBeenCalled()
    expect(env.permissions.request).not.toHaveBeenCalled()
    expect(env.permissions.contains).not.toHaveBeenCalled()
    expect(env.local.get).not.toHaveBeenCalled()
    expect(env.local.set).not.toHaveBeenCalled()
    expect(env.fetch).not.toHaveBeenCalled()
  })

  test.each([
    { method: "send", id: "task-1", task: "Read the page" },
    { method: "get", id: "task-1" },
    { method: "inbox" },
    { method: "accept", id: "task-1", task: "Review this change" },
    { method: "reply", id: "task-1", answer: "Result" },
    { method: "cancel", id: "task-1" },
    { method: "approve" },
  ])("rejects $method on the Settings API even with an approved generation", async (request) => {
    const initial = connection({ state: "approved" })
    const env = await setup(initial)
    expect(
      await env.api.dispatch({
        ...request,
        clientId: initial.clientId,
        generation: initial.generation,
      }),
    ).toMatchObject({ ok: false })
    expect(await store.getLocalConnection()).toEqual(initial)
    expect(env.session.set).not.toHaveBeenCalled()
    expect(env.open).not.toHaveBeenCalled()
  })

  test("rejects extra consent, URL, and token fields rather than ignoring them", async () => {
    const env = await setup()
    for (const extra of [
      { approved: true },
      { url: "https://relay.invalid/" },
      { token: "obsolete-token" },
    ]) {
      expect(
        await env.api.dispatch({ method: "connect", clientId: id(1), ...extra }),
      ).toMatchObject({ ok: false })
    }
    expect(env.session.set).not.toHaveBeenCalled()
  })

  test("Allow opens the Side Panel in the button gesture before waiting for confirmation", async () => {
    const env = await setup()
    const pending = await connect(env)
    const answer = deferred<boolean>()
    const opened = deferred<void>()
    const order: string[] = []
    env.open.mockImplementationOnce(() => {
      order.push("open")
      return opened.promise
    })
    env.confirm.mockImplementationOnce(() => {
      order.push("confirm")
      return answer.promise
    })
    env.changed.mockClear()
    env.session.set.mockClear()
    env.allow.focus()
    env.allow.click()
    expect(order).toEqual(["open", "confirm"])
    expect(env.open).toHaveBeenCalledExactlyOnceWith({ windowId: 7 })
    expect(env.confirm).toHaveBeenCalledWith({
      title: "Allow local Coding Agent?",
      message:
        "Allow this local Pi Coding Agent to start tasks automatically when Browser Agent is idle and the composer is empty? No task confirmation or Send is required. Model-provider access, site access, and action confirmations still apply. Disconnect to revoke this permission.",
      confirmLabel: "Allow local connection",
    })
    expect(env.state.isBusy()).toBe(true)
    expect(env.state.hasDraft()).toBe(false)
    expect(env.allow.disabled).toBe(true)
    expect(env.disconnect.disabled).toBe(true)
    expect(env.changed).toHaveBeenCalled()
    expect(env.session.set).not.toHaveBeenCalled()
    env.allow.click()
    expect(env.open).toHaveBeenCalledOnce()
    answer.resolve(true)
    await settle()
    expect(env.session.set).not.toHaveBeenCalled()
    opened.resolve()
    await vi.waitFor(() => expect(env.state.isBusy()).toBe(false))
    const approved = await store.getLocalConnection()
    expect(approved).toMatchObject({ clientId: id(1), windowId: 7, state: "approved" })
    expect(approved?.generation).not.toBe(pending.generation)
    expect(env.allow.hidden).toBe(true)
    expect(env.disconnect.disabled).toBe(false)
    expect(env.document.activeElement).toBe(env.disconnect)
    expect(env.send).not.toHaveBeenCalled()
    expect(env.permissions.request).not.toHaveBeenCalled()
    expect(env.local.set).not.toHaveBeenCalled()
    expect(env.fetch).not.toHaveBeenCalled()
  })

  test("a synchronous Side Panel failure stays visible and never asks for approval", async () => {
    const env = await setup(connection())
    env.open.mockImplementationOnce(() => {
      throw new Error("Side Panel unavailable")
    })
    env.allow.click()
    await settle()
    expect(env.status.textContent).toBe(
      "Local connection failed or was interrupted; no operation was retried.",
    )
    expect(env.confirm).not.toHaveBeenCalled()
    expect(env.session.set).not.toHaveBeenCalled()
    expect(env.state.isBusy()).toBe(false)
  })

  test("pagehide cancels approval that has not yet acquired the store lock", async () => {
    const env = await setup()
    await connect(env)
    env.session.set.mockClear()
    const entered = deferred<void>()
    const release = deferred<void>()
    const original = store.approveLocalConnection
    const approving = vi
      .spyOn(store, "approveLocalConnection")
      .mockImplementation(async (expected, signal) => {
        entered.resolve()
        await release.promise
        return original(expected, signal)
      })
    env.allow.click()
    await entered.promise
    const signal = approving.mock.calls[0]?.[1]
    expect(signal?.aborted).toBe(false)
    env.pagehide()
    expect(signal?.aborted).toBe(true)
    release.resolve()
    await settle()
    expect((await store.getLocalConnection())?.state).toBe("rejected")
    expect(env.session.set).toHaveBeenCalledOnce()
    expect(env.state.isBusy()).toBe(false)
  })

  test("pagehide during a dispatched approval write leaves no late approved session", async () => {
    const env = await setup()
    await connect(env)
    const entered = deferred<void>()
    const release = deferred<void>()
    const originalSet = env.session.set.getMockImplementation()
    if (!originalSet) throw new Error("Missing session write implementation")
    env.session.set.mockImplementationOnce(async (values) => {
      entered.resolve()
      await release.promise
      await originalSet(values)
    })
    env.allow.click()
    await entered.promise
    env.pagehide()
    release.resolve()
    await vi.waitFor(async () => expect((await store.getLocalConnection())?.state).toBe("rejected"))
    expect(env.dom.window.__piBrowserLocal).toBeUndefined()
    expect(env.storageListeners.size).toBe(0)
    expect(env.state.isBusy()).toBe(false)
  })

  test.each(["denied", "open failed"] as const)("%s never approves or retries", async (failure) => {
    const env = await setup(connection())
    if (failure === "denied") env.confirm.mockResolvedValueOnce(false)
    else env.open.mockRejectedValueOnce(new Error("Side Panel unavailable"))
    env.allow.click()
    await vi.waitFor(() => expect(env.state.isBusy()).toBe(false))
    expect(await store.getLocalConnection()).toEqual(connection())
    expect(env.session.set).not.toHaveBeenCalled()
    expect(env.open).toHaveBeenCalledOnce()
    expect(env.allow.disabled).toBe(false)
    expect(env.state.hasDraft()).toBe(false)
    if (failure === "open failed") {
      expect(env.status.textContent).toBe(
        "Local connection failed or was interrupted; no operation was retried.",
      )
    }
  })

  test.each(["confirmation", "panel open"] as const)(
    "pagehide during %s prevents late approval and removes the API and storage listener",
    async (waiting) => {
      const env = await setup()
      await connect(env)
      env.session.set.mockClear()
      const answer = deferred<boolean>()
      const opened = deferred<void>()
      if (waiting === "confirmation") env.confirm.mockReturnValueOnce(answer.promise)
      else env.open.mockReturnValueOnce(opened.promise)
      const retainedApi = env.api
      env.allow.click()
      expect(env.state.isBusy()).toBe(true)
      env.pagehide()
      expect(env.state.isBusy()).toBe(false)
      expect(env.dom.window.__piBrowserLocal).toBeUndefined()
      expect(env.storageListeners.size).toBe(0)
      answer.resolve(true)
      opened.resolve()
      await settle()
      expect(env.session.set).toHaveBeenCalledOnce()
      expect((await store.getLocalConnection())?.state).toBe("rejected")
      expect(await retainedApi.dispatch({ method: "status", clientId: id(1) })).toMatchObject({
        ok: false,
      })
    },
  )

  test("pagehide removes button actions and does not delete a replacement API", async () => {
    const env = await setup(connection())
    const replacement: LocalApi = { version: 2, role: "conversation", dispatch: vi.fn() }
    env.dom.window.__piBrowserLocal = replacement
    env.pagehide()
    expect(env.dom.window.__piBrowserLocal).toBe(replacement)
    env.allow.click()
    env.disconnect.click()
    await settle()
    expect(env.open).not.toHaveBeenCalled()
    expect(env.confirm).not.toHaveBeenCalled()
    expect(env.session.set).not.toHaveBeenCalled()
  })

  test.each(["generation", "windowId", "clientId", "state"] as const)(
    "a changed %s during confirmation cannot approve the stale request",
    async (field) => {
      const env = await setup(connection())
      const answer = deferred<boolean>()
      env.confirm.mockReturnValueOnce(answer.promise)
      env.allow.click()
      const replacement = connection()
      if (field === "generation" || field === "clientId") replacement[field] = id(3)
      if (field === "windowId") replacement.windowId = 8
      if (field === "state") replacement.state = "rejected"
      await env.session.set({ [store.CODING_CONNECTION_KEY]: replacement })
      env.session.set.mockClear()
      answer.resolve(true)
      await vi.waitFor(() => expect(env.state.isBusy()).toBe(false))
      expect(await store.getLocalConnection()).toEqual(replacement)
      expect(env.session.set).not.toHaveBeenCalled()
    },
  )

  test("status and controls never expose another window's connection", async () => {
    const env = await setup(connection({ windowId: 8, state: "approved" }))
    expect(env.status.textContent).toBe("No local connection request")
    expect(env.allow.hidden).toBe(true)
    expect(env.disconnect.hidden).toBe(true)
    expect(await env.api.dispatch({ method: "status", clientId: id(1) })).toEqual({
      ok: true,
      value: null,
    })
    expect(
      await env.api.dispatch({ method: "disconnect", clientId: id(1), generation: id(2) }),
    ).toMatchObject({ ok: false })
    env.allow.click()
    env.disconnect.click()
    expect(env.open).not.toHaveBeenCalled()
    expect(env.confirm).not.toHaveBeenCalled()
    expect(env.session.set).not.toHaveBeenCalled()
  })

  test("API disconnect revokes its pending generation without approval or browser closure", async () => {
    const env = await setup()
    const pending = await connect(env)
    env.session.set.mockClear()
    expect(
      await env.api.dispatch({
        method: "disconnect",
        clientId: pending.clientId,
        generation: pending.generation,
      }),
    ).toMatchObject({ ok: true, value: { state: "rejected" } })
    const rejected = await store.getLocalConnection()
    expect(rejected?.generation).not.toBe(pending.generation)
    expect(env.session.set).toHaveBeenCalledOnce()
    expect(env.confirm).not.toHaveBeenCalled()
    expect(env.open).not.toHaveBeenCalled()
    env.pagehide()
    await settle()
    expect(await store.getLocalConnection()).toEqual(rejected)
    expect(env.session.set).toHaveBeenCalledOnce()
    expect(env.removeWindow).not.toHaveBeenCalled()
    expect(env.removeTab).not.toHaveBeenCalled()
    expect(env.close).not.toHaveBeenCalled()
  })

  test.each(["pending", "approved", "rejected"] as const)(
    "API disconnect rejects a mismatched scope or rejected record (%s)",
    async (state) => {
      const initial = connection({ state })
      const env = await setup(initial)
      for (const request of [
        { clientId: id(3), generation: initial.generation },
        { clientId: initial.clientId, generation: id(3) },
        ...(state === "rejected"
          ? [{ clientId: initial.clientId, generation: initial.generation }]
          : []),
      ]) {
        expect(await env.api.dispatch({ method: "disconnect", ...request })).toMatchObject({
          ok: false,
        })
      }
      expect(await store.getLocalConnection()).toEqual(initial)
      expect(env.session.set).not.toHaveBeenCalled()
      const otherWindow = { ...initial, windowId: 8 }
      await env.session.set({ [store.CODING_CONNECTION_KEY]: otherWindow })
      env.session.set.mockClear()
      expect(
        await env.api.dispatch({
          method: "disconnect",
          clientId: initial.clientId,
          generation: initial.generation,
        }),
      ).toMatchObject({ ok: false })
      expect(await store.getLocalConnection()).toEqual(otherWindow)
      expect(env.session.set).not.toHaveBeenCalled()
    },
  )

  test("a pending API disconnect cannot revoke an approval that wins the store race", async () => {
    const env = await setup()
    const pending = await connect(env)
    const original = store.disconnectLocalConnection
    let approved: LocalConnection | undefined
    const disconnecting = vi
      .spyOn(store, "disconnectLocalConnection")
      .mockImplementationOnce(async (snapshot) => {
        approved = await store.approveLocalConnection(pending)
        return original(snapshot)
      })
    expect(
      await env.api.dispatch({
        method: "disconnect",
        clientId: pending.clientId,
        generation: pending.generation,
      }),
    ).toMatchObject({ ok: false })
    expect(disconnecting).toHaveBeenCalledOnce()
    expect(await store.getLocalConnection()).toEqual(approved)
    expect(approved?.generation).not.toBe(pending.generation)
  })

  test("pagehide revokes only the page's matching pending request and never closes Chrome", async () => {
    const env = await setup()
    const pending = await connect(env)
    env.session.set.mockClear()
    env.pagehide()
    await settle()
    expect(await store.getLocalConnection()).toMatchObject({
      clientId: pending.clientId,
      windowId: 7,
      state: "rejected",
    })
    expect((await store.getLocalConnection())?.generation).not.toBe(pending.generation)
    expect(env.session.set).toHaveBeenCalledOnce()
    env.pagehide()
    await settle()
    expect(env.session.set).toHaveBeenCalledOnce()
    expect(env.removeWindow).not.toHaveBeenCalled()
    expect(env.removeTab).not.toHaveBeenCalled()
    expect(env.close).not.toHaveBeenCalled()
  })

  test("an approved connection survives closing its Settings page", async () => {
    const env = await setup()
    await connect(env)
    const approved = await approve(env)
    env.session.set.mockClear()
    env.pagehide()
    await settle()
    expect(await store.getLocalConnection()).toEqual(approved)
    expect(env.session.set).not.toHaveBeenCalled()
    expect(env.removeWindow).not.toHaveBeenCalled()
    expect(env.removeTab).not.toHaveBeenCalled()
    expect(env.close).not.toHaveBeenCalled()
  })

  test("pagehide does not claim a pending request loaded from another Settings page", async () => {
    const initial = connection()
    const env = await setup(initial)
    env.pagehide()
    await settle()
    expect(await store.getLocalConnection()).toEqual(initial)
    expect(env.session.set).not.toHaveBeenCalled()
  })

  test.each([
    { generation: id(3) },
    { clientId: id(3) },
    { windowId: 8 },
    { state: "approved" as const, generation: id(3) },
    { state: "rejected" as const },
  ])("pagehide preserves a replacement record (%j)", async (patch) => {
    const env = await setup()
    const pending = await connect(env)
    const replacement = { ...pending, ...patch }
    await env.session.set({ [store.CODING_CONNECTION_KEY]: replacement })
    env.session.set.mockClear()
    env.pagehide()
    await settle()
    expect(await store.getLocalConnection()).toEqual(replacement)
    expect(env.session.set).not.toHaveBeenCalled()
  })

  test("pagehide cleanup uses CAS even if a replacement arrives after cleanup starts", async () => {
    const env = await setup()
    const pending = await connect(env)
    const entered = deferred<void>()
    const release = deferred<void>()
    const original = store.disconnectLocalConnection
    const disconnecting = vi
      .spyOn(store, "disconnectLocalConnection")
      .mockImplementationOnce(async (snapshot) => {
        entered.resolve()
        await release.promise
        return original(snapshot)
      })
    env.pagehide()
    await entered.promise
    const replacement = { ...pending, generation: id(3), clientId: id(4) }
    await env.session.set({ [store.CODING_CONNECTION_KEY]: replacement })
    env.session.set.mockClear()
    release.resolve()
    await settle()
    expect(await store.getLocalConnection()).toEqual(replacement)
    expect(env.session.set).not.toHaveBeenCalled()
    expect(disconnecting).toHaveBeenCalledOnce()
  })

  test("a pending connect write that finishes after pagehide is revoked without late approval", async () => {
    const env = await setup()
    const entered = deferred<void>()
    const release = deferred<void>()
    const originalSet = env.session.set.getMockImplementation()
    if (!originalSet) throw new Error("Missing session write implementation")
    env.session.set.mockImplementationOnce(async (values) => {
      entered.resolve()
      await release.promise
      await originalSet(values)
    })
    const connecting = env.api.dispatch({ method: "connect", clientId: id(1) })
    await entered.promise
    env.pagehide()
    release.resolve()
    expect(await connecting).toMatchObject({ ok: false })
    expect((await store.getLocalConnection())?.state).toBe("rejected")
    expect(env.confirm).not.toHaveBeenCalled()
    expect(env.open).not.toHaveBeenCalled()
    expect(env.dom.window.__piBrowserLocal).toBeUndefined()
  })

  test("API disconnect requires the same approved generation and leaves a rejected tombstone", async () => {
    const env = await setup()
    const pending = await connect(env)
    const approved = await approve(env)
    expect(
      await env.api.dispatch({
        method: "disconnect",
        clientId: id(1),
        generation: pending.generation,
      }),
    ).toMatchObject({ ok: false })
    expect(
      await env.api.dispatch({
        method: "disconnect",
        clientId: id(3),
        generation: approved.generation,
      }),
    ).toMatchObject({ ok: false })
    const result = await env.api.dispatch({
      method: "disconnect",
      clientId: id(1),
      generation: approved.generation,
    })
    expect(result).toMatchObject({
      ok: true,
      value: { state: "rejected", clientId: id(1), windowId: 7 },
    })
    const rejected = await store.getLocalConnection()
    expect(rejected?.generation).not.toBe(approved.generation)
    expect(env.allow.hidden).toBe(true)
    expect(env.disconnect.hidden).toBe(true)
    expect(
      await env.api.dispatch({
        method: "disconnect",
        clientId: id(1),
        generation: approved.generation,
      }),
    ).toMatchObject({ ok: false })
    expect(env.fetch).not.toHaveBeenCalled()
  })

  test.each([false, true])("button disconnect requires confirmation (%s)", async (accepted) => {
    const initial = connection({ state: "approved" })
    const env = await setup(initial)
    const answer = deferred<boolean>()
    env.confirm.mockReturnValueOnce(answer.promise)
    env.disconnect.click()
    expect(env.state.isBusy()).toBe(true)
    expect(env.session.set).not.toHaveBeenCalled()
    expect(env.confirm).toHaveBeenCalledWith({
      title: "Disconnect local Coding Agent?",
      message: "Disconnect cancels delegated work but does not undo completed actions.",
      confirmLabel: "Disconnect local Coding Agent",
    })
    answer.resolve(accepted)
    await vi.waitFor(() => expect(env.state.isBusy()).toBe(false))
    expect((await store.getLocalConnection())?.state).toBe(accepted ? "rejected" : "approved")
    expect(env.session.set).toHaveBeenCalledTimes(accepted ? 1 : 0)
    expect(env.open).not.toHaveBeenCalled()
  })

  test("session updates render state, but unrelated areas and keys do not refresh", async () => {
    const env = await setup()
    env.session.get.mockClear()
    env.emit({ [store.CODING_CONNECTION_KEY]: { newValue: connection() } }, "local")
    env.emit({ unrelated: { newValue: true } })
    expect(env.session.get).not.toHaveBeenCalled()
    await env.session.set({ [store.CODING_CONNECTION_KEY]: connection() })
    await vi.waitFor(() => expect(env.status.textContent).toBe("Waiting for local approval"))
    await env.session.set({ [store.CODING_CONNECTION_KEY]: connection({ state: "approved" }) })
    await vi.waitFor(() =>
      expect(env.status.textContent).toBe("Connected to local Pi Coding Agent"),
    )
    await env.session.set({ [store.CODING_CONNECTION_KEY]: connection({ state: "rejected" }) })
    await vi.waitFor(() => expect(env.status.textContent).toBe("Local connection rejected"))
    expect(env.open).not.toHaveBeenCalled()
    expect(env.confirm).not.toHaveBeenCalled()
    expect(env.local.set).not.toHaveBeenCalled()
    env.pagehide()
    env.session.get.mockClear()
    env.emit({ [store.CODING_CONNECTION_KEY]: { newValue: connection() } })
    expect(env.session.get).not.toHaveBeenCalled()
  })

  test("a late session read cannot replace a more recent render", async () => {
    const env = await setup()
    const late = deferred<Record<string, unknown>>()
    env.session.get.mockReturnValueOnce(late.promise)
    env.emit({ [store.CODING_CONNECTION_KEY]: { newValue: connection() } })
    await env.session.set({ [store.CODING_CONNECTION_KEY]: connection({ state: "rejected" }) })
    await vi.waitFor(() => expect(env.status.textContent).toBe("Local connection rejected"))
    late.resolve({ [store.CODING_CONNECTION_KEY]: connection({ state: "approved" }) })
    await settle()
    expect(env.status.textContent).toBe("Local connection rejected")
  })

  test("a read error stays visible after a later successful refresh", async () => {
    const env = await setup(connection())
    env.session.get.mockRejectedValueOnce(new Error("Session storage unavailable"))
    env.emit({ [store.CODING_CONNECTION_KEY]: {} })
    await settle()
    expect(env.allow.disabled).toBe(true)
    expect(env.disconnect.disabled).toBe(true)
    const failedStatus = env.status.textContent
    expect(failedStatus).toBe(
      "Local connection failed or was interrupted; no operation was retried.",
    )
    env.emit({ [store.CODING_CONNECTION_KEY]: {} })
    await settle()
    expect(env.status.textContent).toBe(failedStatus)
  })

  test("a later refresh does not overwrite a failed action's status", async () => {
    const env = await setup(connection())
    env.open.mockRejectedValueOnce(new Error("Side Panel unavailable"))
    env.allow.click()
    await vi.waitFor(() => expect(env.state.isBusy()).toBe(false))
    const failedStatus = env.status.textContent
    expect(failedStatus).toBe(
      "Local connection failed or was interrupted; no operation was retried.",
    )
    await env.session.set({ [store.CODING_CONNECTION_KEY]: connection() })
    await settle()
    expect(env.status.textContent).toBe(failedStatus)
    await approve(env)
  })

  test("completion does not move focus away from navigation selected while busy", async () => {
    const env = await setup(connection())
    const answer = deferred<boolean>()
    env.confirm.mockReturnValueOnce(answer.promise)
    env.allow.focus()
    env.allow.click()
    const navigation = env.get("settings-tab-model")
    navigation.focus()
    answer.resolve(true)
    await vi.waitFor(() => expect(env.state.isBusy()).toBe(false))
    expect(env.document.activeElement).toBe(navigation)
  })
})
