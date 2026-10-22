import type { AgentTool } from "@earendil-works/pi-agent-core"
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai"
import { IDBFactory } from "fake-indexeddb"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { BrowserAgentRuntime } from "../../src/browser/agent/runtime.js"
import { SessionLease } from "../../src/browser/sessions/session-lease.js"
import { MAX_SESSION_BYTES, type SessionRecord } from "../../src/browser/sessions/session-store.js"
import { parseSkill, SKILL_LIMITS } from "../../src/browser/skills/format.js"
import { SkillStore } from "../../src/browser/skills/store.js"

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

let locks: LockManager
const runtimes = new Set<BrowserAgentRuntime>()

function createRuntime(warnings: string[] = []) {
  const runtime = new BrowserAgentRuntime(
    {
      confirm: vi.fn(async () => false),
      onAuthEvent: vi.fn(),
      onAgentEvent: vi.fn(),
      onPersistenceError: (message) => warnings.push(message),
    },
    new SessionLease(locks),
  )
  runtimes.add(runtime)
  return runtime
}

async function close(runtime: BrowserAgentRuntime) {
  await runtime.shutdown()
  runtimes.delete(runtime)
}

function parsed(name: string, body = `PRIVATE BODY FOR ${name}`, description = `Review ${name}`) {
  return parseSkill(`---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n${body}`)
}

async function install(store: SkillStore, name: string, body?: string, enabled = true) {
  const record = await store.import(parsed(name, body))
  if (enabled) await store.setEnabled(record.id, true)
  return record
}

function loader(runtime: BrowserAgentRuntime): AgentTool {
  const tool = runtime.agent.state.tools.find((tool) => tool.name === "skills_load")
  if (!tool) throw new Error("Missing skills_load tool")
  return tool
}

function resultText(result: Awaited<ReturnType<AgentTool["execute"]>>) {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
}

function catalog(prompt: string) {
  return [...prompt.matchAll(/\{[^{}]*"id"\s*:[^{}]*\}/g)].map((match) => JSON.parse(match[0]))
}

function metadata(record: { id: string; name: string; description: string }) {
  return { id: record.id, name: record.name, description: record.description }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function assistant(runtime: BrowserAgentRuntime): AssistantMessage {
  return {
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
}

function controlledStreams(runtime: BrowserAgentRuntime) {
  const calls: { context: string; finish: () => void }[] = []
  runtime.agent.streamFunction = (_model, context, options) => {
    const stream = createAssistantMessageEventStream()
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      stream.push({ type: "done", reason: "stop", message: assistant(runtime) })
      stream.end()
    }
    options?.signal?.addEventListener("abort", finish, { once: true })
    if (options?.signal?.aborted) finish()
    calls.push({ context: JSON.stringify(context), finish })
    return stream
  }
  return {
    calls,
    async call(index: number) {
      await vi.waitFor(() => expect(calls.length).toBeGreaterThan(index))
      const call = calls[index]
      if (!call) throw new Error("Missing model stream")
      return call
    },
  }
}

function loadThroughModel(runtime: BrowserAgentRuntime, id: string) {
  const contexts: string[] = []
  const stream = vi.fn((_model, context, _options) => {
    contexts.push(JSON.stringify(context))
    const events = createAssistantMessageEventStream()
    const message = assistant(runtime)
    if (contexts.length === 1) {
      message.content = [
        { type: "toolCall", id: "load-reviewed-skill", name: "skills_load", arguments: { id } },
      ]
      message.stopReason = "toolUse"
      events.push({ type: "done", reason: "toolUse", message })
    } else {
      events.push({ type: "done", reason: "stop", message })
    }
    events.end()
    return events
  })
  runtime.agent.streamFunction = stream
  return { contexts, stream }
}

function persist(runtime: BrowserAgentRuntime): Promise<void> {
  return (
    runtime as unknown as { persist(status: SessionRecord["status"]): Promise<void> }
  ).persist("idle")
}

beforeEach(() => {
  locks = new FakeLockManager() as unknown as LockManager
  vi.stubGlobal("indexedDB", new IDBFactory())
  const area = () => {
    const values: Record<string, unknown> = {}
    return {
      get: vi.fn(async (key: string) => structuredClone({ [key]: values[key] })),
      set: vi.fn(async (items: Record<string, unknown>) =>
        Object.assign(values, structuredClone(items)),
      ),
      remove: vi.fn(async (key: string) => {
        delete values[key]
      }),
    }
  }
  vi.stubGlobal("chrome", {
    storage: {
      local: { ...area(), setAccessLevel: vi.fn(async () => undefined) },
      session: area(),
    },
  })
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected network request")
    }),
  )
})

afterEach(async () => {
  try {
    for (const runtime of runtimes) runtime.abort()
    await Promise.all([...runtimes].map((runtime) => close(runtime)))
  } finally {
    runtimes.clear()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})

describe("browser skills runtime", () => {
  test("reads skills only on explicit submit and sends only enabled JSON metadata without page tools", async () => {
    const store = new SkillStore()
    const enabled = await install(store, "private-review")
    const disabled = await install(store, "disabled-review", undefined, false)
    const list = vi.spyOn(SkillStore.prototype, "list")
    const runtime = createRuntime()
    await runtime.initialize()
    await runtime.configuration.updateSettings({
      ...runtime.configuration.appSettings,
      enabledTools: [],
      agentInstructions: "Keep existing AGENTS instructions.",
    })
    await runtime.syncSettings()
    const sessionId = runtime.activeSession.id
    await runtime.newSession()
    await runtime.resumeSession(sessionId)
    expect(list).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(runtime.agent.state.tools).toEqual([])
    expect(runtime.agent.state.systemPrompt).not.toContain(enabled.id)
    expect(JSON.stringify(runtime.agent.state.messages)).not.toContain(enabled.body)

    const streams = controlledStreams(runtime)
    const submission = runtime.submit("Use the reviewed skill", "steer", [], [], false)
    const first = await streams.call(0)
    expect(list).toHaveBeenCalledOnce()
    expect(runtime.usesPageContext).toBe(false)
    expect(runtime.agent.state.tools.map((tool) => tool.name)).toEqual(["skills_load"])
    expect(catalog(runtime.agent.state.systemPrompt)).toEqual([metadata(enabled)])
    expect(runtime.agent.state.systemPrompt).toContain("Keep existing AGENTS instructions.")
    expect(runtime.agent.state.systemPrompt).toContain("Browser page text")
    expect(first.context).not.toContain(enabled.body)
    expect(first.context).not.toContain(disabled.id)
    const result = await loader(runtime).execute("read", { id: enabled.id })
    expect(resultText(result)).toContain(enabled.body)
    expect(fetch).not.toHaveBeenCalled()
    first.finish()
    await submission
  })

  test("rejects unknown and disabled IDs and charges the full serialized result on every repeated load", async () => {
    const store = new SkillStore()
    const enabled = await install(store, "quoted-review", "\\".repeat(60_000))
    const disabled = await install(store, "disabled-review", undefined, false)
    const runtime = createRuntime()
    await runtime.initialize()
    const streams = controlledStreams(runtime)
    const submission = runtime.submit("Review")
    const first = await streams.call(0)
    const tool = loader(runtime)
    await expect(tool.execute("unknown", { id: "not-installed" })).rejects.toThrow()
    await expect(tool.execute("disabled", { id: disabled.id })).rejects.toThrow()
    const result = await tool.execute("first", { id: enabled.id })
    expect(result.isError).not.toBe(true)
    const bytes = new TextEncoder().encode(resultText(result)).byteLength
    expect(bytes).toBeLessThanOrEqual(SKILL_LIMITS.loadedBytes)
    expect(bytes * 2).toBeGreaterThan(SKILL_LIMITS.loadedBytes)
    expect(new TextEncoder().encode(enabled.body).byteLength * 2).toBeLessThan(
      SKILL_LIMITS.loadedBytes,
    )
    await expect(tool.execute("repeat", { id: enabled.id })).rejects.toThrow(/limit|budget/i)
    first.finish()
    await submission

    const next = runtime.submit("New run has a fresh budget")
    const second = await streams.call(1)
    const fresh = await loader(runtime).execute("fresh", { id: enabled.id })
    expect(fresh.isError).not.toBe(true)
    second.finish()
    await next
  })

  test("keeps an immutable snapshot through streaming and queued instructions, then refreshes on a new submit", async () => {
    const store = new SkillStore()
    const replaced = await install(store, "replace-review", "ORIGINAL REVIEW BODY")
    const deleted = await install(store, "delete-review", "DELETED DURING STREAM BODY")
    const runtime = createRuntime()
    await runtime.initialize()
    const list = vi.spyOn(SkillStore.prototype, "list")
    const runReads = () => list.mock.contexts.filter((context) => context !== store).length
    const streams = controlledStreams(runtime)
    const submission = runtime.submit("Start")
    const first = await streams.call(0)
    const tool = loader(runtime)
    const initialPrompt = runtime.agent.state.systemPrompt
    const replacement = await store.replace(
      replaced.id,
      parsed("replace-review", "REPLACEMENT BODY"),
    )
    expect(replacement).toMatchObject({ id: replaced.id, enabled: false })
    await store.setEnabled(replaced.id, true)
    await store.remove(deleted.id)
    const imported = await install(store, "new-review", "NEWLY IMPORTED BODY")
    await runtime.configuration.updateSettings({
      ...runtime.configuration.appSettings,
      agentInstructions: "NEXT RUN INSTRUCTIONS",
    })
    await runtime.syncSettings()
    await expect(runtime.submit("Queued steering instruction")).resolves.toBe("steer")
    await expect(runtime.submit("Queued follow-up", "followUp")).resolves.toBe("followUp")
    runtime.queueFollowUp("Another queued instruction")
    expect(runReads()).toBe(1)
    expect(runtime.agent.state.systemPrompt).toBe(initialPrompt)
    expect(runtime.agent.state.tools).toContain(tool)
    expect(resultText(await tool.execute("old-replacement", { id: replaced.id }))).toContain(
      replaced.body,
    )
    expect(resultText(await tool.execute("old-deleted", { id: deleted.id }))).toContain(
      deleted.body,
    )
    await expect(tool.execute("new-import", { id: imported.id })).rejects.toThrow()
    first.finish()
    for (const index of [1, 2, 3]) {
      const queued = await streams.call(index)
      expect(runtime.agent.state.systemPrompt).toBe(initialPrompt)
      expect(queued.context).not.toContain("REPLACEMENT BODY")
      expect(queued.context).not.toContain(imported.id)
      expect(runReads()).toBe(1)
      expect(resultText(await tool.execute(`queued-${index}`, { id: deleted.id }))).toContain(
        deleted.body,
      )
      queued.finish()
    }
    await submission
    await expect(tool.execute("ended", { id: replaced.id })).rejects.toThrow()

    const next = runtime.submit("Explicit next task")
    const latest = await streams.call(4)
    expect(runReads()).toBe(2)
    expect(catalog(runtime.agent.state.systemPrompt)).toEqual(
      expect.arrayContaining([metadata(replacement), metadata(imported)]),
    )
    expect(runtime.agent.state.systemPrompt).toContain("NEXT RUN INSTRUCTIONS")
    expect(runtime.agent.state.systemPrompt).not.toContain(deleted.id)
    expect(resultText(await loader(runtime).execute("new-body", { id: replaced.id }))).toContain(
      replacement.body,
    )
    await expect(loader(runtime).execute("deleted", { id: deleted.id })).rejects.toThrow()
    await expect(tool.execute("still-ended", { id: replaced.id })).rejects.toThrow()
    latest.finish()
    await next
  })

  test.each(["abort", "shutdown", "session"] as const)(
    "%s invalidates captured tool references",
    async (operation) => {
      const store = new SkillStore()
      const skill = await install(store, "lifetime-review")
      const runtime = createRuntime()
      await runtime.initialize()
      const streams = controlledStreams(runtime)
      const submission = runtime.submit("Start")
      await streams.call(0)
      const tool = loader(runtime)
      expect(resultText(await tool.execute("before", { id: skill.id }))).toContain(skill.body)
      let stopping: Promise<void> = Promise.resolve()
      if (operation === "abort") runtime.abort()
      else if (operation === "shutdown") stopping = close(runtime)
      else stopping = runtime.newSession()
      await expect(tool.execute("after", { id: skill.id })).rejects.toThrow()
      await Promise.all([submission, stopping])
      if (operation === "session") {
        expect(runtime.agent.state.tools.some((entry) => entry.name === "skills_load")).toBe(false)
        expect(runtime.agent.state.systemPrompt).not.toContain(skill.id)
      }
    },
  )

  test.each(["abort", "shutdown", "session"] as const)(
    "%s during skill preparation prevents model dispatch",
    async (operation) => {
      const store = new SkillStore()
      await install(store, "prepared-review")
      const runtime = createRuntime()
      await runtime.initialize()
      const entered = deferred()
      const release = deferred()
      const list = SkillStore.prototype.list
      vi.spyOn(SkillStore.prototype, "list").mockImplementationOnce(async function (
        this: SkillStore,
      ) {
        const records = await list.call(this)
        entered.resolve()
        await release.promise
        return records
      })
      const prompt = vi.spyOn(runtime.agent, "prompt").mockResolvedValue()
      const pending = runtime.submit("Cancelled before dispatch")
      const settled = pending.then(
        () => undefined,
        () => undefined,
      )
      await entered.promise
      let stopping: Promise<void> = Promise.resolve()
      try {
        if (operation === "abort") runtime.abort()
        else if (operation === "shutdown") stopping = close(runtime)
        else stopping = runtime.newSession()
      } finally {
        release.resolve()
      }
      await Promise.all([settled, stopping])
      expect(prompt).not.toHaveBeenCalled()
      expect(runtime.isPreparing).toBe(false)
      expect(runtime.agent.state.tools.some((tool) => tool.name === "skills_load")).toBe(false)
    },
  )

  test.each(["disable", "delete"] as const)(
    "persists a real model-requested body without replay; restored history cannot authorize a %sd skill",
    async (operation) => {
      const store = new SkillStore()
      const skill = await install(store, "saved-review", "REVIEWED BODY PERSISTED IN HISTORY")
      await install(store, "other-review")
      const runtime = createRuntime()
      await runtime.initialize()
      const first = loadThroughModel(runtime, skill.id)
      await runtime.submit("Load the reviewed skill", "steer", [], [], false)
      expect(first.stream).toHaveBeenCalledTimes(2)
      expect(first.contexts[0]).not.toContain(skill.body)
      expect(first.contexts[1]).toContain(skill.body)
      const toolResult = runtime.agent.state.messages.find(
        (message) => message.role === "toolResult",
      )
      expect(toolResult).toMatchObject({ toolName: "skills_load", isError: false })
      expect(JSON.stringify(toolResult)).toContain(skill.body)
      const sessionId = runtime.activeSession.id
      expect(JSON.stringify((await runtime.sessions.get(sessionId))?.messages)).toContain(
        skill.body,
      )
      await close(runtime)
      if (operation === "disable") await store.setEnabled(skill.id, false)
      else await store.remove(skill.id)

      const list = vi.spyOn(SkillStore.prototype, "list")
      const reopened = createRuntime()
      const replay = vi.fn()
      reopened.agent.streamFunction = replay
      await reopened.initialize(sessionId)
      expect(replay).not.toHaveBeenCalled()
      expect(list).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
      expect(JSON.stringify(reopened.agent.state.messages)).toContain(skill.body)
      expect(reopened.agent.state.tools.some((tool) => tool.name === "skills_load")).toBe(false)
      expect(reopened.agent.state.systemPrompt).not.toContain(skill.id)
      const baseline = reopened.agent.state.messages[0]
      expect(baseline?.role).toBe("system")
      if (baseline?.role !== "system") throw new Error("Missing system baseline")
      expect(baseline.toolsAdded?.some((tool) => tool.name === "skills_load")).not.toBe(true)

      const next = loadThroughModel(reopened, skill.id)
      await reopened.submit("Try the historical skill again", "steer", [], [], false)
      expect(next.stream).toHaveBeenCalledTimes(2)
      const results = reopened.agent.state.messages.filter(
        (message) => message.role === "toolResult",
      )
      expect(results.at(-1)).toMatchObject({ toolName: "skills_load", isError: true })
      expect(JSON.stringify(results.at(-1))).not.toContain(skill.body)
      expect(JSON.stringify(reopened.agent.state.messages)).toContain(skill.body)
    },
  )

  test("linear size compaction retains the loaded skill turn and the system baseline", async () => {
    const store = new SkillStore()
    const skill = await install(store, "compact-review", "LOADED BODY RETAINED AFTER COMPACTION")
    const warnings: string[] = []
    const runtime = createRuntime(warnings)
    await runtime.initialize()
    loadThroughModel(runtime, skill.id)
    await runtime.submit("Load for this turn")
    const messages = structuredClone(runtime.agent.state.messages)
    const baseline = messages[0]
    const loadedTurn = messages.filter((message) => message.role !== "system")
    if (!baseline) throw new Error("Missing baseline")
    runtime.agent.state.messages = [
      baseline,
      { role: "user", content: "x".repeat(MAX_SESSION_BYTES), timestamp: 1 },
      ...loadedTurn,
    ]
    await persist(runtime)
    expect(warnings).toEqual([expect.stringContaining("size limit")])
    expect(runtime.agent.state.messages).toEqual([baseline, ...loadedTurn])
    expect(JSON.stringify(runtime.agent.state.messages)).toContain(skill.body)
    expect((await runtime.sessions.get(runtime.activeSession.id))?.messages).toEqual(
      runtime.agent.state.messages,
    )
  })

  test("tree size failure preserves the saved loaded body and does not compact the live path", async () => {
    const store = new SkillStore()
    const skill = await install(store, "tree-review", "LOADED BODY RETAINED IN TREE")
    const warnings: string[] = []
    const runtime = createRuntime(warnings)
    await runtime.initialize()
    loadThroughModel(runtime, skill.id)
    await runtime.submit("Load into a tree")
    await runtime.navigateTree(runtime.getSessionTree().activeLeafId)
    const saved = await runtime.sessions.get(runtime.activeSession.id)
    if (!saved?.tree) throw new Error("Missing saved tree")
    expect(JSON.stringify(saved.tree)).toContain(skill.body)
    runtime.agent.state.messages.push({
      role: "user",
      content: "x".repeat(MAX_SESSION_BYTES),
      timestamp: Date.now(),
    })
    const live = structuredClone(runtime.agent.state.messages)
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    await persist(runtime)
    expect(warnings).toEqual([expect.stringContaining("storage limit")])
    expect(runtime.agent.state.messages).toEqual(live)
    expect(await runtime.sessions.get(saved.id)).toEqual(saved)
    await expect(runtime.navigateTree(null)).rejects.toThrow("storage limit")
    expect(await runtime.sessions.get(saved.id)).toEqual(saved)
    runtime.agent.state.messages = structuredClone(saved.messages)
    await runtime.resumeSession(saved.id)
  })
})
