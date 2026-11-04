import type { AgentEvent } from "@earendil-works/pi-agent-core"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { LocalCodingBridge } from "../../src/browser/coding-agent/bridge.js"
import {
  type LocalApi,
  type LocalConnection,
  type LocalResponse,
  REQUEST_FAILURE,
  TASK_LIMITS,
  type Task,
} from "../../src/browser/coding-agent/protocol.js"
import { CODING_CONNECTION_KEY } from "../../src/browser/coding-agent/store.js"

const clientId = "11111111-1111-1111-1111-111111111111"
const generation = "22222222-2222-2222-2222-222222222222"
let connection: LocalConnection | undefined
let listeners: Set<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void>
let bridge: LocalCodingBridge
let draft: string
let sessionId: string
let busy: boolean
let visible: boolean
let host: { __piBrowserLocal?: LocalApi }
const submit = vi.fn()
const abort = vi.fn()
const confirm = vi.fn(async () => true)
const redactAnswer = vi.fn(async (text: string) => text)
const offer = vi.fn((text: string) => {
  draft = text
})

function value<T>(response: LocalResponse): T {
  if (!response.ok) throw new Error(response.error)
  return response.value as T
}
function dispatch(method: string, fields: Record<string, unknown> = {}) {
  return bridge.api.dispatch({ method, clientId, generation, ...fields })
}
function send(id = "task-1", task = "Read the page") {
  return dispatch("send", { id, task })
}
function message(
  text = "Final answer",
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "PRIVATE THINKING" },
      { type: "text", text },
    ],
    api: "openai-responses",
    model: "test",
    provider: "openai",
    stopReason,
    timestamp: 1,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }
}
function emit(message: AssistantMessage) {
  bridge.onAgentEvent({ type: "message_end", message })
}
function start() {
  const token = bridge.beginSubmission(draft)
  if (!token) throw new Error("Missing offered task")
  bridge.startSubmission(token)
  bridge.onAgentEvent({ type: "agent_start" })
  return token
}
function changeConnection(next: LocalConnection | undefined) {
  const oldValue = connection
  connection = next
  for (const listener of listeners)
    listener({ [CODING_CONNECTION_KEY]: { oldValue, newValue: next } }, "session")
}

beforeEach(async () => {
  connection = { clientId, generation, windowId: 7, state: "approved" }
  listeners = new Set()
  draft = ""
  sessionId = "session-one"
  busy = false
  visible = false
  host = {}
  submit.mockReset()
  abort.mockClear()
  confirm.mockReset().mockResolvedValue(true)
  offer.mockClear()
  redactAnswer.mockReset().mockImplementation(async (text: string) => text)
  vi.stubGlobal("chrome", {
    storage: {
      session: {
        get: vi.fn(async () => ({ [CODING_CONNECTION_KEY]: structuredClone(connection) })),
        setAccessLevel: vi.fn(async () => undefined),
        set: vi.fn(async (values: Record<string, LocalConnection>) =>
          changeConnection(values[CODING_CONNECTION_KEY]),
        ),
      },
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
      throw new Error("Network is forbidden")
    }),
  )
  bridge = new LocalCodingBridge({
    windowId: 7,
    sessionId: () => sessionId,
    busy: () => busy,
    draft: () => draft,
    offer,
    submit,
    clearOffer: (text) => {
      if (draft === text) draft = ""
    },
    showTask: (next) => {
      visible = next
    },
    abort,
    confirm,
    redactAnswer,
  })
  await bridge.initialize(host)
})
afterEach(() => {
  bridge.dispose()
  expect(fetch).not.toHaveBeenCalled()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("local conversation API", () => {
  test("registers only the fixed conversation API and never connects from a conversation", async () => {
    expect(host.__piBrowserLocal).toBe(bridge.api)
    expect(bridge.api).toMatchObject({ version: 2, role: "conversation" })
    expect(await bridge.api.dispatch({ method: "connect", clientId })).toEqual({
      ok: false,
      error: REQUEST_FAILURE,
    })
    expect(value(await bridge.api.dispatch({ method: "status", clientId }))).toEqual(connection)
    expect(await dispatch("send", { id: "a", task: "text", execute: "anything" })).toEqual({
      ok: false,
      error: REQUEST_FAILURE,
    })
  })

  test("offers one exact draft, requests automatic submission once, and deduplicates stable IDs", async () => {
    const results = await Promise.all([send(), send()])
    expect(results[0]).toEqual(results[1])
    expect(value<Task>(results[0] as LocalResponse).status).toBe("queued")
    expect(draft).toBe("Read the page")
    expect(visible).toBe(true)
    expect(offer).toHaveBeenCalledOnce()
    expect(submit).toHaveBeenCalledOnce()
    expect(abort).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
    expect((await send("task-1", "Changed task")).ok).toBe(false)
    expect((await send("another")).ok).toBe(false)
    expect(bridge.tools()).toEqual([])
  })

  test.each(["draft", "busy"])("does not replace an occupied composer: %s", async (occupied) => {
    if (occupied === "draft") draft = "Unsent user text"
    else busy = true
    expect((await send()).ok).toBe(false)
    expect(offer).not.toHaveBeenCalled()
  })

  test("rejects malformed and oversized inputs before changing the composer", async () => {
    expect((await send("bad/id")).ok).toBe(false)
    expect((await send("too-long", "x".repeat(TASK_LIMITS.taskBytes + 1))).ok).toBe(false)
    expect((await send("empty", "   ")).ok).toBe(false)
    expect((await send("escaped", `a${"\u0000".repeat(TASK_LIMITS.taskBytes - 1)}`)).ok).toBe(false)
    expect(offer).not.toHaveBeenCalled()
    expect(draft).toBe("")
  })

  test("requires matching approved client, generation, and owner window", async () => {
    for (const changed of [
      { windowId: 8 },
      { state: "pending" as const },
      { generation: crypto.randomUUID() },
      { clientId: crypto.randomUUID() },
    ]) {
      changeConnection({ clientId, generation, windowId: 7, state: "approved", ...changed })
      expect((await send()).ok).toBe(false)
    }
    expect(value(await bridge.api.dispatch({ method: "status", clientId }))).toBeNull()
  })

  test("editing cancels delegation without clearing the edited text", async () => {
    await send()
    draft = "My edited task"
    bridge.composerChanged()
    expect(value<Task>(await dispatch("get", { id: "task-1" })).status).toBe("cancelled")
    expect(draft).toBe("My edited task")
    expect(visible).toBe(false)
    expect(bridge.beginSubmission(draft)).toBeUndefined()
    expect(abort).not.toHaveBeenCalled()
  })

  test("chip cancellation clears only unchanged offered text", async () => {
    await send()
    bridge.cancelOffered()
    expect(draft).toBe("")
    expect(value<Task>(await dispatch("get", { id: "task-1" }))).not.toHaveProperty("answer")
    expect(bridge.beginSubmission("Read the page")).toBeUndefined()
  })

  test("cancellation aborts pending automatic preflight and never submits again", async () => {
    await send()
    const token = bridge.beginSubmission(draft)
    expect(token?.signal.aborted).toBe(false)
    expect(bridge.beginSubmission(draft)).toBeUndefined()
    await dispatch("cancel", { id: "task-1" })
    expect(token?.signal.aborted).toBe(true)
    expect(() => bridge.assertSubmission(token as object)).toThrow()
    expect(value<Task>(await send()).status).toBe("cancelled")
    expect(submit).toHaveBeenCalledOnce()
    expect(abort).not.toHaveBeenCalled()
  })

  test("a submission callback failure is terminal and is never replayed", async () => {
    submit.mockImplementationOnce(() => {
      throw new Error("Local failure")
    })
    expect(value<Task>(await send()).status).toBe("failed")
    expect(value<Task>(await send()).status).toBe("failed")
    expect(submit).toHaveBeenCalledOnce()
  })

  test("exports only the final text from the owned run with credential redaction", async () => {
    emit(message("UNRELATED HISTORY"))
    await send()
    const token = start()
    emit(message("INTERMEDIATE TOOL TEXT", "toolUse"))
    emit(message("Final Bearer private-token"))
    await bridge.finishSubmission(token, true)
    const result = value<Task>(await dispatch("get", { id: "task-1" }))
    expect(result.status).toBe("completed")
    expect(result.answer).toBe("Final Bearer [REDACTED]")
    expect(JSON.stringify(result)).not.toMatch(/THINKING|HISTORY|INTERMEDIATE|private-token/)
    expect(visible).toBe(false)
  })

  test.each(["error", "aborted"] as const)(
    "returns a fixed safe terminal answer for %s",
    async (reason) => {
      await send()
      const token = start()
      emit(message("PRIVATE ERROR", reason))
      await bridge.finishSubmission(token, true)
      expect(value<Task>(await dispatch("get", { id: "task-1" }))).toMatchObject({
        status: "failed",
        answer: REQUEST_FAILURE,
      })
    },
  )

  test("an oversized final answer fails with a bounded fixed result", async () => {
    await send()
    const token = start()
    emit(message("x".repeat(TASK_LIMITS.answerBytes + 1)))
    await bridge.finishSubmission(token, true)
    expect(value<Task>(await dispatch("get", { id: "task-1" }))).toMatchObject({
      status: "failed",
      answer: REQUEST_FAILURE,
    })
  })

  test("JSON escaping cannot make a final response exceed the wire budget", async () => {
    await send()
    const token = start()
    emit(message(`a${"\u0000".repeat(TASK_LIMITS.answerBytes - 1)}`))
    await bridge.finishSubmission(token, true)
    expect(value<Task>(await dispatch("get", { id: "task-1" }))).toMatchObject({
      status: "failed",
      answer: REQUEST_FAILURE,
    })
  })

  test("preflight rejection fails once, without retry or aborting a normal run", async () => {
    await send()
    const token = bridge.beginSubmission(draft) as object
    await bridge.finishSubmission(token, false)
    expect(value<Task>(await dispatch("get", { id: "task-1" })).status).toBe("failed")
    expect(abort).not.toHaveBeenCalled()
    expect(value<Task>(await send()).status).toBe("failed")
    expect(offer).toHaveBeenCalledOnce()
  })

  test("Node cancellation aborts only its owned run and rejects a late final answer", async () => {
    await send()
    const token = start()
    // The accepted composer has been cleared; a newer identical draft is user-owned.
    draft = "Read the page"
    await dispatch("cancel", { id: "task-1" })
    expect(draft).toBe("Read the page")
    expect(abort).toHaveBeenCalledOnce()
    emit(message("Late answer"))
    await bridge.finishSubmission(token, true)
    expect(value<Task>(await dispatch("get", { id: "task-1" }))).toMatchObject({
      status: "cancelled",
    })
    expect(value<Task>(await dispatch("get", { id: "task-1" }))).not.toHaveProperty("answer")
    await dispatch("cancel", { id: "task-1" })
    expect(abort).toHaveBeenCalledOnce()
  })

  test("awaits trusted credential redaction and cannot revive cancellation or abort a newer run", async () => {
    let release!: (text: string) => void
    redactAnswer.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          release = resolve
        }),
    )
    await send()
    const token = start()
    emit(message("Stored provider key"))
    const finishing = bridge.finishSubmission(token, true)
    expect(redactAnswer).toHaveBeenCalledOnce()
    await dispatch("cancel", { id: "task-1" })
    bridge.onAgentEvent({ type: "agent_start" })
    emit(message("UNRELATED NEW RUN"))
    release("[REDACTED]")
    await finishing
    expect(value<Task>(await dispatch("get", { id: "task-1" })).status).toBe("cancelled")
    expect(abort).not.toHaveBeenCalled()
  })

  test("session changes during credential redaction stop export without aborting the new session", async () => {
    let release!: (text: string) => void
    redactAnswer.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          release = resolve
        }),
    )
    await send()
    const token = start()
    emit(message("Stored provider key"))
    const finishing = bridge.finishSubmission(token, true)
    sessionId = "new-session"
    release("[REDACTED]")
    await finishing
    expect(value<Task>(await dispatch("get", { id: "task-1" })).status).toBe("cancelled")
    expect(abort).not.toHaveBeenCalled()
  })

  test("an extra user message cancels answer export", async () => {
    await send()
    const token = start()
    const user = {
      type: "message_end",
      message: { role: "user", content: "instruction", timestamp: 1 },
    } as AgentEvent
    bridge.onAgentEvent(user)
    bridge.onAgentEvent(user)
    emit(message())
    await bridge.finishSubmission(token, true)
    expect(value<Task>(await dispatch("get", { id: "task-1" })).status).toBe("cancelled")
  })

  test("session changes, revocation, and page disposal discard live capabilities", async () => {
    await send()
    sessionId = "another-session"
    expect(value<Task>(await dispatch("get", { id: "task-1" })).status).toBe("cancelled")
    await send("second")
    start()
    changeConnection({ clientId, generation: crypto.randomUUID(), windowId: 7, state: "rejected" })
    expect(abort).toHaveBeenCalledOnce()
    expect((await dispatch("get", { id: "second" })).ok).toBe(false)
    bridge.dispose()
    expect(host.__piBrowserLocal).toBeUndefined()
    expect(listeners.size).toBe(0)
    expect((await send()).ok).toBe(false)
  })

  test("disconnect revokes only the matching connection", async () => {
    await send()
    expect(value(await dispatch("disconnect"))).toBeNull()
    expect(connection?.state).toBe("rejected")
    expect(visible).toBe(false)
    expect((await send()).ok).toBe(false)
    expect(abort).not.toHaveBeenCalled()
  })
})

describe("Browser to Coding tasks", () => {
  async function outgoing(text = "Review this change", signal?: AbortSignal) {
    const tool = bridge.tools()[0]
    if (!tool) throw new Error("Missing connected tool")
    const result = tool.execute("call", { task: text }, signal)
    const settled = result.then(
      (value) => ({ value }),
      () => ({ error: true }),
    )
    await vi.waitFor(async () => expect(value<Task[]>(await dispatch("inbox"))).toHaveLength(1))
    const task = value<Task[]>(await dispatch("inbox"))[0] as Task
    return { task, result, settled }
  }

  test("redacts provider values before task confirmation or Coding inbox delivery", async () => {
    redactAnswer.mockImplementation(async (text) =>
      text.replaceAll("sk-private-value", "[REDACTED]"),
    )
    const { task, result } = await outgoing("Review sk-private-value and Bearer private-token")
    expect(task.task).toBe("Review [REDACTED] and Bearer [REDACTED]")
    expect(JSON.stringify(confirm.mock.calls)).not.toContain("sk-private-value")
    expect(JSON.stringify(value<Task[]>(await dispatch("inbox")))).not.toContain("private-token")
    await dispatch("accept", { id: task.id, task: task.task })
    await dispatch("reply", { id: task.id, answer: "Selected answer" })
    await result
  })

  test("redaction failure cannot expose its error or enqueue an outgoing task", async () => {
    redactAnswer.mockRejectedValue(new Error("sk-private-value"))
    await expect(bridge.tools()[0]?.execute("call", { task: "Review" })).rejects.toThrow(
      REQUEST_FAILURE,
    )
    expect(confirm).not.toHaveBeenCalled()
    expect(value<Task[]>(await dispatch("inbox"))).toEqual([])
  })

  test("abort during task redaction cannot open confirmation or deliver a late request", async () => {
    let release!: (text: string) => void
    redactAnswer.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          release = resolve
        }),
    )
    const controller = new AbortController()
    const result = bridge.tools()[0]?.execute("call", { task: "Review" }, controller.signal)
    const settled = result?.then(
      () => "completed",
      () => "stopped",
    )
    await vi.waitFor(() => expect(redactAnswer).toHaveBeenCalledOnce())
    controller.abort()
    release("Late redacted request")
    expect(await settled).toBe("stopped")
    expect(confirm).not.toHaveBeenCalled()
    expect(value<Task[]>(await dispatch("inbox"))).toEqual([])
    expect(abort).not.toHaveBeenCalled()
  })

  test("requires fresh confirmation, unchanged review, and explicit acceptance before one reply", async () => {
    const { task, result } = await outgoing()
    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm.mock.calls[0]).toEqual([
      "Send the following task to the connected Coding Agent?",
      { task: task.task },
      expect.any(AbortSignal),
    ])
    expect((await dispatch("reply", { id: task.id, answer: "Too early" })).ok).toBe(false)
    expect((await dispatch("accept", { id: task.id, task: "Changed review" })).ok).toBe(false)
    expect(value<Task>(await dispatch("accept", { id: task.id, task: task.task })).status).toBe(
      "running",
    )
    expect(value<Task[]>(await dispatch("inbox"))).toEqual([])
    expect((await dispatch("accept", { id: task.id, task: task.task })).ok).toBe(false)
    expect(
      value<Task>(await dispatch("reply", { id: task.id, answer: "Selected reply Bearer secret" }))
        .status,
    ).toBe("completed")
    expect(await result).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("[Untrusted Coding Agent reply") }],
      details: { id: task.id },
    })
    expect(JSON.stringify(await result)).not.toContain("Bearer secret")
    expect((await dispatch("reply", { id: task.id, answer: "Replay" })).ok).toBe(false)
  })

  test("reply redaction does not block Node cancellation or restore a late completed reply", async () => {
    const { task, settled } = await outgoing()
    let release!: (text: string) => void
    redactAnswer.mockReset().mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          release = resolve
        }),
    )
    await dispatch("accept", { id: task.id, task: task.task })
    const replying = dispatch("reply", { id: task.id, answer: "Stored provider key" })
    await vi.waitFor(() => expect(redactAnswer).toHaveBeenCalledOnce())
    expect(value<Task>(await dispatch("cancel", { id: task.id })).status).toBe("cancelled")
    release("[REDACTED]")
    expect((await replying).ok).toBe(false)
    expect(await settled).toEqual({ error: true })
    expect(value<Task>(await dispatch("get", { id: task.id })).status).toBe("cancelled")
  })

  test("confirmation refusal enqueues nothing", async () => {
    confirm.mockResolvedValue(false)
    const tool = bridge.tools()[0]
    await expect(tool?.execute("call", { task: "Task" })).rejects.toThrow(REQUEST_FAILURE)
    expect(value<Task[]>(await dispatch("inbox"))).toEqual([])
  })

  test("AbortSignal cancels the pending task and rejects late replies", async () => {
    const controller = new AbortController()
    const { task, settled } = await outgoing("Task", controller.signal)
    await dispatch("accept", { id: task.id, task: task.task })
    controller.abort()
    expect(await settled).toEqual({ error: true })
    expect(value<Task>(await dispatch("get", { id: task.id })).status).toBe("cancelled")
    expect((await dispatch("reply", { id: task.id, answer: "Late" })).ok).toBe(false)
    expect(abort).not.toHaveBeenCalled()
  })

  test("uses the fixed ten-minute wait limit without retries", async () => {
    const { task, settled } = await outgoing()
    vi.useFakeTimers()
    // The timer was installed with real timers; verify through a fresh outgoing task.
    await dispatch("cancel", { id: task.id })
    await settled
    const tool = bridge.tools()[0]
    const result = tool?.execute("second", { task: "Second task" }).catch(() => "stopped")
    await vi.advanceTimersByTimeAsync(0)
    const tasks = value<Task[]>(await dispatch("inbox"))
    expect(tasks).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(TASK_LIMITS.waitMs)
    expect(await result).toBe("stopped")
    expect(value<Task>(await dispatch("get", { id: tasks[0]?.id })).status).toBe("cancelled")
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  test("revocation invalidates previously issued tool closures", async () => {
    const tool = bridge.tools()[0]
    changeConnection(undefined)
    await expect(tool?.execute("call", { task: "Task" })).rejects.toThrow(REQUEST_FAILURE)
    expect(confirm).not.toHaveBeenCalled()
  })
})
