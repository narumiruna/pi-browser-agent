import { IDBFactory } from "fake-indexeddb"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { BrowserAgentRuntime } from "../../src/browser/agent/runtime.js"
import { SessionLease } from "../../src/browser/sessions/session-lease.js"
import {
  createSession,
  MAX_SESSION_BYTES,
  MAX_SESSIONS,
  type SessionRecord,
} from "../../src/browser/sessions/session-store.js"

class FakeLockManager {
  private readonly held = new Set<string>()

  async request(
    name: string,
    _options: LockOptions,
    callback: (lock: Lock | null) => Promise<void>,
  ): Promise<void> {
    if (this.held.has(name)) return callback(null)
    this.held.add(name)
    try {
      await callback({ name, mode: "exclusive" } as Lock)
    } finally {
      this.held.delete(name)
    }
  }
}

function installChromeStorage(): void {
  const local: Record<string, unknown> = {}
  const session: Record<string, unknown> = {}
  const area = (values: Record<string, unknown>) => ({
    get: vi.fn(async (key: string) => ({ [key]: values[key] })),
    set: vi.fn(async (items: Record<string, unknown>) => Object.assign(values, items)),
    remove: vi.fn(async (key: string) => {
      delete values[key]
    }),
  })
  vi.stubGlobal("chrome", {
    storage: {
      local: { ...area(local), setAccessLevel: vi.fn(async () => undefined) },
      session: area(session),
    },
  })
}

function createRuntime(locks: LockManager, warnings: string[] = []): BrowserAgentRuntime {
  return new BrowserAgentRuntime(
    {
      confirm: vi.fn(async () => false),
      onAuthEvent: vi.fn(),
      onAgentEvent: vi.fn(),
      onPersistenceError: (warning) => warnings.push(warning),
    },
    new SessionLease(locks),
  )
}

function persist(runtime: BrowserAgentRuntime, status: SessionRecord["status"]): Promise<void> {
  return (runtime as unknown as { persist(value: SessionRecord["status"]): Promise<void> }).persist(
    status,
  )
}

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory())
  installChromeStorage()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("browser agent session persistence", () => {
  test("gives concurrent Side Panels distinct live sessions", async () => {
    const locks = new FakeLockManager() as unknown as LockManager
    const first = createRuntime(locks)
    await first.initialize()
    await persist(first, "running")

    const second = createRuntime(locks)
    await second.initialize()

    expect(second.activeSession.id).not.toBe(first.activeSession.id)
    await expect(first.sessions.get(first.activeSession.id)).resolves.toMatchObject({
      status: "running",
    })
    await first.shutdown()
    await second.shutdown()
  })

  test("waits for queued persistence before clearing sessions", async () => {
    const runtime = createRuntime(new FakeLockManager() as unknown as LockManager)
    await runtime.initialize()
    const oldId = runtime.activeSession.id
    const originalPut = runtime.sessions.put.bind(runtime.sessions)
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let delayNextPut = true
    vi.spyOn(runtime.sessions, "put").mockImplementation(async (record) => {
      if (delayNextPut) {
        delayNextPut = false
        await gate
      }
      await originalPut(record)
    })
    const queued = persist(runtime, "idle")
    const clearing = runtime.clearSessions()

    await Promise.resolve()
    release?.()
    await Promise.all([queued, clearing])

    const sessions = await runtime.listSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.id).not.toBe(oldId)
    await runtime.shutdown()
  })

  test("deletes the active record before inserting its replacement", async () => {
    const runtime = createRuntime(new FakeLockManager() as unknown as LockManager)
    await runtime.initialize()
    const activeId = runtime.activeSession.id
    const retainedIds: string[] = []
    for (let index = 0; index < MAX_SESSIONS - 1; index += 1) {
      const session = createSession("gpt-5.6-terra")
      session.createdAt = index
      session.updatedAt = index
      retainedIds.push(session.id)
      await runtime.sessions.put(session)
    }

    await runtime.deleteSession(activeId)

    await expect(runtime.listSessions()).resolves.toHaveLength(MAX_SESSIONS)
    for (const id of retainedIds) await expect(runtime.sessions.get(id)).resolves.toBeDefined()
    await runtime.shutdown()
  })

  test("compacts an oversized live transcript and surfaces a warning", async () => {
    const warnings: string[] = []
    const runtime = createRuntime(new FakeLockManager() as unknown as LockManager, warnings)
    await runtime.initialize()
    runtime.agent.state.messages = [
      { role: "user", content: "x".repeat(MAX_SESSION_BYTES), timestamp: 1 },
    ]

    await persist(runtime, "idle")

    expect(warnings).toEqual([expect.stringContaining("size limit")])
    await expect(runtime.sessions.get(runtime.activeSession.id)).resolves.toMatchObject({
      messages: [],
    })
    expect(runtime.agent.state.messages).toEqual([])
    await runtime.shutdown()
  })

  test("removes the stored credential after host permission revocation", async () => {
    const runtime = createRuntime(new FakeLockManager() as unknown as LockManager)
    await runtime.initialize()
    await runtime.credentials.modify("openai-codex", async () => ({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
    }))

    await runtime.invalidateCredential()

    await expect(runtime.authStatus()).resolves.toEqual({ loggedIn: false })
    await runtime.shutdown()
  })
})
