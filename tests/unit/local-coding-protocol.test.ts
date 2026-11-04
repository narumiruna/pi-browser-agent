import { describe, expect, test } from "vitest"
import {
  localId,
  localResponse,
  parseLocalConnection,
  parseLocalRequest,
  parseTask,
  TASK_LIMITS,
  type Task,
  TaskError,
  taskId,
  taskText,
  terminal,
} from "../../src/browser/coding-agent/protocol.js"

const clientId = "00000000-0000-4000-8000-000000000001"
const generation = "00000000-0000-4000-8000-000000000002"
const base = { clientId, generation }
const requests = [
  { method: "connect", clientId },
  { method: "status", clientId },
  { method: "disconnect", ...base },
  { method: "send", ...base, id: "task-1", task: "Read the current page" },
  { method: "get", ...base, id: "task-1" },
  { method: "inbox", ...base },
  { method: "accept", ...base, id: "task-1", task: "Review this change" },
  { method: "reply", ...base, id: "task-1", answer: "Review complete" },
  { method: "cancel", ...base, id: "task-1" },
]
const task: Task = {
  id: "task-1",
  from: "coding",
  to: "browser",
  task: "Read the current page",
  status: "queued",
}

describe("local coding request protocol", () => {
  test("connection metadata has four exact fields and cannot authorize through malformed identities or states", () => {
    const connection = { clientId, generation, windowId: 7, state: "approved" }
    expect(parseLocalConnection(connection)).toEqual(connection)
    for (const update of [
      { extra: true },
      { clientId: `${clientId}\n` },
      { generation: `${generation}\n` },
      { state: ["approved"] },
      { windowId: "7" },
      { windowId: -1 },
      { windowId: NaN },
    ]) {
      expect(() => parseLocalConnection({ ...connection, ...update })).toThrow(TaskError)
    }
  })
  test.each(requests)("accepts only the exact keys for $method", (request) => {
    expect(parseLocalRequest(request)).toEqual(request)
    for (const key of Object.keys(request)) {
      const missing = { ...request } as Record<string, unknown>
      delete missing[key]
      expect(() => parseLocalRequest(missing)).toThrow(TaskError)
    }
    for (const [key, value] of Object.entries({
      extra: true,
      url: "https://relay.invalid/",
      token: "obsolete-remote-token",
      approved: true,
      role: "settings",
      version: 1,
      answer: "unexpected answer",
      task: "unexpected task",
      generation,
      id: "unexpected-id",
    })) {
      if (Object.hasOwn(request, key)) continue
      expect(() => parseLocalRequest({ ...request, [key]: value })).toThrow(TaskError)
    }
  })

  test.each([
    undefined,
    null,
    [],
    "connect",
    {},
    { method: "approve", clientId },
    { method: "constructor", clientId },
    { method: "toString", clientId },
    { method: "__proto__", clientId },
    { method: 1, clientId },
    Object.create({ method: "connect", clientId }),
  ])("rejects malformed or unsupported requests: %j", (value) => {
    expect(() => parseLocalRequest(value)).toThrow(TaskError)
  })

  test.each([
    "",
    "task-1",
    "00000000-0000-4000-8000-00000000000",
    `${clientId}x`,
    `${clientId}\n`,
    `${clientId}\r`,
    null,
    1,
  ])("requires UUID connection identities: %j", (value) => {
    expect(() => localId(value)).toThrow(TaskError)
    expect(() => parseLocalRequest({ method: "connect", clientId: value })).toThrow(TaskError)
    expect(() => parseLocalRequest({ method: "disconnect", clientId, generation: value })).toThrow(
      TaskError,
    )
  })

  test("keeps UUID identities separate from bounded task IDs", () => {
    expect(localId(clientId)).toBe(clientId)
    expect(taskId("A_1-z")).toBe("A_1-z")
    expect(taskId("x".repeat(64))).toHaveLength(64)
    for (const value of [
      "",
      "x".repeat(65),
      "a/b",
      "a b",
      "a.b",
      "id\n",
      "id\r",
      "日本語",
      null,
      1,
    ]) {
      expect(() => taskId(value)).toThrow(TaskError)
      expect(() => parseLocalRequest({ method: "get", ...base, id: value })).toThrow(TaskError)
    }
  })

  test.each([
    ["send", "task", TASK_LIMITS.taskBytes],
    ["accept", "task", TASK_LIMITS.taskBytes],
    ["reply", "answer", TASK_LIMITS.answerBytes],
  ] as const)("bounds %s %s by UTF-8 bytes", (method, field, limit) => {
    const text = "😀".repeat(limit / 4)
    const request = { method, ...base, id: "task-1", [field]: text }
    expect(parseLocalRequest(request)).toMatchObject({ [field]: text })
    for (const value of [undefined, null, 1, "", " \n\t", `${text}a`, "é".repeat(limit / 2 + 1)]) {
      expect(() => parseLocalRequest({ ...request, [field]: value })).toThrow(TaskError)
    }
  })

  test("does not normalize nonempty task text", () => {
    expect(taskText("  reviewed task\n", TASK_LIMITS.taskBytes)).toBe("  reviewed task\n")
  })
})

describe("local coding Task records", () => {
  test.each(["queued", "running", "completed", "failed", "cancelled"] as const)(
    "validates %s and its required answer shape",
    (status) => {
      const answer = status === "completed" || status === "failed" ? { answer: "Result" } : {}
      const value = { ...task, status, ...answer }
      expect(parseTask(value)).toEqual(value)
      expect(parseTask({ ...value, from: "browser", to: "coding" })).toEqual({
        ...value,
        from: "browser",
        to: "coding",
      })
      expect(terminal(value)).toBe(["completed", "failed", "cancelled"].includes(status))
      if ("answer" in answer) {
        const { answer: _answer, ...missing } = value
        expect(() => parseTask(missing)).toThrow(TaskError)
      } else {
        expect(() => parseTask({ ...value, answer: "Unexpected" })).toThrow(TaskError)
      }
    },
  )

  test.each([
    null,
    [],
    {},
    { ...task, id: "" },
    { ...task, from: "relay" },
    { ...task, to: "relay" },
    { ...task, from: "browser", to: "browser" },
    { ...task, to: "coding" },
    { ...task, status: "pending" },
    { ...task, status: null },
    { ...task, extra: true },
    { ...task, clientId },
    { ...task, task: " \n" },
    { ...task, task: "é".repeat(TASK_LIMITS.taskBytes / 2 + 1) },
    { ...task, status: "completed", answer: "" },
    { ...task, status: "failed", answer: null },
    { ...task, status: "completed", answer: "é".repeat(TASK_LIMITS.answerBytes / 2 + 1) },
  ])("rejects invalid Task shape: %j", (value) => {
    expect(() => parseTask(value)).toThrow(TaskError)
  })

  test("requires every core Task field and accepts exact text limits", () => {
    for (const key of Object.keys(task)) {
      const value = { ...task } as Record<string, unknown>
      delete value[key]
      expect(() => parseTask(value)).toThrow(TaskError)
    }
    const value = {
      ...task,
      status: "completed",
      task: "é".repeat(TASK_LIMITS.taskBytes / 2),
      answer: "😀".repeat(TASK_LIMITS.answerBytes / 4),
    }
    expect(parseTask(value)).toEqual(value)
  })
})

describe("bounded local results", () => {
  test("clones selected values instead of sharing mutable Task objects", () => {
    const value = { ...task }
    const response = localResponse({ ok: true, value: [value] })
    expect(response).toEqual({ ok: true, value: [task] })
    value.task = "Changed outside the result"
    expect(response).toEqual({ ok: true, value: [task] })
  })

  test("bounds the full serialized result by UTF-8 bytes, including JSON escaping", () => {
    const overhead = new TextEncoder().encode(JSON.stringify({ ok: false, error: "" })).byteLength
    const available = TASK_LIMITS.responseBytes - overhead
    const error = "é".repeat(Math.floor(available / 2)) + "a".repeat(available % 2)
    expect(localResponse({ ok: false, error })).toEqual({ ok: false, error })
    expect(localResponse({ ok: false, error: `${error}a` })).toEqual({
      ok: false,
      error: "Local response exceeds its byte limit",
    })
    expect(localResponse({ ok: false, error: "\n".repeat(available) })).toEqual({
      ok: false,
      error: "Local response exceeds its byte limit",
    })
    expect(localResponse({ ok: true, value: null })).toEqual({ ok: true, value: null })
  })
})
