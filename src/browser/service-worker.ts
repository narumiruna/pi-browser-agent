import { executePageOperation, type PageOperation } from "./content/page-operations.js"
import { assertTabContext } from "./content/tab-context.js"
import { hasHostPermission } from "./permissions.js"
import { parseRuntimeRequest, type RuntimeEvent, type RuntimeRequest } from "./runtime/messages.js"
import { type JsonValue, RuntimeError, type TabContext, truncateUtf8 } from "./runtime/types.js"
import {
  restrictLocalStorageToTrustedContexts,
  savePendingSelection,
  takePendingSelection,
} from "./storage.js"
import { executeWebMcpOperation, type WebMcpOperation } from "./webmcp/adapter.js"

const SELECTION_CONTEXT_MENU_ID = "pi-chrome-send-selection"
const activeRequests = new Map<string, AbortController>()
let boundContext: TabContext | undefined
let contextEpoch = 0
let pendingSelectionTake: Promise<JsonValue> = Promise.resolve(null)
const initialization = initialize()

function isSupportedPageUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

function emitEvent(event: RuntimeEvent): void {
  void chrome.runtime.sendMessage(event).catch(() => undefined)
}

function emitTabChanged(): void {
  emitEvent({ kind: "event", name: "tab.changed", payload: {}, tabContext: boundContext })
}

function clearBoundTab(): void {
  if (!boundContext) return
  contextEpoch = Math.max(contextEpoch, boundContext.epoch) + 1
  boundContext = undefined
  emitTabChanged()
}

function setBoundTab(tab: chrome.tabs.Tab | undefined): TabContext | undefined {
  if (tab?.id === undefined || !tab.url || !isSupportedPageUrl(tab.url)) {
    clearBoundTab()
    return undefined
  }
  if (boundContext?.tabId === tab.id && boundContext.url === tab.url) {
    return { ...boundContext }
  }
  if (boundContext) contextEpoch = Math.max(contextEpoch, boundContext.epoch) + 1
  boundContext = { tabId: tab.id, url: tab.url, epoch: contextEpoch }
  emitTabChanged()
  return { ...boundContext }
}

async function syncVisibleTab(): Promise<TabContext | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  return setBoundTab(tab)
}

async function syncUpdatedVisibleTab(updatedTabId: number): Promise<void> {
  const previous = boundContext
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  const context = setBoundTab(tab)
  if (
    context &&
    tab?.id === updatedTabId &&
    previous?.tabId === context.tabId &&
    previous.url === context.url &&
    previous.epoch === context.epoch
  ) {
    contextEpoch = Math.max(contextEpoch, context.epoch) + 1
    boundContext = { ...context, epoch: contextEpoch }
    emitTabChanged()
  }
}

async function initialize(): Promise<void> {
  await restrictLocalStorageToTrustedContexts()
  await syncVisibleTab()
}

function bindSelectionTab(tab: chrome.tabs.Tab | undefined): TabContext {
  const context = setBoundTab(tab)
  if (!context) {
    throw new RuntimeError(
      "PERMISSION_DENIED",
      "Selections can only be sent from an HTTP or HTTPS page",
    )
  }
  return context
}

function consumePendingSelection(windowId: number): Promise<JsonValue> {
  pendingSelectionTake = pendingSelectionTake
    .catch(() => null)
    .then(async () => {
      const selection = await takePendingSelection(windowId)
      return selection ? { payload: selection.payload, tabContext: selection.tabContext } : null
    })
  return pendingSelectionTake
}

async function refreshBoundContext(): Promise<TabContext> {
  const context = await syncVisibleTab()
  if (!context) {
    throw new RuntimeError("TAB_NOT_BOUND", "Open an HTTP or HTTPS page in the active tab")
  }
  return context
}

async function revalidateRequestContext(
  request: RuntimeRequest,
  expected: TabContext,
): Promise<TabContext> {
  const current = await refreshBoundContext()
  assertTabContext(expected, current)
  assertTabContext(request.tabContext, current)
  return current
}

function throwStaleContext(expected: TabContext, actual?: TabContext): never {
  throw new RuntimeError(
    "STALE_CONTEXT",
    "The visible tab changed or navigated while the browser operation was running",
    { expected, ...(actual ? { actual } : {}) },
  )
}

async function runPageOperation(
  operation: PageOperation,
  request: RuntimeRequest,
  trustedLinkTargetUrl: string | null = null,
): Promise<JsonValue> {
  const context = await refreshBoundContext()
  assertTabContext(request.tabContext, context)
  let results: chrome.scripting.InjectionResult<Awaited<ReturnType<typeof executePageOperation>>>[]
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: context.tabId },
      func: executePageOperation,
      args: [
        operation,
        request.params,
        request.confirmed ?? false,
        trustedLinkTargetUrl,
        context.url,
      ],
    })
  } catch (error) {
    throw new RuntimeError(
      "PERMISSION_DENIED",
      error instanceof Error ? error.message : "Chrome denied access to the current tab",
    )
  }
  await revalidateRequestContext(request, context)
  const outcome = results[0]?.result
  if (!outcome) throw new RuntimeError("INTERNAL_ERROR", "The page operation returned no result")
  if (!outcome.ok)
    throw new RuntimeError(outcome.error.code, outcome.error.message, outcome.error.details)
  return outcome.result
}

async function runClick(request: RuntimeRequest): Promise<JsonValue> {
  if (!request.confirmed) return runPageOperation("click", request)
  const inspection = await runPageOperation("inspectClick", request)
  const data =
    typeof inspection === "object" && inspection !== null && !Array.isArray(inspection)
      ? inspection
      : {}
  const target = data.targetUrl
  if (target === null || target === undefined) return runPageOperation("click", request)
  if (typeof target !== "string") throw new RuntimeError("INTERNAL_ERROR", "Invalid link target")

  const targetUrl = new URL(target)
  const nativeDownload = data.download === true && ["blob:", "data:"].includes(targetUrl.protocol)
  if (nativeDownload) return runPageOperation("click", request, target)
  if (!isSupportedPageUrl(target)) {
    throw new RuntimeError("PERMISSION_DENIED", "Only HTTP and HTTPS link targets can be opened")
  }

  const context = await refreshBoundContext()
  assertTabContext(request.tabContext, context)
  if (targetUrl.origin === new URL(context.url).origin) {
    return runPageOperation("click", request, data.download === true ? target : null)
  }
  if (!(await hasHostPermission(targetUrl))) {
    throw new RuntimeError(
      "PERMISSION_DENIED",
      "Grant access to the destination before opening this cross-origin link",
      { targetUrl: targetUrl.href },
    )
  }
  const result = await runPageOperation("click", request, targetUrl.href)
  if (
    typeof result === "object" &&
    result !== null &&
    !Array.isArray(result) &&
    result.navigationAllowed === true
  ) {
    const current = await revalidateRequestContext(request, context)
    await chrome.tabs.update(current.tabId, { url: targetUrl.href })
    const updated = await syncVisibleTab()
    if (!updated || updated.tabId !== current.tabId) throwStaleContext(current, updated)
  }
  return result
}

function truncateStructuredResult(value: JsonValue): JsonValue {
  const serialized = JSON.stringify(value)
  const truncated = truncateUtf8(serialized)
  return truncated.truncated ? { text: truncated.text, truncated: true } : value
}

async function runWebMcp(operation: WebMcpOperation, request: RuntimeRequest): Promise<JsonValue> {
  const context = await refreshBoundContext()
  assertTabContext(request.tabContext, context)
  let results: chrome.scripting.InjectionResult<
    Awaited<ReturnType<typeof executeWebMcpOperation>>
  >[]
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: context.tabId },
      func: executeWebMcpOperation,
      args: [operation, request.params, request.confirmed ?? false, context.url],
    })
  } catch (error) {
    throw new RuntimeError(
      "PERMISSION_DENIED",
      error instanceof Error ? error.message : "Chrome denied WebMCP access",
    )
  }
  await revalidateRequestContext(request, context)
  const outcome = results[0]?.result
  if (!outcome) throw new RuntimeError("INTERNAL_ERROR", "WebMCP returned no result")
  if (!outcome.ok)
    throw new RuntimeError(outcome.error.code, outcome.error.message, outcome.error.details)
  return outcome.result
}

async function getActiveTab(request: RuntimeRequest): Promise<JsonValue> {
  const context = await refreshBoundContext()
  assertTabContext(request.tabContext, context)
  const tab = await chrome.tabs.get(context.tabId)
  await revalidateRequestContext(request, context)
  return { ...context, active: tab.active, title: tab.title ?? "", windowId: tab.windowId }
}

async function captureVisible(request: RuntimeRequest): Promise<JsonValue> {
  const context = await refreshBoundContext()
  assertTabContext(request.tabContext, context)
  const tab = await chrome.tabs.get(context.tabId)
  if (!tab.active) {
    throw new RuntimeError("INVALID_REQUEST", "The current tab must remain active for a screenshot")
  }
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" })
  await revalidateRequestContext(request, context)
  if (dataUrl.length > 3_000_000) {
    throw new RuntimeError("INVALID_REQUEST", "Screenshot exceeds the 3 MB extension limit")
  }
  return { dataUrl, mimeType: "image/png", tabContext: context }
}

async function navigate(request: RuntimeRequest): Promise<JsonValue> {
  const context = await refreshBoundContext()
  assertTabContext(request.tabContext, context)
  const target = request.params.url
  if (typeof target !== "string" || !isSupportedPageUrl(target)) {
    throw new RuntimeError("INVALID_REQUEST", "Navigation requires an HTTP or HTTPS URL")
  }
  const targetUrl = new URL(target)
  const crossOrigin = targetUrl.origin !== new URL(context.url).origin
  if (crossOrigin && !request.confirmed) {
    throw new RuntimeError(
      "CONFIRMATION_REQUIRED",
      `Navigate from ${new URL(context.url).origin} to ${targetUrl.origin}?`,
      { targetUrl: targetUrl.href },
    )
  }
  if (crossOrigin && !(await hasHostPermission(targetUrl))) {
    throw new RuntimeError(
      "PERMISSION_DENIED",
      "Grant access to the destination before navigating",
      {
        targetUrl: targetUrl.href,
      },
    )
  }
  const current = await revalidateRequestContext(request, context)
  await chrome.tabs.update(current.tabId, { url: targetUrl.href })
  const updated = await syncVisibleTab()
  if (!updated || updated.tabId !== current.tabId) throwStaleContext(current, updated)
  return updated
}

async function dispatch(request: RuntimeRequest, signal: AbortSignal): Promise<JsonValue> {
  await initialization
  if (signal.aborted) throw new RuntimeError("REQUEST_CANCELLED", "Browser request was cancelled")
  let result: JsonValue
  switch (request.method) {
    case "app.getState":
      result = { tabContext: (await syncVisibleTab()) ?? null }
      break
    case "tabs.getActive":
      result = await getActiveTab(request)
      break
    case "tabs.navigate":
      result = await navigate(request)
      break
    case "selection.takePending": {
      const windowId = request.params.windowId
      if (typeof windowId !== "number")
        throw new RuntimeError("INVALID_REQUEST", "windowId is required")
      result = await consumePendingSelection(windowId)
      break
    }
    case "requests.cancel": {
      const requestId = request.params.requestId
      if (typeof requestId !== "string")
        throw new RuntimeError("INVALID_REQUEST", "requestId is required")
      activeRequests.get(requestId)?.abort()
      result = { cancelled: true }
      break
    }
    case "page.getVisibleText": {
      const value = await runPageOperation("getVisibleText", request)
      if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        typeof value.text === "string"
      ) {
        result = { ...value, ...truncateUtf8(value.text) }
      } else result = value
      break
    }
    case "page.getSelection": {
      const value = await runPageOperation("getSelection", request)
      if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        typeof value.text === "string"
      ) {
        result = { ...value, ...truncateUtf8(value.text) }
      } else result = value
      break
    }
    case "page.captureVisible":
      result = await captureVisible(request)
      break
    case "page.click":
      result = await runClick(request)
      break
    case "page.type":
      result = await runPageOperation("type", request)
      break
    case "webmcp.listTools":
      result = truncateStructuredResult(await runWebMcp("webmcp.listTools", request))
      break
    case "webmcp.callTool":
      result = truncateStructuredResult(await runWebMcp("webmcp.callTool", request))
      break
  }
  if (signal.aborted) throw new RuntimeError("REQUEST_CANCELLED", "Browser request was cancelled")
  return result
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: SELECTION_CONTEXT_MENU_ID,
      title: "Send selection to Pi Chrome",
      contexts: ["selection"],
    })
  })
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url && changeInfo.status !== "loading") return
  void initialization.then(() => syncUpdatedVisibleTab(tabId)).catch(() => undefined)
})

chrome.tabs.onActivated.addListener(() => {
  void initialization.then(syncVisibleTab).catch(() => undefined)
})

chrome.tabs.onRemoved.addListener((tabId) => {
  if (boundContext?.tabId === tabId) {
    clearBoundTab()
    void initialization.then(syncVisibleTab).catch(() => undefined)
  }
})

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    void initialization.then(syncVisibleTab).catch(() => undefined)
  }
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== SELECTION_CONTEXT_MENU_ID) return
  const windowId = tab?.windowId
  if (windowId !== undefined) {
    void chrome.sidePanel.open({ windowId }).catch(() => undefined)
  }
  void initialization
    .then(() => bindSelectionTab(tab))
    .then(async (context) => {
      if (!info.selectionText || windowId === undefined) return
      const selection = truncateUtf8(info.selectionText)
      await savePendingSelection({
        windowId,
        payload: {
          text: selection.text,
          source: "context-menu",
          untrusted: true,
          truncated: selection.truncated,
        },
        tabContext: context,
      })
      emitEvent({
        kind: "event",
        name: "selection.queued",
        payload: { available: true, windowId },
      })
    })
    .catch(() => undefined)
})

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (
    typeof message === "object" &&
    message !== null &&
    "kind" in message &&
    message.kind === "event"
  )
    return false
  let request: RuntimeRequest
  try {
    request = parseRuntimeRequest(message)
  } catch (error) {
    const runtimeError =
      error instanceof RuntimeError ? error : new RuntimeError("INVALID_REQUEST", String(error))
    sendResponse({ ok: false, error: runtimeError.toData() })
    return false
  }

  const controller = new AbortController()
  if (request.method !== "requests.cancel") {
    activeRequests.set(request.requestId, controller)
    emitEvent({
      kind: "event",
      name: "operation.progress",
      payload: { method: request.method, requestId: request.requestId, status: "started" },
    })
  }
  void dispatch(request, controller.signal)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => {
      const runtimeError =
        error instanceof RuntimeError ? error : new RuntimeError("INTERNAL_ERROR", String(error))
      sendResponse({ ok: false, error: runtimeError.toData() })
    })
    .finally(() => {
      if (activeRequests.delete(request.requestId)) {
        emitEvent({
          kind: "event",
          name: "operation.progress",
          payload: { method: request.method, requestId: request.requestId, status: "finished" },
        })
      }
    })
  return true
})
