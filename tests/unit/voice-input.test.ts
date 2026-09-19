import { describe, expect, test, vi } from "vitest"
import {
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

describe("voice input", () => {
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
