import { JSDOM } from "jsdom"
import { afterEach, expect, test, vi } from "vitest"
import { createContentRuntime } from "../../../src/browser/translation/content.js"
import { MESSAGE_TYPES as MessageTypes } from "../../../src/browser/translation/shared/messages.js"

let dom
let runtime
afterEach(() => {
  runtime?.cleanup()
  dom?.window.close()
  vi.unstubAllGlobals()
})
test.each(["scheduled", "in-flight"])(
  "clear prevents %s restoration from reactivating its old session",
  async (stage) => {
    dom = new JSDOM(
      '<main><article><p data-ot-source-id="owned">This public source paragraph has enough words to render a stale placeholder if restoration is incorrectly allowed.</p></article></main>',
      { url: "https://example.com/article" },
    )
    for (const key of ["window", "document", "Node", "MutationObserver"])
      vi.stubGlobal(key, dom.window[key])
    let reply = () => {}
    const restore = new Promise((resolve) => {
      reply = resolve
    })
    const listeners = []
    const sendMessage = vi.fn(async () => restore)
    vi.stubGlobal("chrome", {
      runtime: {
        getManifest: () => ({ version: "0.0.0" }),
        onMessage: { addListener: (fn) => listeners.push(fn), removeListener() {} },
        sendMessage,
      },
    })
    runtime = createContentRuntime()
    if (stage === "in-flight") await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce())
    const send = (message) => {
      let result
      listeners[0](message, {}, (response) => {
        result = response
      })
      return result
    }
    send({ type: MessageTypes.CLEAR_PENDING_TRANSLATIONS, payload: {} })
    reply({ ok: true, active: true, sessionId: "stale-session", targetLanguage: "German" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(
      send({
        type: MessageTypes.RENDER_PAGE_PLACEHOLDERS,
        payload: { sessionId: "stale-session", items: [{ id: "owned", text: "old source" }] },
      }),
    ).toEqual({ ok: false, stale: true })
    expect(document.querySelector('[data-ot-role="note"]')).toBeNull()
  },
)
