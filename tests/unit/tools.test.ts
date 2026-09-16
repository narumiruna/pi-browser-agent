import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { describe, expect, test, vi } from "vitest"
import type { BridgeServer } from "../../src/pi/bridge-server.js"
import { registerBrowserTools } from "../../src/pi/tools.js"
import { BridgeError } from "../../src/protocol/index.js"

interface CapturedTool {
  name: string
  execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text?: string }> }>
}

function captureTools(server: Pick<BridgeServer, "getStatus" | "request">): CapturedTool[] {
  const tools: CapturedTool[] = []
  const api = {
    registerTool(tool: unknown) {
      tools.push(tool as CapturedTool)
    },
  } as unknown as ExtensionAPI
  registerBrowserTools(api, () => server as BridgeServer)
  return tools
}

function findTool(tools: CapturedTool[], name: string): CapturedTool {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`Tool not registered: ${name}`)
  return tool
}

describe("pi browser tool mapping", () => {
  test("maps read tools to stable bridge methods and labels output untrusted", async () => {
    const request = vi.fn().mockResolvedValue({ text: "page text" })
    const tools = captureTools({ getStatus: vi.fn(), request })
    const tool = findTool(tools, "browser_read_page")

    const result = await tool.execute("call", {}, undefined, undefined, {})

    expect(request).toHaveBeenCalledWith("page.getVisibleText", {}, { signal: undefined })
    expect(result.content[0]?.text).toContain("Untrusted browser content")
  })

  test("retries sensitive mutations only after explicit confirmation", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new BridgeError("CONFIRMATION_REQUIRED", "This click submits a form"))
      .mockResolvedValueOnce({ clicked: true })
    const tools = captureTools({ getStatus: vi.fn(), request })
    const tool = findTool(tools, "browser_click")
    const confirm = vi.fn().mockResolvedValue(true)
    const ctx = { hasUI: true, ui: { confirm } } as unknown as ExtensionContext

    await tool.execute("call", { selector: "#submit" }, undefined, undefined, ctx)

    expect(confirm).toHaveBeenCalledOnce()
    expect(request).toHaveBeenLastCalledWith(
      "page.click",
      { selector: "#submit" },
      { confirmed: true, signal: undefined },
    )
  })

  test("routes WebMCP through one stable tool and confirms calls", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new BridgeError("CONFIRMATION_REQUIRED", "Page tool may mutate state"))
      .mockResolvedValueOnce({ content: "done" })
    const tools = captureTools({ getStatus: vi.fn(), request })
    const tool = findTool(tools, "browser_webmcp")
    const ctx = {
      hasUI: true,
      ui: { confirm: vi.fn().mockResolvedValue(true) },
    } as unknown as ExtensionContext

    await tool.execute(
      "call",
      { action: "call", name: "add-todo", arguments: { text: "Ship" } },
      undefined,
      undefined,
      ctx,
    )

    expect(request).toHaveBeenLastCalledWith(
      "webmcp.callTool",
      { name: "add-todo", arguments: { text: "Ship" } },
      { confirmed: true, signal: undefined },
    )
  })

  test("does not execute a sensitive mutation when confirmation is declined", async () => {
    const request = vi
      .fn()
      .mockRejectedValue(new BridgeError("CONFIRMATION_REQUIRED", "This click submits a form"))
    const tools = captureTools({ getStatus: vi.fn(), request })
    const tool = findTool(tools, "browser_click")
    const ctx = {
      hasUI: true,
      ui: { confirm: vi.fn().mockResolvedValue(false) },
    } as unknown as ExtensionContext

    await expect(
      tool.execute("call", { selector: "#submit" }, undefined, undefined, ctx),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" })
    expect(request).toHaveBeenCalledOnce()
  })
})
