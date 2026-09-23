import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai"
import { IDBFactory } from "fake-indexeddb"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { BrowserAgentRuntime } from "../../src/browser/agent/runtime.js"
import { BrowserConfiguration } from "../../src/browser/configuration.js"
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

async function applyModel(
  runtime: BrowserAgentRuntime,
  provider: string,
  modelId: string,
): Promise<void> {
  await runtime.configuration.updateSettings({
    ...runtime.configuration.appSettings,
    modelProvider: provider,
    modelId,
  })
  await runtime.syncSettings({ applyModelToActiveSession: true })
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function controlledStream(runtime: BrowserAgentRuntime) {
  const started = deferred()
  const stream = createAssistantMessageEventStream()
  const finish = () => {
    const message: AssistantMessage = {
      role: "assistant",
      api: runtime.model.api,
      provider: runtime.model.provider,
      model: runtime.model.id,
      content: [{ type: "text", text: "Done" }],
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    }
    stream.push({ type: "done", reason: "stop", message })
    stream.end()
  }
  runtime.agent.streamFunction = (_model, _context, options) => {
    options?.signal?.addEventListener("abort", finish, { once: true })
    started.resolve()
    return stream
  }
  return { started: started.promise, finish }
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
    const steer = vi.spyOn(runtime.agent, "steer")
    const followUp = vi.spyOn(runtime.agent, "followUp")
    const state = runtime.agent.state as unknown as { isStreaming: boolean }
    state.isStreaming = true

    const image = { type: "image" as const, data: "cG5n", mimeType: "image/png" }
    await expect(runtime.submit("Change direction")).resolves.toBe("steer")
    await expect(runtime.submit("Inspect this", "steer", [image])).resolves.toBe("steer")
    await expect(runtime.submit("Do this later", "followUp")).resolves.toBe("followUp")
    await expect(runtime.submit("Inspect this later", "followUp", [image])).resolves.toBe(
      "followUp",
    )
    expect(steer).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ role: "user", content: "Change direction" }),
    )
    expect(steer).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: "Inspect this" }, image],
      }),
    )
    expect(followUp).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ role: "user", content: "Do this later" }),
    )
    expect(followUp).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: "Inspect this later" }, image],
      }),
    )

    state.isStreaming = false
    const prompt = vi.spyOn(runtime.agent, "prompt").mockResolvedValue()
    await expect(runtime.submit("Start a task")).resolves.toBe("prompt")
    await expect(runtime.submit("Inspect now", "steer", [image])).resolves.toBe("prompt")
    expect(prompt).toHaveBeenNthCalledWith(1, "Start a task")
    expect(prompt).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: "Inspect now" }, image],
      }),
    )
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

  test("loads Settings without Agent execution, IndexedDB, or session leases", async () => {
    vi.stubGlobal("indexedDB", undefined)
    vi.stubGlobal("navigator", {})
    const configuration = new BrowserConfiguration(vi.fn())
    const model = await configuration.initialize()

    expect(configuration).not.toHaveProperty("agent")
    expect(configuration).not.toHaveProperty("sessions")
    expect(configuration.appSettings.modelId).toBe("gpt-5.6-terra")
    expect(model.id).toBe("gpt-5.6-terra")
  })

  test("seeds full-tab Settings without changing the configured model", async () => {
    const locks = new FakeLockManager() as unknown as LockManager
    const runtime = createRuntime(locks)
    await runtime.initialize()
    const older = createSession("gpt-5.6-terra", "openai-codex")
    await runtime.sessions.put(older)
    const anthropic = runtime.configuration.getModels("anthropic")[0]
    if (!anthropic) throw new Error("Anthropic test model unavailable")
    await applyModel(runtime, anthropic.provider, anthropic.id)
    await runtime.resumeSession(older.id)
    const settingsRuntime = new BrowserConfiguration(vi.fn())

    const selection = await settingsRuntime.initialize({
      provider: runtime.model.provider,
      id: runtime.model.id,
    })

    expect(selection).toMatchObject({ provider: "openai-codex", id: "gpt-5.6-terra" })
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
    const settingsRuntime = new BrowserConfiguration(vi.fn())
    await settingsRuntime.initialize()
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

    expect(runtime.configuration.appSettings).toMatchObject({ fontFamily: "serif", fontSize: 19 })
    expect(runtime.model).toMatchObject({ provider: "anthropic", id: anthropic.id })
    expect(runtime.activeSession.model).toMatchObject({ provider: "anthropic", id: anthropic.id })
    await expect(runtime.sessions.get(runtime.activeSession.id)).resolves.toMatchObject({
      model: { provider: "anthropic", id: anthropic.id },
    })
    expect(onSettingsModelChanged).toHaveBeenCalledOnce()
    await runtime.shutdown()
  })

  test("applies an explicit thinking choice to the opener and future sessions, not other conversations", async () => {
    const locks = new FakeLockManager() as unknown as LockManager
    const opener = createRuntime(locks)
    await opener.initialize()
    const other = createRuntime(locks)
    await other.initialize()
    const settingsRuntime = new BrowserConfiguration(vi.fn())
    await settingsRuntime.initialize()

    await settingsRuntime.updateSettings({ ...settingsRuntime.appSettings, thinkingLevel: "high" })
    await opener.syncSettings({ applyThinkingToActiveSession: true })
    await other.syncSettings()

    expect(opener.agent.state.thinkingLevel).toBe("high")
    expect(opener.activeSession.model.thinkingLevel).toBe("high")
    await expect(opener.sessions.get(opener.activeSession.id)).resolves.toMatchObject({
      model: { thinkingLevel: "high" },
    })
    expect(other.agent.state.thinkingLevel).toBe("medium")
    const previousSessionId = other.activeSession.id
    await other.newSession()
    expect(other.activeSession.model.thinkingLevel).toBe("high")
    await other.resumeSession(previousSessionId)
    expect(other.agent.state.thinkingLevel).toBe("medium")
    await opener.shutdown()
    await other.shutdown()
  })

  test("defers thinking changes until an active run finishes", async () => {
    const runtime = createRuntime(new FakeLockManager() as unknown as LockManager)
    await runtime.initialize()
    const { started, finish } = controlledStream(runtime)
    const prompt = runtime.submit("Hello")
    await started
    await runtime.configuration.updateSettings({
      ...runtime.configuration.appSettings,
      thinkingLevel: "low",
    })
    await runtime.syncSettings({ applyThinkingToActiveSession: true })
    expect(runtime.agent.state.thinkingLevel).toBe("medium")
    finish()
    await prompt
    await vi.waitFor(() => expect(runtime.activeSession.model.thinkingLevel).toBe("low"))
    await runtime.shutdown()
  })

  test("keeps synchronized model changes scoped to the Settings opener", async () => {
    const locks = new FakeLockManager() as unknown as LockManager
    const opener = createRuntime(locks)
    await opener.initialize()
    const other = createRuntime(locks)
    await other.initialize()
    const settingsRuntime = new BrowserConfiguration(vi.fn())
    await settingsRuntime.initialize()
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
    expect(other.configuration.appSettings).toMatchObject({
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
    const settingsRuntime = new BrowserConfiguration(vi.fn())
    await settingsRuntime.initialize()
    const refresh = vi
      .spyOn(runtime.configuration.models, "refresh")
      .mockResolvedValue({ aborted: false, errors: new Map() })

    await settingsRuntime.updateSettings({
      ...settingsRuntime.appSettings,
      modelProvider: "radius",
      modelId: "dynamic-radius-model",
    })
    await runtime.syncSettings()

    expect(refresh).toHaveBeenCalledWith({ providers: ["radius"] })
    expect(runtime.configuration.appSettings).toMatchObject({
      modelProvider: "radius",
      modelId: "dynamic-radius-model",
    })
    await runtime.shutdown()
  })

  test("persists a selected pi-ai provider and model in the active session", async () => {
    const runtime = createRuntime(new FakeLockManager() as unknown as LockManager)
    await runtime.initialize()
    const anthropic = runtime.configuration.getModels("anthropic")[0]
    if (!anthropic) throw new Error("Anthropic test model unavailable")

    await applyModel(runtime, anthropic.provider, anthropic.id)

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
    const anthropic = runtime.configuration.getModels("anthropic")[0]
    if (!anthropic) throw new Error("Anthropic test model unavailable")
    await applyModel(runtime, anthropic.provider, anthropic.id)

    const older = createSession("gpt-5.6-terra", "openai-codex")
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

    const accountProviders = runtime.configuration.getProviders("oauth")
    const apiKeyProviders = runtime.configuration.getProviders("api_key")
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
    const textOnly = runtime.configuration
      .getProviders()
      .flatMap((provider) => runtime.configuration.getModels(provider.id))
      .find((model) => !model.imageInput)
    if (!textOnly) throw new Error("Text-only test model unavailable")
    await applyModel(runtime, textOnly.provider, textOnly.id)
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
      const session = createSession("gpt-5.6-terra", "openai-codex")
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
    const stale = {
      ...createSession("gpt-5.6-terra", "openai-codex"),
      status: "running" as const,
    }
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
      const session = createSession("gpt-5.6-terra", "openai-codex")
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

  test.each([false, true])(
    "shutdown retains its final write after end persistence (failure=%s)",
    async (failFirst) => {
      const locks = new FakeLockManager() as unknown as LockManager
      const warnings: string[] = []
      const runtime = createRuntime(locks, warnings)
      await runtime.initialize()
      const stream = controlledStream(runtime)
      const submission = runtime.submit("Start")
      await stream.started
      const originalPut = runtime.sessions.put.bind(runtime.sessions)
      const interrupted: SessionRecord[] = []
      let clock = Date.now()
      vi.spyOn(Date, "now").mockImplementation(() => ++clock)
      vi.spyOn(console, "error").mockImplementation(() => undefined)
      vi.spyOn(runtime.sessions, "put").mockImplementation(async (record, protectedIds) => {
        expect((await locks.query()).held).toHaveLength(1)
        if (record.status === "interrupted") {
          interrupted.push(record)
          if (failFirst && interrupted.length === 1) throw new Error("temporary save failure")
        }
        await originalPut(record, protectedIds)
      })

      await runtime.shutdown()
      await submission

      expect(interrupted).toHaveLength(2)
      const [first, final] = interrupted
      if (!first || !final) throw new Error("Missing shutdown persistence")
      expect(final.updatedAt).toBeGreaterThan(first.updatedAt)
      expect(warnings).toHaveLength(failFirst ? 1 : 0)
      if (failFirst) expect(warnings[0]).toContain("temporary save failure")
      await expect(runtime.sessions.get(runtime.activeSession.id)).resolves.toMatchObject(final)
      expect((await locks.query()).held).toEqual([])
    },
  )

  test("shutdown racing an idle end listener still saves interrupted before releasing the lease", async () => {
    const locks = new FakeLockManager() as unknown as LockManager
    const runtime = createRuntime(locks)
    await runtime.initialize()
    const stream = controlledStream(runtime)
    const submission = runtime.submit("Start")
    await stream.started
    const entered = deferred()
    const release = deferred()
    const originalPut = runtime.sessions.put.bind(runtime.sessions)
    const statuses: string[] = []
    vi.spyOn(runtime.sessions, "put").mockImplementation(async (record, protectedIds) => {
      statuses.push(record.status)
      if (record.status === "idle") {
        entered.resolve()
        await release.promise
      }
      expect((await locks.query()).held).toHaveLength(1)
      await originalPut(record, protectedIds)
    })
    stream.finish()
    await entered.promise
    expect(runtime.agent.state.isStreaming).toBe(true)
    const shutdown = runtime.shutdown()
    release.resolve()
    await Promise.all([submission, shutdown])

    expect(statuses.slice(-2)).toEqual(["idle", "interrupted"])
    await expect(runtime.sessions.get(runtime.activeSession.id)).resolves.toMatchObject({
      status: "interrupted",
    })
    expect((await locks.query()).held).toEqual([])
  })

  test.each([false, true])(
    "Radius setup preserves selection and clears auth serialization (refresh failure=%s)",
    async (failRefresh) => {
      const notify = vi.fn()
      const configuration = new BrowserConfiguration(notify)
      const selection = await configuration.initialize()
      const settings = configuration.appSettings
      const controller = new AbortController()
      const prompt = vi.fn()
      const entered = deferred()
      const release = deferred()
      const login = vi.spyOn(configuration.models, "login").mockImplementation(async () => {
        entered.resolve()
        await release.promise
        return { type: "api_key", key: "test-key" }
      })
      const error = new Error("catalog unavailable")
      const refresh = vi.spyOn(configuration.models, "refresh").mockResolvedValue({
        aborted: false,
        errors: failRefresh ? new Map([["radius", error]]) : new Map(),
      })
      const setup = configuration.login("radius", "api_key", controller.signal, prompt)
      await entered.promise
      await expect(configuration.refreshCredential("radius")).rejects.toThrow(
        "Another authentication change",
      )
      expect(configuration.isChangingAuth).toBe(true)
      release.resolve()
      if (failRefresh) await expect(setup).rejects.toThrow(error)
      else await setup
      expect(login).toHaveBeenCalledWith("radius", "api_key", {
        signal: controller.signal,
        notify,
        prompt,
      })
      expect(refresh).toHaveBeenCalledWith({
        providers: ["radius"],
        force: true,
        signal: controller.signal,
      })
      expect(configuration.isChangingAuth).toBe(false)
      expect(selection).toMatchObject({ provider: settings.modelProvider, id: settings.modelId })
      expect(configuration.appSettings).toEqual(settings)
    },
  )

  test("endpoint lookup retains the live model read after awaiting credentials", async () => {
    const configuration = new BrowserConfiguration(vi.fn())
    let model = await configuration.initialize()
    const entered = deferred()
    const release = deferred()
    vi.spyOn(configuration.credentials, "read").mockImplementationOnce(async (provider) => {
      expect(provider).toBe("openai-codex")
      entered.resolve()
      await release.promise
      return undefined
    })
    const endpoints = configuration.requiredModelEndpointUrls(() => model)
    await entered.promise
    model = { ...model, baseUrl: "https://changed-endpoint.test" }
    release.resolve()
    await expect(endpoints).resolves.toEqual(["https://changed-endpoint.test"])
    await expect(
      configuration.requiredModelEndpointUrls(() => ({ ...model, provider: "missing" })),
    ).rejects.toThrow("Provider is unavailable: missing")
    await expect(
      configuration.requiredModelEndpointUrls(() => ({
        ...model,
        provider: "azure-openai-responses",
      })),
    ).rejects.toThrow("No browser endpoint is configured")
  })

  test("cancelled setup releases the authentication guard", async () => {
    const configuration = new BrowserConfiguration(vi.fn())
    const controller = new AbortController()
    const cancelled = new DOMException("Provider setup cancelled", "AbortError")
    vi.spyOn(configuration.models, "login").mockImplementation(
      async (_provider, _type, options) => {
        return new Promise<never>((_resolve, reject) =>
          options.signal?.addEventListener("abort", () => reject(cancelled), { once: true }),
        )
      },
    )
    const setup = configuration.login("anthropic", "api_key", controller.signal, vi.fn())
    controller.abort()
    await expect(setup).rejects.toBe(cancelled)
    expect(configuration.isChangingAuth).toBe(false)
  })

  test.each(["logout", "invalidateCredential"] as const)(
    "%s aborts the conversation and waits for persistence before removing credentials",
    async (operation) => {
      const runtime = createRuntime(new FakeLockManager() as unknown as LockManager)
      await runtime.initialize()
      const configuration = runtime.configuration
      await configuration.credentials.modify("openai-codex", async () => ({
        type: "oauth",
        access: "access",
        refresh: "refresh",
        expires: Date.now() + 60_000,
      }))
      const stream = controlledStream(runtime)
      const submission = runtime.submit("Start")
      await stream.started
      const entered = deferred()
      const release = deferred()
      const originalPut = runtime.sessions.put.bind(runtime.sessions)
      vi.spyOn(runtime.sessions, "put").mockImplementation(async (record, protectedIds) => {
        if (record.status === "idle") {
          entered.resolve()
          await release.promise
        }
        await originalPut(record, protectedIds)
      })
      const removal = configuration[operation]("openai-codex")
      await entered.promise
      await expect(configuration.credentials.read("openai-codex")).resolves.toBeDefined()
      if (operation === "logout")
        await expect(runtime.submit("Blocked")).rejects.toThrow(
          "Wait for the authentication change",
        )
      release.resolve()
      await Promise.all([submission, removal])
      await expect(configuration.credentials.read("openai-codex")).resolves.toBeUndefined()
      expect(runtime.agent.state.isStreaming).toBe(false)
      expect(configuration.isChangingAuth).toBe(false)
      await runtime.shutdown()
    },
  )

  test("auth status requires stored credentials and rechecks concurrent removal", async () => {
    const configuration = new BrowserConfiguration(vi.fn())
    await configuration.initialize()
    const checkAuth = vi.spyOn(configuration.models, "checkAuth")
    await expect(configuration.authStatus("openai-codex")).resolves.toEqual({ loggedIn: false })
    expect(checkAuth).not.toHaveBeenCalled()
    await configuration.credentials.modify("openai-codex", async () => ({
      type: "oauth",
      access: "access",
      refresh: "refresh",
      expires: Date.now() + 60_000,
    }))
    const read = configuration.credentials.read.bind(configuration.credentials)
    const entered = deferred()
    const release = deferred()
    vi.spyOn(configuration.credentials, "read").mockImplementationOnce(async (provider) => {
      const credential = await read(provider)
      entered.resolve()
      await release.promise
      return credential
    })
    const status = configuration.authStatus("openai-codex")
    await entered.promise
    await configuration.credentials.delete("openai-codex")
    release.resolve()
    await expect(status).resolves.toEqual({ loggedIn: false })
    expect(checkAuth).toHaveBeenCalledOnce()
  })

  test("removes the stored credential after host permission revocation", async () => {
    const runtime = createRuntime(new FakeLockManager() as unknown as LockManager)
    await runtime.initialize()
    await runtime.configuration.credentials.modify("openai-codex", async () => ({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
    }))

    await runtime.configuration.invalidateCredential()

    await expect(runtime.configuration.authStatus(runtime.model.provider)).resolves.toEqual({
      loggedIn: false,
    })
    await runtime.shutdown()
  })
})
