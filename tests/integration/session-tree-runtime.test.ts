import type { AgentMessage } from "@earendil-works/pi-agent-core"
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type ImageContent,
} from "@earendil-works/pi-ai"
import { IDBFactory } from "fake-indexeddb"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { BrowserAgentRuntime } from "../../src/browser/agent/runtime.js"
import { McpManager } from "../../src/browser/mcp/manager.js"
import { SessionLease } from "../../src/browser/sessions/session-lease.js"
import { createSession, MAX_SESSION_BYTES } from "../../src/browser/sessions/session-store.js"
import {
  getTreeItems,
  getTreePath,
  MAX_TREE_NODES,
} from "../../src/browser/sessions/session-tree.js"

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

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test fixture")
  return value
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function setup(locks = new FakeLockManager() as unknown as LockManager) {
  const warnings: string[] = []
  const confirm = vi.fn(async () => false)
  const onAgentEvent = vi.fn()
  const lease = new SessionLease(locks)
  const runtime = new BrowserAgentRuntime(
    {
      confirm,
      onAuthEvent: vi.fn(),
      onAgentEvent,
      onPersistenceError: (message) => warnings.push(message),
    },
    lease,
  )
  return { runtime, lease, warnings, confirm, onAgentEvent, locks }
}

function user(text: string, timestamp = 1): AgentMessage {
  return { role: "user", content: text, timestamp }
}

function assistant(text: string, timestamp = 2): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai-codex",
    model: "gpt-5.6-terra",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp,
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

const image: ImageContent = { type: "image", mimeType: "image/png", data: "cG5n" }

function persist(runtime: BrowserAgentRuntime): Promise<void> {
  return (runtime as unknown as { persist(status: "idle"): Promise<void> }).persist("idle")
}

async function seed(runtime: BrowserAgentRuntime, messages: AgentMessage[]) {
  runtime.agent.state.messages = [required(runtime.agent.state.messages[0]), ...messages]
  await persist(runtime)
}

function history(runtime: BrowserAgentRuntime): AgentMessage[] {
  return runtime.agent.state.messages.filter(
    (message, index) => index !== 0 || message.role !== "system",
  )
}

function nodeId(runtime: BrowserAgentRuntime, text: string): string {
  const node = runtime.getSessionTree().nodes.find((node) => {
    const content = node.message.content
    return typeof content === "string"
      ? content === text
      : content.some((part) => part.type === "text" && part.text === text)
  })
  if (!node) throw new Error(`Missing node: ${text}`)
  return node.id
}

function immediateStream(runtime: BrowserAgentRuntime, reply = "New answer") {
  const stream = vi.fn((_model, _context, _options) => {
    const events = createAssistantMessageEventStream()
    events.push({ type: "done", reason: "stop", message: assistant(reply, Date.now()) })
    events.end()
    return events
  })
  runtime.agent.streamFunction = stream
  return stream
}

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory())
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
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("session tree runtime integration", () => {
  test("opening and cancelling a legacy preview does not activate, save, or change context", async () => {
    const { runtime, confirm } = setup()
    await runtime.initialize()
    await seed(runtime, [user("Original"), assistant("Original answer")])
    const saved = await runtime.sessions.get(runtime.activeSession.id)
    const live = structuredClone(runtime.agent.state.messages)
    const put = vi.spyOn(runtime.sessions, "put")
    const reset = vi.spyOn(runtime.agent, "reset")
    const prepare = vi.spyOn(McpManager.prototype, "prepare")
    const snapshot = runtime.getSessionTree()
    const first = required(snapshot.nodes[0])
    const id = first.id
    first.message = user("Changed copy")

    expect(runtime.getSessionTree().nodes[0]?.message).toEqual(user("Original"))
    expect(runtime.previewTreeSelection(id)).toEqual({ text: "Original", images: [] })
    expect(runtime.activeSession.tree).toBeUndefined()
    expect(runtime.agent.state.messages).toEqual(live)
    expect(await runtime.sessions.get(runtime.activeSession.id)).toEqual(saved)
    expect(put).not.toHaveBeenCalled()
    expect(reset).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
    await runtime.shutdown()
    expect((await runtime.sessions.get(runtime.activeSession.id))?.tree).toBeUndefined()
  })

  test("upgrades on user selection, restores images, and retains both branches across restart", async () => {
    const { runtime, locks } = setup()
    await runtime.initialize()
    const multimodal: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: "Inspect original" }, image],
      timestamp: 1,
    }
    await seed(runtime, [multimodal, assistant("Original answer")])
    const original = runtime.getSessionTree()
    const userId = required(original.nodes[0]).id
    const answerId = required(original.nodes[1]).id
    const draft = await runtime.navigateTree(userId)
    expect(draft).toEqual({ text: "Inspect original", images: [image] })
    expect(history(runtime)).toEqual([])
    expect(runtime.activeSession.tree?.activeLeafId).toBeNull()
    required(draft.images[0]).data = "mutated"
    expect(runtime.previewTreeSelection(userId).images).toEqual([image])
    immediateStream(runtime, "New branch answer")
    await runtime.submit("Edited request", "steer", [image])
    const branched = runtime.getSessionTree()
    expect(branched.nodes.slice(0, 2)).toEqual(original.nodes)
    expect(branched.nodes).toHaveLength(4)
    const newLeaf = branched.activeLeafId
    await runtime.navigateTree(answerId)
    expect(history(runtime)).toEqual([multimodal, assistant("Original answer")])
    await runtime.navigateTree(newLeaf)
    expect(JSON.stringify(history(runtime))).toContain("Edited request")
    expect(JSON.stringify(history(runtime))).not.toContain("Original answer")
    const sessionId = runtime.activeSession.id
    await runtime.shutdown()

    const reopened = setup(locks).runtime
    await reopened.initialize(sessionId)
    expect(reopened.getSessionTree()).toEqual(branched)
    await reopened.navigateTree(answerId)
    expect(history(reopened)).toEqual([multimodal, assistant("Original answer")])
    await reopened.shutdown()
  })

  test("only the active path reaches the provider and navigation never prompts or discovers tools", async () => {
    const { runtime, confirm, onAgentEvent } = setup()
    await runtime.initialize()
    await seed(runtime, [user("Original secret"), assistant("Old branch secret")])
    const oldLeaf = runtime.getSessionTree().activeLeafId
    const stream = immediateStream(runtime)
    const prompt = vi.spyOn(runtime.agent, "prompt")
    const resume = vi.spyOn(runtime.agent, "continue")
    const prepare = vi.spyOn(McpManager.prototype, "prepare")
    onAgentEvent.mockClear()
    await runtime.navigateTree(null)
    expect(prompt).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
    expect(onAgentEvent).not.toHaveBeenCalled()
    await runtime.submit("New branch request")
    expect(stream).toHaveBeenCalledOnce()
    const context = required(stream.mock.calls[0])[1]
    expect(JSON.stringify(context)).toContain("New branch request")
    expect(JSON.stringify(context)).not.toContain("Original secret")
    expect(JSON.stringify(context)).not.toContain("Old branch secret")
    expect(getTreePath(runtime.getSessionTree(), oldLeaf)).toHaveLength(2)
    await runtime.shutdown()
  })

  test("inactive image and tool payloads stay out of provider context while selected paired history is retained", async () => {
    const { runtime } = setup()
    await runtime.initialize()
    const historicalImage = { ...image, data: "historical-image-bytes" }
    const request: AgentMessage = { role: "user", content: [historicalImage], timestamp: 1 }
    const call: AssistantMessage = {
      ...assistant(""),
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall",
          id: "historical-mutation",
          name: "browser_click",
          arguments: { target: "historical-target" },
        },
      ],
    }
    const result: AgentMessage = {
      role: "toolResult",
      toolCallId: "historical-mutation",
      toolName: "browser_click",
      content: [historicalImage],
      isError: false,
      timestamp: 3,
    }
    await seed(runtime, [request, call, result, assistant("Historical completion", 4)])
    const resultId = required(runtime.getSessionTree().nodes[2]).id
    await runtime.navigateTree(null)
    const stream = immediateStream(runtime)
    await runtime.submit("Independent branch")
    const independent = JSON.stringify(required(stream.mock.calls[0])[1])
    expect(independent).not.toContain("historical-image-bytes")
    expect(independent).not.toContain("historical-mutation")
    expect(independent).not.toContain("historical-target")
    await runtime.navigateTree(resultId)
    expect(history(runtime)).toEqual([request, call, result])
    stream.mockClear()
    await runtime.submit("Continue after saved result")
    const selected = JSON.stringify(required(stream.mock.calls[0])[1])
    expect(selected).toContain("historical-image-bytes")
    expect(selected).toContain("historical-mutation")
    expect(selected).not.toContain("Independent branch")
    await runtime.shutdown()
  })

  test("nested edits append a suffix with stable ancestors and preserve inactive descendants", async () => {
    const { runtime } = setup()
    await runtime.initialize()
    await seed(runtime, [
      user("First"),
      assistant("First answer"),
      user("Second", 3),
      assistant("Second answer", 4),
    ])
    const initial = runtime.getSessionTree()
    expect(await runtime.navigateTree(required(initial.nodes[2]).id)).toEqual({
      text: "Second",
      images: [],
    })
    expect(history(runtime)).toEqual([user("First"), assistant("First answer")])
    immediateStream(runtime, "Edited answer")
    await runtime.submit("Edited second")
    const tree = runtime.getSessionTree()
    expect(tree.nodes.slice(0, 4)).toEqual(initial.nodes)
    expect(tree.nodes[4]?.parentId).toBe(required(initial.nodes[1]).id)
    await persist(runtime)
    expect(runtime.getSessionTree()).toEqual(tree)
    await runtime.navigateTree(initial.activeLeafId)
    expect(history(runtime)).toEqual(initial.nodes.map((node) => node.message))
    await runtime.shutdown()
  })

  test("retains paired tool calls, results, metadata, and images without replay", async () => {
    const { runtime, confirm } = setup()
    await runtime.initialize()
    const call = {
      ...assistant("", 2),
      stopReason: "toolUse" as const,
      content: [
        {
          type: "toolCall" as const,
          id: "mutation",
          name: "browser_click",
          arguments: { target: "button" },
        },
      ],
    }
    const result: AgentMessage = {
      role: "toolResult",
      toolCallId: "mutation",
      toolName: "browser_click",
      content: [{ type: "text", text: "clicked" }, image],
      details: { operation: "saved metadata" },
      isError: false,
      timestamp: 3,
    }
    await seed(runtime, [user("Click"), call, result, assistant("Complete", 4)])
    const tree = runtime.getSessionTree()
    const reset = vi.spyOn(runtime.agent, "reset")
    const prepare = vi.spyOn(McpManager.prototype, "prepare")
    const execute = runtime.agent.state.tools.map((tool) => vi.spyOn(tool, "execute"))
    expect(getTreeItems(tree)[1]?.selectable).toBe(false)
    await expect(runtime.navigateTree(required(tree.nodes[1]).id)).rejects.toThrow(
      "complete continuation",
    )
    expect(reset).not.toHaveBeenCalled()
    await runtime.navigateTree(required(tree.nodes[2]).id)
    expect(history(runtime)).toEqual([user("Click"), call, result])
    expect(runtime.activeSession.tree?.nodes).toEqual(tree.nodes)
    expect(prepare).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
    for (const spy of execute) expect(spy).not.toHaveBeenCalled()
    await runtime.shutdown()
  })

  test.each(["error", "aborted", "pending"] as const)(
    "rejects an incomplete %s assistant boundary",
    async (stopReason) => {
      const { runtime } = setup()
      await runtime.initialize()
      await seed(runtime, [user("Interrupted"), { ...assistant("Partial"), stopReason }])
      const saved = await runtime.sessions.get(runtime.activeSession.id)
      await expect(runtime.navigateTree(runtime.getSessionTree().activeLeafId)).rejects.toThrow(
        "complete continuation",
      )
      expect(await runtime.sessions.get(runtime.activeSession.id)).toEqual(saved)
      await runtime.shutdown()
    },
  )

  test("keeps current model, thinking, and current system baseline across path changes", async () => {
    const { runtime } = setup()
    await runtime.initialize()
    await seed(runtime, [user("Original"), assistant("Answer")])
    const id = runtime.getSessionTree().activeLeafId
    const target = required(runtime.configuration.getModels("anthropic")[0])
    await runtime.configuration.updateSettings({
      ...runtime.configuration.appSettings,
      modelProvider: target.provider,
      modelId: target.id,
      thinkingLevel: "high",
      systemPrompt: "Current baseline",
      enabledTools: [],
    })
    await runtime.syncSettings({
      applyModelToActiveSession: true,
      applyThinkingToActiveSession: true,
    })
    await runtime.navigateTree(null)
    await runtime.navigateTree(id)
    expect(runtime.model).toMatchObject({ provider: target.provider, id: target.id })
    expect(runtime.agent.state.thinkingLevel).toBe("high")
    expect(runtime.activeSession.model.thinkingLevel).toBe("high")
    const baseline = required(runtime.agent.state.messages[0])
    expect(baseline).toMatchObject({
      role: "system",
      content: expect.stringContaining("Current baseline"),
    })
    expect(baseline.role === "system" && baseline.toolsAdded).toBeUndefined()
    expect(runtime.getSessionTree().nodes).toHaveLength(2)
    await runtime.shutdown()
  })

  test("failed candidate writes leave legacy disk and live state unchanged, then allow retry", async () => {
    const { runtime, warnings } = setup()
    await runtime.initialize()
    await seed(runtime, [user("Keep me"), assistant("Keep answer")])
    const saved = await runtime.sessions.get(runtime.activeSession.id)
    const live = structuredClone(runtime.agent.state.messages)
    const id = nodeId(runtime, "Keep me")
    const reset = vi.spyOn(runtime.agent, "reset")
    const put = vi
      .spyOn(runtime.sessions, "put")
      .mockRejectedValueOnce(new Error("disk unavailable"))
    await expect(runtime.navigateTree(id)).rejects.toThrow("disk unavailable")
    expect(runtime.agent.state.messages).toEqual(live)
    expect(runtime.activeSession.tree).toBeUndefined()
    expect(await runtime.sessions.get(runtime.activeSession.id)).toEqual(saved)
    expect(reset).not.toHaveBeenCalled()
    expect(runtime.isNavigatingTree).toBe(false)
    expect(warnings).toEqual([expect.stringContaining("disk unavailable")])
    put.mockRestore()
    await runtime.navigateTree(id)
    expect(history(runtime)).toEqual([])
    await runtime.shutdown()
  })

  test("waits for pending saves, locks mutations, and saves before resetting live state", async () => {
    const { runtime } = setup()
    await runtime.initialize()
    await seed(runtime, [user("Original"), assistant("Answer")])
    const id = nodeId(runtime, "Original")
    const live = structuredClone(runtime.agent.state.messages)
    const gate = deferred()
    const entered = deferred()
    const originalPut = runtime.sessions.put.bind(runtime.sessions)
    const put = vi
      .spyOn(runtime.sessions, "put")
      .mockImplementationOnce(async (record, protectedIds) => {
        entered.resolve()
        await gate.promise
        return originalPut(record, protectedIds)
      })
    const pending = persist(runtime)
    await entered.promise
    const reset = vi.spyOn(runtime.agent, "reset")
    const navigation = runtime.navigateTree(id)
    expect(runtime.isBusy).toBe(true)
    expect(runtime.isNavigatingTree).toBe(true)
    await expect(runtime.submit("Blocked")).rejects.toThrow("tree navigation")
    expect(() => runtime.queueFollowUp("Blocked")).toThrow("tree navigation")
    expect(() => runtime.abort()).toThrow("tree navigation")
    await expect(runtime.newSession()).rejects.toThrow("tree navigation")
    await expect(runtime.resumeSession(runtime.activeSession.id)).rejects.toThrow("tree navigation")
    await expect(runtime.renameSession("Blocked")).rejects.toThrow("tree navigation")
    await expect(runtime.deleteSession(runtime.activeSession.id)).rejects.toThrow("tree navigation")
    await expect(runtime.clearSessions()).rejects.toThrow("tree navigation")
    await runtime.syncSettings()
    expect(runtime.agent.state.messages).toEqual(live)
    expect(reset).not.toHaveBeenCalled()
    expect(put).toHaveBeenCalledTimes(1)
    gate.resolve()
    await Promise.all([pending, navigation])
    expect(put).toHaveBeenCalledTimes(2)
    expect(reset).toHaveBeenCalledOnce()
    expect(history(runtime)).toEqual([])
    await runtime.shutdown()
  })

  test("does not navigate past failed pending persistence or discard unsaved metadata", async () => {
    const { runtime } = setup()
    await runtime.initialize()
    await seed(runtime, [user("Original"), assistant("Answer")])
    const id = runtime.getSessionTree().activeLeafId
    const saved = await runtime.sessions.get(runtime.activeSession.id)
    runtime.agent.state.messages.push(user("Unsaved request", 3), assistant("Unsaved answer", 4))
    const put = vi
      .spyOn(runtime.sessions, "put")
      .mockRejectedValueOnce(new Error("pending save failed"))
    await persist(runtime)
    const unsaved = runtime.activeSession
    await expect(runtime.navigateTree(id)).rejects.toThrow("pending save failed")
    expect(runtime.activeSession).toEqual(unsaved)
    expect(history(runtime)).toHaveLength(4)
    expect(await runtime.sessions.get(runtime.activeSession.id)).toEqual(saved)
    put.mockRestore()
    await persist(runtime)
    await runtime.navigateTree(nodeId(runtime, "Answer"))
    expect(runtime.getSessionTree().nodes).toHaveLength(4)
    await runtime.shutdown()
  })

  test("candidate save includes unsaved complete live history rather than dropping it", async () => {
    const { runtime } = setup()
    await runtime.initialize()
    await seed(runtime, [user("Original"), assistant("Answer")])
    runtime.agent.state.messages.push(user("Not yet persisted", 3), assistant("Retain me", 4))
    await runtime.navigateTree(null)
    expect(runtime.getSessionTree().nodes).toHaveLength(4)
    expect((await runtime.sessions.get(runtime.activeSession.id))?.tree?.nodes).toHaveLength(4)
    await runtime.shutdown()
  })

  test.each(["preparing", "finishingRun", "streaming", "auth", "lease", "session"])(
    "rejects navigation while %s guard is invalid",
    async (guard) => {
      const { runtime, lease } = setup()
      await runtime.initialize()
      await seed(runtime, [user("Keep"), assistant("Answer")])
      const put = vi.spyOn(runtime.sessions, "put")
      const state = runtime as unknown as { preparing: boolean; finishingRun?: Promise<void> }
      if (guard === "preparing") state.preparing = true
      if (guard === "finishingRun") state.finishingRun = Promise.resolve()
      const agentState = runtime.agent.state as unknown as { isStreaming: boolean }
      if (guard === "streaming") agentState.isStreaming = true
      const auth = vi.spyOn(runtime.configuration, "isChangingAuth", "get")
      if (guard === "auth") auth.mockReturnValue(true)
      if (guard === "lease") await lease.release()
      if (guard === "session") runtime.agent.sessionId = "stale"
      await expect(runtime.navigateTree(null)).rejects.toThrow()
      expect(put).not.toHaveBeenCalled()
      expect(history(runtime)).toHaveLength(2)
      state.preparing = false
      state.finishingRun = undefined
      agentState.isStreaming = false
      runtime.agent.sessionId = runtime.activeSession.id
      auth.mockRestore()
      if (guard === "lease") await lease.claim(runtime.activeSession.id)
      await runtime.shutdown()
    },
  )

  test("rejects during real MCP discovery without restarting discovery or dispatching a model", async () => {
    const { runtime } = setup()
    await runtime.initialize()
    const gate = deferred()
    const entered = deferred()
    vi.spyOn(McpManager.prototype, "prepare").mockImplementation(async () => {
      entered.resolve()
      await gate.promise
      return []
    })
    const prompt = vi.spyOn(runtime.agent, "prompt").mockResolvedValue()
    const submission = runtime.submit("Waiting")
    await entered.promise
    await expect(runtime.navigateTree(null)).rejects.toThrow("current operation")
    expect(prompt).not.toHaveBeenCalled()
    gate.resolve()
    await submission
    await runtime.shutdown()
  })

  test.each(["dialog", "auth", "lease", "session"])(
    "rechecks %s before writing a candidate",
    async (guard) => {
      const { runtime, lease } = setup()
      await runtime.initialize()
      await seed(runtime, [user("Keep"), assistant("Answer")])
      const saved = await runtime.sessions.get(runtime.activeSession.id)
      const live = structuredClone(runtime.agent.state.messages)
      const entered = deferred()
      const gate = deferred()
      const protectedIds = lease.protectedSessionIds.bind(lease)
      vi.spyOn(lease, "protectedSessionIds").mockImplementationOnce(async () => {
        entered.resolve()
        await gate.promise
        return protectedIds()
      })
      const put = vi.spyOn(runtime.sessions, "put")
      let current = true
      const accept = vi.fn(() => {
        if (!current) throw new Error("Stale tree dialog")
      })
      const auth = vi.spyOn(runtime.configuration, "isChangingAuth", "get")
      const navigation = runtime.navigateTree(null, accept)
      const rejected = expect(navigation).rejects.toThrow()
      await entered.promise
      if (guard === "dialog") current = false
      if (guard === "auth") auth.mockReturnValue(true)
      if (guard === "lease") await lease.release()
      if (guard === "session") runtime.agent.sessionId = "stale"
      gate.resolve()
      await rejected
      expect(runtime.agent.state.messages).toEqual(live)
      expect(runtime.activeSession.tree).toBeUndefined()
      expect(await runtime.sessions.get(runtime.activeSession.id)).toEqual(saved)
      expect(runtime.isNavigatingTree).toBe(false)
      expect(put).not.toHaveBeenCalled()
      auth.mockRestore()
      runtime.agent.sessionId = runtime.activeSession.id
      if (guard === "lease") await lease.claim(runtime.activeSession.id)
      await runtime.shutdown()
    },
  )

  test.each([false, true])(
    "shutdown waits for candidate completion before final save and lease release (failure=%s)",
    async (fail) => {
      const { runtime, lease, locks } = setup()
      await runtime.initialize()
      await seed(runtime, [user("Original"), assistant("Answer")])
      const sessionId = runtime.activeSession.id
      const gate = deferred()
      const entered = deferred()
      const originalPut = runtime.sessions.put.bind(runtime.sessions)
      vi.spyOn(runtime.sessions, "put").mockImplementationOnce(async (record, protectedIds) => {
        entered.resolve()
        await gate.promise
        if (fail) throw new Error("candidate failed")
        return originalPut(record, protectedIds)
      })
      const navigation = runtime.navigateTree(null)
      const completed = fail ? expect(navigation).rejects.toThrow("candidate failed") : navigation
      await entered.promise
      const shutdown = runtime.shutdown()
      expect(lease.sessionId).toBe(sessionId)
      expect((await locks.query()).held).toHaveLength(1)
      gate.resolve()
      await Promise.all([completed, shutdown])
      expect((await locks.query()).held).toEqual([])
      const saved = await runtime.sessions.get(sessionId)
      if (fail) {
        expect(saved?.tree).toBeUndefined()
        expect(history(runtime)).toHaveLength(2)
      } else {
        expect(saved?.tree?.activeLeafId).toBeNull()
        expect(saved?.tree?.nodes).toHaveLength(2)
        expect(history(runtime)).toEqual([])
      }
    },
  )

  test("shutdown before the candidate write cancels selection without activating a legacy tree", async () => {
    const { runtime, lease } = setup()
    await runtime.initialize()
    await seed(runtime, [user("Original"), assistant("Answer")])
    const entered = deferred()
    const gate = deferred()
    const originalProtectedIds = lease.protectedSessionIds.bind(lease)
    vi.spyOn(lease, "protectedSessionIds").mockImplementationOnce(async () => {
      entered.resolve()
      await gate.promise
      return originalProtectedIds()
    })
    const navigation = runtime.navigateTree(null)
    const rejected = expect(navigation).rejects.toThrow("current operation")
    await entered.promise
    const shutdown = runtime.shutdown()
    gate.resolve()
    await Promise.all([rejected, shutdown])
    expect(history(runtime)).toHaveLength(2)
    expect((await runtime.sessions.get(runtime.activeSession.id))?.tree).toBeUndefined()
    expect(lease.sessionId).toBeUndefined()
  })

  test("credential removal waits for a tree commit and does not replace its path", async () => {
    const { runtime } = setup()
    await runtime.initialize()
    await seed(runtime, [user("Original"), assistant("Answer")])
    await runtime.configuration.credentials.modify("openai-codex", async () => ({
      type: "oauth",
      access: "access",
      refresh: "refresh",
      expires: Date.now() + 60_000,
    }))
    const entered = deferred()
    const gate = deferred()
    const originalPut = runtime.sessions.put.bind(runtime.sessions)
    vi.spyOn(runtime.sessions, "put").mockImplementationOnce(async (record, protectedIds) => {
      entered.resolve()
      await gate.promise
      return originalPut(record, protectedIds)
    })
    const navigation = runtime.navigateTree(null)
    await entered.promise
    const removal = runtime.configuration.logout("openai-codex")
    await expect(runtime.configuration.credentials.read("openai-codex")).resolves.toBeDefined()
    gate.resolve()
    await Promise.all([navigation, removal])
    await expect(runtime.configuration.credentials.read("openai-codex")).resolves.toBeUndefined()
    expect(history(runtime)).toEqual([])
    expect(runtime.activeSession.tree?.nodes).toHaveLength(2)
    await runtime.shutdown()
  })

  test("defers synchronized model and thinking changes until the tree commit", async () => {
    const { runtime } = setup()
    await runtime.initialize()
    await seed(runtime, [user("Original"), assistant("Answer")])
    const previousModel = runtime.model
    const target = required(runtime.configuration.getModels("anthropic")[0])
    const entered = deferred()
    const gate = deferred()
    const originalPut = runtime.sessions.put.bind(runtime.sessions)
    vi.spyOn(runtime.sessions, "put").mockImplementationOnce(async (record, protectedIds) => {
      entered.resolve()
      await gate.promise
      return originalPut(record, protectedIds)
    })
    const navigation = runtime.navigateTree(null)
    await entered.promise
    await runtime.configuration.updateSettings({
      ...runtime.configuration.appSettings,
      modelProvider: target.provider,
      modelId: target.id,
      thinkingLevel: "high",
    })
    await runtime.syncSettings({
      applyModelToActiveSession: true,
      applyThinkingToActiveSession: true,
    })
    expect(runtime.model).toBe(previousModel)
    expect(runtime.agent.state.thinkingLevel).toBe("medium")
    gate.resolve()
    await navigation
    await persist(runtime)
    expect(runtime.model).toMatchObject({ provider: target.provider, id: target.id })
    expect(runtime.agent.state.thinkingLevel).toBe("high")
    expect(history(runtime)).toEqual([])
    expect((await runtime.sessions.get(runtime.activeSession.id))?.model).toMatchObject({
      provider: target.provider,
      thinkingLevel: "high",
    })
    await runtime.shutdown()
  })

  test("initial UI rejection causes no write and own navigation busy state permits acceptance", async () => {
    const { runtime } = setup()
    await runtime.initialize()
    const put = vi.spyOn(runtime.sessions, "put")
    await expect(
      runtime.navigateTree(null, () => {
        throw new Error("Attachments changed")
      }),
    ).rejects.toThrow("Attachments changed")
    expect(put).not.toHaveBeenCalled()
    const busy: boolean[] = []
    await runtime.navigateTree(null, () => busy.push(runtime.isNavigatingTree))
    expect(busy[0]).toBe(false)
    expect(busy.slice(1).every(Boolean)).toBe(true)
    await runtime.shutdown()
  })

  test("tree size overflow never compacts images or nodes and retains the stored record", async () => {
    const { runtime, warnings } = setup()
    await runtime.initialize()
    await seed(runtime, [user("Original"), assistant("Answer")])
    await runtime.navigateTree(runtime.getSessionTree().activeLeafId)
    const saved = await runtime.sessions.get(runtime.activeSession.id)
    runtime.agent.state.messages.push({
      role: "user",
      content: [
        { type: "text", text: "Oversized" },
        { ...image, data: "x".repeat(MAX_SESSION_BYTES) },
      ],
      timestamp: 3,
    })
    const live = structuredClone(runtime.agent.state.messages)
    await persist(runtime)
    expect(warnings).toEqual([expect.stringContaining("storage limit")])
    expect(runtime.agent.state.messages).toEqual(live)
    expect(await runtime.sessions.get(runtime.activeSession.id)).toEqual(saved)
    expect(runtime.activeSession.tree?.nodes).toHaveLength(3)
    await expect(runtime.navigateTree(null)).rejects.toThrow("storage limit")
    expect(await runtime.sessions.get(runtime.activeSession.id)).toEqual(saved)
    // Restore a valid suffix so shutdown does not retry the intentionally oversized transcript.
    runtime.agent.state.messages = structuredClone(required(saved).messages)
    await runtime.resumeSession(runtime.activeSession.id)
    await runtime.shutdown()
  })

  test("node-limit synchronization errors remain reported after an older queued save succeeds", async () => {
    const { runtime, warnings } = setup()
    await runtime.initialize()
    await runtime.navigateTree(null)
    const saved = await runtime.sessions.get(runtime.activeSession.id)
    const entered = deferred()
    const gate = deferred()
    const originalPut = runtime.sessions.put.bind(runtime.sessions)
    vi.spyOn(runtime.sessions, "put").mockImplementationOnce(async (record, protectedIds) => {
      entered.resolve()
      await gate.promise
      return originalPut(record, protectedIds)
    })
    const queued = persist(runtime)
    await entered.promise
    runtime.agent.state.messages.push(
      ...Array.from({ length: MAX_TREE_NODES + 1 }, (_, index) => user("Retain", index)),
    )
    await persist(runtime)
    gate.resolve()
    await queued
    expect(warnings).toEqual([expect.stringContaining("node limit")])
    await expect(runtime.navigateTree(null)).rejects.toThrow("Session persistence failed")
    expect(history(runtime)).toHaveLength(MAX_TREE_NODES + 1)
    expect((await runtime.sessions.get(runtime.activeSession.id))?.tree).toEqual(saved?.tree)
    await runtime.resumeSession(runtime.activeSession.id)
    await runtime.shutdown()
  })

  test("previews large legacy history and rejects only an oversized navigation candidate", async () => {
    const { runtime } = setup()
    await runtime.initialize()
    const saved = await runtime.sessions.get(runtime.activeSession.id)
    runtime.agent.state.messages.push(user("x".repeat(MAX_SESSION_BYTES)))
    expect(runtime.getSessionTree().nodes).toHaveLength(1)
    await expect(runtime.navigateTree(null)).rejects.toThrow("storage limit")
    expect(runtime.activeSession.tree).toBeUndefined()
    expect(await runtime.sessions.get(runtime.activeSession.id)).toEqual(saved)
    runtime.agent.state.messages = []
    await runtime.shutdown()
  })

  test("can select the root of a large legacy transcript when the destination fits", async () => {
    const { runtime } = setup()
    await runtime.initialize()
    await seed(runtime, [user("x".repeat(3 * 1024 * 1024)), assistant("Saved answer")])
    expect(runtime.getSessionTree().nodes).toHaveLength(2)
    expect(runtime.activeSession.tree).toBeUndefined()
    await runtime.navigateTree(null)
    expect(history(runtime)).toEqual([])
    const record = required(await runtime.sessions.get(runtime.activeSession.id))
    expect(record.tree?.nodes).toHaveLength(2)
    expect(record.tree?.nodes[0]?.message.content).toHaveLength(3 * 1024 * 1024)
    await runtime.shutdown()
  })

  test("catalog refresh during the committed write cannot invalidate the captured model", async () => {
    const { runtime } = setup()
    await runtime.initialize()
    await seed(runtime, [user("Original"), assistant("Saved answer")])
    const selected = nodeId(runtime, "Saved answer")
    const model = runtime.model
    const entered = deferred()
    const gate = deferred()
    const put = runtime.sessions.put.bind(runtime.sessions)
    vi.spyOn(runtime.sessions, "put").mockImplementationOnce(async (record, protectedIds) => {
      entered.resolve()
      await gate.promise
      await put(record, protectedIds)
    })
    const navigation = runtime.navigateTree(selected)
    await entered.promise
    const catalog = vi.spyOn(runtime.configuration.models, "getModel").mockReturnValue(undefined)
    gate.resolve()
    try {
      await expect(navigation).resolves.toEqual({ text: "", images: [] })
      expect(runtime.model).toBe(model)
      expect(history(runtime)).toEqual([user("Original"), assistant("Saved answer")])
      expect((await runtime.sessions.get(runtime.activeSession.id))?.tree?.activeLeafId).toBe(
        selected,
      )
    } finally {
      catalog.mockRestore()
    }
    await runtime.shutdown()
  })

  test("malformed system tool metadata is rejected before a navigation write", async () => {
    const { runtime } = setup()
    await runtime.initialize()
    await seed(runtime, [user("Original"), assistant("Saved answer")])
    const baseline = required(runtime.agent.state.messages[0])
    const put = vi.spyOn(runtime.sessions, "put")
    runtime.agent.state.messages = [
      { ...baseline, toolsAdded: {} } as unknown as AgentMessage,
      ...history(runtime),
    ]
    await expect(runtime.navigateTree(null)).rejects.toThrow("system message")
    expect(put).not.toHaveBeenCalled()
    expect(runtime.activeSession.tree).toBeUndefined()
    runtime.agent.state.messages = [baseline, ...history(runtime)]
    await runtime.shutdown()
  })

  test("navigation cannot overlap a pending session replacement", async () => {
    const { runtime } = setup()
    await runtime.initialize()
    const replacement = createSession(runtime.model.id, runtime.model.provider)
    await runtime.sessions.put(replacement)
    const gate = deferred()
    const entered = deferred()
    const originalGet = runtime.sessions.get.bind(runtime.sessions)
    vi.spyOn(runtime.sessions, "get").mockImplementationOnce(async (id) => {
      entered.resolve()
      await gate.promise
      return originalGet(id)
    })
    const resuming = runtime.resumeSession(replacement.id)
    await entered.promise
    await expect(runtime.navigateTree(null)).rejects.toThrow("current operation")
    gate.resolve()
    await resuming
    expect(runtime.activeSession.id).toBe(replacement.id)
    await runtime.shutdown()
  })
})
