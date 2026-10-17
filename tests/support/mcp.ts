import { vi } from "vitest"
import { saveMcpServer, setMcpConnection } from "../../src/browser/mcp/store.js"

export const endpoint = "https://mcp.example.com:8443/tools"
export const schema = {
  type: "object" as const,
  properties: { text: { type: "string" as const, maxLength: 100 } },
  required: ["text"],
  additionalProperties: false,
}
export const remoteTool = {
  name: "echo",
  description: "Untrusted description",
  inputSchema: schema,
}

export function mcpEnvironment() {
  const data: Record<string, unknown> = {}
  const storageListeners = new Set<
    (changes: Record<string, chrome.storage.StorageChange>, area: string) => void
  >()
  const permissionListeners = new Set<() => void>()
  let granted = true
  const local = {
    get: vi.fn(async (keys: string | string[]) =>
      Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(data[key])]),
      ),
    ),
    set: vi.fn(async (entries: Record<string, unknown>) => {
      const changes = Object.fromEntries(
        Object.entries(entries).map(([key, value]) => [
          key,
          { oldValue: data[key], newValue: structuredClone(value) },
        ]),
      )
      Object.assign(data, structuredClone(entries))
      for (const listener of storageListeners) listener(changes, "local")
    }),
    setAccessLevel: vi.fn(async () => undefined),
  }
  data.piBrowserAgentApprovedHostPermissions = ["https://mcp.example.com/*"]
  vi.stubGlobal("chrome", {
    storage: {
      local,
      onChanged: {
        addListener: (f: typeof storageListeners extends Set<infer F> ? F : never) =>
          storageListeners.add(f),
        removeListener: (f: typeof storageListeners extends Set<infer F> ? F : never) =>
          storageListeners.delete(f),
      },
    },
    permissions: {
      contains: vi.fn(async () => granted),
      onRemoved: {
        addListener: (f: () => void) => permissionListeners.add(f),
        removeListener: (f: () => void) => permissionListeners.delete(f),
      },
    },
  })
  return {
    data,
    local,
    storageListeners,
    permissionListeners,
    revoke() {
      granted = false
      for (const listener of permissionListeners) listener()
    },
    async server(token?: string) {
      const saved = await saveMcpServer({ name: "Fixture", endpoint, token })
      return setMcpConnection(saved.id, true, saved.revision)
    },
  }
}

export function mockMcpFetch(
  options: {
    list?: (params: Record<string, unknown>) => unknown
    call?: (params: Record<string, unknown>) => unknown
    protocol?: string
    response?: (
      message: Record<string, unknown>,
      init: RequestInit,
    ) => Response | Promise<Response | undefined> | undefined
  } = {},
) {
  const messages: { method: string; params?: Record<string, unknown>; init: RequestInit }[] = []
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const message = JSON.parse(init.body as string)
    messages.push({ ...message, init })
    const override = await options.response?.(message, init)
    if (override) return override
    if (message.id === undefined) return new Response(null, { status: 202 })
    let result: unknown
    switch (message.method) {
      case "initialize":
        result = {
          protocolVersion: options.protocol ?? "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
        }
        break
      case "tools/list":
        result = options.list?.(message.params ?? {}) ?? { tools: [remoteTool] }
        break
      case "tools/call":
        result = options.call?.(message.params ?? {}) ?? {
          content: [{ type: "text", text: "Remote result" }],
        }
        break
      default:
        throw new Error("Unexpected method")
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), {
      headers: { "content-type": "application/json", "mcp-session-id": "session" },
    })
  })
  vi.stubGlobal("fetch", fetch)
  return { fetch, messages }
}
