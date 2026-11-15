import { JSDOM } from "jsdom"
import { afterEach, expect, test, vi } from "vitest"
import { TranslationController } from "../../../src/browser/sidepanel/translation.js"

let dom
let controller
afterEach(() => {
  controller?.dispose()
  dom?.window.close()
  vi.unstubAllGlobals()
})
test("a busy post-claim operation releases startup even if it ends during owner release", async () => {
  dom = new JSDOM(
    '<button id="translation-approve"></button><button id="translation-stop" hidden></button>',
  )
  vi.stubGlobal("document", dom.window.document)
  const context = { tabId: 7, windowId: 3, url: "https://example.com/source", epoch: 1 }
  const event = { addListener() {}, removeListener() {} }
  let busy = false
  const sendMessage = vi.fn(async (message) => {
    if (message.kind === "request") return { ok: true, result: { tabContext: context } }
    if (message.operation === "claim") {
      busy = true
      return { ok: true, result: { owner: "owned", boot: "current" } }
    }
    if (message.operation === "release") busy = false
    return { ok: true, result: {} }
  })
  vi.stubGlobal("chrome", {
    runtime: { sendMessage, onMessage: event },
    storage: { onChanged: event },
    permissions: { onRemoved: event },
  })
  controller = new TranslationController(
    {},
    { busy: () => busy, changed() {}, status() {}, error() {} },
  )
  const intent = { id: "intent", tab: { id: 7, url: context.url }, kind: "page" }
  controller.intent = intent
  controller.scopedProvider = {}
  await expect(controller.begin(intent, {})).rejects.toThrow(
    "Finish the current operation before translating",
  )
  expect(
    sendMessage.mock.calls.filter(([message]) => message.operation === "release"),
  ).toHaveLength(1)
  expect(controller.active).toBe(false)
  expect(document.querySelector("#translation-stop").hidden).toBe(true)
})
