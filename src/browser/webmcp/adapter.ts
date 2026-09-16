import type {
  PageOperationFailure,
  PageOperationResult,
  PageOperationSuccess,
} from "../content/page-operations.js"
import type { JsonObject, JsonValue, TabContext } from "../runtime/types.js"

export type WebMcpOperation = "webmcp.callTool" | "webmcp.listTools"

/**
 * This function is passed directly to chrome.scripting.executeScript. Keep runtime helpers inside
 * the function because the page execution world cannot access the extension bundle's module scope.
 */
export async function executeWebMcpOperation(
  operation: WebMcpOperation,
  params: JsonObject,
  confirmed: boolean,
  expectedContext: TabContext | null = null,
): Promise<PageOperationResult> {
  const success = (result: JsonValue): PageOperationSuccess => ({ ok: true, result })
  const failure = (
    code: PageOperationFailure["error"]["code"],
    message: string,
    details?: JsonObject,
  ): PageOperationFailure => ({
    ok: false,
    error: { code, message, ...(details ? { details } : {}) },
  })
  const modelContext = (): {
    getTools?: () => Promise<Record<string, unknown>[]>
    executeTool?: (tool: Record<string, unknown>, args: JsonObject) => Promise<unknown>
  } | null => {
    const documentContext = (
      document as Document & {
        modelContext?: {
          getTools?: () => Promise<Record<string, unknown>[]>
          executeTool?: (tool: Record<string, unknown>, args: JsonObject) => Promise<unknown>
        }
      }
    ).modelContext
    if (documentContext) return documentContext
    return (
      (
        navigator as Navigator & {
          modelContext?: {
            getTools?: () => Promise<Record<string, unknown>[]>
            executeTool?: (tool: Record<string, unknown>, args: JsonObject) => Promise<unknown>
          }
        }
      ).modelContext ?? null
    )
  }
  const jsonSafe = (value: unknown): JsonValue => {
    if (value === undefined) return null
    return JSON.parse(JSON.stringify(value)) as JsonValue
  }
  const stalePage = (): PageOperationFailure | undefined =>
    expectedContext !== null &&
    (location.href !== expectedContext.url || document.visibilityState !== "visible")
      ? failure(
          "STALE_CONTEXT",
          "The page is no longer the visible target for this WebMCP operation",
        )
      : undefined

  try {
    const initialStalePage = stalePage()
    if (initialStalePage) return initialStalePage
    if (!confirmed) {
      return failure("CONFIRMATION_REQUIRED", "WebMCP access requires explicit confirmation", {
        action: operation,
      })
    }
    const context = modelContext()
    if (!context?.getTools) {
      return failure("NOT_SUPPORTED", "WebMCP is not available in this page context")
    }

    if (operation === "webmcp.listTools") {
      const tools = await context.getTools()
      const currentStalePage = stalePage()
      if (currentStalePage) return currentStalePage
      return success(
        tools.map((tool) => ({
          name: typeof tool.name === "string" ? tool.name : "unknown",
          description: typeof tool.description === "string" ? tool.description : "",
          inputSchema: jsonSafe(tool.inputSchema ?? {}),
          origin: typeof tool.origin === "string" ? tool.origin : location.origin,
        })),
      )
    }

    if (!context.executeTool) {
      return failure("NOT_SUPPORTED", "WebMCP tool execution is not available in this page context")
    }
    const name = params.name
    const args = params.arguments
    if (
      typeof name !== "string" ||
      typeof args !== "object" ||
      args === null ||
      Array.isArray(args)
    ) {
      return failure("INVALID_REQUEST", "WebMCP tool name and object arguments are required")
    }
    const tools = await context.getTools()
    const currentStalePage = stalePage()
    if (currentStalePage) return currentStalePage
    const tool = tools.find((candidate) => candidate.name === name)
    if (!tool) return failure("INVALID_REQUEST", `WebMCP tool is not registered: ${name}`)
    if (expectedContext !== null) {
      const assertion = (await chrome.runtime.sendMessage({
        kind: "assert-current-mutation-target",
        tabContext: expectedContext,
      })) as { ok?: boolean; error?: { message?: string } } | undefined
      if (!assertion?.ok) {
        return failure(
          "STALE_CONTEXT",
          assertion?.error?.message ?? "The page is no longer in the focused browser window",
        )
      }
    }
    const result = await context.executeTool(tool, args as JsonObject)
    return success(jsonSafe(result))
  } catch (error) {
    return failure(
      "INTERNAL_ERROR",
      error instanceof Error ? error.message : "WebMCP operation failed",
    )
  }
}
