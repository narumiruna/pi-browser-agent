import { McpConnection } from "../mcp/client.js"
import { MCP_FAILURE, MCP_LIMITS, McpConfigurationError } from "../mcp/policy.js"
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
import { element, type SettingsSectionState } from "./ui.js"

/** MCP changes save independently; stored tokens never populate form fields or previews. */
export async function initializeMcpSettings(
  confirm: ConfirmSettingsAction,
  onStateChange: () => void = () => {},
): Promise<SettingsSectionState> {
  const list = element<HTMLUListElement>("mcp-servers")
  const empty = element<HTMLElement>("mcp-empty")
  const create = element<HTMLButtonElement>("mcp-new")
  const title = element<HTMLElement>("mcp-editor-title")
  const hint = element<HTMLElement>("mcp-action-hint")
  const danger = element<HTMLElement>("mcp-danger-zone")
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

  function clearError(input: HTMLInputElement): void {
    const error = element<HTMLElement>(`${input.id}-error`)
    error.hidden = true
    error.textContent = ""
    input.removeAttribute("aria-invalid")
  }
  function validationField(message: string): HTMLInputElement | undefined {
    // Only fixed local store/policy errors are associated with fields. Never show raw errors.
    if (message === "Enter an MCP server name of at most 80 characters") return name
    if (
      message === "Enter an MCP bearer token of 16 to 4096 characters without spaces" ||
      message === "Replace or remove the invalid MCP token explicitly"
    )
      return token
    if (
      message === "MCP endpoint is too long" ||
      message === "Enter a public HTTPS MCP endpoint" ||
      message === "Use a public HTTPS hostname without credentials, query, or fragment"
    )
      return endpoint
  }

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
    const draft = hasDraft()
    const limitReached = !server && servers.length >= MCP_LIMITS.servers
    connect.hidden = !server || draft
    connect.disabled = busy || !server || draft
    connect.classList.toggle("primary", Boolean(server) && !draft)
    save.classList.toggle("primary", !server || draft)
    save.disabled = busy || (Boolean(server) && !draft) || limitReached
    disable.hidden = !server?.enabled
    disable.disabled = busy || !server?.enabled
    danger.hidden = !server
    remove.disabled = busy || !server
    create.disabled = busy || servers.length >= MCP_LIMITS.servers
    create.setAttribute("aria-pressed", String(!activeId))
    for (const button of list.querySelectorAll<HTMLButtonElement>("button")) {
      button.disabled = busy
      button.setAttribute("aria-pressed", String(button.dataset.serverId === activeId))
    }
    for (const input of [name, endpoint, token, clearToken]) input.disabled = busy
    hint.textContent = busy
      ? "Wait for the current server action to finish."
      : limitReached
        ? "The eight-server limit is reached. Select a saved server to edit or remove it."
        : !server || draft
          ? "Save server edits disconnected before testing. Saving does not request host access."
          : server.enabled
            ? "Enabled for new runs, not a live connection. Test again only to check the saved endpoint."
            : "Test and enable requests host access and checks the saved endpoint. No tool is called."
    onStateChange()
  }
  function renderList(): void {
    list.replaceChildren(
      ...servers.map((server) => {
        const item = document.createElement("li")
        const button = document.createElement("button")
        button.type = "button"
        button.className = "resource-item"
        button.dataset.serverId = server.id
        const text = document.createElement("span")
        text.className = "resource-item-text"
        const label = document.createElement("span")
        label.textContent = server.name
        const address = document.createElement("small")
        address.textContent = server.endpoint
        text.append(label, address)
        const state = document.createElement("span")
        state.className = "state-badge"
        state.textContent = server.enabled ? "Enabled" : "Disabled"
        button.append(text, state)
        button.addEventListener("click", () => choose(server.id))
        item.append(button)
        return item
      }),
    )
    empty.hidden = servers.length > 0
  }
  function fill(): void {
    const server = servers.find((s) => s.id === activeId)
    name.value = server?.name ?? ""
    endpoint.value = server?.endpoint ?? ""
    token.value = ""
    clearToken.checked = false
    preview.textContent = ""
    for (const input of [name, endpoint, token]) clearError(input)
    title.textContent = server ? `Edit ${server.name}` : "New server"
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
    activeId = servers.some((s) => s.id === id) ? id : ""
    renderList()
    fill()
  }
  async function perform(
    action: () => Promise<void>,
    validate = false,
    progress = "Working…",
  ): Promise<void> {
    if (busy || disposed) return
    const previousStatus = status.textContent
    const previousFocus = document.activeElement as HTMLElement | null
    let invalidField: HTMLInputElement | undefined
    busy = true
    updateControls()
    status.textContent = progress
    try {
      await action()
    } catch (error) {
      if (disposed) return
      status.textContent = error instanceof McpConfigurationError ? error.message : MCP_FAILURE
      if (validate && error instanceof McpConfigurationError) {
        invalidField = validationField(error.message)
        if (invalidField) {
          const localError = element<HTMLElement>(`${invalidField.id}-error`)
          localError.textContent = error.message
          localError.hidden = false
          invalidField.setAttribute("aria-invalid", "true")
        }
      }
    } finally {
      busy = false
      if (!disposed) {
        if (status.textContent === progress) status.textContent = previousStatus
        updateControls()
        // A closed confirmation can leave focus on its now-hidden Cancel button.
        const focused = document.activeElement
        const lostFocus =
          focused === document.body ||
          focused === previousFocus ||
          focused?.closest("dialog:not([open])")
        // Restore lost focus, but do not take it back after the user moves elsewhere.
        if ((invalidField || (previousFocus && previousFocus !== document.body)) && lostFocus) {
          const selectedButton = [...list.querySelectorAll<HTMLButtonElement>("button")].find(
            (button) => button.dataset.serverId === activeId,
          )
          const target = [invalidField, previousFocus, connect, selectedButton, create, name].find(
            (candidate) =>
              candidate?.isConnected &&
              !candidate.closest("[hidden]") &&
              !candidate.hasAttribute("disabled"),
          )
          target?.focus()
        }
      }
    }
  }
  function choose(nextId: string): void {
    if (busy || disposed || nextId === activeId) return
    if (!hasDraft()) {
      activeId = nextId
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
      fill()
    })
  }
  create.addEventListener("click", () => {
    if (!create.disabled) choose("")
  })
  for (const input of [name, endpoint, token, clearToken])
    input.addEventListener("input", () => {
      if (input === clearToken) clearError(token)
      else clearError(input)
      preview.textContent = ""
      status.textContent = hasDraft()
        ? "Unsaved MCP edits. Select Save disconnected."
        : servers.find((server) => server.id === activeId)?.enabled
          ? "Enabled for new runs; each call requires confirmation"
          : activeId
            ? "Disabled"
            : "New server"
      updateControls()
    })
  save.addEventListener("click", () => {
    if (busy || disposed || save.disabled) return
    for (const input of [name, endpoint, token]) clearError(input)
    const input = {
      id: activeId || undefined,
      revision: servers.find((server) => server.id === activeId)?.revision,
      name: name.value,
      endpoint: endpoint.value,
      token: clearToken.checked ? "" : token.value || undefined,
    }
    void perform(
      async () => {
        const server = await saveMcpServer(input)
        await refresh(server.id)
        if (!disposed)
          status.textContent =
            "Saved disconnected. Select Test and enable to make tools available for new runs."
      },
      true,
      "Saving disconnected…",
    )
  })
  connect.addEventListener("click", () => {
    const server = servers.find((s) => s.id === activeId)
    if (!server || busy || disposed || connect.disabled) return
    // Chrome's optional permission request must start in this click gesture.
    const permission = requestHostPermission(server.endpoint)
    void perform(
      async () => {
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
      },
      false,
      "Testing saved endpoint…",
    )
  })
  disable.addEventListener(
    "click",
    () =>
      void perform(async () => {
        const server = servers.find((item) => item.id === activeId)
        if (!server?.enabled) return
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
      onStateChange()
      chrome.storage.onChanged.removeListener(changed)
      chrome.permissions.onRemoved.removeListener(revoked)
    },
    { once: true },
  )
  await refresh()
  return { hasDraft, isBusy: () => busy && !disposed }
}
