// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest"
import { executeWebMcpOperation } from "../../src/browser/webmcp/adapter.js"

afterEach(() => {
  Reflect.deleteProperty(document, "modelContext")
  vi.unstubAllGlobals()
})

describe("WebMCP final mutation assertion", () => {
  test.each(["REQUEST_CANCELLED", "PERMISSION_DENIED", "STALE_CONTEXT"] as const)(
    "passes the request ID after deferred discovery and preserves %s without execution",
    async (code) => {
      let release: () => void = () => undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const getTools = vi.fn(async () => {
        await gate
        return [{ name: "mutate", inputSchema: {} }]
      })
      const executeTool = vi.fn(async () => ({ changed: true }))
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
      Object.defineProperty(document, "modelContext", {
        configurable: true,
        value: { getTools, executeTool },
      })
      const sendMessage = vi.fn(async () => ({
        ok: false,
        error: { code, message: "The request is no longer authorized" },
      }))
      vi.stubGlobal("chrome", { runtime: { sendMessage } })
      const expectedContext = { tabId: 7, url: location.href, epoch: 3 }
      const calling = executeWebMcpOperation(
        "webmcp.callTool",
        { name: "mutate", arguments: {} },
        true,
        expectedContext,
        "cancel-during-discovery",
      )
      expect(getTools).toHaveBeenCalledOnce()
      expect(sendMessage).not.toHaveBeenCalled()
      release()
      expect(await calling).toMatchObject({ ok: false, error: { code } })
      expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
        kind: "assert-current-mutation-target",
        tabContext: expectedContext,
        requestId: "cancel-during-discovery",
      })
      expect(executeTool).not.toHaveBeenCalled()
    },
  )
})
