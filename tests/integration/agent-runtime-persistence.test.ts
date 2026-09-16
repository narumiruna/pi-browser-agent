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

  async request<T>(
    name: string,
    _options: LockOptions,
    callback: (lock: Lock | null) => Promise<T>,
  ): Promise<T> {
    if (this.held.has(name)) return callback(null)
    this.held.add(name)
    try {
      return await callback({ name, mode: "exclusive" } as Lock)
    } finally {
      this.held.delete(name)
    }
  }

  async query(): Promise<LockManagerSnapshot> {
    return {
      held: [...this.held].map((name) => ({ name, mode: "exclusive", clientId: "test" })),
      pending: [],
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

  test("preserves leased sessions when retention evicts an old record", async () => {
    const locks = new FakeLockManager() as unknown as LockManager
    const first = createRuntime(locks)
    await first.initialize()
    const firstRecord = { ...first.activeSession, createdAt: 0, updatedAt: 0 }
    await first.sessions.put(firstRecord)
    for (let index = 1; index < MAX_SESSIONS; index += 1) {
      const session = createSession("gpt-5.6-terra")
      session.createdAt = index
      session.updatedAt = index
      await first.sessions.put(session)
    }

    const second = createRuntime(locks)
    await second.initialize()

    await expect(first.sessions.get(firstRecord.id)).resolves.toBeDefined()
    await expect(first.listSessions()).resolves.toHaveLength(MAX_SESSIONS)
    await first.shutdown()
    await second.shutdown()
  })

  test("restores the latest session when the preferred record is missing", async () => {
    const runtime = createRuntime(new FakeLockManager() as unknown as LockManager)
    const saved = createSession("gpt-5.6-terra")
    await runtime.sessions.put(saved)

    await runtime.initialize("missing-session")

    expect(runtime.activeSession.id).toBe(saved.id)
    await runtime.shutdown()
  })

  test("does not stop the current run when a resumed session is already leased", async () => {
    const locks = new FakeLockManager() as unknown as LockManager
    const first = createRuntime(locks)
    await first.initialize()
    const originalId = first.activeSession.id
    const second = createRuntime(locks)
    await second.initialize()
    const abort = vi.spyOn(first.agent, "abort")

    await expect(first.resumeSession(second.activeSession.id)).rejects.toThrow(
      "open in another Side Panel",
    )

    expect(abort).not.toHaveBeenCalled()
    expect(first.activeSession.id).toBe(originalId)
    await first.shutdown()
    await second.shutdown()
  })

  test("marks a stale running session interrupted when resuming it", async () => {
    const runtime = createRuntime(new FakeLockManager() as unknown as LockManager)
    await runtime.initialize()
    const stale = { ...createSession("gpt-5.6-terra"), status: "running" as const }
    await runtime.sessions.put(stale)

    await runtime.resumeSession(stale.id)

    expect(runtime.activeSession.status).toBe("interrupted")
    await expect(runtime.sessions.get(stale.id)).resolves.toMatchObject({ status: "interrupted" })
    await runtime.shutdown()
  })

  test("rechecks a retention candidate's lease immediately before eviction", async () => {
    const locks = new FakeLockManager() as unknown as LockManager
    const runtime = createRuntime(locks)
    await runtime.initialize()
    const candidate = createSession("gpt-5.6-terra")
    candidate.createdAt = 0
    candidate.updatedAt = 0
    await runtime.sessions.put(candidate)
    for (let index = 1; index < MAX_SESSIONS - 1; index += 1) {
      const session = createSession("gpt-5.6-terra")
      session.createdAt = index
      session.updatedAt = index
      await runtime.sessions.put(session)
    }

    const competingLease = new SessionLease(locks)
    const originalList = runtime.sessions.list.bind(runtime.sessions)
    let leaseAcquired = false
    vi.spyOn(runtime.sessions, "list").mockImplementation(async () => {
      const sessions = await originalList()
      if (!leaseAcquired && sessions.length > MAX_SESSIONS) {
        leaseAcquired = await competingLease.claim(candidate.id)
      }
      return sessions
    })

    await runtime.newSession()

    expect(leaseAcquired).toBe(true)
    await expect(runtime.sessions.get(candidate.id)).resolves.toBeDefined()
    await expect(runtime.listSessions()).resolves.toHaveLength(MAX_SESSIONS)
    await competingLease.release()
    await runtime.shutdown()
  })

  test("refuses to clear sessions owned by another Side Panel", async () => {
    const locks = new FakeLockManager() as unknown as LockManager
    const first = createRuntime(locks)
    await first.initialize()
    const second = createRuntime(locks)
    await second.initialize()
    const abort = vi.spyOn(first.agent, "abort")

    await expect(first.clearSessions()).rejects.toThrow("Close other Side Panels")

    expect(abort).not.toHaveBeenCalled()
    await expect(first.sessions.get(first.activeSession.id)).resolves.toBeDefined()
    await expect(first.sessions.get(second.activeSession.id)).resolves.toBeDefined()
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
