import type { AgentTool } from "@earendil-works/pi-agent-core"
import type { TSchema } from "typebox"
import type { ConfirmationHandler } from "../agent/browser-tools.js"
import { hasApprovedHostPermission } from "../permissions.js"
import { formatUntrusted, type JsonObject } from "../runtime/types.js"
import { McpConnection } from "./client.js"
import { byteLength, MCP_FAILURE, MCP_LIMITS } from "./policy.js"
import { validateArguments } from "./schema.js"
import { listMcpServers, MCP_SERVERS_KEY, MCP_TOKENS_KEY, mcpAccess } from "./store.js"

/** Connections and declarations belong to one panel and one run, not to saved sessions. */
export class McpManager {
  private lifetime = new AbortController()
  private connections: McpConnection[] = []
  private disposed = false
  private generation = 0
  private listening = false
  private readonly changed = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area === "local" && (MCP_SERVERS_KEY in changes || MCP_TOKENS_KEY in changes))
      this.invalidate()
  }
  private readonly revoked = (removed: chrome.permissions.Permissions) => {
    if (!removed.origins?.length) return
    const connections = this.connections
    void Promise.all(connections.map(({ server }) => hasApprovedHostPermission(server.endpoint)))
      .then((allowed) => {
        if (this.connections === connections && allowed.includes(false)) this.invalidate()
      })
      .catch(() => {
        if (this.connections === connections) this.invalidate()
      })
  }

  constructor(private readonly confirm: ConfirmationHandler) {}

  invalidate(): void {
    this.generation++
    this.lifetime.abort()
    for (const connection of this.connections) connection.close()
    this.connections = []
  }

  async finish(): Promise<void> {
    this.lifetime.abort()
    const connections = this.connections
    await Promise.all(connections.map((connection) => connection.disconnect()))
    if (this.connections === connections) this.connections = []
  }

  async prepare(): Promise<AgentTool[]> {
    if (this.disposed) throw new Error(MCP_FAILURE)
    if (!this.listening) {
      chrome.storage.onChanged?.addListener(this.changed)
      chrome.permissions?.onRemoved?.addListener(this.revoked)
      this.listening = true
    }
    const generation = this.generation
    await this.finish()
    if (this.disposed || generation !== this.generation) throw new Error(MCP_FAILURE)
    this.lifetime = new AbortController()
    const signal = this.lifetime.signal
    const declarations: AgentTool[] = []
    try {
      const servers = (await listMcpServers()).filter((server) => server.enabled && server.approved)
      for (const server of servers) {
        signal.throwIfAborted()
        const connection = new McpConnection(server)
        this.connections.push(connection)
        const tools = await connection.discover(signal)
        for (const tool of tools) {
          const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tool.name))
          const suffix = [...new Uint8Array(digest)]
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("")
            .slice(0, 20)
          const name = `mcp_${server.id.replaceAll("-", "")}_${suffix}`
          if (declarations.some((entry) => entry.name === name)) throw new Error(MCP_FAILURE)
          declarations.push({
            name,
            label: "Remote MCP tool",
            description: `Untrusted remote MCP tool from ${server.name}: ${tool.name}. Requires confirmation; may have side effects.\n${tool.description ?? ""}`,
            parameters: tool.inputSchema as TSchema,
            replay: "never",
            executionMode: "sequential",
            execute: async (_id, params, executionSignal) => {
              const combined = AbortSignal.any([
                signal,
                ...(executionSignal ? [executionSignal] : []),
              ])
              combined.throwIfAborted()
              const args = structuredClone(params)
              validateArguments(tool.inputSchema, args)
              await mcpAccess(server)
              if (
                !(await this.confirm(
                  "Call this remote MCP tool? Arguments go to this server; results go to the selected model and saved session. This call may have side effects. Every call requires confirmation.",
                  { endpoint: server.endpoint, tool: tool.name, arguments: args as JsonObject },
                  combined,
                ))
              )
                throw new Error("Remote MCP call was declined")
              combined.throwIfAborted()
              await mcpAccess(server)
              const result = await connection.call(tool, args as Record<string, unknown>, combined)
              combined.throwIfAborted()
              return {
                content: [{ type: "text", text: formatUntrusted("remote MCP result", result) }],
                details: {
                  endpoint: server.endpoint,
                  tool: tool.name,
                  isError: result.isError ?? false,
                },
                isError: result.isError ?? false,
              }
            },
          })
          if (
            declarations.length > MCP_LIMITS.tools ||
            byteLength(
              declarations.map(({ name, description, parameters }) => ({
                name,
                description,
                parameters,
              })),
            ) > MCP_LIMITS.declarationBytes
          ) {
            throw new Error(MCP_FAILURE)
          }
        }
      }
      signal.throwIfAborted()
      return declarations
    } catch {
      this.invalidate()
      throw new Error(MCP_FAILURE)
    }
  }

  dispose(): void {
    this.disposed = true
    this.invalidate()
    if (this.listening) {
      chrome.storage.onChanged?.removeListener(this.changed)
      chrome.permissions?.onRemoved?.removeListener(this.revoked)
    }
  }
}
