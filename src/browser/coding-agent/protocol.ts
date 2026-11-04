export const TASK_LIMITS = {
  taskBytes: 8 * 1024,
  answerBytes: 24 * 1024,
  responseBytes: 48 * 1024,
  inbox: 10,
  tracked: 64,
  timeoutMs: 15_000,
  waitMs: 10 * 60_000,
} as const

export const LOCAL_API_NAME = "__piBrowserLocal" as const
export const LOCAL_API_VERSION = 2 as const
export const REQUEST_FAILURE =
  "Local browser connection stopped. Execution may be unknown. Inspect the task ID before another operation; no operation was retried."

export class TaskError extends Error {}
export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled"
export type Task = {
  id: string
  from: "coding" | "browser"
  to: "coding" | "browser"
  task: string
  status: TaskStatus
  answer?: string
}
export type LocalConnection = {
  clientId: string
  generation: string
  windowId: number
  state: "pending" | "approved" | "rejected"
}
export type LocalRequest = {
  method:
    | "connect"
    | "status"
    | "disconnect"
    | "send"
    | "get"
    | "inbox"
    | "accept"
    | "reply"
    | "cancel"
  clientId: string
  generation?: string
  id?: string
  task?: string
  answer?: string
}
export type LocalResponse =
  | { ok: true; value: LocalConnection | Task | Task[] | null }
  | { ok: false; error: string }
export type LocalApi = {
  version: typeof LOCAL_API_VERSION
  role: "settings" | "conversation"
  dispatch(request: unknown): Promise<LocalResponse>
}

declare global {
  interface Window {
    __piBrowserLocal?: LocalApi
  }
}

export function taskId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 64 ||
    /[^a-zA-Z0-9_-]/.test(value)
  ) {
    throw new TaskError("Invalid task ID")
  }
  return value
}

export function localId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length !== 36 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
  ) {
    throw new TaskError("Invalid local connection identity")
  }
  return value
}

export function taskText(value: unknown, limit: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    new TextEncoder().encode(value).byteLength > limit
  ) {
    throw new TaskError("Task text is empty or exceeds its byte limit")
  }
  return value
}

export function terminal(task: Task): boolean {
  return task.status === "completed" || task.status === "failed" || task.status === "cancelled"
}

export function parseTask(value: unknown): Task {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TaskError("Invalid local task")
  const task = value as Record<string, unknown>
  if (
    Object.keys(task).some(
      (key) => !["id", "from", "to", "task", "status", "answer"].includes(key),
    ) ||
    (task.from !== "coding" && task.from !== "browser") ||
    (task.to !== "coding" && task.to !== "browser") ||
    task.from === task.to ||
    typeof task.status !== "string" ||
    !["queued", "running", "completed", "failed", "cancelled"].includes(task.status) ||
    (task.status === "completed" || task.status === "failed") !== (task.answer !== undefined)
  )
    throw new TaskError("Invalid local task")
  return {
    id: taskId(task.id),
    from: task.from,
    to: task.to,
    task: taskText(task.task, TASK_LIMITS.taskBytes),
    status: task.status as TaskStatus,
    ...(task.answer === undefined
      ? {}
      : { answer: taskText(task.answer, TASK_LIMITS.answerBytes) }),
  }
}

export function parseLocalConnection(value: unknown): LocalConnection {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TaskError("Invalid local connection record")
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).sort().join() !== "clientId,generation,state,windowId" ||
    typeof record.state !== "string" ||
    !["pending", "approved", "rejected"].includes(record.state) ||
    typeof record.windowId !== "number" ||
    !Number.isSafeInteger(record.windowId) ||
    record.windowId < 0
  )
    throw new TaskError("Invalid local connection record")
  return {
    clientId: localId(record.clientId),
    generation: localId(record.generation),
    windowId: record.windowId,
    state: record.state as LocalConnection["state"],
  }
}

export function parseLocalRequest(value: unknown): LocalRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TaskError("Invalid local request")
  const request = value as Record<string, unknown>
  const fields: Record<string, string[]> = {
    connect: ["method", "clientId"],
    status: ["method", "clientId"],
    disconnect: ["method", "clientId", "generation"],
    send: ["method", "clientId", "generation", "id", "task"],
    get: ["method", "clientId", "generation", "id"],
    inbox: ["method", "clientId", "generation"],
    accept: ["method", "clientId", "generation", "id", "task"],
    reply: ["method", "clientId", "generation", "id", "answer"],
    cancel: ["method", "clientId", "generation", "id"],
  }
  const keys =
    typeof request.method === "string" && Object.hasOwn(fields, request.method)
      ? fields[request.method]
      : undefined
  if (
    !keys ||
    Object.keys(request).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(request, key))
  ) {
    throw new TaskError("Invalid local request")
  }
  const result: LocalRequest = {
    method: request.method as LocalRequest["method"],
    clientId: localId(request.clientId),
  }
  if (keys.includes("generation")) result.generation = localId(request.generation)
  if (keys.includes("id")) result.id = taskId(request.id)
  if (keys.includes("task")) result.task = taskText(request.task, TASK_LIMITS.taskBytes)
  if (keys.includes("answer")) result.answer = taskText(request.answer, TASK_LIMITS.answerBytes)
  return result
}

export function localResponse(value: LocalResponse): LocalResponse {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > TASK_LIMITS.responseBytes) {
    return { ok: false, error: "Local response exceeds its byte limit" }
  }
  return structuredClone(value)
}
