import { ELEMENT_PICKER_COMMAND, ELEMENT_PICKER_PORT } from "../element-picker-shortcut.js"
import { t } from "../i18n/index.js"
import type { TabContext } from "../runtime/types.js"

export function pickerButtonTitle(active: boolean, shortcut: string): string {
  if (shortcut) {
    return active
      ? t("Cancel element selection ({shortcut})", { shortcut })
      : t("Select page element ({shortcut})", { shortcut })
  }
  return active ? t("Cancel element selection") : t("Select page element")
}

/** Connect only after the conversation is ready. Reconnect after MV3 worker suspension. */
export async function connectElementPickerShortcut(options: {
  toggle: (context: TabContext) => Promise<void>
  error: (error: unknown) => void
  disconnected: () => void
}): Promise<() => void> {
  const { id: windowId } = await chrome.windows.getCurrent()
  if (windowId === undefined) return () => undefined
  let stopped = false
  let port: chrome.runtime.Port | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  const seen = new Set<string>()

  function connect(): void {
    if (stopped) return
    try {
      const connection = chrome.runtime.connect({ name: ELEMENT_PICKER_PORT })
      port = connection
      connection.onMessage.addListener((message) => {
        if (stopped || port !== connection) return
        if (message?.kind === "error" && typeof message.message === "string") {
          options.error(new Error(message.message))
          return
        }
        const context = message?.tabContext
        if (
          message?.kind !== "toggle" ||
          typeof message.id !== "string" ||
          !context ||
          !Number.isSafeInteger(context.tabId) ||
          !Number.isSafeInteger(context.epoch) ||
          typeof context.url !== "string"
        ) {
          return
        }
        try {
          connection.postMessage({ kind: "ack", id: message.id })
        } catch {
          // Do not start an action whose handoff could not be acknowledged.
          return
        }
        if (seen.has(message.id)) return
        seen.add(message.id)
        if (seen.size > 32) seen.delete(seen.values().next().value as string)
        void options.toggle(context).catch(options.error)
      })
      connection.onDisconnect.addListener(() => {
        // Read lastError to consume Chrome's disconnected-worker diagnostic.
        void chrome.runtime.lastError
        if (stopped || port !== connection) return
        options.disconnected()
        retry = setTimeout(connect, 250)
      })
      connection.postMessage({ kind: "ready", windowId })
    } catch (error) {
      options.error(error)
    }
  }
  connect()
  return () => {
    stopped = true
    clearTimeout(retry)
    port?.disconnect()
  }
}

export async function assignedPickerShortcut(): Promise<string> {
  const commands = await chrome.commands.getAll()
  return commands.find((command) => command.name === ELEMENT_PICKER_COMMAND)?.shortcut ?? ""
}
