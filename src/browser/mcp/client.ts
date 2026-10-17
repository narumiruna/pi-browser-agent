import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import { byteLength, MCP_FAILURE, MCP_LIMITS } from "./policy.js"
import { boundedJson, checkSchema, mcpSchemaValidator, validateArguments } from "./schema.js"
import { type McpServer, mcpAccess } from "./store.js"

const methods = new Set([
  "initialize",
  "notifications/initialized",
  "tools/list",
  "tools/call",
  "notifications/cancelled",
])

/** One bounded operation at a time; no reconnect, auth discovery, resumption, or call retry. */
export class McpConnection {
  private readonly lifetime = new AbortController()
  private operation?: AbortSignal
  private readonly client: Client
  private readonly transport: StreamableHTTPClientTransport
  private closed = false
  private disconnecting?: Promise<void>

  constructor(
    readonly server: McpServer,
    private readonly access: "run" | "preview" = "run",
  ) {
    this.client = new Client(
      { name: "pi-browser-agent", version: "1" },
      {
        capabilities: {},
        jsonSchemaValidator: mcpSchemaValidator,
      },
    )
    this.transport = new StreamableHTTPClientTransport(new URL(server.endpoint), {
      fetch: this.fetch.bind(this),
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
    })
    // SDK errors can contain credentials echoed by a server. Never forward their text.
    this.client.onerror = () => {
      this.close()
    }
  }

  private async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    if (String(input) !== this.server.endpoint || this.closed) throw new Error(MCP_FAILURE)
    const token = await mcpAccess(this.server, this.access)
    const signal = AbortSignal.any([
      this.lifetime.signal,
      this.operation ?? AbortSignal.timeout(MCP_LIMITS.timeoutMs),
      ...(init?.signal ? [init.signal] : []),
    ])
    signal.throwIfAborted()
    // Standalone server streams are optional. Do not open them or resume a broken POST stream.
    if (init?.method === "GET") {
      if (new Headers(init.headers).has("last-event-id")) throw new Error(MCP_FAILURE)
      return new Response(null, { status: 405 })
    }
    const cleanup = init?.method === "DELETE" && this.disconnecting !== undefined
    if (
      !cleanup &&
      (init?.method !== "POST" ||
        typeof init.body !== "string" ||
        byteLength(init.body) > MCP_LIMITS.requestBytes)
    ) {
      throw new Error(MCP_FAILURE)
    }
    if (!cleanup) {
      const message = JSON.parse(init?.body as string) as { method?: string }
      if (
        !methods.has(message.method ?? "") ||
        (this.access === "preview" && message.method === "tools/call")
      )
        throw new Error(MCP_FAILURE)
    }
    const headers = new Headers(init?.headers)
    headers.delete("authorization")
    if (token) headers.set("authorization", `Bearer ${token}`)
    const response = await fetch(this.server.endpoint, {
      method: cleanup ? "DELETE" : "POST",
      ...(cleanup ? { keepalive: true } : { body: init?.body }),
      headers,
      signal,
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    })
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      throw new Error(MCP_FAILURE)
    }
    if (cleanup) {
      await response.body?.cancel()
      if (!response.ok && response.status !== 405) throw new Error(MCP_FAILURE)
      return new Response(null, { status: response.status })
    }
    const session = response.headers.get("mcp-session-id")
    if (session && (session.length > 256 || !/^[\x21-\x7e]+$/.test(session))) {
      await response.body?.cancel()
      throw new Error(MCP_FAILURE)
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(MCP_FAILURE)
    }
    if (!response.body) return response
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    const cancelReader = () => {
      void reader.cancel().catch(() => undefined)
    }
    signal.addEventListener("abort", cancelReader, { once: true })
    try {
      while (true) {
        signal.throwIfAborted()
        const part = await reader.read()
        if (part.done) break
        size += part.value.byteLength
        if (size > MCP_LIMITS.responseBytes) throw new Error(MCP_FAILURE)
        chunks.push(part.value)
      }
    } catch {
      await reader.cancel().catch(() => undefined)
      throw new Error(MCP_FAILURE)
    } finally {
      signal.removeEventListener("abort", cancelReader)
      reader.releaseLock()
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    // Known tokens echoed by a server must not reach tool metadata, results, or transcripts.
    if (token && text.includes(token)) throw new Error(MCP_FAILURE)
    return new Response(response.status === 202 || response.status === 204 ? null : bytes, {
      status: response.status,
      headers: response.headers,
    })
  }

  private async run<T>(
    action: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.closed || this.operation) throw new Error(MCP_FAILURE)
    const deadline = AbortSignal.timeout(MCP_LIMITS.timeoutMs)
    const combined = AbortSignal.any([this.lifetime.signal, deadline, ...(signal ? [signal] : [])])
    this.operation = combined
    const onAbort = () => this.close()
    combined.addEventListener("abort", onAbort, { once: true })
    try {
      combined.throwIfAborted()
      const result = await action(combined)
      if (!boundedJson(result)) throw new Error(MCP_FAILURE)
      combined.throwIfAborted()
      const token = await mcpAccess(this.server, this.access)
      if (token && JSON.stringify(result).includes(token)) throw new Error(MCP_FAILURE)
      return result
    } catch {
      this.close()
      throw new Error(MCP_FAILURE)
    } finally {
      combined.removeEventListener("abort", onAbort)
      this.operation = undefined
    }
  }

  async discover(signal?: AbortSignal): Promise<Tool[]> {
    return this.run(async (operation) => {
      const options = { signal: operation, timeout: MCP_LIMITS.timeoutMs }
      await this.client.connect(this.transport, options)
      if (
        !["2025-11-25", "2025-06-18", "2025-03-26"].includes(this.transport.protocolVersion ?? "")
      ) {
        throw new Error(MCP_FAILURE)
      }
      const tools: Tool[] = []
      const cursors = new Set<string>()
      let cursor: string | undefined
      for (let page = 0; page < MCP_LIMITS.pages; page++) {
        const result = await this.client.listTools(cursor ? { cursor } : {}, options)
        for (const tool of result.tools) {
          if (
            !/^[A-Za-z0-9_.-]{1,64}$/.test(tool.name) ||
            (tool.description?.length ?? 0) > 2048 ||
            tool.execution?.taskSupport === "required" ||
            tool.inputSchema.type !== "object" ||
            tools.some((existing) => existing.name === tool.name)
          )
            throw new Error(MCP_FAILURE)
          checkSchema(tool.inputSchema)
          if (tool.outputSchema) checkSchema(tool.outputSchema)
          tools.push(tool)
          if (tools.length > MCP_LIMITS.tools) throw new Error(MCP_FAILURE)
        }
        cursor = result.nextCursor
        if (!cursor) return tools
        if (cursor.length > 256 || cursors.has(cursor)) throw new Error(MCP_FAILURE)
        cursors.add(cursor)
      }
      throw new Error(MCP_FAILURE)
    }, signal)
  }

  async call(
    tool: Tool,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{
    content: { type: "text"; text: string }[]
    structuredContent?: Record<string, unknown>
    isError?: boolean
  }> {
    if (this.access === "preview") throw new Error(MCP_FAILURE)
    return this.run(async (operation) => {
      validateArguments(tool.inputSchema, args)
      // Use a request rather than cached per-page output validators: the run snapshot owns metadata.
      const { CallToolResultSchema } = await import("@modelcontextprotocol/sdk/types.js")
      const result = await this.client.request(
        { method: "tools/call", params: { name: tool.name, arguments: args } },
        CallToolResultSchema,
        {
          signal: operation,
          timeout: MCP_LIMITS.timeoutMs,
        },
      )
      if (
        byteLength(result) > MCP_LIMITS.resultBytes ||
        !boundedJson(result) ||
        result.content.some((part) => part.type !== "text")
      ) {
        throw new Error(MCP_FAILURE)
      }
      if (
        tool.outputSchema &&
        !result.isError &&
        !mcpSchemaValidator.getValidator(tool.outputSchema)(result.structuredContent).valid
      ) {
        throw new Error(MCP_FAILURE)
      }
      return {
        content: result.content.map((part) => ({
          type: "text",
          text: (part as { text: string }).text,
        })),
        ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
        ...(result.isError ? { isError: true } : {}),
      }
    }, signal)
  }

  /** Best-effort cleanup for idle, authorized sessions. Abort and revocation use close(). */
  disconnect(): Promise<void> {
    if (this.disconnecting) return this.disconnecting
    if (this.closed || this.operation || !this.transport.sessionId) {
      this.close()
      return Promise.resolve()
    }
    this.operation = AbortSignal.any([
      this.lifetime.signal,
      AbortSignal.timeout(MCP_LIMITS.cleanupTimeoutMs),
    ])
    let stop = (): void => undefined
    const stopped = new Promise<void>((resolve) => {
      stop = resolve
    })
    const abort = () => {
      this.close()
      stop()
    }
    this.operation.addEventListener("abort", abort, { once: true })
    // Defer the SDK call so fetch can identify this one permitted DELETE operation.
    this.disconnecting = Promise.resolve()
      .then(() =>
        this.closed ? undefined : Promise.race([this.transport.terminateSession(), stopped]),
      )
      .catch(() => undefined)
      .finally(() => {
        this.operation?.removeEventListener("abort", abort)
        this.operation = undefined
        this.close()
      })
    return this.disconnecting
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.lifetime.abort()
    void this.client.close().catch(() => undefined)
  }
}
