import { hasApprovedHostPermission } from "../permissions.js"
import { restrictLocalStorageToTrustedContexts } from "../storage.js"
import { withExclusiveStorageWrite } from "../storage-lock.js"
import { MCP_LIMITS, mcpEndpoint } from "./policy.js"

export const MCP_SERVERS_KEY = "piBrowserAgentMcpServersV1"
export const MCP_TOKENS_KEY = "piBrowserAgentMcpTokensV1"
const LOCK = "pi-browser-agent-mcp-write"

export interface McpServer {
  id: string
  revision: string
  name: string
  endpoint: string
  enabled: boolean
  approved: boolean
  hasToken: boolean
}
interface TokenRecord {
  endpoint: string
  revision: string
  token: string
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/

function serversFrom(value: unknown): McpServer[] {
  try {
    const record = value as { version: number; servers: McpServer[] }
    if (record?.version !== 1 || !Array.isArray(record.servers)) return []
    if (record.servers.length > MCP_LIMITS.servers) return []
    const ids = new Set<string>()
    for (const server of record.servers) {
      if (
        !server ||
        !uuid.test(server.id) ||
        !uuid.test(server.revision) ||
        ids.has(server.id) ||
        typeof server.name !== "string" ||
        !server.name.trim() ||
        server.name.length > 80 ||
        typeof server.enabled !== "boolean" ||
        typeof server.approved !== "boolean" ||
        typeof server.hasToken !== "boolean" ||
        mcpEndpoint(server.endpoint) !== server.endpoint
      )
        return []
      ids.add(server.id)
    }
    return record.servers.map(({ id, revision, name, endpoint, enabled, approved, hasToken }) => ({
      id,
      revision,
      name,
      endpoint,
      enabled,
      approved,
      hasToken,
    }))
  } catch {
    return []
  }
}

function writableServers(value: unknown): McpServer[] {
  const servers = serversFrom(value)
  const record = value as { version?: unknown; servers?: unknown[] } | undefined
  if (
    value !== undefined &&
    (record?.version !== 1 ||
      !Array.isArray(record.servers) ||
      record.servers.length !== servers.length)
  ) {
    throw new Error("Saved MCP configuration is invalid; no records were changed")
  }
  return servers
}

function tokensFrom(value: unknown): Record<string, TokenRecord> {
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1) return {}
  const tokens = (value as { tokens?: unknown }).tokens
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return {}
  return Object.fromEntries(
    Object.entries(tokens).filter(([id, entry]) => {
      const item = entry as TokenRecord
      return (
        uuid.test(id) &&
        item &&
        typeof item.endpoint === "string" &&
        uuid.test(item.revision) &&
        typeof item.token === "string" &&
        validToken(item.token)
      )
    }),
  )
}

function writableTokens(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  const record = value as { version?: unknown; tokens?: unknown } | null
  if (
    record?.version !== 1 ||
    !record.tokens ||
    typeof record.tokens !== "object" ||
    Array.isArray(record.tokens)
  ) {
    throw new Error("Saved MCP token storage is invalid; no records were changed")
  }
  return { ...record.tokens }
}

function validToken(token: string): boolean {
  return token.length <= 4096 && /^[A-Za-z0-9._~+/-]+=*$/.test(token)
}

export async function listMcpServers(): Promise<McpServer[]> {
  return serversFrom((await chrome.storage.local.get(MCP_SERVERS_KEY))[MCP_SERVERS_KEY])
}

/** Empty token removes authentication. Tokens are never returned to the settings UI. */
export async function saveMcpServer(input: {
  id?: string
  name: string
  endpoint: string
  token?: string
}): Promise<McpServer> {
  const endpoint = mcpEndpoint(input.endpoint)
  const name = input.name.trim()
  if (!name || name.length > 80)
    throw new Error("Enter an MCP server name of at most 80 characters")
  if (input.token && !validToken(input.token)) throw new Error("Invalid MCP bearer token")
  await restrictLocalStorageToTrustedContexts()
  return withExclusiveStorageWrite(LOCK, async () => {
    const stored = await chrome.storage.local.get([MCP_SERVERS_KEY, MCP_TOKENS_KEY])
    const servers = writableServers(stored[MCP_SERVERS_KEY])
    const previous = servers.find((server) => server.id === input.id)
    if (input.id && !previous) throw new Error("MCP server no longer exists")
    if (!previous && servers.length >= MCP_LIMITS.servers)
      throw new Error("MCP server limit reached")
    const server: McpServer = {
      id: previous?.id ?? crypto.randomUUID(),
      revision: crypto.randomUUID(),
      name,
      endpoint,
      enabled: false,
      approved: false,
      hasToken: false,
    }
    const tokens = writableTokens(stored[MCP_TOKENS_KEY])
    const previousToken = tokensFrom(stored[MCP_TOKENS_KEY])[server.id]
    if (
      input.token === undefined &&
      previous?.endpoint === endpoint &&
      (previous.hasToken !== Boolean(previousToken) ||
        (previousToken &&
          (previousToken.revision !== previous.revision || previousToken.endpoint !== endpoint)))
    ) {
      throw new Error("Replace or remove the invalid MCP token explicitly")
    }
    const token =
      input.token ?? (previous?.endpoint === endpoint ? previousToken?.token : undefined)
    server.hasToken = Boolean(token)
    delete tokens[server.id]
    if (token) tokens[server.id] = { endpoint, revision: server.revision, token }
    await chrome.storage.local.set({
      [MCP_SERVERS_KEY]: {
        version: 1,
        servers: [...servers.filter((s) => s.id !== server.id), server],
      },
      [MCP_TOKENS_KEY]: { version: 1, tokens },
    })
    return server
  })
}

export async function setMcpConnection(
  id: string,
  connect: boolean,
  revision?: string,
): Promise<McpServer> {
  return withExclusiveStorageWrite(LOCK, async () => {
    const servers = await listMcpServers()
    const server = servers.find((item) => item.id === id)
    if (!server) throw new Error("MCP server no longer exists")
    if ((connect || revision !== undefined) && revision !== server.revision)
      throw new Error("MCP server changed before connection approval")
    if (connect && !(await hasApprovedHostPermission(server.endpoint))) {
      throw new Error("MCP host access is required")
    }
    server.enabled = connect
    server.approved = connect
    await chrome.storage.local.set({ [MCP_SERVERS_KEY]: { version: 1, servers } })
    return server
  })
}

export async function removeMcpServer(id: string): Promise<void> {
  await withExclusiveStorageWrite(LOCK, async () => {
    const stored = await chrome.storage.local.get([MCP_SERVERS_KEY, MCP_TOKENS_KEY])
    const tokens = writableTokens(stored[MCP_TOKENS_KEY])
    delete tokens[id]
    await chrome.storage.local.set({
      [MCP_SERVERS_KEY]: {
        version: 1,
        servers: writableServers(stored[MCP_SERVERS_KEY]).filter((s) => s.id !== id),
      },
      [MCP_TOKENS_KEY]: { version: 1, tokens },
    })
  })
}

/** Read only in a trusted MCP client, never in worker messages or model context. */
export async function mcpAccess(snapshot: McpServer): Promise<string | undefined> {
  const stored = await chrome.storage.local.get([MCP_SERVERS_KEY, MCP_TOKENS_KEY])
  const current = serversFrom(stored[MCP_SERVERS_KEY]).find((s) => s.id === snapshot.id)
  if (
    !current?.enabled ||
    !current.approved ||
    current.revision !== snapshot.revision ||
    current.endpoint !== snapshot.endpoint ||
    current.hasToken !== snapshot.hasToken ||
    !(await hasApprovedHostPermission(current.endpoint))
  ) {
    throw new Error("MCP connection changed or access was revoked")
  }
  const tokenStore = stored[MCP_TOKENS_KEY] as { version?: unknown; tokens?: unknown } | undefined
  if (
    tokenStore &&
    (tokenStore.version !== 1 ||
      !tokenStore.tokens ||
      typeof tokenStore.tokens !== "object" ||
      Array.isArray(tokenStore.tokens))
  ) {
    throw new Error("MCP authentication configuration is invalid")
  }
  const token = tokensFrom(stored[MCP_TOKENS_KEY])[current.id]
  if (
    current.hasToken !== Boolean(token) ||
    (token && (token.endpoint !== current.endpoint || token.revision !== current.revision))
  ) {
    throw new Error("MCP authentication configuration is invalid")
  }
  // Fail closed if a stored token entry was corrupted instead of sending unauthenticated requests.
  const raw = stored[MCP_TOKENS_KEY] as { tokens?: Record<string, unknown> } | undefined
  if (raw?.tokens && Object.hasOwn(raw.tokens, current.id) && !token) {
    throw new Error("MCP authentication configuration is invalid")
  }
  return token?.token
}
