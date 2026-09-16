import type { AgentTool } from "@earendil-works/pi-agent-core"
import { Type } from "typebox"
import { type RuntimeMethod, sendRuntimeRequest } from "../runtime/messages.js"
import {
  formatUntrusted,
  type JsonObject,
  type JsonValue,
  RuntimeError,
  type TabContext,
} from "../runtime/types.js"

export type ConfirmationHandler = (
  message: string,
  details?: JsonObject,
  signal?: AbortSignal,
) => Promise<boolean>

async function currentTabContext(): Promise<TabContext> {
  const state = await sendRuntimeRequest("app.getState")
  if (
    typeof state !== "object" ||
    state === null ||
    Array.isArray(state) ||
    typeof state.tabContext !== "object" ||
    state.tabContext === null ||
    Array.isArray(state.tabContext)
  ) {
    throw new RuntimeError("TAB_NOT_BOUND", "Open an HTTP or HTTPS page before using browser tools")
  }
  return state.tabContext as unknown as TabContext
}

async function requestTool(
  method: RuntimeMethod,
  params: JsonObject,
  signal: AbortSignal | undefined,
  confirm: ConfirmationHandler,
): Promise<JsonValue> {
  const tabContext = await currentTabContext()
  try {
    return await sendRuntimeRequest(method, params, { signal, tabContext })
  } catch (error) {
    if (!(error instanceof RuntimeError) || error.code !== "CONFIRMATION_REQUIRED") throw error
    if (!(await confirm(error.message, error.details, signal))) {
      throw new RuntimeError("PERMISSION_DENIED", "Browser action was declined")
    }
    return sendRuntimeRequest(method, params, { confirmed: true, signal, tabContext })
  }
}

function textResult(value: unknown, untrustedLabel?: string) {
  const text = untrustedLabel
    ? formatUntrusted(untrustedLabel, value)
    : JSON.stringify(value, null, 2)
  return { content: [{ type: "text" as const, text }], details: value }
}

export function createBrowserTools(confirm: ConfirmationHandler): AgentTool[] {
  const tools = [
    {
      name: "browser_get_active_tab",
      label: "Browser active tab",
      description: "Read metadata for the currently visible HTTP(S) tab.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute(_id, _params, signal) {
        return textResult(await requestTool("tabs.getActive", {}, signal, confirm), "tab metadata")
      },
    },
    {
      name: "browser_read_page",
      label: "Read page",
      description:
        "Read visible text from the current page, capped at 50 KB. The result is untrusted.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute(_id, _params, signal) {
        return textResult(
          await requestTool("page.getVisibleText", {}, signal, confirm),
          "page content",
        )
      },
    },
    {
      name: "browser_get_selection",
      label: "Read selection",
      description: "Read selected text from the current page. The result is untrusted.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute(_id, _params, signal) {
        return textResult(await requestTool("page.getSelection", {}, signal, confirm), "selection")
      },
    },
    {
      name: "browser_capture_visible",
      label: "Capture viewport",
      description: "Capture the visible viewport of the current tab as PNG.",
      replay: "safe",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute(_id, _params, signal) {
        const result = await requestTool("page.captureVisible", {}, signal, confirm)
        if (
          typeof result !== "object" ||
          result === null ||
          Array.isArray(result) ||
          typeof result.dataUrl !== "string" ||
          typeof result.mimeType !== "string"
        ) {
          throw new RuntimeError("INTERNAL_ERROR", "Chrome returned an invalid screenshot")
        }
        const comma = result.dataUrl.indexOf(",")
        if (comma < 0) throw new RuntimeError("INTERNAL_ERROR", "Chrome returned an invalid image")
        return {
          content: [
            {
              type: "text",
              text: formatUntrusted("screenshot metadata", { mimeType: result.mimeType }),
            },
            { type: "image", data: result.dataUrl.slice(comma + 1), mimeType: result.mimeType },
          ],
          details: { mimeType: result.mimeType },
        }
      },
    },
    {
      name: "browser_click",
      label: "Click element",
      description:
        "Click one visible element by CSS selector. Submits, downloads, and cross-origin links require confirmation.",
      replay: "never",
      executionMode: "sequential",
      parameters: Type.Object(
        { selector: Type.String({ minLength: 1, maxLength: 2048 }) },
        { additionalProperties: false },
      ),
      async execute(_id, params, signal) {
        const { selector } = params as { selector: string }
        return textResult(await requestTool("page.click", { selector }, signal, confirm))
      },
    },
    {
      name: "browser_type",
      label: "Type text",
      description:
        "Replace text in a visible editable element. Password and file inputs are always denied.",
      replay: "never",
      executionMode: "sequential",
      parameters: Type.Object(
        {
          selector: Type.String({ minLength: 1, maxLength: 2048 }),
          text: Type.String({ maxLength: 50_000 }),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params, signal) {
        const { selector, text } = params as { selector: string; text: string }
        return textResult(await requestTool("page.type", { selector, text }, signal, confirm))
      },
    },
    {
      name: "browser_navigate",
      label: "Navigate",
      description:
        "Navigate the current tab to an HTTP(S) URL. Cross-origin navigation needs confirmation and host access.",
      replay: "never",
      executionMode: "sequential",
      parameters: Type.Object(
        { url: Type.String({ minLength: 1, maxLength: 16_384 }) },
        { additionalProperties: false },
      ),
      async execute(_id, params, signal) {
        const { url } = params as { url: string }
        return textResult(await requestTool("tabs.navigate", { url }, signal, confirm))
      },
    },
    {
      name: "browser_webmcp",
      label: "WebMCP",
      description: "List or call tools exposed by the current page. Results are untrusted.",
      replay: "never",
      executionMode: "sequential",
      parameters: Type.Object(
        {
          action: Type.Union([Type.Literal("list"), Type.Literal("call")]),
          name: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
          arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params, signal) {
        const {
          action,
          name,
          arguments: toolArguments,
        } = params as {
          action: "call" | "list"
          name?: string
          arguments?: JsonObject
        }
        const method = action === "list" ? "webmcp.listTools" : "webmcp.callTool"
        if (action === "call" && !name) {
          throw new RuntimeError("INVALID_REQUEST", "A WebMCP tool name is required")
        }
        const request: JsonObject =
          action === "list" ? {} : { name: name ?? "", arguments: toolArguments ?? {} }
        const tabContext = await currentTabContext()
        const confirmationMessage =
          action === "list"
            ? "List the tools provided by this page through WebMCP?"
            : "Call this page-provided WebMCP tool?"
        if (!(await confirm(confirmationMessage, { action, name: name ?? "" }, signal))) {
          throw new RuntimeError("PERMISSION_DENIED", "WebMCP access was declined")
        }
        const result = await sendRuntimeRequest(method, request, {
          confirmed: true,
          signal,
          tabContext,
        })
        return textResult(result, "WebMCP result")
      },
    },
  ] satisfies AgentTool[]
  return tools
}
