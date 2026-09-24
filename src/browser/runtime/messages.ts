import type { PageCapability } from "./page-capability.js"
import {
  type ElementTarget,
  type JsonObject,
  type JsonValue,
  RuntimeError,
  type TabContext,
} from "./types.js"

export const RUNTIME_METHODS = [
  "app.getState",
  "tabs.getActive",
  "tabs.navigate",
  "bookmarks.search",
  "bookmarks.getRecent",
  "selection.takePending",
  "elementPicker.start",
  "elementPicker.stop",
  "requests.cancel",
  "page.getVisibleText",
  "page.listElements",
  "page.getSelection",
  "page.captureVisible",
  "page.click",
  "page.type",
  "webmcp.listTools",
  "webmcp.callTool",
] as const

export type RuntimeMethod = (typeof RUNTIME_METHODS)[number]

export const REQUEST_LIMITS = {
  selector: 2048,
  snapshotId: 36,
  elementRef: 8,
  typedText: 50_000,
  url: 16_384,
  bookmarkQuery: 500,
  bookmarkResults: 50,
  requestId: 256,
  webMcpName: 256,
} as const

type RuntimeParams = {
  "app.getState": Record<string, never>
  "tabs.getActive": Record<string, never>
  "tabs.navigate": { url: string }
  "bookmarks.search": { query: string; limit: number }
  "bookmarks.getRecent": { limit: number }
  "selection.takePending": { windowId: number }
  "elementPicker.start": { clientId: string }
  "elementPicker.stop": Record<string, never>
  "requests.cancel": { requestId: string }
  "page.getVisibleText": { selector?: string; offset?: number }
  "page.listElements": Record<string, never>
  "page.getSelection": Record<string, never>
  "page.captureVisible": Record<string, never>
  "page.click": ElementTarget
  "page.type": ElementTarget & { text: string }
  "webmcp.listTools": Record<string, never>
  "webmcp.callTool": { name: string; arguments: JsonObject }
}

export type RuntimeRequest<M extends RuntimeMethod = RuntimeMethod> = {
  [K in M]: {
    kind: "request"
    requestId: string
    method: K
    params: RuntimeParams[K]
    tabContext?: TabContext
    confirmed?: boolean
  }
}[M]

export interface RuntimeEvent {
  kind: "event"
  name:
    | "elementPicker.cancelled"
    | "elementPicker.selected"
    | "elementPicker.started"
    | "operation.progress"
    | "selection.queued"
    | "settings.saved"
    | "tab.changed"
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

export function pageCapabilityFrom(value: unknown): PageCapability {
  if (
    isRecord(value) &&
    hasOnlyKeys(value, ["kind", "title"]) &&
    ["none", "web", "restricted", "file", "pdf"].includes(String(value.kind)) &&
    typeof value.title === "string" &&
    value.title.length <= 160
  ) {
    return value as unknown as PageCapability
  }
  return { kind: "none", title: "" }
}

function isTabContext(value: unknown): value is TabContext {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.tabId) &&
    (value.tabId as number) >= 0 &&
    typeof value.url === "string" &&
    value.url.length > 0 &&
    value.url.length <= REQUEST_LIMITS.url &&
    Number.isSafeInteger(value.epoch) &&
    (value.epoch as number) >= 0
  )
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function hasValidTarget(params: Record<string, unknown>, extra: string[] = []): boolean {
  if ("selector" in params) {
    return (
      hasOnlyKeys(params, ["selector", ...extra]) &&
      typeof params.selector === "string" &&
      params.selector.length > 0 &&
      params.selector.length <= REQUEST_LIMITS.selector
    )
  }
  return (
    hasOnlyKeys(params, ["snapshotId", "ref", ...extra]) &&
    typeof params.snapshotId === "string" &&
    /^[a-f0-9-]{36}$/.test(params.snapshotId) &&
    typeof params.ref === "string" &&
    /^e[1-9][0-9]*$/.test(params.ref) &&
    params.ref.length <= REQUEST_LIMITS.elementRef
  )
}

function hasValidParams(method: RuntimeMethod, params: Record<string, unknown>): boolean {
  switch (method) {
    case "app.getState":
    case "elementPicker.stop":
    case "tabs.getActive":
    case "page.listElements":
    case "page.getSelection":
    case "page.captureVisible":
    case "webmcp.listTools":
      return Object.keys(params).length === 0
    case "page.getVisibleText":
      return (
        hasOnlyKeys(params, ["selector", "offset"]) &&
        (params.selector === undefined ||
          (typeof params.selector === "string" &&
            params.selector.length > 0 &&
            params.selector.length <= REQUEST_LIMITS.selector)) &&
        (params.offset === undefined ||
          (Number.isSafeInteger(params.offset) && (params.offset as number) >= 0))
      )
    case "elementPicker.start":
      return (
        hasOnlyKeys(params, ["clientId"]) &&
        typeof params.clientId === "string" &&
        /^[a-f0-9-]{36}$/.test(params.clientId)
      )
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
        params.query.length <= REQUEST_LIMITS.bookmarkQuery &&
        Number.isSafeInteger(params.limit) &&
        (params.limit as number) >= 1 &&
        (params.limit as number) <= REQUEST_LIMITS.bookmarkResults
      )
    case "bookmarks.getRecent":
      return (
        hasOnlyKeys(params, ["limit"]) &&
        Number.isSafeInteger(params.limit) &&
        (params.limit as number) >= 1 &&
        (params.limit as number) <= REQUEST_LIMITS.bookmarkResults
      )
    case "tabs.navigate":
      return (
        hasOnlyKeys(params, ["url"]) &&
        typeof params.url === "string" &&
        params.url.length > 0 &&
        params.url.length <= REQUEST_LIMITS.url
      )
    case "requests.cancel":
      return (
        hasOnlyKeys(params, ["requestId"]) &&
        typeof params.requestId === "string" &&
        params.requestId.length > 0 &&
        params.requestId.length <= REQUEST_LIMITS.requestId
      )
    case "page.click":
      return hasValidTarget(params)
    case "page.type":
      return (
        hasValidTarget(params, ["text"]) &&
        typeof params.text === "string" &&
        params.text.length <= REQUEST_LIMITS.typedText
      )
    case "webmcp.callTool":
      return (
        hasOnlyKeys(params, ["arguments", "name"]) &&
        typeof params.name === "string" &&
        params.name.length > 0 &&
        params.name.length <= REQUEST_LIMITS.webMcpName &&
        isRecord(params.arguments) &&
        isJsonValue(params.arguments)
      )
  }
}

function isRuntimeMethod(value: unknown): value is RuntimeMethod {
  return RUNTIME_METHODS.some((method) => method === value)
}

function isRuntimeRequest(value: unknown): value is RuntimeRequest {
  return (
    isRecord(value) &&
    value.kind === "request" &&
    typeof value.requestId === "string" &&
    value.requestId.length > 0 &&
    value.requestId.length <= REQUEST_LIMITS.requestId &&
    isRuntimeMethod(value.method) &&
    isRecord(value.params) &&
    isJsonValue(value.params) &&
    hasValidParams(value.method, value.params) &&
    (!["bookmarks.search", "bookmarks.getRecent"].includes(value.method) ||
      value.tabContext === undefined) &&
    (value.tabContext === undefined || isTabContext(value.tabContext)) &&
    (value.confirmed === undefined || typeof value.confirmed === "boolean")
  )
}

export function parseRuntimeRequest(value: unknown): RuntimeRequest {
  if (!isRuntimeRequest(value)) {
    throw new RuntimeError("INVALID_REQUEST", "Malformed or unknown extension runtime message")
  }
  return value
}

export async function sendRuntimeRequest(
  method: RuntimeMethod,
  params: JsonObject = {},
  options: { confirmed?: boolean; signal?: AbortSignal; tabContext?: TabContext } = {},
): Promise<JsonValue> {
  const { signal, ...requestOptions } = options
  if (signal?.aborted) throw new RuntimeError("REQUEST_CANCELLED", "Browser request was cancelled")
  const request = {
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
