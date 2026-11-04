import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai"
import { IDBFactory } from "fake-indexeddb"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { BrowserAgentRuntime } from "../../src/browser/agent/runtime.js"
import { LocalCodingBridge } from "../../src/browser/coding-agent/bridge.js"
import {
  type LocalConnection,
  type LocalResponse,
  REQUEST_FAILURE,
  type Task,
} from "../../src/browser/coding-agent/protocol.js"
import { CODING_CONNECTION_KEY } from "../../src/browser/coding-agent/store.js"
import { McpManager } from "../../src/browser/mcp/manager.js"
import { SessionLease } from "../../src/browser/sessions/session-lease.js"
import { SkillStore } from "../../src/browser/skills/store.js"

const clientId = "11111111-1111-1111-1111-111111111111"
const generation = "22222222-2222-2222-2222-222222222222"
let runtime: BrowserAgentRuntime
let bridge: LocalCodingBridge
let draft: string
let connection: LocalConnection
let listeners: Set<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void>

function value<T>(response: LocalResponse): T {
  if (!response.ok) throw new Error(response.error)
  return response.value as T
}
function dispatch(method: string, fields: Record<string, unknown> = {}) {
  return bridge.api.dispatch({ method, clientId, generation, ...fields })
}
function assistant(text = "Delegated final text"): AssistantMessage {
  return {
    role: "assistant",
    api: runtime.model.api,
    provider: runtime.model.provider,
    model: runtime.model.id,
    content: [
      { type: "thinking", thinking: "PRIVATE THINKING" },
      { type: "text", text },
    ],
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
function streams() {
  const calls: { finish: (text?: string) => void; tools: string[] }[] = []
  runtime.agent.streamFunction = (_model, _context, options) => {
    const stream = createAssistantMessageEventStream()
    let finished = false
    const finish = (text?: string) => {
      if (finished) return
      finished = true
      stream.push({ type: "done", reason: "stop", message: assistant(text) })
      stream.end()
    }
    options?.signal?.addEventListener("abort", () => finish("LATE ABORT CONTENT"), { once: true })
    calls.push({ finish, tools: runtime.agent.state.tools.map((tool) => tool.name) })
    return stream
  }
  return {
    calls,
    async next(index = 0) {
      await vi.waitFor(() => expect(calls.length).toBeGreaterThan(index))
      const call = calls[index]
      if (!call) throw new Error("Missing stream")
      return call
    },
  }
}
async function offer(text = "Inspect this page") {
  expect(value<Task>(await dispatch("send", { id: "delegated", task: text })).status).toBe("queued")
  return bridge.beginSubmission(draft) as object
}
async function submitOffered(token: object) {
  bridge.startSubmission(token)
  try {
    const mode = await runtime.submit(draft, "steer", [], [], false, () =>
      bridge.assertSubmission(token),
    )
    await bridge.finishSubmission(token, mode === "prompt")
  } catch {
    await bridge.finishSubmission(token, false)
  }
}

beforeEach(async () => {
  vi.stubGlobal("indexedDB", new IDBFactory())
  listeners = new Set()
  connection = { clientId, generation, windowId: 7, state: "approved" }
  const area = () => {
    const values: Record<string, unknown> = {}
    return {
      get: vi.fn(async (key: string) =>
        structuredClone({ [key]: key === CODING_CONNECTION_KEY ? connection : values[key] }),
      ),
      set: vi.fn(async (items: Record<string, unknown>) =>
        Object.assign(values, structuredClone(items)),
      ),
      remove: vi.fn(async (key: string) => {
        delete values[key]
      }),
      setAccessLevel: vi.fn(async () => undefined),
    }
  }
  vi.stubGlobal("chrome", {
    storage: {
      local: area(),
      session: area(),
      onChanged: {
        addListener: (listener: typeof listeners extends Set<infer T> ? T : never) =>
          listeners.add(listener),
        removeListener: (listener: typeof listeners extends Set<infer T> ? T : never) =>
          listeners.delete(listener),
      },
    },
  })
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected network request")
    }),
  )
  const locks = {
    request: async (name: string, _options: LockOptions, callback: (lock: Lock) => Promise<void>) =>
      callback({ name, mode: "exclusive" } as Lock),
    query: async () => ({ held: [], pending: [] }),
  } as unknown as LockManager
  runtime = new BrowserAgentRuntime(
    {
      confirm: vi.fn(async () => true),
      onAuthEvent: vi.fn(),
      onAgentEvent: (event) => bridge?.onAgentEvent(event),
      codingTools: () => bridge?.tools() ?? [],
    },
    new SessionLease(locks),
  )
  await runtime.initialize()
  await runtime.configuration.updateSettings({
    ...runtime.configuration.appSettings,
    enabledTools: [],
  })
  await runtime.syncSettings()
  draft = ""
  bridge = new LocalCodingBridge({
    windowId: 7,
    sessionId: () => runtime.activeSession.id,
    busy: () => runtime.isBusy,
    draft: () => draft,
    offer: (text) => {
      draft = text
    },
    submit: vi.fn(),
    clearOffer: (text) => {
      if (draft === text) draft = ""
    },
    showTask: vi.fn(),
    abort: () => runtime.abort(),
    confirm: vi.fn(async () => true),
    redactAnswer: (text) => runtime.configuration.credentials.redact(text),
  })
  await bridge.initialize({})
})
afterEach(async () => {
  bridge.dispose()
  await runtime.shutdown()
  expect(fetch).not.toHaveBeenCalled()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("local task runtime boundary", () => {
  test("queues without runtime/provider preparation, then exports only the explicit delegated run", async () => {
    runtime.agent.state.messages.push(
      { role: "user", content: "PRIVATE HISTORY", timestamp: 1 },
      assistant("OTHER ANSWER"),
    )
    const skillList = vi.spyOn(SkillStore.prototype, "list")
    const prepare = vi.spyOn(McpManager.prototype, "prepare")
    const controlled = streams()
    const token = await offer()
    expect(controlled.calls).toEqual([])
    expect(skillList).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
    expect(runtime.agent.state.tools.map((tool) => tool.name)).not.toContain("coding_task")
    const submission = submitOffered(token)
    const first = await controlled.next()
    expect(first.tools).not.toContain("coding_task")
    expect(skillList).toHaveBeenCalledOnce()
    expect(prepare).toHaveBeenCalledOnce()
    expect(value<Task>(await dispatch("get", { id: "delegated" })).status).toBe("running")
    first.finish("Only selected final text Bearer private-token")
    await submission
    const task = value<Task>(await dispatch("get", { id: "delegated" }))
    expect(task).toMatchObject({
      status: "completed",
      answer: "Only selected final text Bearer [REDACTED]",
    })
    expect(JSON.stringify(task)).not.toMatch(/PRIVATE|OTHER ANSWER|private-token/)
  })

  test("cancellation during skill/MCP preparation prevents model dispatch and late completion", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const prepare = vi.spyOn(McpManager.prototype, "prepare").mockImplementation(async () => {
      await gate
      return []
    })
    const controlled = streams()
    const token = await offer()
    const submission = submitOffered(token)
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
    await dispatch("cancel", { id: "delegated" })
    release()
    await submission
    expect(controlled.calls).toEqual([])
    expect(value<Task>(await dispatch("get", { id: "delegated" }))).toMatchObject({
      status: "cancelled",
    })
  })

  test("redacts exact stored provider credentials and JSON-escaped values only at the answer boundary", async () => {
    const key = 'private-provider-key-"quoted"'
    await runtime.configuration.credentials.modify("openai", async () => ({ type: "api_key", key }))
    const controlled = streams()
    const token = await offer()
    const submission = submitOffered(token)
    const first = await controlled.next()
    first.finish(`Selected answer ${key} ${JSON.stringify(key).slice(1, -1)}`)
    await submission
    expect(value<Task>(await dispatch("get", { id: "delegated" })).answer).toBe(
      "Selected answer [REDACTED] [REDACTED]",
    )
  })

  test("Node cancel aborts the owned run but cannot turn a late result into completion", async () => {
    const controlled = streams()
    const token = await offer()
    const submission = submitOffered(token)
    await controlled.next()
    await dispatch("cancel", { id: "delegated" })
    await submission
    const task = value<Task>(await dispatch("get", { id: "delegated" }))
    expect(task.status).toBe("cancelled")
    expect(task).not.toHaveProperty("answer")
  })

  test("coding tools are appended only after preparation for a new run, outside tool preferences", async () => {
    expect(runtime.agent.state.tools.map((tool) => tool.name)).not.toContain("coding_task")
    const order: string[] = []
    const tools = bridge.tools.bind(bridge)
    const codingTools = vi.spyOn(bridge, "tools").mockImplementation(() => {
      order.push("coding")
      return tools()
    })
    vi.spyOn(SkillStore.prototype, "list").mockImplementation(async () => {
      order.push("skills")
      return []
    })
    vi.spyOn(McpManager.prototype, "prepare").mockImplementation(async () => {
      order.push("mcp")
      return []
    })
    const controlled = streams()
    const firstSubmission = runtime.submit("Normal user task", "steer", [], [], false)
    const first = await controlled.next()
    expect(order).toEqual(["skills", "mcp", "coding"])
    expect(first.tools).toEqual(["coding_task"])
    await runtime.submit("User instruction", "followUp", [], [], false)
    expect(codingTools).toHaveBeenCalledOnce()
    first.finish()
    const followUp = await controlled.next(1)
    followUp.finish()
    await firstSubmission
    await runtime.agent.waitForIdle()
    expect(codingTools).toHaveBeenCalledOnce()
    expect(runtime.configuration.appSettings.enabledTools).toEqual([])
  })

  test("ordinary runs expose a connected tool and a selected local Coding reply resolves its wait", async () => {
    const controlled = streams()
    const submission = runtime.submit("Ask Coding to review", "steer", [], [], false)
    const first = await controlled.next()
    expect(first.tools).toEqual(["coding_task"])
    const tool = runtime.agent.state.tools.find((tool) => tool.name === "coding_task")
    const waiting = tool?.execute("coding-call", { task: "Review this function" })
    await vi.waitFor(async () => expect(value<Task[]>(await dispatch("inbox"))).toHaveLength(1))
    const task = value<Task[]>(await dispatch("inbox"))[0] as Task
    await dispatch("accept", { id: task.id, task: task.task })
    await dispatch("reply", { id: task.id, answer: "Reviewed reply" })
    expect(await waiting).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("Reviewed reply") }],
    })
    first.finish()
    await submission
  })

  test("revocation cancels bridge-owned work without aborting an ordinary user run", async () => {
    const controlled = streams()
    const submission = runtime.submit("Normal user run", "steer", [], [], false)
    const first = await controlled.next()
    const abort = vi.spyOn(runtime, "abort")
    const previous = connection
    connection = { ...connection, generation: crypto.randomUUID(), state: "rejected" }
    for (const listener of listeners)
      listener({ [CODING_CONNECTION_KEY]: { oldValue: previous, newValue: connection } }, "session")
    expect(abort).not.toHaveBeenCalled()
    expect(await dispatch("get", { id: "unknown" })).toEqual({ ok: false, error: REQUEST_FAILURE })
    first.finish()
    await submission
  })
})
