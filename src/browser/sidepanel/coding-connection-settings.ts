import {
  LOCAL_API_VERSION,
  type LocalApi,
  type LocalConnection,
  localResponse,
  parseLocalRequest,
  TaskError,
} from "../coding-agent/protocol.js"
import {
  approveLocalConnection,
  CODING_CONNECTION_KEY,
  disconnectLocalConnection,
  getLocalConnection,
  requestLocalConnection,
} from "../coding-agent/store.js"
import { t } from "../i18n/index.js"
import type { ConfirmSettingsAction } from "./settings-confirmation.js"
import { element, type SettingsSectionState } from "./ui.js"

/** Local consent only. No network request, token, filesystem access, or process lives here. */
export async function initializeCodingConnectionSettings(
  confirm: ConfirmSettingsAction,
  onStateChange: () => void = () => {},
): Promise<SettingsSectionState> {
  const allow = element<HTMLButtonElement>("coding-allow")
  const disconnect = element<HTMLButtonElement>("coding-disconnect")
  const status = element<HTMLElement>("coding-status")
  const ownerWindow = (await chrome.windows.getCurrent()).id
  if (ownerWindow === undefined) throw new TaskError("Local Settings window is unavailable")
  let current: LocalConnection | undefined
  let ownPending: LocalConnection | undefined
  let actionFailed = false
  let busy = false
  let disposed = false
  let refreshGeneration = 0
  const lifetime = new AbortController()

  function render(): void {
    const owned = current?.windowId === ownerWindow ? current : undefined
    allow.hidden = owned?.state !== "pending"
    allow.disabled = busy || allow.hidden
    disconnect.hidden = !owned || owned.state === "rejected"
    disconnect.disabled = busy || disconnect.hidden
    status.textContent = actionFailed
      ? t("Local connection failed or was interrupted; no operation was retried.")
      : owned?.state === "approved"
        ? t("Connected to local Pi Coding Agent")
        : owned?.state === "pending"
          ? t("Waiting for local approval")
          : owned?.state === "rejected"
            ? t("Local connection rejected")
            : t("No local connection request")
    onStateChange()
  }

  async function refresh(): Promise<void> {
    const generation = ++refreshGeneration
    try {
      const value = await getLocalConnection()
      if (disposed || generation !== refreshGeneration) return
      current = value
      render()
    } catch {
      if (disposed || generation !== refreshGeneration) return
      actionFailed = true
      render()
      allow.disabled = disconnect.disabled = true
    }
  }

  async function perform(action: () => Promise<void>): Promise<void> {
    if (busy || disposed) return
    const previousFocus = document.activeElement as HTMLElement | null
    busy = true
    actionFailed = false
    render()
    try {
      await action()
    } catch {
      actionFailed = true
    } finally {
      busy = false
      if (!disposed) {
        await refresh()
        if (
          document.activeElement === document.body ||
          document.activeElement === previousFocus ||
          document.activeElement?.closest("dialog:not([open])")
        ) {
          const target = [previousFocus, disconnect, allow].find(
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

  const handleAllow = (): void => {
    const selected = current
    if (disposed || busy || allow.disabled || !selected || selected.windowId !== ownerWindow) return
    // Opening the Side Panel must start in this real button gesture, never from CDP.
    let opened: Promise<void>
    try {
      opened = chrome.sidePanel.open({ windowId: ownerWindow })
    } catch {
      actionFailed = true
      render()
      return
    }
    void opened.catch(() => {})
    void perform(async () => {
      const approved = await confirm({
        title: t("Allow local Coding Agent?"),
        message: t(
          "Allow this local Pi Coding Agent to start tasks automatically when Browser Agent is idle and the composer is empty? No task confirmation or Send is required. Model-provider access, site access, and action confirmations still apply. Disconnect to revoke this permission.",
        ),
        confirmLabel: t("Allow local connection"),
      })
      if (!approved) return
      lifetime.signal.throwIfAborted()
      await opened
      lifetime.signal.throwIfAborted()
      const allowed = await approveLocalConnection(selected, lifetime.signal)
      if (lifetime.signal.aborted) {
        await disconnectLocalConnection(allowed).catch(() => {})
        return
      }
      current = allowed
    })
  }
  const handleDisconnect = (): void => {
    const selected = current
    if (disposed || busy || disconnect.disabled || !selected || selected.windowId !== ownerWindow)
      return
    void perform(async () => {
      if (
        !(await confirm({
          title: t("Disconnect local Coding Agent?"),
          message: t("Disconnect cancels delegated work but does not undo completed actions."),
          confirmLabel: t("Disconnect local Coding Agent"),
        }))
      )
        return
      lifetime.signal.throwIfAborted()
      current = await disconnectLocalConnection(selected)
    })
  }
  allow.addEventListener("click", handleAllow)
  disconnect.addEventListener("click", handleDisconnect)

  const api: LocalApi = Object.freeze({
    version: LOCAL_API_VERSION,
    role: "settings" as const,
    async dispatch(value: unknown) {
      try {
        lifetime.signal.throwIfAborted()
        const request = parseLocalRequest(value)
        if (request.method === "connect") {
          const result = await requestLocalConnection(request.clientId, ownerWindow)
          if (result.state === "pending") {
            ownPending = result
            if (disposed) await disconnectLocalConnection(result).catch(() => {})
          }
          lifetime.signal.throwIfAborted()
          await refresh()
          return localResponse({ ok: true, value: result })
        }
        if (request.method === "status") {
          const result = await getLocalConnection()
          lifetime.signal.throwIfAborted()
          return localResponse({
            ok: true,
            value:
              result?.clientId === request.clientId && result.windowId === ownerWindow
                ? result
                : null,
          })
        }
        if (request.method === "disconnect" && request.generation) {
          const snapshot = await getLocalConnection()
          if (
            !snapshot ||
            snapshot.clientId !== request.clientId ||
            snapshot.generation !== request.generation ||
            snapshot.windowId !== ownerWindow ||
            (snapshot.state !== "pending" && snapshot.state !== "approved")
          )
            throw new TaskError("Local connection changed")
          lifetime.signal.throwIfAborted()
          const result = await disconnectLocalConnection(snapshot)
          await refresh()
          return localResponse({ ok: true, value: result })
        }
        throw new TaskError("Task operations require the conversation Side Panel")
      } catch {
        return localResponse({
          ok: false,
          error: "Local connection request failed or is no longer approved",
        })
      }
    },
  })
  window.__piBrowserLocal = api
  const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area === "session" && CODING_CONNECTION_KEY in changes && !disposed) void refresh()
  }
  chrome.storage.onChanged.addListener(changed)
  window.addEventListener(
    "pagehide",
    () => {
      disposed = true
      lifetime.abort()
      refreshGeneration++
      // The store compares the complete pending snapshot under its lock. Never revoke
      // an approved generation or a replacement owned by another Settings page.
      if (ownPending) void disconnectLocalConnection(ownPending).catch(() => {})
      ownPending = undefined
      chrome.storage.onChanged.removeListener(changed)
      allow.removeEventListener("click", handleAllow)
      disconnect.removeEventListener("click", handleDisconnect)
      if (window.__piBrowserLocal === api) delete window.__piBrowserLocal
      onStateChange()
    },
    { once: true },
  )
  await refresh()
  return { hasDraft: () => false, isBusy: () => busy && !disposed }
}
