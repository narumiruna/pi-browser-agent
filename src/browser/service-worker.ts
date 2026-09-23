import { getRecentBookmarks, searchBookmarks } from "./bookmarks.js"
import {
  type ElementPickerOperationResult,
  executeElementPicker,
  stopElementPickerInjection,
} from "./content/element-picker.js"
import { executePageOperation, type PageOperation } from "./content/page-operations.js"
import { assertTabContext } from "./content/tab-context.js"
import {
  BOOKMARKS_PERMISSION,
  hasBookmarkPermission,
  hasHostPermission,
  hasScreenshotPermission,
  SCREENSHOT_HOST_PERMISSION,
} from "./permissions.js"
import { ELEMENT_PICKER_LIMITS, parseSelectedElementContext } from "./runtime/element-context.js"
import { parseRuntimeRequest, type RuntimeEvent, type RuntimeRequest } from "./runtime/messages.js"
import { classifyPage, type PageCapability } from "./runtime/page-capability.js"
import {
  ELEMENT_LIMITS,
  type ElementSnapshot,
  type JsonValue,
  RuntimeError,
  type TabContext,
  truncateUtf8,
} from "./runtime/types.js"
import {
  restrictLocalStorageToTrustedContexts,
  savePendingSelection,
  takePendingSelection,
} from "./storage.js"
import { executeWebMcpOperation, type WebMcpOperation } from "./webmcp/adapter.js"

const SELECTION_CONTEXT_MENU_ID = "pi-browser-agent-send-selection"
const VISIBLE_TAB_FOCUS_RETRY_ATTEMPTS = 5
const VISIBLE_TAB_FOCUS_RETRY_MS = 50
const activeRequests = new Map<string, AbortController>()
let boundContext: TabContext | undefined
let visiblePage: PageCapability = { kind: "none", title: "" }
let inaccessibleTab: { id: number; url: string } | undefined
let observedTab: { id: number; url?: string } | undefined
let elementSnapshot: ElementSnapshot | undefined
let activeElementPicker:
  | { clientId: string; context: TabContext; expiresAt: number; token: string }
  | undefined
let elementPickerOperationVersion = 0
let contextEpoch = 0
let visibleTabSyncVersion = 0
let latestVisibleTabSync: { version: number; promise: Promise<TabContext | undefined> } | undefined
let pendingSelectionTake: Promise<JsonValue> = Promise.resolve(null)
const initialization = initialize()

function isSupportedPageUrl(value: string): boolean {
  return classifyPage(value).kind === "web"
}

function setVisiblePage(page: PageCapability): void {
  if (visiblePage.kind === page.kind && visiblePage.title === page.title) return
  visiblePage = page
  emitTabChanged()
}

function markTabInaccessible(context: TabContext): void {
  inaccessibleTab = { id: context.tabId, url: context.url }
  clearBoundTab({ kind: "restricted", title: visiblePage.title })
}

function emitEvent(event: RuntimeEvent): void {
  void chrome.runtime.sendMessage(event).catch(() => undefined)
}

function emitTabChanged(): void {
  emitEvent({ kind: "event", name: "tab.changed", payload: {}, tabContext: boundContext })
}

async function notifyInjectedElementPickerToStop(context: TabContext): Promise<void> {
  if (typeof chrome.tabs.sendMessage !== "function") return
  await chrome.tabs
    .sendMessage(context.tabId, { kind: "element-picker-stop" }, { frameId: 0 })
    .catch(() => undefined)
}

async function stopInjectedElementPicker(context: TabContext): Promise<void> {
  await notifyInjectedElementPickerToStop(context)
  await chrome.scripting
    .executeScript({
      target: { tabId: context.tabId },
      func: stopElementPickerInjection,
      world: "ISOLATED",
      args: [],
    })
    .catch(() => undefined)
}

async function stopActiveElementPicker(reason: string, emit = true): Promise<void> {
  const picker = activeElementPicker
  activeElementPicker = undefined
  if (picker) await stopInjectedElementPicker(picker.context)
  if (emit) {
    emitEvent({
      kind: "event",
      name: "elementPicker.cancelled",
      payload: { reason, ...(picker ? { clientId: picker.clientId } : {}) },
      ...(picker ? { tabContext: picker.context } : {}),
    })
  }
}

function clearBoundTab(page: PageCapability = { kind: "none", title: "" }): void {
  elementPickerOperationVersion += 1
  if (activeElementPicker) void stopActiveElementPicker("tab-context-cleared")
  if (boundContext) {
    contextEpoch = Math.max(contextEpoch, boundContext.epoch) + 1
    boundContext = undefined
    elementSnapshot = undefined
    emitTabChanged()
  }
  setVisiblePage(page)
}

function setBoundTab(tab: chrome.tabs.Tab | undefined): TabContext | undefined {
  const observedChanged = observedTab?.id !== tab?.id || observedTab?.url !== tab?.url
  observedTab = tab?.id === undefined ? undefined : { id: tab.id, url: tab.url }
  if (inaccessibleTab && (inaccessibleTab.id !== tab?.id || inaccessibleTab.url !== tab.url)) {
    inaccessibleTab = undefined
  }
  const page = classifyPage(tab?.url, tab?.title)
  if (tab?.id === undefined || !tab.url || page.kind !== "web" || inaccessibleTab) {
    clearBoundTab(inaccessibleTab ? { kind: "restricted", title: page.title } : page)
    if (observedChanged) emitTabChanged()
    return undefined
  }
  if (boundContext?.tabId === tab.id && boundContext.url === tab.url) {
    setVisiblePage(page)
    return { ...boundContext }
  }
  elementPickerOperationVersion += 1
  if (activeElementPicker) void stopActiveElementPicker("tab-changed")
  if (boundContext) contextEpoch = Math.max(contextEpoch, boundContext.epoch) + 1
  elementSnapshot = undefined
  boundContext = { tabId: tab.id, url: tab.url, epoch: contextEpoch }
  visiblePage = page
  emitTabChanged()
  return { ...boundContext }
}

function currentBoundContext(): TabContext | undefined {
  return boundContext ? { ...boundContext } : undefined
}

function sameTab(left: chrome.tabs.Tab | undefined, right: chrome.tabs.Tab | undefined): boolean {
  return left?.id === right?.id && left?.url === right?.url && left?.windowId === right?.windowId
}

async function latestVisibleTabContext(version: number): Promise<TabContext | undefined> {
  const latest = latestVisibleTabSync
  return latest && latest.version > version ? latest.promise : currentBoundContext()
}

async function findFocusedVisibleTab(version: number): Promise<chrome.tabs.Tab | undefined | null> {
  let focusAttempts = 0
  while (version === visibleTabSyncVersion) {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (version !== visibleTabSyncVersion) return null
    if (tab?.id === undefined) return undefined

    const window = await chrome.windows.get(tab.windowId)
    if (version !== visibleTabSyncVersion) return null
    const [latestTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (version !== visibleTabSyncVersion) return null
    if (!sameTab(tab, latestTab)) continue
    if (window.focused) return latestTab
    focusAttempts += 1
    if (focusAttempts >= VISIBLE_TAB_FOCUS_RETRY_ATTEMPTS) return undefined
    await new Promise((resolve) => setTimeout(resolve, VISIBLE_TAB_FOCUS_RETRY_MS))
  }
  return null
}

async function finishVisibleTabSync(
  version: number,
  updatedTabId?: number,
): Promise<TabContext | undefined> {
  const previous = boundContext
  const tab = await findFocusedVisibleTab(version)
  if (tab === null || version !== visibleTabSyncVersion) {
    return latestVisibleTabContext(version)
  }

  const context = setBoundTab(tab)
  if (
    context &&
    tab?.id === updatedTabId &&
    previous?.tabId === context.tabId &&
    previous.url === context.url &&
    previous.epoch === context.epoch
  ) {
    contextEpoch = Math.max(contextEpoch, context.epoch) + 1
    elementSnapshot = undefined
    boundContext = { ...context, epoch: contextEpoch }
    emitTabChanged()
    return { ...boundContext }
  }
  return context
}

function syncVisibleTab(updatedTabId?: number): Promise<TabContext | undefined> {
  const version = ++visibleTabSyncVersion
  const promise = finishVisibleTabSync(version, updatedTabId)
  latestVisibleTabSync = { version, promise }
  return promise
}

async function syncUpdatedVisibleTab(updatedTabId: number): Promise<void> {
  await syncVisibleTab(updatedTabId)
}

async function initialize(): Promise<void> {
  await restrictLocalStorageToTrustedContexts()
  const context = await syncVisibleTab()
  if (context) await notifyInjectedElementPickerToStop(context)
}

function bindSelectionTab(tab: chrome.tabs.Tab | undefined): TabContext {
  visibleTabSyncVersion += 1
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

function mutationTargetContext(message: unknown): TabContext | undefined {
  if (
    typeof message !== "object" ||
    message === null ||
    !("kind" in message) ||
    message.kind !== "assert-current-mutation-target" ||
    !("tabContext" in message)
  ) {
    return undefined
  }
  const context = message.tabContext
  return typeof context === "object" &&
    context !== null &&
    "tabId" in context &&
    typeof context.tabId === "number" &&
    "url" in context &&
    typeof context.url === "string" &&
    "epoch" in context &&
    typeof context.epoch === "number"
    ? (context as TabContext)
    : undefined
}

async function assertCurrentMutationTarget(
  expected: TabContext,
  sender: chrome.runtime.MessageSender,
  requestId?: unknown,
  snapshotId?: unknown,
): Promise<void> {
  if (sender.id !== chrome.runtime.id || sender.tab?.id !== expected.tabId) {
    throw new RuntimeError("PERMISSION_DENIED", "Invalid browser mutation target assertion")
  }
  const current = await syncVisibleTab()
  if (!current) throwStaleContext(expected)
  assertTabContext(expected, current)
  const tab = await chrome.tabs.get(current.tabId)
  const window = await chrome.windows.get(tab.windowId)
  if (!(await hasHostPermission(expected.url)))
    throw new RuntimeError("PERMISSION_DENIED", "Current site access was revoked")
  const latest = await syncVisibleTab()
  if (!latest) throwStaleContext(expected)
  assertTabContext(expected, latest)
  if (
    typeof requestId === "string" &&
    (!activeRequests.has(requestId) || activeRequests.get(requestId)?.signal.aborted)
  ) {
    throw new RuntimeError("REQUEST_CANCELLED", "Browser request was cancelled")
  }
  if (
    snapshotId !== undefined &&
    (!elementSnapshot ||
      snapshotId !== elementSnapshot.id ||
      Date.now() >= elementSnapshot.expiresAt)
  ) {
    throw new RuntimeError("STALE_CONTEXT", "Element snapshot expired; discover again")
  }
  if (!tab.active || !window.focused || sender.tab.windowId !== tab.windowId) {
    throw new RuntimeError(
      "STALE_CONTEXT",
      "The target tab is no longer active in the focused browser window",
      { expected, actual: latest },
    )
  }
}

function readDocumentContentType(): string {
  return document.contentType
}

async function assertReadableDocument(context: TabContext): Promise<void> {
  let contentType: string | undefined
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: context.tabId },
      world: "ISOLATED",
      func: readDocumentContentType,
    })
    contentType = results[0]?.result
  } catch (error) {
    const latest = await syncVisibleTab()
    if (
      !latest ||
      latest.tabId !== context.tabId ||
      latest.url !== context.url ||
      latest.epoch !== context.epoch
    ) {
      throwStaleContext(context, latest)
    }
    markTabInaccessible(context)
    throw new RuntimeError(
      "PERMISSION_DENIED",
      error instanceof Error ? error.message : "Chrome denied access to the current tab",
    )
  }
  const latest = await syncVisibleTab()
  if (
    !latest ||
    latest.tabId !== context.tabId ||
    latest.url !== context.url ||
    latest.epoch !== context.epoch
  ) {
    throwStaleContext(context, latest)
  }
  if (
    typeof contentType !== "string" ||
    !contentType ||
    contentType.toLowerCase() === "application/pdf"
  ) {
    markTabInaccessible(context)
    throw new RuntimeError("PERMISSION_DENIED", "This page cannot be read or operated")
  }
}

async function runPageOperation(
  operation: PageOperation,
  request: RuntimeRequest<
    "page.getVisibleText" | "page.getSelection" | "page.listElements" | "page.click" | "page.type"
  >,
  trustedLinkTargetUrl: string | null = null,
): Promise<JsonValue> {
  const context = await refreshBoundContext()
  assertTabContext(request.tabContext, context)
  if (!(await hasHostPermission(context.url))) {
    throw new RuntimeError(
      "PERMISSION_DENIED",
      "Grant access to the current site before using page tools",
    )
  }
  if (activeRequests.get(request.requestId)?.signal.aborted)
    throw new RuntimeError("REQUEST_CANCELLED", "Browser request was cancelled")
  await assertReadableDocument(context)
  let snapshot: ElementSnapshot | null = null
  if (operation === "listElements") {
    snapshot = {
      id: crypto.randomUUID(),
      expiresAt: Date.now() + ELEMENT_LIMITS.lifetimeMs,
      context,
      limits: ELEMENT_LIMITS,
    }
    elementSnapshot = snapshot
  } else if ("snapshotId" in request.params) {
    snapshot = elementSnapshot ?? null
    if (
      !snapshot ||
      snapshot.id !== request.params.snapshotId ||
      Date.now() >= snapshot.expiresAt
    ) {
      throw new RuntimeError(
        "STALE_CONTEXT",
        "Element reference expired; call browser_list_elements again",
      )
    }
    assertTabContext(snapshot.context, context)
  }
  let results: chrome.scripting.InjectionResult<Awaited<ReturnType<typeof executePageOperation>>>[]
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: context.tabId },
      func: executePageOperation,
      world: "ISOLATED",
      args: [
        operation,
        request.params,
        request.confirmed ?? false,
        trustedLinkTargetUrl,
        context,
        snapshot,
        request.requestId,
      ],
    })
  } catch (error) {
    const latest = await syncVisibleTab()
    if (
      !latest ||
      latest.tabId !== context.tabId ||
      latest.url !== context.url ||
      latest.epoch !== context.epoch
    ) {
      throwStaleContext(context, latest)
    }
    markTabInaccessible(context)
    throw new RuntimeError(
      "PERMISSION_DENIED",
      error instanceof Error ? error.message : "Chrome denied access to the current tab",
    )
  }
  const outcome = results[0]?.result
  if (!outcome) throw new RuntimeError("INTERNAL_ERROR", "The page operation returned no result")
  if (!outcome.ok) {
    await revalidateRequestContext(request, context)
    throw new RuntimeError(outcome.error.code, outcome.error.message, outcome.error.details)
  }
  const navigationPending =
    operation === "click" &&
    typeof outcome.result === "object" &&
    outcome.result !== null &&
    !Array.isArray(outcome.result) &&
    outcome.result.navigationAllowed === true
  // A successful injected mutation may itself invalidate its snapshot by navigating. Preserve
  // that outcome; reads and navigation not yet performed still require a current snapshot.
  if ((operation !== "click" && operation !== "type") || navigationPending) {
    await revalidateRequestContext(request, context)
    if (snapshot && snapshot !== elementSnapshot) throwStaleContext(context)
  }
  return outcome.result
}

async function runClick(request: RuntimeRequest<"page.click">): Promise<JsonValue> {
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

async function runWebMcp(
  operation: WebMcpOperation,
  request: RuntimeRequest<"webmcp.listTools" | "webmcp.callTool">,
): Promise<JsonValue> {
  const context = await refreshBoundContext()
  assertTabContext(request.tabContext, context)
  if (!(await hasHostPermission(context.url))) {
    throw new RuntimeError(
      "PERMISSION_DENIED",
      "Grant access to the current site before using WebMCP",
    )
  }
  await assertReadableDocument(context)
  let results: chrome.scripting.InjectionResult<
    Awaited<ReturnType<typeof executeWebMcpOperation>>
  >[]
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: context.tabId },
      func: executeWebMcpOperation,
      args: [operation, request.params, request.confirmed ?? false, context],
    })
  } catch (error) {
    const latest = await syncVisibleTab()
    if (
      !latest ||
      latest.tabId !== context.tabId ||
      latest.url !== context.url ||
      latest.epoch !== context.epoch
    ) {
      throwStaleContext(context, latest)
    }
    markTabInaccessible(context)
    throw new RuntimeError(
      "PERMISSION_DENIED",
      error instanceof Error ? error.message : "Chrome denied WebMCP access",
    )
  }
  const outcome = results[0]?.result
  if (!outcome) throw new RuntimeError("INTERNAL_ERROR", "WebMCP returned no result")
  if (!outcome.ok) {
    await revalidateRequestContext(request, context)
    throw new RuntimeError(outcome.error.code, outcome.error.message, outcome.error.details)
  }
  if (operation === "webmcp.listTools") {
    await revalidateRequestContext(request, context)
  }
  return outcome.result
}

async function getActiveTab(request: RuntimeRequest<"tabs.getActive">): Promise<JsonValue> {
  const context = await refreshBoundContext()
  assertTabContext(request.tabContext, context)
  if (!(await hasHostPermission(context.url))) {
    throw new RuntimeError(
      "PERMISSION_DENIED",
      "Grant access to the current site before reading tab metadata",
    )
  }
  await assertReadableDocument(context)
  const tab = await chrome.tabs.get(context.tabId)
  await revalidateRequestContext(request, context)
  return { ...context, active: tab.active, title: tab.title ?? "", windowId: tab.windowId }
}

async function captureVisible(request: RuntimeRequest<"page.captureVisible">): Promise<JsonValue> {
  const context = await refreshBoundContext()
  assertTabContext(request.tabContext, context)
  const permissionGranted = await hasScreenshotPermission().catch(() => false)
  if (!permissionGranted && !request.confirmed) {
    throw new RuntimeError(
      "CONFIRMATION_REQUIRED",
      "Allow screenshots of visible HTTP(S) tabs? Chrome grants access to all sites, but Pi Browser Agent captures only the current visible viewport and separately limits ordinary access to exact origins approved through explicit actions. Screenshots are sent to the selected model provider and saved in this session.",
      { requiredPermission: SCREENSHOT_HOST_PERMISSION },
    )
  }
  if (!permissionGranted) {
    throw new RuntimeError("PERMISSION_DENIED", "Chrome screenshot access is not granted")
  }
  const tab = await chrome.tabs.get(context.tabId)
  if (!tab.active) {
    throw new RuntimeError("INVALID_REQUEST", "The current tab must remain active for a screenshot")
  }
  await assertReadableDocument(context)
  await revalidateRequestContext(request, context)
  let dataUrl: string
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" })
  } catch (error) {
    throw new RuntimeError(
      "INTERNAL_ERROR",
      error instanceof Error ? error.message : "Chrome could not capture the visible tab",
    )
  }
  await revalidateRequestContext(request, context)
  if (dataUrl.length > 3_000_000) {
    throw new RuntimeError("INVALID_REQUEST", "Screenshot exceeds the 3 MB extension limit")
  }
  return { dataUrl, mimeType: "image/png", tabContext: context }
}

async function runBookmarkRead(
  request: RuntimeRequest<"bookmarks.search" | "bookmarks.getRecent">,
): Promise<JsonValue> {
  const permissionGranted = await hasBookmarkPermission().catch(() => false)
  const limit = request.params.limit
  const operation = request.method === "bookmarks.search" ? "search" : "getRecent"
  if (!request.confirmed) {
    const details: Record<string, JsonValue> = { limit, operation }
    if (!permissionGranted) details.requiredPermission = BOOKMARKS_PERMISSION
    if (request.method === "bookmarks.search") {
      details.query = request.params.query
    }
    const subject = operation === "search" ? "matching" : "recent"
    throw new RuntimeError(
      "CONFIRMATION_REQUIRED",
      `Read ${subject} Chrome bookmark titles and URLs? Results will be sent to the selected model provider and saved in this session.`,
      details,
    )
  }
  if (!permissionGranted) {
    throw new RuntimeError("PERMISSION_DENIED", "Chrome bookmark access is not granted")
  }
  if (request.method === "bookmarks.getRecent") return getRecentBookmarks(limit)
  return searchBookmarks(request.params.query, limit)
}

async function navigate(request: RuntimeRequest<"tabs.navigate">): Promise<JsonValue> {
  const context = await refreshBoundContext()
  assertTabContext(request.tabContext, context)
  if (!(await hasHostPermission(context.url))) {
    throw new RuntimeError(
      "PERMISSION_DENIED",
      "Grant access to the current site before navigating",
    )
  }
  await assertReadableDocument(context)
  const target = request.params.url
  if (!isSupportedPageUrl(target)) {
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
  if (!(await hasHostPermission(targetUrl))) {
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

function elementPickerPageUrl(value: string): string {
  const url = new URL(value)
  url.username = ""
  url.password = ""
  if (url.href.length > ELEMENT_PICKER_LIMITS.pageUrl) {
    throw new RuntimeError("INVALID_REQUEST", "Current page URL exceeds the element picker limit")
  }
  return url.href
}

async function startElementPicker(
  request: RuntimeRequest<"elementPicker.start">,
): Promise<JsonValue> {
  const operationVersion = ++elementPickerOperationVersion
  const context = await refreshBoundContext()
  if (operationVersion !== elementPickerOperationVersion) return { active: false }
  assertTabContext(request.tabContext, context)
  elementPickerPageUrl(context.url)
  if (!(await hasHostPermission(context.url))) {
    throw new RuntimeError(
      "PERMISSION_DENIED",
      "Grant access to the current site before selecting an element",
    )
  }
  if (operationVersion !== elementPickerOperationVersion) return { active: false }
  await assertReadableDocument(context)
  if (operationVersion !== elementPickerOperationVersion) return { active: false }
  if (activeElementPicker) await stopActiveElementPicker("replaced")
  if (operationVersion !== elementPickerOperationVersion) return { active: false }
  const token = crypto.randomUUID()
  activeElementPicker = {
    clientId: request.params.clientId,
    context,
    token,
    expiresAt: Date.now() + ELEMENT_PICKER_LIMITS.lifetimeMs,
  }
  let injectionFailed = false
  try {
    let results: chrome.scripting.InjectionResult<ElementPickerOperationResult>[]
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId: context.tabId },
        func: executeElementPicker,
        world: "ISOLATED",
        args: ["start", token, context, ELEMENT_PICKER_LIMITS],
      })
    } catch (error) {
      injectionFailed = true
      if (activeElementPicker?.token === token) activeElementPicker = undefined
      const latest = await syncVisibleTab()
      if (
        !latest ||
        latest.tabId !== context.tabId ||
        latest.url !== context.url ||
        latest.epoch !== context.epoch
      ) {
        throwStaleContext(context, latest)
      }
      markTabInaccessible(context)
      throw new RuntimeError(
        "PERMISSION_DENIED",
        error instanceof Error ? error.message : "Chrome denied access to the current tab",
      )
    }
    const outcome = results[0]?.result
    if (!outcome?.ok || outcome.result.started !== true) {
      throw new RuntimeError("STALE_CONTEXT", "The page changed before the element picker started")
    }
    await revalidateRequestContext(request, context)
    const active = activeElementPicker?.token === token
    if (active) {
      emitEvent({
        kind: "event",
        name: "elementPicker.started",
        payload: { active: true, clientId: request.params.clientId },
        tabContext: context,
      })
    }
    return { active, clientId: request.params.clientId }
  } catch (error) {
    if (activeElementPicker?.token === token) activeElementPicker = undefined
    if (!injectionFailed) await stopInjectedElementPicker(context)
    if (error instanceof RuntimeError) throw error
    throw new RuntimeError(
      "PERMISSION_DENIED",
      error instanceof Error ? error.message : "Chrome denied access to the current tab",
    )
  }
}

async function stopElementPicker(
  request: RuntimeRequest<"elementPicker.stop">,
): Promise<JsonValue> {
  elementPickerOperationVersion += 1
  const picker = activeElementPicker
  if (picker) {
    await stopActiveElementPicker("user")
    return { active: false }
  }
  const context = await syncVisibleTab()
  if (context) {
    if (request.tabContext) assertTabContext(request.tabContext, context)
    await stopInjectedElementPicker(context)
  }
  emitEvent({
    kind: "event",
    name: "elementPicker.cancelled",
    payload: { reason: "user" },
    ...(context ? { tabContext: context } : {}),
  })
  return { active: false }
}

async function dispatch(request: RuntimeRequest, signal: AbortSignal): Promise<JsonValue> {
  await initialization
  if (signal.aborted) throw new RuntimeError("REQUEST_CANCELLED", "Browser request was cancelled")
  let result: JsonValue
  switch (request.method) {
    case "app.getState":
      result = { tabContext: (await syncVisibleTab()) ?? null, page: { ...visiblePage } }
      break
    case "tabs.getActive":
      result = await getActiveTab(request)
      break
    case "tabs.navigate":
      result = await navigate(request)
      break
    case "bookmarks.search":
    case "bookmarks.getRecent":
      result = truncateStructuredResult(await runBookmarkRead(request))
      break
    case "selection.takePending":
      result = await consumePendingSelection(request.params.windowId)
      break
    case "elementPicker.start":
      result = await startElementPicker(request)
      break
    case "elementPicker.stop":
      result = await stopElementPicker(request)
      break
    case "requests.cancel":
      activeRequests.get(request.params.requestId)?.abort()
      result = { cancelled: true }
      break
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
    case "page.listElements":
      result = await runPageOperation("listElements", request)
      break
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
    default: {
      const unhandled: never = request
      throw new Error(`Unhandled runtime request: ${unhandled}`)
    }
  }
  if (signal.aborted) throw new RuntimeError("REQUEST_CANCELLED", "Browser request was cancelled")
  return result
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: SELECTION_CONTEXT_MENU_ID,
      title: "Send selection to Pi Browser Agent",
      contexts: ["selection"],
    })
  })
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const navigation = Boolean(changeInfo.url) || changeInfo.status === "loading"
  if (!navigation) {
    if (changeInfo.title !== undefined) {
      // A title-only update changes the UI label, not the page or its references.
      void initialization.then(() => syncVisibleTab()).catch(() => undefined)
    }
    return
  }
  if (changeInfo.status === "loading" && inaccessibleTab?.id === tabId) inaccessibleTab = undefined
  elementPickerOperationVersion += 1
  if (activeElementPicker?.context.tabId === tabId) void stopActiveElementPicker("navigation")
  if (boundContext?.tabId === tabId) elementSnapshot = undefined
  void initialization.then(() => syncUpdatedVisibleTab(tabId)).catch(() => undefined)
})

chrome.tabs.onActivated.addListener(() => {
  elementPickerOperationVersion += 1
  if (activeElementPicker) void stopActiveElementPicker("tab-activated")
  elementSnapshot = undefined
  void initialization.then(() => syncVisibleTab()).catch(() => undefined)
})

chrome.tabs.onRemoved.addListener((tabId) => {
  if (boundContext?.tabId === tabId) {
    clearBoundTab()
    void initialization.then(() => syncVisibleTab()).catch(() => undefined)
  }
})

chrome.windows.onFocusChanged.addListener((windowId) => {
  elementPickerOperationVersion += 1
  if (activeElementPicker) void stopActiveElementPicker("window-focus-changed")
  elementSnapshot = undefined
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    clearBoundTab()
    // Register recovery immediately so in-flight lookups await the focus handoff.
    void syncVisibleTab().catch(() => undefined)
    return
  }
  void initialization.then(() => syncVisibleTab()).catch(() => undefined)
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
      // The context menu provides selection text even when the URL masks an unreadable PDF.
      await assertReadableDocument(context)
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

function isElementPickerResultMessage(message: unknown): message is {
  element?: unknown
  kind: "element-picker-result"
  reason?: string
  status: "cancelled" | "selected"
  tabContext: TabContext
  token: string
} {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return false
  const value = message as Record<string, unknown>
  if (
    value.kind !== "element-picker-result" ||
    typeof value.token !== "string" ||
    !/^[a-f0-9-]{36}$/.test(value.token) ||
    (value.status !== "cancelled" && value.status !== "selected") ||
    typeof value.tabContext !== "object" ||
    value.tabContext === null ||
    Array.isArray(value.tabContext) ||
    (value.reason !== undefined && (typeof value.reason !== "string" || value.reason.length > 128))
  ) {
    return false
  }
  const context = value.tabContext as Record<string, unknown>
  if (
    Object.keys(context).length !== 3 ||
    !Object.keys(context).every((key) => ["epoch", "tabId", "url"].includes(key)) ||
    !Number.isSafeInteger(context.tabId) ||
    (context.tabId as number) < 0 ||
    !Number.isSafeInteger(context.epoch) ||
    (context.epoch as number) < 0 ||
    typeof context.url !== "string" ||
    context.url.length === 0 ||
    context.url.length > 16_384
  ) {
    return false
  }
  const allowedKeys =
    value.status === "selected"
      ? ["element", "kind", "status", "tabContext", "token"]
      : ["kind", "reason", "status", "tabContext", "token"]
  return (
    Object.keys(value).every((key) => allowedKeys.includes(key)) &&
    (value.status !== "selected" || "element" in value)
  )
}

async function acceptElementPickerResult(
  message: {
    element?: unknown
    reason?: string
    status: "cancelled" | "selected"
    tabContext: TabContext
    token: string
  },
  sender: chrome.runtime.MessageSender,
): Promise<JsonValue> {
  const picker = activeElementPicker
  if (
    !picker ||
    sender.id !== chrome.runtime.id ||
    sender.tab?.id !== picker.context.tabId ||
    sender.frameId !== 0 ||
    message.token !== picker.token
  ) {
    throw new RuntimeError("PERMISSION_DENIED", "Invalid or expired element picker result")
  }
  assertTabContext(message.tabContext, picker.context)
  if (Date.now() >= picker.expiresAt) {
    activeElementPicker = undefined
    emitEvent({
      kind: "event",
      name: "elementPicker.cancelled",
      payload: { reason: "timeout", clientId: picker.clientId },
      tabContext: picker.context,
    })
    if (message.status === "cancelled" && message.reason === "timeout") {
      return { accepted: true }
    }
    throw new RuntimeError("PERMISSION_DENIED", "Invalid or expired element picker result")
  }
  if (message.status === "cancelled") {
    activeElementPicker = undefined
    emitEvent({
      kind: "event",
      name: "elementPicker.cancelled",
      payload: {
        reason: (message.reason ?? "page").slice(0, 128),
        clientId: picker.clientId,
      },
      tabContext: picker.context,
    })
    return { accepted: true }
  }

  activeElementPicker = undefined
  try {
    const current = await syncVisibleTab()
    if (!current) throwStaleContext(picker.context)
    assertTabContext(picker.context, current)
    if (!(await hasHostPermission(picker.context.url))) {
      throw new RuntimeError("PERMISSION_DENIED", "Current site access was revoked")
    }
    const element = parseSelectedElementContext(message.element)
    if (element.pageUrl !== elementPickerPageUrl(picker.context.url)) {
      throw new RuntimeError("STALE_CONTEXT", "The selected element came from a different page")
    }
    emitEvent({
      kind: "event",
      name: "elementPicker.selected",
      payload: { element, clientId: picker.clientId },
      tabContext: picker.context,
    })
    return { accepted: true }
  } catch (error) {
    emitEvent({
      kind: "event",
      name: "elementPicker.cancelled",
      payload: {
        reason:
          error instanceof RuntimeError && error.code === "PERMISSION_DENIED"
            ? "access-revoked"
            : "invalid-result",
        clientId: picker.clientId,
      },
      tabContext: picker.context,
    })
    throw error
  }
}

chrome.permissions.onRemoved?.addListener(() => {
  const picker = activeElementPicker
  if (!picker) return
  void hasHostPermission(picker.context.url)
    .then((allowed) => {
      if (!allowed && activeElementPicker?.token === picker.token) {
        elementPickerOperationVersion += 1
        return stopActiveElementPicker("access-revoked")
      }
    })
    .catch(() => undefined)
})

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (
    typeof message === "object" &&
    message !== null &&
    "kind" in message &&
    message.kind === "element-picker-result"
  ) {
    if (!isElementPickerResultMessage(message)) {
      sendResponse({
        ok: false,
        error: new RuntimeError("INVALID_REQUEST", "Malformed element picker result").toData(),
      })
      return false
    }
    void acceptElementPickerResult(message, sender)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => {
        const runtimeError =
          error instanceof RuntimeError ? error : new RuntimeError("INVALID_REQUEST", String(error))
        sendResponse({ ok: false, error: runtimeError.toData() })
      })
    return true
  }
  const mutationContext = mutationTargetContext(message)
  if (mutationContext) {
    void assertCurrentMutationTarget(
      mutationContext,
      sender,
      (message as { requestId?: unknown }).requestId,
      (message as { snapshotId?: unknown }).snapshotId,
    )
      .then(() => sendResponse({ ok: true, result: { current: true } }))
      .catch((error) => {
        const runtimeError =
          error instanceof RuntimeError ? error : new RuntimeError("INTERNAL_ERROR", String(error))
        sendResponse({ ok: false, error: runtimeError.toData() })
      })
    return true
  }
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
  const reportsProgress = ![
    "elementPicker.start",
    "elementPicker.stop",
    "requests.cancel",
  ].includes(request.method)
  if (request.method !== "requests.cancel") {
    activeRequests.set(request.requestId, controller)
    if (reportsProgress) {
      emitEvent({
        kind: "event",
        name: "operation.progress",
        payload: { method: request.method, requestId: request.requestId, status: "started" },
      })
    }
  }
  void dispatch(request, controller.signal)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => {
      const runtimeError =
        error instanceof RuntimeError ? error : new RuntimeError("INTERNAL_ERROR", String(error))
      sendResponse({ ok: false, error: runtimeError.toData() })
    })
    .finally(() => {
      if (activeRequests.delete(request.requestId) && reportsProgress) {
        emitEvent({
          kind: "event",
          name: "operation.progress",
          payload: { method: request.method, requestId: request.requestId, status: "finished" },
        })
      }
    })
  return true
})
