import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  ELEMENT_PICKER_COMMAND,
  ELEMENT_PICKER_PORT,
  installElementPickerShortcut,
  SHORTCUT_INTENT_LIFETIME_MS,
} from "../../src/browser/element-picker-shortcut.js"
import { setLanguagePreference, t } from "../../src/browser/i18n/index.js"
import {
  assignedPickerShortcut,
  connectElementPickerShortcut,
  pickerButtonTitle,
} from "../../src/browser/sidepanel/element-picker-shortcut.js"

function event<T extends (...args: never[]) => unknown>() {
  const listeners: T[] = []
  return {
    addListener: (listener: T) => listeners.push(listener),
    emit: (...args: Parameters<T>) => {
      for (const listener of listeners) listener(...args)
    },
  }
}

function makePort(windowId = 3, url = "chrome-extension://extension/panel.html") {
  const port = {
    name: ELEMENT_PICKER_PORT,
    sender: { id: "extension", url, tab: { windowId } },
    onMessage: event<(message: unknown) => void>(),
    onDisconnect: event<() => void>(),
    postMessage: vi.fn(),
    disconnect: vi.fn(),
  }
  port.disconnect.mockImplementation(() => port.onDisconnect.emit())
  return port
}

const tab = { id: 1, windowId: 3, url: "https://example.test/" } as chrome.tabs.Tab
const context = { tabId: 1, url: tab.url as string, epoch: 0 }
let command: ReturnType<typeof event<(name: string, tab?: chrome.tabs.Tab) => void>>
let connected: ReturnType<typeof event<(port: chrome.runtime.Port) => void>>
let open: ReturnType<typeof vi.fn>
let getAll: ReturnType<typeof vi.fn>
let validate: ReturnType<typeof vi.fn<() => Promise<typeof context | undefined>>>
let stop: ReturnType<typeof vi.fn<() => void>>

beforeEach(() => {
  command = event()
  connected = event()
  open = vi.fn(async () => undefined)
  getAll = vi.fn(async () => [{ name: ELEMENT_PICKER_COMMAND, shortcut: "Command+Shift+E" }])
  validate = vi.fn(async () => context)
  stop = vi.fn<() => void>()
  vi.stubGlobal("chrome", {
    commands: { onCommand: command, getAll },
    sidePanel: { open },
    windows: { getCurrent: vi.fn(async () => ({ id: 3 })) },
    runtime: {
      id: "extension",
      onConnect: connected,
      getManifest: () => ({ side_panel: { default_path: "panel.html" } }),
      getURL: (path: string) => `chrome-extension://extension/${path}`,
    },
  })
})

afterEach(() => {
  setLanguagePreference("en")
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function ready(port = makePort(), windowId = 3) {
  connected.emit(port as unknown as chrome.runtime.Port)
  port.onMessage.emit({ kind: "ready", windowId })
  return port
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
}

test("localizes picker titles without translating the assigned shortcut", () => {
  setLanguagePreference("ja")
  expect(pickerButtonTitle(false, "")).toBe(t("Select page element"))
  expect(pickerButtonTitle(true, "")).toBe(t("Cancel element selection"))
  expect(pickerButtonTitle(false, "")).not.toBe("Select page element")
  const shortcut = "Command+Shift+E"
  expect(pickerButtonTitle(false, shortcut)).toBe(
    t("Select page element ({shortcut})", { shortcut }),
  )
  expect(pickerButtonTitle(true, shortcut)).toBe(
    t("Cancel element selection ({shortcut})", { shortcut }),
  )
  expect(pickerButtonTitle(false, shortcut)).toContain(shortcut)
})

describe("worker command handoff", () => {
  test("opens synchronously, then delivers once to a ready panel and accepts its ack", async () => {
    const controller = installElementPickerShortcut({ validate, stop })
    command.emit(ELEMENT_PICKER_COMMAND, tab)
    expect(open).toHaveBeenCalledWith({ windowId: 3 })
    expect(validate).not.toHaveBeenCalled()
    const port = ready()
    await flush()
    expect(port.postMessage).toHaveBeenCalledTimes(1)
    const message = port.postMessage.mock.calls[0]?.[0]
    expect(message).toMatchObject({ kind: "toggle", tabContext: context })
    port.onMessage.emit({ kind: "ack", id: message.id })
    ready()
    await flush()
    expect(validate).toHaveBeenCalledTimes(1)
    controller.invalidate()
  })

  test("a ready panel receives consecutive commands, including cancellation", async () => {
    const controller = installElementPickerShortcut({ validate, stop })
    const port = ready()
    command.emit(ELEMENT_PICKER_COMMAND, tab)
    await flush()
    command.emit(ELEMENT_PICKER_COMMAND, tab)
    await flush()
    expect(port.postMessage).toHaveBeenCalledTimes(2)
    expect(port.postMessage.mock.calls[0]?.[0].id).not.toBe(port.postMessage.mock.calls[1]?.[0].id)
    controller.invalidate()
  })

  test("two commands before panel readiness cancel the pending start", async () => {
    installElementPickerShortcut({ validate, stop })
    command.emit(ELEMENT_PICKER_COMMAND, tab)
    command.emit(ELEMENT_PICKER_COMMAND, tab)
    const port = ready()
    await flush()
    expect(open).toHaveBeenCalledTimes(2)
    expect(port.postMessage).not.toHaveBeenCalled()
  })

  test("expiry and navigation invalidation discard pending starts", async () => {
    vi.useFakeTimers()
    const controller = installElementPickerShortcut({ validate, stop })
    command.emit(ELEMENT_PICKER_COMMAND, tab)
    await vi.advanceTimersByTimeAsync(SHORTCUT_INTENT_LIFETIME_MS)
    const port = ready()
    await flush()
    expect(port.postMessage).not.toHaveBeenCalled()
    command.emit(ELEMENT_PICKER_COMMAND, tab)
    controller.invalidate()
    await flush()
    expect(port.postMessage).not.toHaveBeenCalled()
  })

  test("does not deliver an intent to another window or a non-panel sender", async () => {
    const controller = installElementPickerShortcut({ validate, stop })
    command.emit(ELEMENT_PICKER_COMMAND, tab)
    const wrongWindow = ready(makePort(4), 4)
    const wrongSender = ready(makePort(3, "https://example.test"))
    await flush()
    expect(wrongWindow.postMessage).not.toHaveBeenCalled()
    expect(wrongSender.disconnect).toHaveBeenCalled()
    expect(wrongSender.postMessage).not.toHaveBeenCalled()
    controller.invalidate()
  })

  test("rejects a forged window on an extension-tab sender", () => {
    installElementPickerShortcut({ validate, stop })
    const port = ready(makePort(4), 3)
    expect(port.disconnect).toHaveBeenCalled()
  })

  test("rejects stale targets and denied panel opening without injecting", async () => {
    installElementPickerShortcut({ validate, stop })
    validate.mockRejectedValueOnce(new Error("stale"))
    const port = ready()
    command.emit(ELEMENT_PICKER_COMMAND, tab)
    await flush()
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: "error" }))
    open.mockRejectedValueOnce(new Error("no gesture"))
    command.emit(ELEMENT_PICKER_COMMAND, tab)
    await flush()
    expect(port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "error" }))
    expect(port.postMessage.mock.calls.some(([message]) => message.kind === "toggle")).toBe(false)
  })

  test("disconnect discards an unacknowledged intent and stops the picker", async () => {
    installElementPickerShortcut({ validate, stop })
    const port = ready()
    command.emit(ELEMENT_PICKER_COMMAND, tab)
    await flush()
    port.disconnect()
    const replacement = ready()
    await flush()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(replacement.postMessage).not.toHaveBeenCalled()
  })

  test("restarting the controller cannot replay an old pending command", async () => {
    vi.useFakeTimers()
    const previous = installElementPickerShortcut({ validate, stop })
    command.emit(ELEMENT_PICKER_COMMAND, tab)
    previous.invalidate()
    command = event()
    connected = event()
    Object.assign(chrome.commands, { onCommand: command })
    Object.assign(chrome.runtime, { onConnect: connected })
    installElementPickerShortcut({ validate, stop })
    const port = ready()
    await flush()
    expect(port.postMessage).not.toHaveBeenCalled()
  })

  test("ignores unknown commands and absent tabs", () => {
    installElementPickerShortcut({ validate, stop })
    command.emit("other", tab)
    command.emit(ELEMENT_PICKER_COMMAND)
    expect(open).not.toHaveBeenCalled()
  })
})

describe("panel shortcut connection", () => {
  test("acknowledges and deduplicates delivery, reconnects, and stops on disposal", async () => {
    vi.useFakeTimers()
    const port = makePort()
    const replacement = makePort()
    chrome.runtime.connect = vi.fn().mockReturnValueOnce(port).mockReturnValue(replacement)
    const toggle = vi.fn(async () => undefined)
    const error = vi.fn()
    const disconnected = vi.fn()
    const disconnect = await connectElementPickerShortcut({ toggle, error, disconnected })
    expect(port.postMessage).toHaveBeenCalledWith({ kind: "ready", windowId: 3 })
    const message = { kind: "toggle", id: "intent", tabContext: context }
    port.onMessage.emit(message)
    port.onMessage.emit(message)
    expect(toggle).toHaveBeenCalledTimes(1)
    expect(port.postMessage).toHaveBeenCalledWith({ kind: "ack", id: "intent" })
    port.disconnect()
    expect(disconnected).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(250)
    expect(replacement.postMessage).toHaveBeenCalledWith({ kind: "ready", windowId: 3 })
    disconnect()
    await vi.advanceTimersByTimeAsync(1000)
    replacement.onMessage.emit({ ...message, id: "later" })
    expect(toggle).toHaveBeenCalledTimes(1)
    expect(chrome.runtime.connect).toHaveBeenCalledTimes(2)
  })

  test("does not start when the acknowledgement cannot be sent", async () => {
    const port = makePort()
    chrome.runtime.connect = vi.fn().mockReturnValue(port)
    const toggle = vi.fn(async () => undefined)
    const disconnect = await connectElementPickerShortcut({
      toggle,
      error: vi.fn(),
      disconnected: vi.fn(),
    })
    port.postMessage.mockImplementation(() => {
      throw new Error("disconnected")
    })
    port.onMessage.emit({ kind: "toggle", id: "intent", tabContext: context })
    expect(toggle).not.toHaveBeenCalled()
    disconnect()
  })

  test("reports handler and worker errors", async () => {
    const port = makePort()
    chrome.runtime.connect = vi.fn().mockReturnValue(port)
    const error = vi.fn()
    const disconnect = await connectElementPickerShortcut({
      toggle: vi.fn(async () => {
        throw new Error("denied")
      }),
      error,
      disconnected: vi.fn(),
    })
    port.onMessage.emit({ kind: "toggle", id: "intent", tabContext: context })
    port.onMessage.emit({ kind: "error", message: "unsupported" })
    await flush()
    expect(error).toHaveBeenCalledTimes(2)
    disconnect()
  })

  test("uses the assigned shortcut, including remapped or unassigned keys", async () => {
    expect(await assignedPickerShortcut()).toBe("Command+Shift+E")
    getAll.mockResolvedValueOnce([{ name: ELEMENT_PICKER_COMMAND, shortcut: "Alt+Shift+P" }])
    expect(pickerButtonTitle(false, await assignedPickerShortcut())).toBe(
      "Select page element (Alt+Shift+P)",
    )
    getAll.mockResolvedValueOnce([{ name: ELEMENT_PICKER_COMMAND, shortcut: "" }])
    expect(pickerButtonTitle(true, await assignedPickerShortcut())).toBe("Cancel element selection")
    getAll.mockResolvedValueOnce([])
    expect(await assignedPickerShortcut()).toBe("")
  })
})
