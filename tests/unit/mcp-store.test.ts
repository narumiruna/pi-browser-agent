import { afterEach, describe, expect, test, vi } from "vitest"
import { mcpEndpoint } from "../../src/browser/mcp/policy.js"
import {
  listMcpServers,
  MCP_SERVERS_KEY,
  MCP_TOKENS_KEY,
  mcpAccess,
  removeMcpServer,
  saveMcpServer,
  setMcpConnection,
} from "../../src/browser/mcp/store.js"
import { endpoint, mcpEnvironment } from "../support/mcp.js"

afterEach(() => vi.unstubAllGlobals())

describe("MCP endpoint policy", () => {
  test.each([
    "not a URL",
    "http://mcp.example.com/a",
    "file:///etc/passwd",
    "https://u:p@mcp.example.com/a",
    "https://mcp.example.com/a?token=secret",
    "https://mcp.example.com/a#fragment",
    "https://127.0.0.1/a",
    "https://2130706433/a",
    "https://0x7f000001/a",
    "https://[::1]/a",
    "https://192.168.1.1/a",
    "https://localhost/a",
    "https://sub.localhost/a",
    "https://foo.local/a",
    "https://foo.internal/a",
    "https://foo.home.arpa/a",
    "https://foo.localdomain/a",
    "https://foo.test/a",
    "https://foo.lan/a",
    "https://foo.invalid/a",
    "https://foo.onion/a",
    "https://bad-.example.com/a",
  ])("rejects %s", (url) => expect(() => mcpEndpoint(url)).toThrow())

  test("preserves exact port and path; normalizes hostname", () => {
    expect(mcpEndpoint("https://MCP.example.com:8443/a/../tools")).toBe(endpoint)
    expect(mcpEndpoint("https://mcp.example.com:8444/tools")).not.toBe(endpoint)
    expect(mcpEndpoint("https://mcp.example.com:8443/other")).not.toBe(endpoint)
  })
})

describe("MCP configuration and token storage", () => {
  test("starts disconnected, separates secrets, and requires exact snapshot consent", async () => {
    const env = mcpEnvironment()
    const saved = await saveMcpServer({ name: "Fixture", endpoint, token: "private-token" })
    expect(saved).toMatchObject({ enabled: false, approved: false })
    expect(JSON.stringify(env.data[MCP_SERVERS_KEY])).not.toContain("private-token")
    await expect(mcpAccess(saved)).rejects.toThrow()
    await expect(setMcpConnection(saved.id, true)).rejects.toThrow("changed")
    const connected = await setMcpConnection(saved.id, true, saved.revision)
    expect(await mcpAccess(connected)).toBe("private-token")
    expect(env.local.setAccessLevel).toHaveBeenCalledWith({ accessLevel: "TRUSTED_CONTEXTS" })
  })

  test("rejects broad permission without recorded approval and revoked grants", async () => {
    const env = mcpEnvironment()
    const saved = await env.server()
    env.data.piBrowserAgentApprovedHostPermissions = []
    await expect(mcpAccess(saved)).rejects.toThrow("revoked")
    await expect(setMcpConnection(saved.id, true, saved.revision)).rejects.toThrow("host access")
    env.data.piBrowserAgentApprovedHostPermissions = ["https://mcp.example.com/*"]
    env.revoke()
    await expect(mcpAccess(saved)).rejects.toThrow("revoked")
  })

  test("endpoint edits discard tokens and connection approval, including same-host paths", async () => {
    const env = mcpEnvironment()
    const server = await env.server("secret-token")
    const edited = await saveMcpServer({
      id: server.id,
      name: "Edited",
      endpoint: `${endpoint}/new`,
    })
    expect(edited).toMatchObject({ enabled: false, approved: false })
    expect(env.data[MCP_TOKENS_KEY]).toEqual({ version: 1, tokens: {} })
    await expect(setMcpConnection(server.id, true, server.revision)).rejects.toThrow("changed")
    await expect(mcpAccess(server)).rejects.toThrow()
  })

  test("same endpoint retains a token without returning it; blank explicitly removes it", async () => {
    const env = mcpEnvironment()
    const server = await env.server("secret-token")
    const edited = await saveMcpServer({ ...server, name: "Edited" })
    const reconnected = await setMcpConnection(edited.id, true, edited.revision)
    expect(await mcpAccess(reconnected)).toBe("secret-token")
    const cleared = await saveMcpServer({ ...edited, token: "" })
    expect(
      await mcpAccess(await setMcpConnection(cleared.id, true, cleared.revision)),
    ).toBeUndefined()
    await removeMcpServer(server.id)
    expect(await listMcpServers()).toEqual([])
    expect(env.data[MCP_TOKENS_KEY]).toEqual({ version: 1, tokens: {} })
  })

  test("serializes concurrent writes and keeps records unchanged when a write fails", async () => {
    const env = mcpEnvironment()
    await Promise.all([env.server("first"), env.server("second")])
    expect(await listMcpServers()).toHaveLength(2)
    const original = structuredClone(env.data)
    env.local.set.mockRejectedValueOnce(new Error("Disk full"))
    await expect(saveMcpServer({ name: "No save", endpoint })).rejects.toThrow("Disk full")
    expect(env.data).toEqual(original)
  })

  test("fails closed on corrupt configuration, tokens, and token binding", async () => {
    const env = mcpEnvironment()
    const server = await env.server("secret-token")
    const original = structuredClone(env.data[MCP_TOKENS_KEY])
    for (const bad of [
      undefined,
      { version: 1, tokens: {} },
      { version: 2, tokens: {} },
      { version: 1, tokens: [] },
      { version: 1, tokens: { [server.id]: { token: "bad\nvalue" } } },
      {
        version: 1,
        tokens: {
          [server.id]: {
            endpoint: `${endpoint}/other`,
            revision: server.revision,
            token: "secret",
          },
        },
      },
    ]) {
      env.data[MCP_TOKENS_KEY] = bad
      await expect(mcpAccess(server)).rejects.toThrow("invalid")
    }
    env.data[MCP_TOKENS_KEY] = original
    env.data[MCP_SERVERS_KEY] = {
      version: 1,
      servers: [{ ...server, endpoint: "https://localhost/a" }],
    }
    expect(await listMcpServers()).toEqual([])
    await expect(mcpAccess(server)).rejects.toThrow()
    const corrupt = structuredClone(env.data)
    await expect(saveMcpServer({ name: "New", endpoint })).rejects.toThrow("invalid")
    await expect(removeMcpServer(server.id)).rejects.toThrow("invalid")
    expect(env.data).toEqual(corrupt)
  })

  test("preserves another server's corrupt token entry during edits and refuses corrupt store replacement", async () => {
    const env = mcpEnvironment()
    const first = await env.server("first-token")
    const second = await env.server("second-token")
    const tokens = env.data[MCP_TOKENS_KEY] as { version: number; tokens: Record<string, unknown> }
    tokens.tokens[second.id] = { invalid: "retained-for-explicit-removal" }
    await saveMcpServer({ ...first, name: "Edited" })
    expect((env.data[MCP_TOKENS_KEY] as typeof tokens).tokens[second.id]).toEqual({
      invalid: "retained-for-explicit-removal",
    })
    await expect(mcpAccess(second)).rejects.toThrow("invalid")
    env.data[MCP_TOKENS_KEY] = { version: 2, tokens: {} }
    const original = structuredClone(env.data)
    await expect(saveMcpServer({ ...first, token: "new-token" })).rejects.toThrow("invalid")
    expect(env.data).toEqual(original)
  })

  test("enforces server and token limits", async () => {
    const env = mcpEnvironment()
    await expect(
      saveMcpServer({ name: "bad", endpoint, token: "Bearer bad token" }),
    ).rejects.toThrow("token")
    await expect(saveMcpServer({ name: "", endpoint })).rejects.toThrow("name")
    for (let i = 0; i < 8; i++) await env.server()
    await expect(env.server()).rejects.toThrow("limit")
  })
})
