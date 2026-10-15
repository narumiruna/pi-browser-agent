import type { TabContext } from "./runtime/types.js"

export const ELEMENT_PICKER_COMMAND = "toggle-element-picker"
export const ELEMENT_PICKER_PORT = "element-picker-shortcut"
export const SHORTCUT_INTENT_LIFETIME_MS = 10_000

type Intent = {
  id: string
  tab: chrome.tabs.Tab
  expiresAt: number
  delivered: boolean
  opened: boolean
}

/** A command gesture opens the panel; a ready panel acknowledges one bounded intent. */
export function installElementPickerShortcut(options: {
  validate: (tab: chrome.tabs.Tab) => Promise<TabContext | undefined>
  stop: (windowId: number) => void
}): { invalidate: (tabId?: number) => void } {
  let pending: Intent | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const panels = new Map<number, chrome.runtime.Port>()

  function clear(): void {
    pending = undefined
    clearTimeout(timer)
    timer = undefined
  }

  function report(port: chrome.runtime.Port, message: string): void {
    try {
      port.postMessage({ kind: "error", message })
    } catch {
      // A closing panel cannot display an error.
    }
  }

  async function deliver(windowId: number, port: chrome.runtime.Port): Promise<void> {
    const intent = pending
    if (!intent || intent.tab.windowId !== windowId || intent.delivered || !intent.opened) return
    if (Date.now() >= intent.expiresAt) {
      clear()
      return
    }
    try {
      const context = await options.validate(intent.tab)
      if (pending !== intent || panels.get(windowId) !== port) return
      if (Date.now() >= intent.expiresAt) {
        clear()
        return
      }
      if (!context) {
        clear()
        report(port, "Open a supported HTTP or HTTPS page before selecting an element")
        return
      }
      // Mark before posting. A second command must cancel a delivered start, not erase it.
      intent.delivered = true
      port.postMessage({ kind: "toggle", id: intent.id, tabContext: context })
    } catch {
      if (pending !== intent) return
      clear()
      report(port, "The page changed before element selection could start. Try again.")
    }
  }

  chrome.commands.onCommand.addListener((command, tab) => {
    if (
      command !== ELEMENT_PICKER_COMMAND ||
      tab?.id === undefined ||
      !tab.url ||
      !Number.isSafeInteger(tab.windowId) ||
      tab.windowId < 0
    )
      return
    // Do not put an await before open(): it must retain the command's user gesture.
    const opening = chrome.sidePanel.open({ windowId: tab.windowId })
    if (pending && !pending.delivered) {
      clear() // Two presses during panel startup cancel the pending start.
    } else {
      clear()
      const intent: Intent = {
        id: crypto.randomUUID(),
        tab: { ...tab },
        expiresAt: Date.now() + SHORTCUT_INTENT_LIFETIME_MS,
        delivered: false,
        opened: false,
      }
      pending = intent
      timer = setTimeout(clear, SHORTCUT_INTENT_LIFETIME_MS)
    }
    const intent = pending
    void opening
      .then(() => {
        if (!intent || pending !== intent) return
        intent.opened = true
        const port = panels.get(tab.windowId)
        if (port) void deliver(tab.windowId, port)
      })
      .catch(() => {
        if (pending !== intent) return
        clear()
        const port = panels.get(tab.windowId)
        if (port)
          report(port, "Could not open Pi Browser Agent. Open it from the extension button.")
      })
  })

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== ELEMENT_PICKER_PORT) return
    const panelPath = chrome.runtime.getManifest().side_panel?.default_path
    const senderUrl = port.sender?.url?.split(/[?#]/, 1)[0]
    if (
      port.sender?.id !== chrome.runtime.id ||
      !panelPath ||
      senderUrl !== chrome.runtime.getURL(panelPath)
    ) {
      port.disconnect()
      return
    }
    let windowId: number | undefined
    port.onMessage.addListener((message: unknown) => {
      if (typeof message !== "object" || message === null) return
      const value = message as Record<string, unknown>
      if (value.kind === "ready" && windowId === undefined) {
        if (
          !Number.isSafeInteger(value.windowId) ||
          (value.windowId as number) < 0 ||
          (port.sender?.tab && port.sender.tab.windowId !== value.windowId)
        ) {
          port.disconnect()
          return
        }
        windowId = value.windowId as number
        const previous = panels.get(windowId)
        panels.set(windowId, port)
        previous?.disconnect()
        void deliver(windowId, port)
      } else if (
        value.kind === "ack" &&
        windowId !== undefined &&
        panels.get(windowId) === port &&
        pending?.tab.windowId === windowId &&
        pending?.id === value.id
      ) {
        clear()
      }
    })
    port.onDisconnect.addListener(() => {
      if (windowId === undefined || panels.get(windowId) !== port) return
      panels.delete(windowId)
      if (pending?.tab.windowId === windowId) clear()
      options.stop(windowId)
    })
  })

  // Navigation, activation and window changes invalidate the original command target.
  // Worker restart also drops pending intents; reconnecting never replays old commands.
  return {
    invalidate(tabId) {
      if (tabId === undefined || pending?.tab.id === tabId) clear()
    },
  }
}
