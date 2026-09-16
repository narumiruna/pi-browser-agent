import { executePageOperation, type PageOperation } from "./content/page-operations.js"
import { assertTabContext } from "./content/tab-context.js"
import { hasHostPermission, toHostPermissionPattern } from "./permissions.js"
import { parseRuntimeRequest, type RuntimeEvent, type RuntimeRequest } from "./runtime/messages.js"
import { type JsonValue, RuntimeError, type TabContext, truncateUtf8 } from "./runtime/types.js"
import { getBoundTabId, restrictLocalStorageToTrustedContexts, saveBoundTabId } from "./storage.js"
import { executeWebMcpOperation, type WebMcpOperation } from "./webmcp/adapter.js"

const CONTEXT_MENU_ID = "pi-chrome-send-selection"
const activeRequests = new Map<string, AbortController>()
let boundContext: TabContext | undefined
const initialization = Promise.all([restrictLocalStorageToTrustedContexts(), restoreBoundContext()])

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

async function clearBoundTab(): Promise<void> {
  boundContext = undefined
  await saveBoundTabId(undefined)
  emitTabChanged()
}

async function restoreBoundContext(): Promise<void> {
  const tabId = await getBoundTabId()
  if (tabId === undefined) return
  try {
    const tab = await chrome.tabs.get(tabId)
    if (!tab.url || !isSupportedPageUrl(tab.url)) return clearBoundTab()
    boundContext = { tabId, url: tab.url, epoch: 0 }
  } catch {
    await clearBoundTab()
  }
}

async function bindActiveTab(): Promise<TabContext> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tab?.id === undefined || !tab.url || !isSupportedPageUrl(tab.url)) {
    throw new RuntimeError(
      "PERMISSION_DENIED",
      "Open an HTTP or HTTPS page before binding the active tab",
    )
  }
  boundContext = { tabId: tab.id, url: tab.url, epoch: 0 }
  await saveBoundTabId(tab.id)
  emitTabChanged()
  return { ...boundContext }
}

async function refreshBoundContext(): Promise<TabContext> {
  if (!boundContext) throw new RuntimeError("TAB_NOT_BOUND", "Bind a tab from the Side Panel")
  let tab: chrome.tabs.Tab
  try {
    tab = await chrome.tabs.get(boundContext.tabId)
  } catch {
    await clearBoundTab()
    throw new RuntimeError("TAB_NOT_BOUND", "The bound tab no longer exists")
  }
  if (!tab.url || !isSupportedPageUrl(tab.url)) {
    throw new RuntimeError("PERMISSION_DENIED", "The bound tab is not an HTTP or HTTPS page")
  }
  if (tab.url !== boundContext.url) {
    boundContext = { ...boundContext, url: tab.url, epoch: boundContext.epoch + 1 }
    emitTabChanged()
  }
  return { ...boundContext }
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
      args: [operation, request.params, request.confirmed ?? false, trustedLinkTargetUrl],
    })
  } catch (error) {
    throw new RuntimeError(
      "PERMISSION_DENIED",
      error instanceof Error ? error.message : "Chrome denied access to the bound tab",
    )
  }
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
    await chrome.tabs.update(context.tabId, { url: targetUrl.href })
    boundContext = { ...context, url: targetUrl.href, epoch: context.epoch + 1 }
    emitTabChanged()
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
      args: [operation, request.params, request.confirmed ?? false],
    })
  } catch (error) {
    throw new RuntimeError(
      "PERMISSION_DENIED",
      error instanceof Error ? error.message : "Chrome denied WebMCP access",
    )
  }
  const outcome = results[0]?.result
  if (!outcome) throw new RuntimeError("INTERNAL_ERROR", "WebMCP returned no result")
  if (!outcome.ok)
    throw new RuntimeError(outcome.error.code, outcome.error.message, outcome.error.details)
  return outcome.result
}

async function getActiveTab(): Promise<JsonValue> {
  const context = await refreshBoundContext()
  const tab = await chrome.tabs.get(context.tabId)
  return { ...context, active: tab.active, title: tab.title ?? "", windowId: tab.windowId }
}

async function captureVisible(request: RuntimeRequest): Promise<JsonValue> {
  const context = await refreshBoundContext()
  assertTabContext(request.tabContext, context)
  const tab = await chrome.tabs.get(context.tabId)
  if (!tab.active) {
    throw new RuntimeError("INVALID_REQUEST", "The bound tab must be active for a screenshot")
  }
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" })
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
  await chrome.tabs.update(context.tabId, { url: targetUrl.href })
  boundContext = { ...context, url: targetUrl.href, epoch: context.epoch + 1 }
  emitTabChanged()
  return { ...boundContext }
}

async function grantBoundOrigin(): Promise<JsonValue> {
  const context = await refreshBoundContext()
  const pattern = toHostPermissionPattern(context.url)
  const granted = await chrome.permissions.request({ origins: [pattern] })
  return { granted, pattern }
}

async function dispatch(request: RuntimeRequest, signal: AbortSignal): Promise<JsonValue> {
  await initialization
  if (signal.aborted) throw new RuntimeError("REQUEST_CANCELLED", "Browser request was cancelled")
  let result: JsonValue
  switch (request.method) {
    case "app.getState":
      result = { tabContext: boundContext ?? null }
      break
    case "tabs.bindActive":
      result = await bindActiveTab()
      break
    case "tabs.unbind":
      await clearBoundTab()
      result = { unbound: true }
      break
    case "tabs.getActive":
      result = await getActiveTab()
      break
    case "tabs.navigate":
      result = await navigate(request)
      break
    case "permissions.grantBoundOrigin":
      result = await grantBoundOrigin()
      break
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
      id: CONTEXT_MENU_ID,
      title: "Send selection to Pi Chrome",
      contexts: ["selection"],
    })
  })
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (
    !boundContext ||
    tabId !== boundContext.tabId ||
    (!changeInfo.url && changeInfo.status !== "loading")
  )
    return
  boundContext = {
    tabId,
    url: changeInfo.url ?? boundContext.url,
    epoch: boundContext.epoch + 1,
  }
  emitTabChanged()
})

chrome.tabs.onRemoved.addListener((tabId) => {
  if (boundContext?.tabId === tabId) void clearBoundTab()
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (
    info.menuItemId !== CONTEXT_MENU_ID ||
    !info.selectionText ||
    !boundContext ||
    tab?.id !== boundContext.tabId
  )
    return
  const selection = truncateUtf8(info.selectionText)
  emitEvent({
    kind: "event",
    name: "selection.queued",
    payload: {
      text: selection.text,
      source: "context-menu",
      untrusted: true,
      truncated: selection.truncated,
    },
    tabContext: { ...boundContext },
  })
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
