import { JSDOM } from "jsdom"
import { afterEach, expect, test, vi } from "vitest"
import { TranslationController } from "../../../src/browser/sidepanel/translation.js"

const permissionRequest = vi.hoisted(() => vi.fn())
vi.mock("../../../src/browser/permissions.js", async (importOriginal) => ({
  ...(await importOriginal()),
  requestHostPermissions: permissionRequest,
}))
let dom
let controller
afterEach(() => {
  controller?.dispose()
  dom?.window.close()
  vi.unstubAllGlobals()
  permissionRequest.mockReset()
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

test.each(["active", "starting"])(
  "an old approval cannot stop a replacement that is %s",
  async (phase) => {
    dom = new JSDOM(
      '<button id="translation-approve"></button><button id="translation-stop"></button>',
    )
    vi.stubGlobal("document", dom.window.document)
    const event = { addListener() {}, removeListener() {} }
    const sendMessage = vi.fn(async () => ({ ok: true, result: {} }))
    vi.stubGlobal("chrome", {
      runtime: { sendMessage, onMessage: event },
      storage: { onChanged: event },
      permissions: { onRemoved: event },
    })
    const error = vi.fn()
    controller = new TranslationController(
      {},
      { busy: () => false, changed() {}, status() {}, error },
    )
    const oldIntent = { id: "old", tab: { id: 7, url: "https://example.com/source" } }
    controller.intent = oldIntent
    controller.snapshot = {}
    let approve = () => {}
    permissionRequest.mockReturnValueOnce(
      new Promise((resolve) => {
        approve = () => resolve(true)
      }),
    )
    const button = document.querySelector("#translation-approve")
    button.click()
    expect(button.disabled).toBe(true)
    const replacement = { ...oldIntent, id: "replacement" }
    const abort = new AbortController()
    let finish = () => {}
    const starting =
      phase === "starting"
        ? new Promise((resolve) => {
            finish = resolve
          })
        : undefined
    controller.intent = replacement
    controller.abort = abort
    controller.owner = phase === "active" ? "replacement-owner" : ""
    controller.starting = starting
    try {
      approve()
      await vi.waitFor(() => expect(button.disabled).toBe(false))
      expect(controller.intent).toBe(replacement)
      expect(controller.abort).toBe(abort)
      expect(abort.signal.aborted).toBe(false)
      expect(controller.owner).toBe(phase === "active" ? "replacement-owner" : "")
      expect(controller.starting).toBe(starting)
      expect(sendMessage).not.toHaveBeenCalled()
      expect(error).not.toHaveBeenCalled()
    } finally {
      finish()
      await controller.stop()
    }
  },
)
