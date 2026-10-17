import { afterEach, describe, expect, test, vi } from "vitest"
import { McpConnection } from "../../src/browser/mcp/client.js"
import { MCP_LIMITS } from "../../src/browser/mcp/policy.js"
import { setMcpConnection } from "../../src/browser/mcp/store.js"
import { mcpEnvironment, mockMcpFetch, remoteTool } from "../support/mcp.js"

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("MCP SDK transport boundaries", () => {
  test("uses fixed endpoint, no cookies, no redirects, session headers, and a scoped token", async () => {
    const env = mcpEnvironment()
    const mock = mockMcpFetch()
    const connection = new McpConnection(await env.server("secret-token-value"))
    expect(await connection.discover()).toEqual([remoteTool])
    expect(await connection.call(remoteTool, { text: "hello" })).toMatchObject({
      content: [{ type: "text", text: "Remote result" }],
    })
    expect(mock.messages.map((m) => m.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ])
    for (const message of mock.messages) {
      expect(message.init).toMatchObject({
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
      })
      expect(new Headers(message.init.headers).get("authorization")).toBe(
        "Bearer secret-token-value",
      )
    }
    expect(new Headers(mock.messages.at(-1)?.init.headers).get("mcp-session-id")).toBe("session")
    connection.close()
    connection.close()
    await expect(connection.call(remoteTool, {})).rejects.toThrow("MCP request failed")
  })

  test.each([301, 307, 401, 403, 404, 500])(
    "fails HTTP %s without auth fallback, redirects, or retries",
    async (status) => {
      const env = mcpEnvironment()
      const mock = mockMcpFetch({
        response: () =>
          new Response("secret-token-value", {
            status,
            headers: { location: "https://evil.example.com/steal" },
          }),
      })
      const connection = new McpConnection(await env.server("secret-token-value"))
      await expect(connection.discover()).rejects.toThrow("MCP request failed")
      expect(mock.fetch).toHaveBeenCalledTimes(1)
    },
  )

  test.each(["2000-01-01", "2024-11-05"])(
    "rejects unsupported Streamable HTTP protocol %s",
    async (protocol) => {
      const env = mcpEnvironment()
      mockMcpFetch({ protocol })
      const connection = new McpConnection(await env.server())
      await expect(connection.discover()).rejects.toThrow("MCP request failed")
    },
  )

  test.each([
    { body: "not json", type: "application/json" },
    { body: "event: message\ndata: not json\n\n", type: "text/event-stream" },
    { body: "x".repeat(MCP_LIMITS.responseBytes + 1), type: "application/json" },
    { body: "secret-token-value", type: "text/plain" },
  ])(
    "rejects malformed, oversized, unsupported, or credential-echoing responses",
    async ({ body, type }) => {
      const env = mcpEnvironment()
      const mock = mockMcpFetch({
        response: () => new Response(body, { headers: { "content-type": type } }),
      })
      const connection = new McpConnection(await env.server("secret-token-value"))
      await expect(connection.discover()).rejects.toThrow("MCP request failed")
      expect(mock.fetch).toHaveBeenCalledTimes(1)
    },
  )

  test("rejects JSON-escaped token echoes after parsing without exposing the token", async () => {
    const env = mcpEnvironment()
    const mock = mockMcpFetch({
      response: (message) =>
        message.method === "tools/call"
          ? new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: { content: [{ type: "text", text: "secret-token-value" }] },
              }).replace("secret-token-value", "\\u0073ecret-token-value"),
              { headers: { "content-type": "application/json" } },
            )
          : undefined,
    })
    const connection = new McpConnection(await env.server("secret-token-value"))
    await connection.discover()
    await expect(connection.call(remoteTool, { text: "x" })).rejects.toThrow("MCP request failed")
    expect(mock.messages.filter((m) => m.method === "tools/call")).toHaveLength(1)
  })

  test("bounds response streams before JSON parsing and cancels unread bytes", async () => {
    const env = mcpEnvironment()
    let chunks = 0
    let cancelled = false
    mockMcpFetch({
      response: () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              chunks++
              controller.enqueue(new Uint8Array(64 * 1024))
            },
            cancel() {
              cancelled = true
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    })
    const connection = new McpConnection(await env.server())
    await expect(connection.discover()).rejects.toThrow()
    expect(chunks).toBeLessThanOrEqual(6)
    expect(cancelled).toBe(true)
  })

  test("rejects pagination loops, excess tools, duplicate names, and unsupported schemas", async () => {
    const env = mcpEnvironment()
    const server = await env.server()
    for (const list of [
      () => ({ tools: [], nextCursor: "repeat" }),
      () => ({
        tools: Array.from({ length: 33 }, (_, i) => ({ ...remoteTool, name: `tool${i}` })),
      }),
      () => ({ tools: [remoteTool, remoteTool] }),
      () => ({
        tools: [
          { ...remoteTool, inputSchema: { type: "object", $ref: "https://evil.example.com/a" } },
        ],
      }),
      () => ({
        tools: [{ ...remoteTool, outputSchema: { type: "object", patternProperties: {} } }],
      }),
    ]) {
      mockMcpFetch({ list })
      await expect(new McpConnection(server).discover()).rejects.toThrow("MCP request failed")
    }
  })

  test("supports bounded pagination and freezes output schema validation across pages", async () => {
    const env = mcpEnvironment()
    const tool = {
      ...remoteTool,
      outputSchema: {
        type: "object" as const,
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      },
    }
    mockMcpFetch({
      list: (params) =>
        params.cursor
          ? { tools: [{ ...remoteTool, name: "second" }] }
          : { tools: [tool], nextCursor: "next" },
      call: () => ({ content: [], structuredContent: { ok: "not boolean" } }),
    })
    const connection = new McpConnection(await env.server())
    const tools = await connection.discover()
    expect(tools).toHaveLength(2)
    await expect(connection.call(tool, { text: "x" })).rejects.toThrow("MCP request failed")
  })

  test.each([
    { content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] },
    { content: [{ type: "audio", data: "aGVsbG8=", mimeType: "audio/wav" }] },
    {
      content: [
        { type: "resource", resource: { uri: "https://evil.example.com/data", text: "resource" } },
      ],
    },
    {
      content: [
        { type: "resource_link", uri: "https://evil.example.com/secret", name: "resource" },
      ],
    },
    { content: [{ type: "text", text: "x".repeat(MCP_LIMITS.resultBytes) }] },
  ])(
    "rejects unsupported result blocks or oversized results without fetching links",
    async (result) => {
      const env = mcpEnvironment()
      const mock = mockMcpFetch({ call: () => result })
      const connection = new McpConnection(await env.server())
      await connection.discover()
      await expect(connection.call(remoteTool, { text: "x" })).rejects.toThrow("MCP request failed")
      expect(mock.messages.filter((m) => m.method === "tools/call")).toHaveLength(1)
      expect(mock.fetch.mock.calls.every(([url]) => url === connection.server.endpoint)).toBe(true)
    },
  )

  test("does not resume a broken SSE response or replay a primed tool call", async () => {
    const env = mcpEnvironment()
    const mock = mockMcpFetch({
      response: (message) =>
        message.method === "tools/call"
          ? new Response("id: priming-event\ndata: \n\nretry: 0\n\n", {
              headers: { "content-type": "text/event-stream" },
            })
          : undefined,
    })
    const connection = new McpConnection(await env.server())
    await connection.discover()
    await expect(connection.call(remoteTool, { text: "x" })).rejects.toThrow("MCP request failed")
    expect(mock.messages.filter((m) => m.method === "tools/call")).toHaveLength(1)
    expect(mock.messages.filter((m) => m.method === "initialize")).toHaveLength(1)
  })

  test("rechecks consent before dispatch and never reconnects after a tool 404", async () => {
    const env = mcpEnvironment()
    const server = await env.server()
    const mock = mockMcpFetch({
      response: (message) =>
        message.method === "tools/call" ? new Response(null, { status: 404 }) : undefined,
    })
    const connection = new McpConnection(server)
    await connection.discover()
    await expect(connection.call(remoteTool, { text: "x" })).rejects.toThrow()
    expect(mock.messages.filter((m) => m.method === "initialize")).toHaveLength(1)
    const fresh = new McpConnection(server)
    await fresh.discover()
    await setMcpConnection(server.id, false)
    await expect(fresh.call(remoteTool, { text: "x" })).rejects.toThrow()
    expect(mock.messages.filter((m) => m.method === "tools/call")).toHaveLength(1)
  })

  test("preview access discovers and cleans up a disabled server but cannot call a tool", async () => {
    const env = mcpEnvironment()
    const server = await env.server("secret-token-value")
    const preview = await setMcpConnection(server.id, false, server.revision)
    const mock = mockMcpFetch()
    const connection = new McpConnection(preview, "preview")
    expect(await connection.discover()).toEqual([remoteTool])
    await expect(connection.call(remoteTool, { text: "x" })).rejects.toThrow("MCP request failed")
    expect(mock.messages.some((message) => message.method === "tools/call")).toBe(false)
    await connection.disconnect()
    expect(mock.messages.filter((message) => message.method === "session/delete")).toHaveLength(1)
    expect(new Headers(mock.messages.at(-1)?.init.headers).get("authorization")).toBe(
      "Bearer secret-token-value",
    )
  })

  test("a normal client cannot discover a disabled preview server", async () => {
    const env = mcpEnvironment()
    const server = await env.server()
    const preview = await setMcpConnection(server.id, false, server.revision)
    const mock = mockMcpFetch()
    await expect(new McpConnection(preview).discover()).rejects.toThrow("MCP request failed")
    expect(mock.fetch).not.toHaveBeenCalled()
  })

  test("terminates an idle session once with valid authorization, then closes", async () => {
    const env = mcpEnvironment()
    const mock = mockMcpFetch()
    const connection = new McpConnection(await env.server("secret-token-value"))
    await connection.discover()
    await Promise.all([connection.disconnect(), connection.disconnect()])
    const deletes = mock.messages.filter((m) => m.method === "session/delete")
    expect(deletes).toHaveLength(1)
    expect(deletes[0]?.init).toMatchObject({
      method: "DELETE",
      credentials: "omit",
      redirect: "error",
      keepalive: true,
    })
    expect(new Headers(deletes[0]?.init.headers).get("authorization")).toBe(
      "Bearer secret-token-value",
    )
    expect(new Headers(deletes[0]?.init.headers).get("mcp-session-id")).toBe("session")
    await expect(connection.call(remoteTool, { text: "x" })).rejects.toThrow("MCP request failed")
  })

  test.each(["revoke", "remove", "abort"])(
    "does not send a cleanup request after %s",
    async (action) => {
      const env = mcpEnvironment()
      const mock = mockMcpFetch()
      const server = await env.server()
      const connection = new McpConnection(server)
      await connection.discover()
      if (action === "revoke") env.revoke()
      else if (action === "remove") await setMcpConnection(server.id, false)
      else connection.close()
      await connection.disconnect()
      expect(mock.messages.some((m) => m.method === "session/delete")).toBe(false)
    },
  )

  test.each([405, 500, 307])(
    "cleanup status %s does not retry a call or escape its endpoint",
    async (status) => {
      const env = mcpEnvironment()
      const mock = mockMcpFetch({
        response: (message) =>
          message.method === "session/delete"
            ? new Response(null, {
                status,
                headers: { location: "https://evil.example.com/steal" },
              })
            : undefined,
      })
      const connection = new McpConnection(await env.server())
      await connection.discover()
      await connection.disconnect()
      expect(mock.messages.filter((m) => m.method === "session/delete")).toHaveLength(1)
      expect(mock.messages.filter((m) => m.method === "initialize")).toHaveLength(1)
      expect(mock.fetch.mock.calls.every(([url]) => url === connection.server.endpoint)).toBe(true)
    },
  )

  test("bounds cleanup duration and aborts a pending DELETE", async () => {
    const env = mcpEnvironment()
    const mock = mockMcpFetch({
      response: (message, init) => {
        if (message.method === "session/delete")
          return new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("Aborted")), {
              once: true,
            })
          })
        return
      },
    })
    const connection = new McpConnection(await env.server())
    await connection.discover()
    const started = Date.now()
    await connection.disconnect()
    expect(Date.now() - started).toBeLessThan(MCP_LIMITS.cleanupTimeoutMs + 1500)
    expect(mock.messages.filter((m) => m.method === "session/delete")).toHaveLength(1)
  })

  test("aborts a pending operation and applies a finite deadline without replay", async () => {
    const env = mcpEnvironment()
    const mock = mockMcpFetch({
      response: (message, init) => {
        if (message.method !== "tools/call") return
        return new Promise((_resolve, reject) =>
          init.signal?.addEventListener("abort", () => reject(new Error("Aborted")), {
            once: true,
          }),
        )
      },
    })
    const server = await env.server()
    const connection = new McpConnection(server)
    await connection.discover()
    const controller = new AbortController()
    const pending = connection.call(remoteTool, { text: "x" }, controller.signal)
    const rejected = expect(pending).rejects.toThrow("MCP request failed")
    await vi.waitFor(() =>
      expect(mock.messages.filter((m) => m.method === "tools/call")).toHaveLength(1),
    )
    controller.abort()
    await rejected
    expect(mock.messages.filter((m) => m.method === "tools/call")).toHaveLength(1)
    const fresh = new McpConnection(server)
    await fresh.discover()
    vi.useFakeTimers()
    const timed = expect(fresh.call(remoteTool, { text: "x" })).rejects.toThrow(
      "MCP request failed",
    )
    await vi.advanceTimersByTimeAsync(MCP_LIMITS.timeoutMs + 1)
    await timed
  })
})
