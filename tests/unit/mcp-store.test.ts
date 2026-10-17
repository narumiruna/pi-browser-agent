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
    const saved = await saveMcpServer({ name: "Fixture", endpoint, token: "private-token-value" })
    expect(saved).toMatchObject({ enabled: false, approved: false })
    expect(JSON.stringify(env.data[MCP_SERVERS_KEY])).not.toContain("private-token-value")
    await expect(mcpAccess(saved)).rejects.toThrow()
    await expect(setMcpConnection(saved.id, true)).rejects.toThrow("changed")
    const connected = await setMcpConnection(saved.id, true, saved.revision)
    expect(await mcpAccess(connected)).toBe("private-token-value")
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
    const server = await env.server("secret-token-value")
    const edited = await saveMcpServer({
      id: server.id,
      revision: server.revision,
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
    const server = await env.server("secret-token-value")
    const edited = await saveMcpServer({ ...server, name: "Edited" })
    const reconnected = await setMcpConnection(edited.id, true, edited.revision)
    expect(await mcpAccess(reconnected)).toBe("secret-token-value")
    const cleared = await saveMcpServer({ ...edited, token: "" })
    expect(
      await mcpAccess(await setMcpConnection(cleared.id, true, cleared.revision)),
    ).toBeUndefined()
    await removeMcpServer(server.id, cleared.revision)
    expect(await listMcpServers()).toEqual([])
    expect(env.data[MCP_TOKENS_KEY]).toEqual({ version: 1, tokens: {} })
  })

  test("serializes concurrent writes and keeps records unchanged when a write fails", async () => {
    const env = mcpEnvironment()
    await Promise.all([env.server("first-test-token-value"), env.server("second-test-token-value")])
    expect(await listMcpServers()).toHaveLength(2)
    const original = structuredClone(env.data)
    env.local.set.mockRejectedValueOnce(new Error("Disk full"))
    await expect(saveMcpServer({ name: "No save", endpoint })).rejects.toThrow("Disk full")
    expect(env.data).toEqual(original)
  })

  test("fails closed on corrupt configuration, tokens, and token binding", async () => {
    const env = mcpEnvironment()
    const server = await env.server("secret-token-value")
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
    await expect(removeMcpServer(server.id, server.revision)).rejects.toThrow("invalid")
    expect(env.data).toEqual(corrupt)
  })

  test("preserves another server's corrupt token entry during edits and refuses corrupt store replacement", async () => {
    const env = mcpEnvironment()
    const first = await env.server("first-token-value")
    const second = await env.server("second-token-value")
    const tokens = env.data[MCP_TOKENS_KEY] as { version: number; tokens: Record<string, unknown> }
    tokens.tokens[second.id] = { invalid: "retained-for-explicit-removal" }
    const edited = await saveMcpServer({ ...first, name: "Edited" })
    expect((env.data[MCP_TOKENS_KEY] as typeof tokens).tokens[second.id]).toEqual({
      invalid: "retained-for-explicit-removal",
    })
    await expect(mcpAccess(second)).rejects.toThrow("invalid")
    env.data[MCP_TOKENS_KEY] = { version: 2, tokens: {} }
    const original = structuredClone(env.data)
    await expect(saveMcpServer({ ...edited, token: "new-token-value-1" })).rejects.toThrow(
      "invalid",
    )
    expect(env.data).toEqual(original)
  })

  test("rejects short tokens before any storage change", async () => {
    const env = mcpEnvironment()
    for (const token of ["a", "123456789012345"]) {
      await expect(saveMcpServer({ name: "Fixture", endpoint, token })).rejects.toThrow(
        "16 to 4096",
      )
    }
    expect(env.local.set).not.toHaveBeenCalled()
    expect(env.local.setAccessLevel).not.toHaveBeenCalled()
  })

  test("rejects stale or missing edit revisions without losing a newer endpoint or token", async () => {
    const env = mcpEnvironment()
    const original = await env.server("original-token-value")
    const current = await saveMcpServer({
      ...original,
      name: "Current",
      endpoint: `${endpoint}/new`,
      token: "replacement-token-value",
    })
    const snapshot = structuredClone(env.data)
    await expect(saveMcpServer({ ...original, name: "Stale" })).rejects.toThrow("Reload Settings")
    await expect(saveMcpServer({ id: current.id, name: "No revision", endpoint })).rejects.toThrow(
      "Reload Settings",
    )
    expect(env.data).toEqual(snapshot)
    expect(await mcpAccess(await setMcpConnection(current.id, true, current.revision))).toBe(
      "replacement-token-value",
    )
  })

  test("rejects stale removal before changing configuration or tokens", async () => {
    const env = mcpEnvironment()
    const original = await env.server("original-token-value")
    const current = await saveMcpServer({
      ...original,
      name: "Current",
      endpoint: `${endpoint}/new`,
      token: "replacement-token-value",
    })
    const snapshot = structuredClone(env.data)
    for (const revision of ["", original.revision]) {
      await expect(removeMcpServer(current.id, revision)).rejects.toThrow("Reload Settings")
      expect(env.data).toEqual(snapshot)
    }
    await removeMcpServer(current.id, current.revision)
    expect(await listMcpServers()).toEqual([])
    expect(env.data[MCP_TOKENS_KEY]).toEqual({ version: 1, tokens: {} })
  })

  test("serializes concurrent edits and removals without applying both", async () => {
    const env = mcpEnvironment()
    const server = await env.server("original-token-value")
    const [edit, removal] = await Promise.allSettled([
      saveMcpServer({ ...server, name: "Newer", token: "replacement-token-value" }),
      removeMcpServer(server.id, server.revision),
    ])
    expect([edit.status, removal.status].sort()).toEqual(["fulfilled", "rejected"])
    if (edit.status === "fulfilled") {
      const [current] = await listMcpServers()
      if (!current) throw new Error("Newer server was removed")
      expect(current.name).toBe("Newer")
      expect(await mcpAccess(await setMcpConnection(current.id, true, current.revision))).toBe(
        "replacement-token-value",
      )
    } else {
      expect(await listMcpServers()).toEqual([])
      expect(env.data[MCP_TOKENS_KEY]).toEqual({ version: 1, tokens: {} })
    }
  })

  test("disabled previews retain token binding and cannot become run access before approval", async () => {
    const env = mcpEnvironment()
    const server = await env.server("original-token-value")
    const preview = await setMcpConnection(server.id, false, server.revision)
    expect(preview.revision).not.toBe(server.revision)
    expect(preview).toMatchObject({ enabled: false, approved: false })
    await expect(mcpAccess(preview)).rejects.toThrow("revoked")
    expect(await mcpAccess(preview, "preview")).toBe("original-token-value")
    const disabled = await setMcpConnection(preview.id, false, preview.revision)
    await expect(mcpAccess(preview, "preview")).rejects.toThrow("revoked")
    await expect(setMcpConnection(preview.id, true, preview.revision)).rejects.toThrow("changed")
    expect(await mcpAccess(disabled, "preview")).toBe("original-token-value")
    const connected = await setMcpConnection(disabled.id, true, disabled.revision)
    expect(await mcpAccess(connected)).toBe("original-token-value")
    await expect(mcpAccess(disabled, "preview")).rejects.toThrow("revoked")
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
