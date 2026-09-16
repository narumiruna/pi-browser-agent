import {
  BridgeError,
  type BridgeMethod,
  isBridgeMethod,
  isPairingSecret,
  type JsonValue,
  type RequestFrame,
  type TabContext,
  truncateUtf8,
} from "../protocol/index.js"
import { BridgeClient } from "./bridge/client.js"
import { RECONNECT_ALARM } from "./bridge/reconnect.js"
import { executePageOperation, type PageOperation } from "./content/page-operations.js"
import { assertTabContext } from "./content/tab-context.js"
import { hasHostPermission } from "./permissions.js"
import {
  clearPairing,
  getBoundTabId,
  getBridgeSettings,
  saveBoundTabId,
  updateBridgeSettings,
} from "./storage.js"
import { executeWebMcpOperation, type WebMcpOperation } from "./webmcp/adapter.js"

const CONTEXT_MENU_ID = "pi-chrome-send-selection"
const MAX_PROMPT_CHARACTERS = 50_000

let boundContext: TabContext | undefined

function truncatePromptText(text: string): string {
  if (text.length <= MAX_PROMPT_CHARACTERS) return text
  const marker = "\n[truncated]"
  return `${text.slice(0, MAX_PROMPT_CHARACTERS - marker.length)}${marker}`
}

async function restoreBoundContext(): Promise<void> {
  const boundTabId = await getBoundTabId()
  if (boundTabId === undefined) return
  try {
    const tab = await chrome.tabs.get(boundTabId)
    if (!tab.url || !isSupportedPageUrl(tab.url)) {
      await clearBoundTab()
      return
    }
    boundContext = { tabId: tab.id as number, url: tab.url, epoch: 0 }
  } catch {
    await clearBoundTab()
  }
}

function isSupportedPageUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === "http:" || protocol === "https:"
  } catch {
    return false
  }
}

async function bindActiveTab(): Promise<TabContext> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tab?.id === undefined || !tab.url || !isSupportedPageUrl(tab.url)) {
    throw new BridgeError(
      "PERMISSION_DENIED",
      "Open an HTTP or HTTPS page before binding the active tab",
    )
  }
  boundContext = { tabId: tab.id, url: tab.url, epoch: 0 }
  await saveBoundTabId(tab.id)
  bridge.sendEvent("tab.changed", {}, boundContext)
  return boundContext
}

async function clearBoundTab(): Promise<void> {
  boundContext = undefined
  await saveBoundTabId(undefined)
}

async function refreshBoundContext(): Promise<TabContext> {
  if (!boundContext) throw new BridgeError("TAB_NOT_BOUND", "Bind a tab from the extension popup")
  let tab: chrome.tabs.Tab
  try {
    tab = await chrome.tabs.get(boundContext.tabId)
  } catch {
    await clearBoundTab()
    throw new BridgeError("TAB_NOT_BOUND", "The bound tab no longer exists")
  }
  if (!tab.url || !isSupportedPageUrl(tab.url)) {
    throw new BridgeError("PERMISSION_DENIED", "The bound tab is not an HTTP or HTTPS page")
  }
  if (tab.url !== boundContext.url) {
    boundContext = { ...boundContext, url: tab.url, epoch: boundContext.epoch + 1 }
    bridge.sendEvent("tab.changed", {}, boundContext)
    sendRuntimeStatus()
  }
  return boundContext
}

async function runPageOperation(
  operation: PageOperation,
  request: RequestFrame,
): Promise<JsonValue> {
  const context = await refreshBoundContext()
  assertTabContext(request.tabContext, context)

  let results: chrome.scripting.InjectionResult<Awaited<ReturnType<typeof executePageOperation>>>[]
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: context.tabId },
      func: executePageOperation,
      args: [operation, request.params, request.confirmed ?? false],
    })
  } catch (error) {
    throw new BridgeError(
      "PERMISSION_DENIED",
      error instanceof Error ? error.message : "Chrome denied access to the bound tab",
    )
  }
  const outcome = results[0]?.result
  if (!outcome) throw new BridgeError("INTERNAL_ERROR", "The page operation returned no result")
  if (!outcome.ok)
    throw new BridgeError(outcome.error.code, outcome.error.message, outcome.error.details)
  return outcome.result
}

async function runWebMcpOperation(
  operation: WebMcpOperation,
  request: RequestFrame,
): Promise<JsonValue> {
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
    throw new BridgeError(
      "PERMISSION_DENIED",
      error instanceof Error ? error.message : "Chrome denied access to WebMCP in the bound tab",
    )
  }
  const outcome = results[0]?.result
  if (!outcome) throw new BridgeError("INTERNAL_ERROR", "The WebMCP operation returned no result")
  if (!outcome.ok)
    throw new BridgeError(outcome.error.code, outcome.error.message, outcome.error.details)
  return outcome.result
}

async function getActiveTab(): Promise<JsonValue> {
  const context = await refreshBoundContext()
  const tab = await chrome.tabs.get(context.tabId)
  return {
    ...context,
    active: tab.active,
    title: tab.title ?? "",
    windowId: tab.windowId,
  }
}

async function captureVisiblePage(request: RequestFrame): Promise<JsonValue> {
  const context = await refreshBoundContext()
  assertTabContext(request.tabContext, context)
  const tab = await chrome.tabs.get(context.tabId)
  if (!tab.active) {
    throw new BridgeError("INVALID_REQUEST", "The bound tab must be active to capture a screenshot")
  }
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" })
  return { dataUrl, mimeType: "image/png", tabContext: { ...context } }
}

async function navigate(request: RequestFrame): Promise<JsonValue> {
  const context = await refreshBoundContext()
  assertTabContext(request.tabContext, context)
  const target = request.params.url
  if (typeof target !== "string" || !isSupportedPageUrl(target)) {
    throw new BridgeError("INVALID_REQUEST", "Navigation requires an HTTP or HTTPS URL")
  }
  const targetUrl = new URL(target)
  const crossesOrigin = targetUrl.origin !== new URL(context.url).origin
  if (crossesOrigin && !request.confirmed) {
    throw new BridgeError(
      "CONFIRMATION_REQUIRED",
      `Navigation crosses origins from ${new URL(context.url).origin} to ${targetUrl.origin}`,
      { action: "navigate", targetUrl: targetUrl.href },
    )
  }
  if (crossesOrigin && !(await hasHostPermission(targetUrl))) {
    throw new BridgeError(
      "PERMISSION_DENIED",
      "Grant persistent access to the destination from the popup before cross-origin navigation",
      { action: "navigate", targetUrl: targetUrl.href },
    )
  }
  await chrome.tabs.update(context.tabId, { url: targetUrl.href })
  boundContext = { tabId: context.tabId, url: targetUrl.href, epoch: context.epoch + 1 }
  bridge.sendEvent("tab.changed", {}, boundContext)
  return { ...boundContext }
}

async function handleBridgeRequest(request: RequestFrame, signal: AbortSignal): Promise<JsonValue> {
  if (signal.aborted) throw new BridgeError("REQUEST_CANCELLED", "Browser request was cancelled")
  if (!isBridgeMethod(request.method)) {
    throw new BridgeError("METHOD_NOT_FOUND", `Unknown bridge method: ${request.method}`)
  }

  let result: JsonValue
  const method: BridgeMethod = request.method
  switch (method) {
    case "browser.getConnectionState":
      result = {
        bridge: bridge.getStatus().state,
        tabContext: boundContext ? { ...boundContext } : null,
      }
      break
    case "tabs.getActive":
      result = await getActiveTab()
      break
    case "tabs.navigate":
      result = await navigate(request)
      break
    case "page.getVisibleText": {
      const pageResult = await runPageOperation("getVisibleText", request)
      if (typeof pageResult === "object" && pageResult !== null && !Array.isArray(pageResult)) {
        const text = pageResult.text
        if (typeof text === "string") {
          const truncated = truncateUtf8(text)
          result = { ...pageResult, ...truncated }
          break
        }
      }
      result = pageResult
      break
    }
    case "page.getSelection":
      result = await runPageOperation("getSelection", request)
      break
    case "page.captureVisible":
      result = await captureVisiblePage(request)
      break
    case "page.click":
      result = await runPageOperation("click", request)
      break
    case "page.type":
      result = await runPageOperation("type", request)
      break
    case "webmcp.listTools":
      result = await runWebMcpOperation("webmcp.listTools", request)
      break
    case "webmcp.callTool":
      result = await runWebMcpOperation("webmcp.callTool", request)
      break
  }

  if (signal.aborted) throw new BridgeError("REQUEST_CANCELLED", "Browser request was cancelled")
  return result
}

const bridge = new BridgeClient(getBridgeSettings, handleBridgeRequest)

function sendRuntimeStatus(): void {
  void chrome.runtime
    .sendMessage({
      type: "bridge.status.changed",
      status: bridge.getStatus(),
      tabContext: boundContext,
    })
    .catch(() => undefined)
}

bridge.onStatus((status) => {
  if (status.state === "authenticated" && boundContext) {
    bridge.sendEvent("tab.changed", {}, boundContext)
  }
  sendRuntimeStatus()
})

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: "Send selection to pi",
      contexts: ["selection"],
    })
  })
  chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 })
})

chrome.runtime.onStartup.addListener(() => {
  void restoreBoundContext().then(() => bridge.start())
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM && bridge.getStatus().state !== "authenticated") {
    void bridge.reconnect()
  }
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (
    !boundContext ||
    tabId !== boundContext.tabId ||
    (changeInfo.status !== "loading" && changeInfo.url === undefined)
  ) {
    return
  }
  boundContext = {
    tabId,
    url: changeInfo.url ?? boundContext.url,
    epoch: boundContext.epoch + 1,
  }
  bridge.sendEvent("tab.changed", {}, boundContext)
  sendRuntimeStatus()
})

chrome.tabs.onRemoved.addListener((tabId) => {
  if (boundContext?.tabId !== tabId) return
  void clearBoundTab().then(sendRuntimeStatus)
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (
    info.menuItemId !== CONTEXT_MENU_ID ||
    !info.selectionText ||
    !boundContext ||
    tab?.id !== boundContext.tabId
  ) {
    return
  }
  bridge.sendEvent("user.prompt", {
    text: truncatePromptText(info.selectionText),
    source: "context-menu",
  })
})

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (typeof message !== "object" || message === null || !("type" in message)) return false
  const typed = message as { type: string; port?: unknown; secret?: unknown }

  void (async () => {
    switch (typed.type) {
      case "bridge.getStatus":
        return { status: bridge.getStatus(), tabContext: boundContext }
      case "bridge.pair": {
        const secret = typeof typed.secret === "string" ? typed.secret.trim() : undefined
        if (!isPairingSecret(secret)) {
          throw new BridgeError("INVALID_REQUEST", "Enter the pairing secret shown by /chrome-pair")
        }
        const port = typeof typed.port === "number" ? typed.port : (await getBridgeSettings()).port
        if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
          throw new BridgeError("INVALID_REQUEST", "Port must be between 1024 and 65535")
        }
        await updateBridgeSettings({ enabled: true, port, secret })
        await bindActiveTab()
        await bridge.reconnect()
        return { status: bridge.getStatus(), tabContext: boundContext }
      }
      case "bridge.bindTab":
        return { tabContext: await bindActiveTab() }
      case "bridge.disconnect":
        bridge.stop()
        await updateBridgeSettings({ enabled: false })
        return { status: bridge.getStatus() }
      case "bridge.revoke": {
        const settings = await getBridgeSettings()
        let serverAcknowledged = false
        let warning: string | undefined
        if (bridge.getStatus().state === "authenticated") {
          try {
            await bridge.revokePairing()
            serverAcknowledged = true
          } catch (error) {
            if (
              !(error instanceof BridgeError) ||
              !["CONNECTION_CLOSED", "NOT_CONNECTED", "REQUEST_TIMEOUT"].includes(error.code)
            ) {
              throw error
            }
          }
        }
        if (!serverAcknowledged) {
          bridge.stop()
          if (settings.secret) {
            warning =
              "Local pairing data was cleared, but pi did not acknowledge revocation. Run /chrome-revoke in pi before pairing again."
          }
        }
        await clearPairing()
        await clearBoundTab()
        if (!serverAcknowledged) await bridge.start()
        return { status: bridge.getStatus(), ...(warning ? { warning } : {}) }
      }
      case "bridge.sendSelection": {
        const selection = await runPageOperation("getSelection", {
          type: "request",
          id: crypto.randomUUID(),
          method: "page.getSelection",
          params: {},
          timeoutMs: 5000,
          ...(boundContext ? { tabContext: boundContext } : {}),
        })
        const text =
          typeof selection === "object" && selection !== null && !Array.isArray(selection)
            ? selection.text
            : undefined
        if (typeof text !== "string" || !text) {
          throw new BridgeError("INVALID_REQUEST", "The bound page has no selected text")
        }
        if (!bridge.sendEvent("user.prompt", { text: truncatePromptText(text), source: "popup" })) {
          throw new BridgeError("NOT_CONNECTED", "Connect to pi before sending a selection")
        }
        return { sent: true }
      }
      default:
        throw new BridgeError("METHOD_NOT_FOUND", `Unknown runtime message: ${typed.type}`)
    }
  })()
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => {
      const bridgeError =
        error instanceof BridgeError ? error : new BridgeError("INTERNAL_ERROR", String(error))
      sendResponse({ ok: false, error: bridgeError.toData() })
    })

  return true
})

void restoreBoundContext().then(() => bridge.start())
