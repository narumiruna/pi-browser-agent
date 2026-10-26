import { JSDOM } from "jsdom"
import { afterEach, describe, expect, test, vi } from "vitest"
import { initializeDocumentLanguage } from "../../src/browser/i18n/dom.js"
import { getLocale, setLanguagePreference, t } from "../../src/browser/i18n/index.js"
import { initializeMicrophonePage } from "../../src/browser/sidepanel/microphone-page.js"
import {
  getMicrophonePermissionState,
  requestMicrophoneAccess,
  type SpeechRecognitionLike,
  type SpeechRecognitionResultListLike,
  VoiceInputController,
} from "../../src/browser/sidepanel/voice-input.js"

class FakeSpeechRecognition implements SpeechRecognitionLike {
  continuous = false
  interimResults = false
  lang = ""
  onresult: SpeechRecognitionLike["onresult"] = null
  onerror: SpeechRecognitionLike["onerror"] = null
  onend: SpeechRecognitionLike["onend"] = null
  start = vi.fn()
  stop = vi.fn()
  abort = vi.fn()

  emitResult(...transcripts: string[]): void {
    const results: SpeechRecognitionResultListLike = {
      length: transcripts.length,
      item(index) {
        const transcript = transcripts[index]
        if (transcript === undefined) return null
        return {
          length: 1,
          item(alternativeIndex) {
            return alternativeIndex === 0 ? { transcript } : null
          },
        }
      },
    }
    this.onresult?.({ results })
  }
}

async function setupMicrophonePage() {
  microphoneDom = new JSDOM(`
    <section id="microphone-access-page" hidden>
      <p id="microphone-access-status"></p>
      <button id="allow-microphone">Allow microphone access</button>
      <button id="open-microphone-settings">Open Chrome microphone settings</button>
      <button id="close-microphone-access">Close tab</button>
    </section>
  `)
  const { window } = microphoneDom
  vi.stubGlobal("window", window)
  vi.stubGlobal("document", window.document)
  vi.stubGlobal("DOMException", window.DOMException)
  const query = vi.fn(async () => ({ state: "prompt" as PermissionState }))
  const getUserMedia = vi.fn<() => Promise<{ getTracks: () => { stop: () => void }[] }>>()
  vi.stubGlobal("navigator", { permissions: { query }, mediaDevices: { getUserMedia } })
  const listeners = new Set<
    (changes: Record<string, chrome.storage.StorageChange>, area: string) => void
  >()
  vi.stubGlobal("chrome", {
    storage: {
      local: { get: vi.fn(async () => ({ piBrowserAgentSettings: { language: "en" } })) },
      onChanged: {
        addListener: (
          listener: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void,
        ) => listeners.add(listener),
        removeListener: (
          listener: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void,
        ) => listeners.delete(listener),
      },
    },
    tabs: { create: vi.fn() },
  })
  await initializeDocumentLanguage(window.document)
  await initializeMicrophonePage()
  const saveLanguage = (language: string) => {
    for (const listener of listeners) {
      listener({ piBrowserAgentSettings: { newValue: { language } } }, "local")
    }
  }
  return {
    window,
    saveLanguage,
    query,
    getUserMedia,
    status: window.document.querySelector("#microphone-access-status") as HTMLElement,
    allow: window.document.querySelector("#allow-microphone") as HTMLButtonElement,
    settings: window.document.querySelector("#open-microphone-settings") as HTMLButtonElement,
  }
}

function setup() {
  const recognition = new FakeSpeechRecognition()
  const callbacks = {
    onTranscript: vi.fn(),
    onListeningChange: vi.fn(),
    onError: vi.fn(),
  }
  const controller = new VoiceInputController(recognition, callbacks, "zh-TW")
  return { callbacks, controller, recognition }
}

let microphoneDom: JSDOM | undefined

afterEach(() => {
  if (microphoneDom) {
    microphoneDom.window.dispatchEvent(new microphoneDom.window.Event("pagehide"))
    microphoneDom.window.close()
    microphoneDom = undefined
  }
  setLanguagePreference("en")
  vi.unstubAllGlobals()
})

describe("microphone page language updates", () => {
  test("relabels saved language changes without querying or requesting microphone access", async () => {
    const { window, saveLanguage, query, getUserMedia, status, allow } = await setupMicrophonePage()
    saveLanguage("ja")
    expect(window.document.documentElement.lang).toBe("ja")
    expect(window.document.title).toBe(t("Microphone access · Pi Browser Agent"))
    expect(status.textContent).toBe(
      t("Select Allow microphone access, then approve Chrome's prompt."),
    )
    expect(status.textContent).not.toBe(
      "Select Allow microphone access, then approve Chrome's prompt.",
    )
    expect(allow.textContent).toBe(t("Allow microphone access"))
    expect(query).toHaveBeenCalledOnce()
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  test("defers saved language while the permission request is pending and flushes after grant", async () => {
    const { window, saveLanguage, query, getUserMedia, status, allow } = await setupMicrophonePage()
    let finish!: (stream: { getTracks: () => { stop: () => void }[] }) => void
    getUserMedia.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    allow.click()
    saveLanguage("ja")
    expect(getLocale()).toBe("en")
    expect(window.document.documentElement.lang).toBe("en")
    expect(status.textContent).toBe("Waiting for Chrome's microphone prompt…")
    expect(allow.disabled).toBe(true)
    const stop = vi.fn()
    finish({ getTracks: () => [{ stop }] })
    await vi.waitFor(() => expect(window.document.documentElement.lang).toBe("ja"))
    expect(status.textContent).toBe(
      t(
        "Microphone access is allowed. Close this tab and select the microphone in Pi Browser Agent.",
      ),
    )
    expect(allow.hidden).toBe(true)
    expect(stop).toHaveBeenCalledOnce()
    expect(getUserMedia).toHaveBeenCalledOnce()
    expect(query).toHaveBeenCalledOnce()
  })

  test.each([
    [
      "NotAllowedError",
      "Chrome blocked microphone access. Open Chrome microphone settings, remove Pi Browser Agent from Not allowed, then return here and try again.",
    ],
    ["NotFoundError", "Chrome could not find a microphone. Connect or enable one, then try again."],
  ] as const)(
    "localizes the classified %s failure after a deferred language change",
    async (name, message) => {
      const { window, saveLanguage, getUserMedia, status, allow } = await setupMicrophonePage()
      let fail!: (error: unknown) => void
      getUserMedia.mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            fail = reject
          }),
      )
      allow.click()
      saveLanguage("ja")
      fail(new window.DOMException("Browser detail must not appear", name))
      await vi.waitFor(() => expect(allow.disabled).toBe(false))
      expect(getLocale()).toBe("ja")
      expect(status.textContent).toBe(t(message))
      expect(status.textContent).not.toContain("Browser detail")
      expect(getUserMedia).toHaveBeenCalledOnce()
    },
  )

  test("retains the failed-request state while relabeling and redacts browser diagnostics", async () => {
    const { saveLanguage, query, getUserMedia, status, allow, settings } =
      await setupMicrophonePage()
    getUserMedia.mockRejectedValue(new Error("Browser failure Bearer secret"))
    query.mockResolvedValue({ state: "denied" })
    allow.click()
    await vi.waitFor(() => expect(allow.disabled).toBe(false))
    saveLanguage("ja")
    expect(status.textContent).toBe(
      t("Microphone access failed: {error}", { error: "Browser failure Bearer [REDACTED]" }),
    )
    expect(allow.hidden).toBe(true)
    expect(settings.hidden).toBe(false)
    expect(getUserMedia).toHaveBeenCalledOnce()
    expect(query).toHaveBeenCalledTimes(2)
  })
})

describe("voice input", () => {
  test("localizes fixed recognition errors without changing dictation language or transcript", () => {
    setLanguagePreference("ja")
    const { callbacks, controller, recognition } = setup()
    controller.start("No microphone is available.")
    recognition.emitResult("Voice recognition is blocked by Chrome.")
    expect(recognition.lang).toBe("zh-TW")
    expect(callbacks.onTranscript).toHaveBeenLastCalledWith(
      "No microphone is available. Voice recognition is blocked by Chrome.",
    )
    recognition.onerror?.({ error: "audio-capture" })
    expect(callbacks.onError).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: t("No microphone is available.") }),
    )
    expect(t("No microphone is available.")).not.toBe("No microphone is available.")
    recognition.onerror?.({ error: "unknown-browser-code" })
    expect(callbacks.onError).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: t("Voice recognition stopped unexpectedly.") }),
    )
  })

  test("checks the microphone content permission", async () => {
    const query = vi.fn(async () => ({ state: "granted" as const }))

    await expect(getMicrophonePermissionState(query)).resolves.toBe("granted")
    expect(query).toHaveBeenCalledWith({ name: "microphone" })
  })

  test("requests microphone access and immediately releases the stream", async () => {
    const stop = vi.fn()
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop }, { stop }] }))

    await requestMicrophoneAccess(getUserMedia)

    expect(getUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(stop).toHaveBeenCalledTimes(2)
  })

  test("configures continuous interim recognition and appends the transcript", () => {
    const { callbacks, controller, recognition } = setup()

    controller.start("Existing prompt")
    recognition.emitResult("這是", "語音輸入")

    expect(recognition).toMatchObject({ continuous: true, interimResults: true, lang: "zh-TW" })
    expect(recognition.start).toHaveBeenCalledOnce()
    expect(callbacks.onListeningChange).toHaveBeenCalledWith(true)
    expect(callbacks.onTranscript).toHaveBeenLastCalledWith("Existing prompt 這是語音輸入")

    recognition.onend?.()
    expect(controller.active).toBe(false)
    expect(callbacks.onListeningChange).toHaveBeenLastCalledWith(false)
  })

  test("makes repeated stops idempotent and still discards late results", () => {
    const { callbacks, controller, recognition } = setup()

    controller.start("Draft")
    controller.stop()
    controller.stop({ discardResults: true })
    recognition.emitResult("late final result")

    expect(recognition.stop).toHaveBeenCalledOnce()
    expect(callbacks.onTranscript).not.toHaveBeenCalled()
  })

  test("stops an active session and reports microphone errors", () => {
    const { callbacks, controller, recognition } = setup()

    controller.toggle("")
    controller.toggle("")
    expect(recognition.stop).toHaveBeenCalledOnce()

    recognition.onerror?.({ error: "not-allowed" })
    expect(controller.active).toBe(false)
    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Microphone access was denied") }),
    )
  })

  test("aborts without showing an error during panel shutdown", () => {
    const { callbacks, controller, recognition } = setup()

    controller.start("")
    controller.abort()
    recognition.onerror?.({ error: "aborted" })

    expect(recognition.abort).toHaveBeenCalledOnce()
    expect(controller.active).toBe(false)
    expect(callbacks.onError).not.toHaveBeenCalled()
  })
})
