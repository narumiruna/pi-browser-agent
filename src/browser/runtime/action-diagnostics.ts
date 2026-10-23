import type { RuntimeMethod, RuntimeRequest } from "./messages.js"
import type { PageCapability } from "./page-capability.js"
import { type JsonObject, RuntimeError, type TabContext } from "./types.js"

export type MutationOutcome = "not_dispatched" | "dispatched" | "outcome_unknown"
export type ActionStage =
  | "target_resolution"
  | "validation"
  | "confirmation"
  | "dispatch"
  | "completed"

export function isMutationMethod(method: RuntimeMethod): boolean {
  return [
    "page.click",
    "page.type",
    "page.scroll",
    "page.selectOption",
    "page.setChecked",
    "tabs.navigate",
    "webmcp.callTool",
  ].includes(method)
}

export function safeContext(context: TabContext): JsonObject {
  return { tabId: context.tabId, documentEpoch: context.epoch }
}

export function contextUnavailableError(
  kind: PageCapability["kind"],
  state?: string,
): RuntimeError {
  if (state === "permission_denied")
    return new RuntimeError(
      "PERMISSION_DENIED",
      "Chrome denied access to this page. Review site access, then reload the intended tab before a new request.",
    )
  if (state === "unsupported_url" || ["restricted", "file", "pdf"].includes(kind))
    return new RuntimeError(
      "UNSUPPORTED_URL",
      "This page type cannot be read or operated. Select an authorized HTTP(S) web page and start a new request.",
    )
  return new RuntimeError(
    "TAB_NOT_BOUND",
    "No focused page target is available. Focus the intended browser window and select its web tab, then start a new request.",
  )
}

// Construct diagnostics from fixed fields only. Never spread a request, tab, URL, or exception.
export function actionDiagnostics(
  request: RuntimeRequest,
  actionStage: ActionStage,
  contextState: string,
  actual?: TabContext,
  windowId?: number,
): JsonObject {
  return {
    requestId: request.requestId,
    toolName: request.method,
    targetResolutionSource: request.tabContext ? "request_context" : "focused_visible_tab",
    contextState,
    actionStage,
    ...(request.tabContext ? { expected: safeContext(request.tabContext) } : {}),
    ...(actual ? safeContext(actual) : {}),
    ...(windowId === undefined ? {} : { windowId }),
  }
}
