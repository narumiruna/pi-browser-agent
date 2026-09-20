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

function createRuntime(
  locks: LockManager,
  warnings: string[] = [],
  onSettingsModelChanged = vi.fn(),
): BrowserAgentRuntime {
  return new BrowserAgentRuntime(
    {
      confirm: vi.fn(async () => false),
      onAuthEvent: vi.fn(),
      onAgentEvent: vi.fn(),
      onSettingsModelChanged,
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
  test("automatically routes submissions based on the current run state", async () => {
    const runtime = createRuntime(new FakeLockManager() as unknown as LockManager)
    await runtime.initialize()
    const steer = vi.spyOn(runtime, "steer")
    const followUp = vi.spyOn(runtime, "followUp")
    const state = runtime.agent.state as unknown as { isStreaming: boolean }
    state.isStreaming = true

    const image = { type: "image" as const, data: "cG5n", mimeType: "image/png" }
    await expect(runtime.submit("Change direction")).resolves.toBe("steer")
    await expect(runtime.submit("Inspect this", "steer", [image])).resolves.toBe("steer")
    await expect(runtime.submit("Do this later", "followUp")).resolves.toBe("followUp")
    await expect(runtime.submit("Inspect this later", "followUp", [image])).resolves.toBe(
      "followUp",
    )
    expect(steer).toHaveBeenNthCalledWith(1, "Change direction")
    expect(steer).toHaveBeenNthCalledWith(2, "Inspect this", [image])
    expect(followUp).toHaveBeenNthCalledWith(1, "Do this later")
    expect(followUp).toHaveBeenNthCalledWith(2, "Inspect this later", [image])

    state.isStreaming = false
    const prompt = vi.spyOn(runtime, "prompt").mockResolvedValue()
    await expect(runtime.submit("Start a task")).resolves.toBe("prompt")
    await expect(runtime.submit("Inspect now", "steer", [image])).resolves.toBe("prompt")
    expect(prompt).toHaveBeenNthCalledWith(1, "Start a task")
    expect(prompt).toHaveBeenNthCalledWith(2, "Inspect now", [image])
    await runtime.shutdown()
  })

  test("omits empty text blocks from image-only submissions", async () => {
    const runtime = createRuntime(new FakeLockManager() as unknown as LockManager)
    await runtime.initialize()
    const image = { type: "image" as const, data: "cG5n", mimeType: "image/png" }
    const expectedMessage = {
      role: "user",
      content: [image],
      timestamp: expect.any(Number),
    }

    const state = runtime.agent.state as unknown as { isStreaming: boolean }
    state.isStreaming = true
    const steer = vi.spyOn(runtime.agent, "steer")
    const followUp = vi.spyOn(runtime.agent, "followUp")
    await expect(runtime.submit("", "steer", [image])).resolves.toBe("steer")
    await expect(runtime.submit("", "followUp", [image])).resolves.toBe("followUp")
    expect(steer).toHaveBeenCalledWith(expectedMessage)
    expect(followUp).toHaveBeenCalledWith(expectedMessage)

    state.isStreaming = false
    const prompt = vi.spyOn(runtime.agent, "prompt").mockResolvedValue()
    await expect(runtime.submit("", "steer", [image])).resolves.toBe("prompt")
    expect(prompt).toHaveBeenCalledWith(expectedMessage)
    await runtime.shutdown()
  })

  test("loads Settings without creating or claiming a conversation session", async () => {
    const runtime = createRuntime(new FakeLockManager() as unknown as LockManager)

    await runtime.initializeSettings()

    await expect(runtime.listSessions()).resolves.toEqual([])
    expect(runtime.appSettings.modelId).toBe("gpt-5.6-terra")
  })

  test("seeds full-tab Settings without changing the configured model", async () => {
    const locks = new FakeLockManager() as unknown as LockManager
    const runtime = createRuntime(locks)
    await runtime.initialize()
    const older = createSession("gpt-5.6-terra")
    await runtime.sessions.put(older)
    const anthropic = runtime.getModels("anthropic")[0]
    if (!anthropic) throw new Error("Anthropic test model unavailable")
    await runtime.selectModel(anthropic.provider, anthropic.id)
    await runtime.resumeSession(older.id)
    const settingsRuntime = createRuntime(locks)

    await settingsRuntime.initializeSettings({
      provider: runtime.model.provider,
      id: runtime.model.id,
    })

    expect(settingsRuntime.model).toMatchObject({ provider: "openai-codex", id: "gpt-5.6-terra" })
    expect(settingsRuntime.appSettings).toMatchObject({
      modelProvider: anthropic.provider,
      modelId: anthropic.id,
    })
    await runtime.shutdown()
  })

  test("synchronizes settings saved by a full-tab Settings page", async () => {
    const locks = new FakeLockManager() as unknown as LockManager
    const onSettingsModelChanged = vi.fn()
    const runtime = createRuntime(locks, [], onSettingsModelChanged)
    await runtime.initialize()
    const settingsRuntime = createRuntime(locks)
    await settingsRuntime.initializeSettings()
    const anthropic = settingsRuntime.getModels("anthropic")[0]
    if (!anthropic) throw new Error("Anthropic test model unavailable")

    await settingsRuntime.updateSettings({
      ...settingsRuntime.appSettings,
      fontFamily: "serif",
      fontSize: 19,
      modelProvider: anthropic.provider,
      modelId: anthropic.id,
    })
    await runtime.syncSettings({ applyModelToActiveSession: true })

    expect(runtime.appSettings).toMatchObject({ fontFamily: "serif", fontSize: 19 })
    expect(runtime.model).toMatchObject({ provider: "anthropic", id: anthropic.id })
    expect(runtime.activeSession.model).toMatchObject({ provider: "anthropic", id: anthropic.id })
    await expect(runtime.sessions.get(runtime.activeSession.id)).resolves.toMatchObject({
      model: { provider: "anthropic", id: anthropic.id },
    })
    expect(onSettingsModelChanged).toHaveBeenCalledOnce()
    await runtime.shutdown()
  })

  test("keeps synchronized model changes scoped to the Settings opener", async () => {
    const locks = new FakeLockManager() as unknown as LockManager
    const opener = createRuntime(locks)
    await opener.initialize()
    const other = createRuntime(locks)
    await other.initialize()
    const settingsRuntime = createRuntime(locks)
    await settingsRuntime.initializeSettings()
    const anthropic = settingsRuntime.getModels("anthropic")[0]
    if (!anthropic) throw new Error("Anthropic test model unavailable")
    const otherSessionId = other.activeSession.id

    await settingsRuntime.updateSettings({
      ...settingsRuntime.appSettings,
      modelProvider: anthropic.provider,
      modelId: anthropic.id,
    })
    await opener.syncSettings({ applyModelToActiveSession: true })
    await other.syncSettings()

    expect(opener.model).toMatchObject({ provider: "anthropic", id: anthropic.id })
    expect(other.model.provider).toBe("openai-codex")
    expect(other.activeSession.model.provider).toBe("openai-codex")
    await expect(other.sessions.get(otherSessionId)).resolves.toMatchObject({
      model: { provider: "openai-codex" },
    })
    expect(other.appSettings).toMatchObject({
      modelProvider: anthropic.provider,
      modelId: anthropic.id,
    })

    await other.newSession()
    expect(other.model).toMatchObject({ provider: anthropic.provider, id: anthropic.id })
    await opener.shutdown()
    await other.shutdown()
  })

  test("refreshes Radius before resolving synchronized settings", async () => {
    const locks = new FakeLockManager() as unknown as LockManager
    const runtime = createRuntime(locks)
    await runtime.initialize()
    const settingsRuntime = createRuntime(locks)
    await settingsRuntime.initializeSettings()
    const refresh = vi
      .spyOn(runtime.models, "refresh")
      .mockResolvedValue({ aborted: false, errors: new Map() })

    await settingsRuntime.updateSettings({
      ...settingsRuntime.appSettings,
      modelProvider: "radius",
      modelId: "dynamic-radius-model",
    })
    await runtime.syncSettings()

    expect(refresh).toHaveBeenCalledWith({ providers: ["radius"] })
    expect(runtime.appSettings).toMatchObject({
      modelProvider: "radius",
      modelId: "dynamic-radius-model",
    })
    await runtime.shutdown()
  })

  test("persists a selected pi-ai provider and model in the active session", async () => {
    const runtime = createRuntime(new FakeLockManager() as unknown as LockManager)
    await runtime.initialize()
    const anthropic = runtime.getModels("anthropic")[0]
    if (!anthropic) throw new Error("Anthropic test model unavailable")

    await runtime.selectModel(anthropic.provider, anthropic.id)

    expect(runtime.model).toMatchObject({ provider: "anthropic", id: anthropic.id })
    expect(runtime.activeSession.model).toMatchObject({ provider: "anthropic", id: anthropic.id })
    await expect(runtime.sessions.get(runtime.activeSession.id)).resolves.toMatchObject({
      model: { provider: "anthropic", id: anthropic.id },
    })
    await runtime.shutdown()
  })

  test("creates new sessions from the latest selected model after resuming an older session", async () => {
    const runtime = createRuntime(new FakeLockManager() as unknown as LockManager)
    await runtime.initialize()
    const anthropic = runtime.getModels("anthropic")[0]
    if (!anthropic) throw new Error("Anthropic test model unavailable")
    await runtime.selectModel(anthropic.provider, anthropic.id)

    const older = createSession("gpt-5.6-terra")
    await runtime.sessions.put(older)
    await runtime.resumeSession(older.id)
    expect(runtime.model.provider).toBe("openai-codex")

    await runtime.newSession()

    expect(runtime.model).toMatchObject({ provider: anthropic.provider, id: anthropic.id })
    expect(runtime.activeSession.model).toMatchObject({
      provider: anthropic.provider,
      id: anthropic.id,
    })
    await runtime.shutdown()
  })

  test("rejects a saved session whose model is unavailable without changing the active model", async () => {
    const runtime = createRuntime(new FakeLockManager() as unknown as LockManager)
    await runtime.initialize()
    const activeId = runtime.activeSession.id
    const activeModel = runtime.model
    const unavailable = createSession("retired-model", "radius")
    await runtime.sessions.put(unavailable)

    await expect(runtime.resumeSession(unavailable.id)).rejects.toThrow(
      "Saved model is unavailable: radius/retired-model",
    )

    expect(runtime.activeSession.id).toBe(activeId)
    expect(runtime.model).toBe(activeModel)
    await expect(runtime.sessions.get(unavailable.id)).resolves.toMatchObject({
      model: { provider: "radius", id: "retired-model" },
    })
    await runtime.shutdown()
  })

  test("filters providers by browser-supported authentication method", async () => {
    const runtime = createRuntime(new FakeLockManager() as unknown as LockManager)
    await runtime.initialize()

    const accountProviders = runtime.getProviders("oauth")
    const apiKeyProviders = runtime.getProviders("api_key")
    const codex = accountProviders.find((provider) => provider.id === "openai-codex")
    const openai = apiKeyProviders.find((provider) => provider.id === "openai")

    expect(accountProviders.map((provider) => provider.id)).toEqual(["openai-codex"])
    expect(codex?.authMethods).toEqual([{ type: "oauth", label: "OpenAI (ChatGPT Plus/Pro)" }])
    expect(apiKeyProviders.map((provider) => provider.id)).toContain("anthropic")
    expect(apiKeyProviders.map((provider) => provider.id)).not.toContain("openai-codex")
    expect(openai?.authMethods).toEqual([{ type: "api_key", label: "OpenAI API key" }])
    await runtime.shutdown()
  })

  test("rejects images before submitting them to a text-only model", async () => {
    const runtime = createRuntime(new FakeLockManager() as unknown as LockManager)
    await runtime.initialize()
    const textOnly = runtime
      .getProviders()
      .flatMap((provider) => runtime.getModels(provider.id))
      .find((model) => !model.imageInput)
    if (!textOnly) throw new Error("Text-only test model unavailable")
    await runtime.selectModel(textOnly.provider, textOnly.id)
    const image = { type: "image" as const, data: "cG5n", mimeType: "image/png" }

    await expect(runtime.submit("Inspect this", "steer", [image])).rejects.toThrow(
      "does not support image input",
    )
    expect(runtime.agent.state.messages).toEqual([])
    await runtime.shutdown()
  })

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
