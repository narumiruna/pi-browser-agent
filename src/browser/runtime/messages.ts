import { type JsonObject, type JsonValue, RuntimeError, type TabContext } from "./types.js"

export const RUNTIME_METHODS = [
  "app.getState",
  "tabs.getActive",
  "tabs.navigate",
  "bookmarks.search",
  "bookmarks.getRecent",
  "selection.takePending",
  "requests.cancel",
  "page.getVisibleText",
  "page.getSelection",
  "page.captureVisible",
  "page.click",
  "page.type",
  "webmcp.listTools",
  "webmcp.callTool",
] as const

export type RuntimeMethod = (typeof RUNTIME_METHODS)[number]

export interface RuntimeRequest {
  kind: "request"
  requestId: string
  method: RuntimeMethod
  params: JsonObject
  tabContext?: TabContext
  confirmed?: boolean
}

export interface RuntimeEvent {
  kind: "event"
  name: "operation.progress" | "selection.queued" | "tab.changed"
  payload: JsonObject
  tabContext?: TabContext
}

export type RuntimeResponse =
  | { ok: true; result: JsonValue }
  | { ok: false; error: { code: string; message: string; details?: JsonObject } }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 20) return false
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value))
    return value.length <= 10_000 && value.every((item) => isJsonValue(item, depth + 1))
  if (!isRecord(value) || Object.keys(value).length > 1000) return false
  return Object.entries(value).every(
    ([key, item]) =>
      !["__proto__", "constructor", "prototype"].includes(key) && isJsonValue(item, depth + 1),
  )
}

function isTabContext(value: unknown): value is TabContext {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.tabId) &&
    (value.tabId as number) >= 0 &&
    typeof value.url === "string" &&
    value.url.length > 0 &&
    value.url.length <= 16_384 &&
    Number.isSafeInteger(value.epoch) &&
    (value.epoch as number) >= 0
  )
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function hasValidParams(method: RuntimeMethod, params: Record<string, unknown>): boolean {
  switch (method) {
    case "app.getState":
    case "tabs.getActive":
    case "page.getVisibleText":
    case "page.getSelection":
    case "page.captureVisible":
    case "webmcp.listTools":
      return Object.keys(params).length === 0
    case "selection.takePending":
      return (
        hasOnlyKeys(params, ["windowId"]) &&
        Number.isSafeInteger(params.windowId) &&
        (params.windowId as number) >= 0
      )
    case "bookmarks.search":
      return (
        hasOnlyKeys(params, ["limit", "query"]) &&
        typeof params.query === "string" &&
        params.query.trim().length > 0 &&
        params.query.length <= 500 &&
        Number.isSafeInteger(params.limit) &&
        (params.limit as number) >= 1 &&
        (params.limit as number) <= 50
      )
    case "bookmarks.getRecent":
      return (
        hasOnlyKeys(params, ["limit"]) &&
        Number.isSafeInteger(params.limit) &&
        (params.limit as number) >= 1 &&
        (params.limit as number) <= 50
      )
    case "tabs.navigate":
      return (
        hasOnlyKeys(params, ["url"]) &&
        typeof params.url === "string" &&
        params.url.length > 0 &&
        params.url.length <= 16_384
      )
    case "requests.cancel":
      return (
        hasOnlyKeys(params, ["requestId"]) &&
        typeof params.requestId === "string" &&
        params.requestId.length > 0 &&
        params.requestId.length <= 256
      )
    case "page.click":
      return (
        hasOnlyKeys(params, ["selector"]) &&
        typeof params.selector === "string" &&
        params.selector.length > 0 &&
        params.selector.length <= 2048
      )
    case "page.type":
      return (
        hasOnlyKeys(params, ["selector", "text"]) &&
        typeof params.selector === "string" &&
        params.selector.length > 0 &&
        params.selector.length <= 2048 &&
        typeof params.text === "string" &&
        params.text.length <= 50_000
      )
    case "webmcp.callTool":
      return (
        hasOnlyKeys(params, ["arguments", "name"]) &&
        typeof params.name === "string" &&
        params.name.length > 0 &&
        params.name.length <= 256 &&
        isRecord(params.arguments) &&
        isJsonValue(params.arguments)
      )
  }
}

export function parseRuntimeRequest(value: unknown): RuntimeRequest {
  if (
    !isRecord(value) ||
    value.kind !== "request" ||
    typeof value.requestId !== "string" ||
    value.requestId.length === 0 ||
    value.requestId.length > 256 ||
    typeof value.method !== "string" ||
    !RUNTIME_METHODS.includes(value.method as RuntimeMethod) ||
    !isRecord(value.params) ||
    !isJsonValue(value.params) ||
    !hasValidParams(value.method as RuntimeMethod, value.params) ||
    (["bookmarks.search", "bookmarks.getRecent"].includes(value.method) &&
      value.tabContext !== undefined) ||
    (value.tabContext !== undefined && !isTabContext(value.tabContext)) ||
    (value.confirmed !== undefined && typeof value.confirmed !== "boolean")
  ) {
    throw new RuntimeError("INVALID_REQUEST", "Malformed or unknown extension runtime message")
  }
  return value as unknown as RuntimeRequest
}

export async function sendRuntimeRequest(
  method: RuntimeMethod,
  params: JsonObject = {},
  options: { confirmed?: boolean; signal?: AbortSignal; tabContext?: TabContext } = {},
): Promise<JsonValue> {
  const { signal, ...requestOptions } = options
  if (signal?.aborted) throw new RuntimeError("REQUEST_CANCELLED", "Browser request was cancelled")
  const request: RuntimeRequest = {
    kind: "request",
    requestId: crypto.randomUUID(),
    method,
    params,
    ...requestOptions,
  }
  const cancel = (): void => {
    void chrome.runtime.sendMessage({
      kind: "request",
      requestId: crypto.randomUUID(),
      method: "requests.cancel",
      params: { requestId: request.requestId },
    })
  }
  signal?.addEventListener("abort", cancel, { once: true })
  const response = (await chrome.runtime.sendMessage(request).finally(() => {
    signal?.removeEventListener("abort", cancel)
  })) as RuntimeResponse | undefined
  if (signal?.aborted) throw new RuntimeError("REQUEST_CANCELLED", "Browser request was cancelled")
  if (!response) throw new RuntimeError("INTERNAL_ERROR", "The extension worker did not respond")
  if (!response.ok) {
    throw new RuntimeError(
      response.error.code as ConstructorParameters<typeof RuntimeError>[0],
      response.error.message,
      response.error.details,
    )
  }
  return response.result
}
