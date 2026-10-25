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
import { hasApprovedHostPermission, requestHostPermission } from "../permissions.js"
import type { ConfirmSettingsAction } from "./settings-confirmation.js"
import { element } from "./ui.js"

/** MCP changes save independently; stored tokens never populate form fields or previews. */
export async function initializeMcpSettings(
  confirm: ConfirmSettingsAction,
): Promise<() => boolean> {
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
  let activeId = ""
  let saving = false

  function hasDraft(): boolean {
    const server = servers.find((s) => s.id === activeId)
    return (
      name.value !== (server?.name ?? "") ||
      endpoint.value !== (server?.endpoint ?? "") ||
      Boolean(token.value) ||
      clearToken.checked
    )
  }
  function updateControls(): void {
    const server = servers.find((s) => s.id === activeId)
    connect.disabled = busy || !server || hasDraft()
    disable.disabled = remove.disabled = busy || !server
    save.disabled = select.disabled = busy
    for (const input of [name, endpoint, token, clearToken]) input.disabled = busy
  }
  function fill(): void {
    const server = servers.find((s) => s.id === activeId)
    name.value = server?.name ?? ""
    endpoint.value = server?.endpoint ?? ""
    token.value = ""
    clearToken.checked = false
    preview.textContent = ""
    status.textContent = server
      ? server.enabled
        ? "Enabled for new runs; each call requires confirmation"
        : "Disabled"
      : "New server"
    updateControls()
  }
  async function refresh(id = activeId): Promise<void> {
    servers = await listMcpServers()
    if (disposed) return
    select.replaceChildren(
      new Option("New server", ""),
      ...servers.map((s) => new Option(s.name, s.id)),
    )
    activeId = servers.some((s) => s.id === id) ? id : ""
    select.value = activeId
    fill()
  }
  async function perform(action: () => Promise<void>): Promise<void> {
    if (busy || disposed) return
    const previousStatus = status.textContent
    const previousFocus = document.activeElement as HTMLElement | null
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
        if (status.textContent === "Working…") status.textContent = previousStatus
        updateControls()
        if (
          previousFocus?.isConnected &&
          !previousFocus.closest("[hidden]") &&
          !previousFocus.hasAttribute("disabled")
        )
          previousFocus.focus()
      }
    }
  }
  select.addEventListener("change", () => {
    const nextId = select.value
    // The browser has already changed the select, but the fields still belong to activeId.
    select.value = activeId
    if (busy || disposed || nextId === activeId) return
    if (!hasDraft()) {
      activeId = nextId
      select.value = activeId
      fill()
      return
    }
    void perform(async () => {
      const server = servers.find((s) => s.id === activeId)
      const discard = await confirm({
        title: "Discard MCP changes?",
        message: `Discard unsaved changes to ${server ? `“${server.name}”` : "the new server"}?`,
        confirmLabel: "Discard changes",
      })
      if (!discard || disposed) return
      activeId = nextId
      select.value = activeId
      fill()
    })
  })
  for (const input of [name, endpoint, token, clearToken])
    input.addEventListener("input", updateControls)
  save.addEventListener("click", () => {
    if (busy || disposed) return
    const input = {
      id: activeId || undefined,
      revision: servers.find((server) => server.id === activeId)?.revision,
      name: name.value,
      endpoint: endpoint.value,
      token: clearToken.checked ? "" : token.value || undefined,
    }
    void perform(async () => {
      saving = true
      try {
        const server = await saveMcpServer(input)
        await refresh(server.id)
        status.textContent =
          "Saved disconnected. Select Test and enable to make tools available for new runs."
      } finally {
        saving = false
      }
    })
  })
  connect.addEventListener("click", () => {
    const server = servers.find((s) => s.id === activeId)
    if (!server || busy || disposed || connect.disabled) return
    // Chrome's optional permission request must start in this click gesture.
    const permission = requestHostPermission(server.endpoint)
    void perform(async () => {
      if (!(await permission) || disposed) throw new Error(MCP_FAILURE)
      const previewServer = await setMcpConnection(server.id, false, server.revision)
      connection?.close()
      connection = new McpConnection(previewServer, "preview")
      try {
        if (disposed) throw new Error(MCP_FAILURE)
        const tools = await connection.discover()
        await connection.disconnect()
        if (disposed) throw new Error(MCP_FAILURE)
        await setMcpConnection(previewServer.id, true, previewServer.revision)
        await refresh(server.id)
        preview.textContent =
          tools.map((tool) => `${tool.name}\n${tool.description ?? ""}`).join("\n\n") ||
          "No tools returned"
        status.textContent =
          "Enabled for new runs. Tool metadata and results can go to the selected model."
      } catch (error) {
        await refresh(server.id)
        throw error instanceof McpConfigurationError ? error : new Error(MCP_FAILURE)
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
        const server = servers.find((item) => item.id === activeId)
        if (!server) return
        if (
          hasDraft() &&
          !(await confirm({
            title: "Discard MCP changes and disable?",
            message: `Discard unsaved changes to “${server.name}” and disable the saved server?`,
            confirmLabel: "Discard and disable",
          }))
        )
          return
        if (disposed) return
        await setMcpConnection(server.id, false, server.revision)
        await refresh(server.id)
      }),
  )
  remove.addEventListener(
    "click",
    () =>
      void perform(async () => {
        const server = servers.find((item) => item.id === activeId)
        if (!server) return
        const confirmed = await confirm({
          title: "Remove MCP server and token?",
          message: `Remove “${server.name}”? Its stored token will be deleted.${hasDraft() ? " Unsaved changes will be discarded." : ""}`,
          confirmLabel: "Remove server and token",
        })
        if (!confirmed || disposed) return
        await removeMcpServer(server.id, server.revision)
        await refresh("")
      }),
  )
  const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== "local" || !connection) return
    if (MCP_TOKENS_KEY in changes && !(MCP_SERVERS_KEY in changes)) connection.close()
    if (MCP_SERVERS_KEY in changes) {
      const record = changes[MCP_SERVERS_KEY].newValue as { servers?: McpServer[] } | undefined
      const records = record?.servers
      const current = Array.isArray(records)
        ? records.find((s) => s?.id === connection?.server.id)
        : undefined
      if (
        !current ||
        current.enabled !== connection.server.enabled ||
        current.approved !== connection.server.approved ||
        current.revision !== connection.server.revision
      )
        connection.close()
    }
  }
  const revoked = (removed: chrome.permissions.Permissions) => {
    if (!removed.origins?.length || !connection) return
    const current = connection
    void hasApprovedHostPermission(current.server.endpoint)
      .then((allowed) => {
        if (!allowed) current.close()
      })
      .catch(() => current.close())
  }
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
  return () => saving || hasDraft()
}
