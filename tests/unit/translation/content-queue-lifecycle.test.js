import { JSDOM } from "jsdom"
import { afterEach, expect, test, vi } from "vitest"
import { isTranslationContentMessage } from "../../../src/browser/runtime/translation.js"
import { createContentRuntime } from "../../../src/browser/translation/content.js"
import { MESSAGE_TYPES } from "../../../src/browser/translation/shared/messages.js"

let dom
let runtime
afterEach(() => {
  runtime?.cleanup()
  dom?.window.close()
  vi.unstubAllGlobals()
})

test.each(["success", "cancel", "reject"])(
  "visible-page packets stop safely after %s",
  async (mode) => {
    const cells = Array.from(
      { length: 65 },
      (_, index) =>
        `<tr><td>Public cell ${index} has enough readable prose for independent visible page translation.</td></tr>`,
    ).join("")
    dom = new JSDOM(`<main><article><table>${cells}</table></article></main>`, {
      url: "https://example.com/article",
    })
    dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 600,
      bottom: 20,
      width: 600,
      height: 20,
    })
    for (const key of ["window", "document", "Node", "MutationObserver"])
      vi.stubGlobal(key, dom.window[key])
    let listener
    const messages = []
    const sendMessage = vi.fn(async (message) => {
      if (message.type === MESSAGE_TYPES.GET_PAGE_TRANSLATION_SESSION)
        return { ok: true, active: true, sessionId: "owned-session", targetLanguage: "German" }
      messages.push(message)
      expect(isTranslationContentMessage(message)).toBe(true)
      if (mode === "cancel")
        listener(
          { type: MESSAGE_TYPES.CLEAR_PENDING_TRANSLATIONS, payload: {} },
          { id: "owned-extension" },
          () => {},
        )
      return mode === "reject"
        ? { ok: false }
        : { ok: true, queued: message.payload.items.length, sessionStatus: "active" }
    })
    vi.stubGlobal("chrome", {
      runtime: {
        id: "owned-extension",
        getManifest: () => ({ version: "0.0.0" }),
        onMessage: {
          addListener: (fn) => {
            listener = fn
          },
          removeListener() {},
        },
        sendMessage,
      },
    })
    runtime = createContentRuntime()
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce())
    await new Promise((resolve) => setTimeout(resolve, 0))
    document.dispatchEvent(new dom.window.Event("scroll"))
    await vi.waitFor(() => expect(messages.length).toBe(mode === "success" ? 2 : 1))
    expect(messages.map((message) => message.payload.items.length)).toEqual(
      mode === "success" ? [64, 1] : [64],
    )
    if (mode === "reject") {
      expect(document.querySelector('[data-ot-role="toast"]').textContent).toContain(
        "could not be translated",
      )
      await new Promise((resolve) => setTimeout(resolve, 3700))
      expect(messages).toHaveLength(1)
    }
  },
  10000,
)
