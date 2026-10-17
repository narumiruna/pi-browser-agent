import { McpConnection } from "../mcp/client.js"
import { MCP_FAILURE, McpConfigurationError } from "../mcp/policy.js"
import {
  listMcpServers,
  MCP_SERVERS_KEY,
  MCP_TOKENS_KEY,
  type McpServer,
  removeMcpServer,
  saveMcpServer,
  setMcpConnection,
} from "../mcp/store.js"
import { requestHostPermission } from "../permissions.js"
import { element } from "./ui.js"

/** MCP changes save independently; tokens never populate form fields or preview output. */
export async function initializeMcpSettings(): Promise<void> {
  const select = element<HTMLSelectElement>("mcp-server")
  const name = element<HTMLInputElement>("mcp-name")
  const endpoint = element<HTMLInputElement>("mcp-endpoint")
  const token = element<HTMLInputElement>("mcp-token")
  const clearToken = element<HTMLInputElement>("mcp-clear-token")
  const status = element<HTMLElement>("mcp-status")
  const preview = element<HTMLElement>("mcp-tools")
  const save = element<HTMLButtonElement>("mcp-save")
  const connect = element<HTMLButtonElement>("mcp-connect")
  const disable = element<HTMLButtonElement>("mcp-disable")
  const remove = element<HTMLButtonElement>("mcp-remove")
  let servers: McpServer[] = []
  let connection: McpConnection | undefined
  let busy = false
  let disposed = false

  function updateControls(): void {
    const server = servers.find((s) => s.id === select.value)
    const dirty =
      !server ||
      name.value.trim() !== server.name ||
      endpoint.value !== server.endpoint ||
      Boolean(token.value) ||
      clearToken.checked
    connect.disabled = busy || dirty
    disable.disabled = remove.disabled = busy || !server
    save.disabled = select.disabled = busy
    for (const input of [name, endpoint, token, clearToken]) input.disabled = busy
  }
  function fill(): void {
    const server = servers.find((s) => s.id === select.value)
    name.value = server?.name ?? ""
    endpoint.value = server?.endpoint ?? ""
    token.value = ""
    clearToken.checked = false
    preview.textContent = ""
    status.textContent = server
      ? server.enabled
        ? "Enabled; each call requires confirmation"
        : "Disconnected"
      : "New server"
    updateControls()
  }
  async function refresh(id = select.value): Promise<void> {
    servers = await listMcpServers()
    if (disposed) return
    select.replaceChildren(
      new Option("New server", ""),
      ...servers.map((s) => new Option(s.name, s.id)),
    )
    select.value = servers.some((s) => s.id === id) ? id : ""
    fill()
  }
  async function perform(action: () => Promise<void>): Promise<void> {
    if (busy || disposed) return
    busy = true
    updateControls()
    status.textContent = "Working…"
    try {
      await action()
    } catch (error) {
      status.textContent = error instanceof McpConfigurationError ? error.message : MCP_FAILURE
    } finally {
      busy = false
      if (!disposed) {
        updateControls()
      }
    }
  }
  select.addEventListener("change", fill)
  for (const input of [name, endpoint, token, clearToken])
    input.addEventListener("input", updateControls)
  save.addEventListener("click", () => {
    const input = {
      id: select.value || undefined,
      revision: servers.find((server) => server.id === select.value)?.revision,
      name: name.value,
      endpoint: endpoint.value,
      token: clearToken.checked ? "" : token.value || undefined,
    }
    token.value = ""
    void perform(async () => {
      const server = await saveMcpServer(input)
      await refresh(server.id)
      status.textContent = "Saved disconnected. Select Connect and preview to enable."
    })
  })
  connect.addEventListener("click", () => {
    const server = servers.find((s) => s.id === select.value)
    if (!server || busy || connect.disabled) return
    // Chrome's optional permission request must start in this click gesture.
    const permission = requestHostPermission(server.endpoint)
    void perform(async () => {
      if (!(await permission) || disposed) throw new Error(MCP_FAILURE)
      const approved = await setMcpConnection(server.id, true, server.revision)
      connection?.close()
      connection = new McpConnection(approved)
      try {
        if (disposed) throw new Error(MCP_FAILURE)
        const tools = await connection.discover()
        await connection.disconnect()
        await refresh(server.id)
        preview.textContent =
          tools.map((tool) => `${tool.name}\n${tool.description ?? ""}`).join("\n\n") ||
          "No tools returned"
        status.textContent =
          "Connected and enabled. Tool metadata and results can go to the selected model."
      } catch {
        await setMcpConnection(approved.id, false, approved.revision).catch(() => undefined)
        await refresh(server.id)
        throw new Error(MCP_FAILURE)
      } finally {
        await connection.disconnect()
        connection = undefined
      }
    })
  })
  disable.addEventListener(
    "click",
    () =>
      void perform(async () => {
        await setMcpConnection(select.value, false)
        await refresh()
      }),
  )
  remove.addEventListener(
    "click",
    () =>
      void perform(async () => {
        await removeMcpServer(select.value)
        await refresh("")
      }),
  )
  const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== "local" || !connection) return
    if (MCP_TOKENS_KEY in changes) connection.close()
    if (MCP_SERVERS_KEY in changes) {
      const record = changes[MCP_SERVERS_KEY].newValue as { servers?: McpServer[] } | undefined
      const records = record?.servers
      const current = Array.isArray(records)
        ? records.find((s) => s?.id === connection?.server.id)
        : undefined
      if (!current?.enabled || !current.approved || current.revision !== connection.server.revision)
        connection.close()
    }
  }
  const revoked = () => connection?.close()
  chrome.storage.onChanged.addListener(changed)
  chrome.permissions.onRemoved.addListener(revoked)
  window.addEventListener(
    "pagehide",
    () => {
      disposed = true
      connection?.close()
      token.value = ""
      chrome.storage.onChanged.removeListener(changed)
      chrome.permissions.onRemoved.removeListener(revoked)
    },
    { once: true },
  )
  await refresh()
}
