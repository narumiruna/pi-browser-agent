import { afterEach, describe, expect, test, vi } from "vitest"
import type { LocalConnection } from "../../src/browser/coding-agent/protocol.js"
import {
  approveLocalConnection,
  assertLocalConnection,
  CODING_CONNECTION_KEY,
  disconnectLocalConnection,
  getLocalConnection,
  requestLocalConnection,
} from "../../src/browser/coding-agent/store.js"

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const connection = (patch: Partial<LocalConnection> = {}): LocalConnection => ({
  clientId: id(1),
  generation: id(2),
  windowId: 7,
  state: "pending",
  ...patch,
})

function environment() {
  const data: Record<string, unknown> = {}
  const session = {
    // Return references so that tests detect changes before a failed write.
    get: vi.fn(async (key: string) => ({ [key]: data[key] })),
    set: vi.fn(async (values: Record<string, unknown>) => {
      Object.assign(data, structuredClone(values))
    }),
    setAccessLevel: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  }
  const local = {
    get: vi.fn(async () => ({})),
    set: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  }
  const tails = new Map<string, Promise<unknown>>()
  const request = vi.fn((name: string, _options: unknown, operation: () => Promise<unknown>) => {
    const result = (tails.get(name) ?? Promise.resolve()).catch(() => undefined).then(operation)
    tails.set(name, result)
    return result
  })
  const permissions = { contains: vi.fn(), request: vi.fn(), getAll: vi.fn() }
  const fetch = vi.fn(() => {
    throw new Error("Unexpected network request")
  })
  vi.stubGlobal("chrome", { storage: { session, local }, permissions })
  vi.stubGlobal("navigator", { locks: { request } })
  vi.stubGlobal("fetch", fetch)
  return { data, session, local, request, permissions, fetch }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}

async function tabs() {
  vi.resetModules()
  const first = await import("../../src/browser/coding-agent/store.js")
  vi.resetModules()
  const second = await import("../../src/browser/coding-agent/store.js")
  return [first, second] as const
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("trusted local coding session store", () => {
  test("stores only versionless session metadata without consent migration or network", async () => {
    const env = environment()
    const legacy = {
      piBrowserAgentLocalCodingSessionV1: {
        clientId: id(8),
        generation: id(9),
        windowId: 7,
        state: "approved",
      },
      piBrowserAgentCodingConnectionV1: {
        version: 1,
        connection: { state: "paired", endpoint: "https://obsolete.invalid/" },
        credential: { token: "obsolete-browser-token" },
      },
      piBrowserAgentApprovedHostPermissions: ["https://example.org/*"],
      piBrowserAgentSettings: { provider: "openai" },
      piBrowserAgentCredentialsV1: { openai: { type: "api_key", key: "provider-secret" } },
      piBrowserAgentMcpServersV1: { servers: [] },
      piBrowserAgentMcpTokensV1: { tokens: { other: "mcp-secret" } },
      piBrowserAgentActiveSessionId: "conversation-1",
      sessionRecords: [{ text: "History" }],
    }
    Object.assign(env.data, structuredClone(legacy))
    expect(CODING_CONNECTION_KEY).toBe("piBrowserAgentLocalCodingSessionV2")
    await expect(getLocalConnection()).resolves.toBeUndefined()
    const pending = await requestLocalConnection(id(1), 7)
    expect(pending).toEqual({
      clientId: id(1),
      generation: expect.any(String),
      windowId: 7,
      state: "pending",
    })
    expect(pending.generation).toMatch(/^[a-f0-9-]{36}$/)
    expect(env.data).toEqual({ ...legacy, [CODING_CONNECTION_KEY]: pending })
    expect(env.session.setAccessLevel).toHaveBeenCalledWith({ accessLevel: "TRUSTED_CONTEXTS" })
    expect(env.session.setAccessLevel.mock.invocationCallOrder[0]).toBeLessThan(
      env.session.set.mock.invocationCallOrder[0] ?? 0,
    )
    const approved = await approveLocalConnection(pending)
    await disconnectLocalConnection(approved)
    for (const [key, value] of Object.entries(legacy)) expect(env.data[key]).toEqual(value)
    for (const [values] of env.session.set.mock.calls)
      expect(Object.keys(values)).toEqual([CODING_CONNECTION_KEY])
    expect(env.session.remove).not.toHaveBeenCalled()
    expect(env.local.get).not.toHaveBeenCalled()
    expect(env.local.set).not.toHaveBeenCalled()
    expect(env.local.remove).not.toHaveBeenCalled()
    expect(env.permissions.contains).not.toHaveBeenCalled()
    expect(env.permissions.request).not.toHaveBeenCalled()
    expect(env.permissions.getAll).not.toHaveBeenCalled()
    expect(env.fetch).not.toHaveBeenCalled()
  })

  test("returns detached snapshots and captures expected state before the lock", async () => {
    const env = environment()
    const pending = await requestLocalConnection(id(1), 7)
    pending.windowId = 99
    expect((await getLocalConnection())?.windowId).toBe(7)
    const read = await getLocalConnection()
    if (!read) throw new Error("Missing local connection")
    const approving = approveLocalConnection(read)
    read.clientId = id(99)
    read.state = "rejected"
    const approved = await approving
    expect(approved).toMatchObject({ clientId: id(1), state: "approved", windowId: 7 })
    approved.state = "rejected"
    expect(env.data[CODING_CONNECTION_KEY]).toMatchObject({ state: "approved" })
  })

  test("reuses an active request only for the same client and window without another write", async () => {
    const env = environment()
    const pending = await requestLocalConnection(id(1), 7)
    env.session.set.mockClear()
    expect(await requestLocalConnection(id(1), 7)).toEqual(pending)
    expect(env.session.set).not.toHaveBeenCalled()
    await expect(requestLocalConnection(id(3), 7)).rejects.toThrow("disconnected")
    await expect(requestLocalConnection(id(1), 8)).rejects.toThrow("disconnected")
    const approved = await approveLocalConnection(pending)
    env.session.set.mockClear()
    expect(await requestLocalConnection(id(1), 7)).toEqual(approved)
    expect(env.session.set).not.toHaveBeenCalled()
    await expect(requestLocalConnection(id(3), 7)).rejects.toThrow("disconnected")
  })

  test("rotates generations on approval, rejection, and a fresh request", async () => {
    environment()
    const pending = await requestLocalConnection(id(1), 7)
    await expect(assertLocalConnection(pending.clientId, pending.generation, 7)).rejects.toThrow()
    const approved = await approveLocalConnection(pending)
    expect(approved.state).toBe("approved")
    expect(approved.generation).not.toBe(pending.generation)
    expect(await assertLocalConnection(id(1), approved.generation, 7)).toEqual(approved)
    await expect(assertLocalConnection(id(1), pending.generation, 7)).rejects.toThrow()
    const rejected = await disconnectLocalConnection(approved)
    expect(rejected).toEqual({ ...approved, generation: expect.any(String), state: "rejected" })
    expect(rejected.generation).not.toBe(approved.generation)
    await expect(assertLocalConnection(id(1), approved.generation, 7)).rejects.toThrow()
    await expect(assertLocalConnection(id(1), rejected.generation, 7)).rejects.toThrow()
    await expect(approveLocalConnection(pending)).rejects.toThrow("changed")
    const next = await requestLocalConnection(id(3), 8)
    expect(next).toMatchObject({ clientId: id(3), windowId: 8, state: "pending" })
    expect(
      new Set([pending.generation, approved.generation, rejected.generation, next.generation]).size,
    ).toBe(4)
    await expect(disconnectLocalConnection(approved)).rejects.toThrow("changed")
  })

  test("rejects a pending request with a persistent tombstone", async () => {
    const env = environment()
    const pending = await requestLocalConnection(id(1), 7)
    const rejected = await disconnectLocalConnection(pending)
    expect(rejected.state).toBe("rejected")
    expect(env.data[CODING_CONNECTION_KEY]).toEqual(rejected)
    await expect(approveLocalConnection(pending)).rejects.toThrow("changed")
    await expect(approveLocalConnection(rejected)).rejects.toThrow("pending")
  })

  test.each(["clientId", "generation", "windowId", "state"] as const)(
    "compares expected %s before mutation",
    async (field) => {
      const env = environment()
      const pending = await requestLocalConnection(id(1), 7)
      const stale = { ...pending }
      if (field === "clientId" || field === "generation") stale[field] = id(99)
      if (field === "windowId") stale.windowId = 8
      if (field === "state") stale.state = "approved"
      env.session.set.mockClear()
      await expect(approveLocalConnection(stale)).rejects.toThrow()
      await expect(disconnectLocalConnection(stale)).rejects.toThrow()
      expect(await getLocalConnection()).toEqual(pending)
      expect(env.session.set).not.toHaveBeenCalled()
    },
  )

  test("asserts the exact approved client, generation, and owner window", async () => {
    environment()
    await expect(assertLocalConnection(id(1), id(2), 7)).rejects.toThrow()
    const approved = await approveLocalConnection(await requestLocalConnection(id(1), 7))
    await expect(assertLocalConnection(id(3), approved.generation, 7)).rejects.toThrow()
    await expect(assertLocalConnection(id(1), id(3), 7)).rejects.toThrow()
    await expect(assertLocalConnection(id(1), approved.generation, 8)).rejects.toThrow()
  })

  test.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid owner window %s without writes",
    async (windowId) => {
      const env = environment()
      await expect(requestLocalConnection(id(1), windowId)).rejects.toThrow()
      expect(env.session.set).not.toHaveBeenCalled()
    },
  )

  test("rejects non-UUID callers without writes", async () => {
    const env = environment()
    await expect(requestLocalConnection("client", 7)).rejects.toThrow()
    await expect(assertLocalConnection("client", id(1), 7)).rejects.toThrow()
    await expect(assertLocalConnection(id(1), "generation", 7)).rejects.toThrow()
    expect(env.session.set).not.toHaveBeenCalled()
  })

  test.each([
    null,
    [],
    {},
    { ...connection(), version: 1 },
    { version: 1, connection: connection() },
    { ...connection(), clientId: "client" },
    { ...connection(), generation: "generation" },
    { ...connection(), state: "paired" },
    { ...connection(), state: { toString: (): string => "pending" } },
    { ...connection(), windowId: -1 },
    { ...connection(), windowId: 1.5 },
    { ...connection(), windowId: "7" },
    { ...connection(), token: "remote-token" },
  ])("corrupt session metadata fails closed: %j", async (invalid) => {
    const env = environment()
    env.data[CODING_CONNECTION_KEY] = invalid
    await expect(getLocalConnection()).rejects.toThrow()
    await expect(requestLocalConnection(id(1), 7)).rejects.toThrow()
    await expect(approveLocalConnection(connection())).rejects.toThrow()
    await expect(disconnectLocalConnection(connection())).rejects.toThrow()
    expect(env.data[CODING_CONNECTION_KEY]).toBe(invalid)
    expect(env.session.set).not.toHaveBeenCalled()
  })

  test.each(["request", "approve", "disconnect"] as const)(
    "failed %s writes preserve the previous session",
    async (operation) => {
      const env = environment()
      const pending = operation === "request" ? undefined : await requestLocalConnection(id(1), 7)
      const before = structuredClone(env.data)
      env.session.set.mockRejectedValueOnce(new Error("Storage failed"))
      const result =
        operation === "request"
          ? requestLocalConnection(id(1), 7)
          : operation === "approve"
            ? approveLocalConnection(pending as LocalConnection)
            : disconnectLocalConnection(pending as LocalConnection)
      await expect(result).rejects.toThrow("Storage failed")
      expect(env.data).toEqual(before)
    },
  )

  test("access restriction failure prevents the metadata write", async () => {
    const env = environment()
    env.session.setAccessLevel.mockRejectedValueOnce(new Error("Access restriction failed"))
    await expect(requestLocalConnection(id(1), 7)).rejects.toThrow("Access restriction failed")
    expect(env.session.set).not.toHaveBeenCalled()
    expect(env.data).toEqual({})
  })

  test("cancellation while waiting for the shared lock prevents approval", async () => {
    const env = environment()
    const pending = await requestLocalConnection(id(1), 7)
    const entered = deferred<void>()
    const release = deferred<void>()
    const controller = new AbortController()
    env.request.mockImplementationOnce(async (_name, _options, operation) => {
      entered.resolve()
      await release.promise
      return operation()
    })
    env.session.set.mockClear()
    const approving = approveLocalConnection(pending, controller.signal)
    const rejected = expect(approving).rejects.toThrow()
    await entered.promise
    controller.abort()
    release.resolve()
    await rejected
    expect(await getLocalConnection()).toEqual(pending)
    expect(env.session.set).not.toHaveBeenCalled()
  })

  test("cancellation during a dispatched approval write leaves a fresh rejected tombstone", async () => {
    const env = environment()
    const pending = await requestLocalConnection(id(1), 7)
    const entered = deferred<void>()
    const release = deferred<void>()
    const controller = new AbortController()
    let dispatched: LocalConnection | undefined
    env.session.set.mockImplementationOnce(async (values) => {
      dispatched = structuredClone(values[CODING_CONNECTION_KEY]) as LocalConnection
      entered.resolve()
      await release.promise
      Object.assign(env.data, structuredClone(values))
    })
    const approving = approveLocalConnection(pending, controller.signal)
    const rejected = expect(approving).rejects.toThrow()
    await entered.promise
    controller.abort()
    release.resolve()
    await rejected
    const tombstone = await getLocalConnection()
    expect(tombstone).toMatchObject({ clientId: pending.clientId, windowId: 7, state: "rejected" })
    expect(tombstone?.generation).not.toBe(pending.generation)
    expect(tombstone?.generation).not.toBe(dispatched?.generation)
    await expect(assertLocalConnection(id(1), dispatched?.generation ?? "", 7)).rejects.toThrow()
  })

  test("cancelled approval cleanup never overwrites a replacement connection", async () => {
    const env = environment()
    const pending = await requestLocalConnection(id(1), 7)
    const entered = deferred<void>()
    const release = deferred<void>()
    const controller = new AbortController()
    env.session.set.mockImplementationOnce(async (values) => {
      Object.assign(env.data, structuredClone(values))
      entered.resolve()
      await release.promise
    })
    const approving = approveLocalConnection(pending, controller.signal)
    const rejected = expect(approving).rejects.toThrow()
    await entered.promise
    const replacement = connection({ clientId: id(3), generation: id(4), windowId: 8 })
    env.data[CODING_CONNECTION_KEY] = replacement
    controller.abort()
    release.resolve()
    env.session.set.mockClear()
    await rejected
    expect(await getLocalConnection()).toEqual(replacement)
    expect(env.session.set).not.toHaveBeenCalled()
  })

  test("independent tabs share one exclusive Web Lock for all session writes", async () => {
    const env = environment()
    const [first, second] = await tabs()
    const initial = await Promise.allSettled([
      first.requestLocalConnection(id(1), 7),
      second.requestLocalConnection(id(3), 7),
    ])
    expect(initial.map((value) => value.status).sort()).toEqual(["fulfilled", "rejected"])
    const pending = await first.getLocalConnection()
    if (!pending) throw new Error("Missing local request")
    const competing = await Promise.allSettled([
      first.approveLocalConnection(pending),
      second.disconnectLocalConnection(pending),
    ])
    expect(competing.map((value) => value.status).sort()).toEqual(["fulfilled", "rejected"])
    const approved = await second.getLocalConnection()
    if (!approved) throw new Error("Missing approved session")
    await second.disconnectLocalConnection(approved)
    const names = env.request.mock.calls.map(([name]) => name)
    expect(new Set(names).size).toBe(1)
    expect(env.request).toHaveBeenCalledWith(
      "pi-browser-agent-local-coding-session",
      { mode: "exclusive" },
      expect.any(Function),
    )
    await expect(first.approveLocalConnection(pending)).rejects.toThrow("changed")
    expect((await first.getLocalConnection())?.state).toBe("rejected")
  })
})
