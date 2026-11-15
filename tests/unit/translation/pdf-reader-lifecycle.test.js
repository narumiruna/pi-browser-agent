import { readFileSync } from "node:fs"
import { JSDOM } from "jsdom"
import { afterEach, expect, test, vi } from "vitest"
import * as Pdf from "../../../src/browser/translation/shared/pdf.js"

const mocks = vi.hoisted(() => ({
  tasks: [],
  ports: [],
  pageCount: 6,
  destroy: async () => {},
  render: async () => {},
  cached: "",
  observers: [],
}))
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: {},
  PasswordResponses: { INCORRECT_PASSWORD: 2 },
  TextLayer: class {
    async render() {}
    cancel() {}
  },
  getDocument({ data }) {
    const name = new TextDecoder().decode(data).split("\n")[1]
    const document = {
      numPages: mocks.pageCount,
      fingerprints: [name],
      async getMetadata() {
        return { info: { Title: name } }
      },
      async getPage(pageNumber) {
        return {
          getViewport: ({ scale }) => ({
            width: 600 * scale,
            height: 800 * scale,
            scale,
            userUnit: 1,
          }),
          async getTextContent() {
            return {
              items: [
                {
                  str: `${name} paragraph ${pageNumber} has enough selectable original prose for safe bounded PDF translation.`,
                  width: 480,
                  height: 12,
                  transform: [12, 0, 0, 12, 40, 700],
                },
              ],
            }
          },
          async getStructTree() {
            return null
          },
          render() {
            return { promise: mocks.render(name, pageNumber), cancel() {} }
          },
        }
      },
    }
    const task = {
      name,
      promise: Promise.resolve(document),
      destroy: vi.fn(() => mocks.destroy(name)),
    }
    mocks.tasks.push(task)
    return task
  },
}))
vi.mock("../../../src/browser/pdf/cache.js", () => ({
  cacheTranslations: async () => {},
  clearPdfCache: async () => {},
  getCachedTranslations: async (_context, blocks) => {
    if (mocks.cacheGate) await mocks.cacheGate(blocks)
    return mocks.cached ? blocks.map((block) => ({ id: block.id, translation: mocks.cached })) : []
  },
}))
vi.mock("../../../src/browser/pdf/local-session.js", () => ({
  createReaderPort() {
    const messages = []
    const disconnected = []
    const port = {
      posted: [],
      onMessage: { addListener: (fn) => messages.push(fn) },
      onDisconnect: { addListener: (fn) => disconnected.push(fn) },
      postMessage(message) {
        this.posted.push(message)
      },
      disconnect: vi.fn(() => {
        for (const fn of disconnected) fn()
      }),
      emit(message) {
        for (const fn of messages) fn(message)
      },
    }
    mocks.ports.push(port)
    return port
  },
}))
let dom
async function setup(pageCount = 6) {
  vi.resetModules()
  mocks.cacheGate = null
  mocks.tasks = []
  mocks.ports = []
  mocks.observers = []
  mocks.pageCount = pageCount
  mocks.cached = ""
  mocks.destroy = async () => {}
  mocks.render = async () => {}
  dom = new JSDOM(readFileSync("src/browser/pages/pdf.html", "utf8"), {
    url: "https://reader.test/pages/pdf.html",
  })
  for (const key of ["window", "document", "location", "history", "sessionStorage"])
    vi.stubGlobal(key, dom.window[key])
  vi.stubGlobal("devicePixelRatio", 1)
  vi.stubGlobal("CSS", { escape: (value) => value })
  vi.stubGlobal("Worker", class {})
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback) {
        mocks.observers.push(callback)
      }
      observe() {}
      disconnect() {}
    },
  )
  vi.stubGlobal("chrome", { runtime: { getURL: (path) => `https://reader.test/${path}` } })
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({})
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  const reader = await import("../../../src/browser/pdf/reader.js")
  reader.connectPort()
  const port = mocks.ports[0]
  port.emit({
    type: Pdf.SERVER_MESSAGE_TYPES.SESSION_STARTED,
    sessionId: "owned-session",
    targetLanguage: "German",
    settingsFingerprint: "owned-settings",
    source: { url: "" },
  })
  return { reader, port }
}
function choose(name) {
  const input = document.querySelector("#local-file")
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [
      {
        name: `${name}.pdf`,
        size: 30,
        arrayBuffer: async () => new TextEncoder().encode(`%PDF-1.7\n${name}`).buffer,
      },
    ],
  })
  input.dispatchEvent(new dom.window.Event("change"))
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
afterEach(() => {
  dom?.window.close()
  vi.unstubAllGlobals()
})

test("a stale PDF continuation cannot overwrite a newer document after old-task destruction", async () => {
  await setup()
  choose("first")
  await vi.waitFor(() =>
    expect(document.querySelector("#document-title").textContent).toBe("first"),
  )
  let release = () => {}
  const gate = new Promise((resolve) => {
    release = resolve
  })
  mocks.destroy = async (name) => {
    if (name === "first") await gate
  }
  try {
    choose("second")
    await vi.waitFor(() => expect(mocks.tasks[0].destroy).toHaveBeenCalled())
    choose("third")
    await vi.waitFor(() =>
      expect(document.querySelector("#document-title").textContent).toBe("third"),
    )
    release()
    await tick()
    await tick()
    expect(document.querySelector("#document-title").textContent).toBe("third")
    expect(document.querySelector("#translation-pages").textContent).not.toContain(
      "second paragraph",
    )
    expect(document.querySelector("#translation-pages").textContent).toContain("third paragraph")
  } finally {
    release()
  }
})
test("old render completion keeps the current page canvas", async () => {
  await setup(10)
  let release = () => {}
  const gate = new Promise((resolve) => {
    release = resolve
  })
  mocks.render = async (_name, page) => {
    if (page === 1) await gate
  }
  try {
    choose("navigation")
    await vi.waitFor(() => expect(document.querySelectorAll(".pdf-page")).toHaveLength(10))
    mocks.observers.at(-1)([
      {
        isIntersecting: true,
        intersectionRatio: 1,
        target: document.querySelector('.pdf-page[data-page-number="10"]'),
      },
    ])
    await vi.waitFor(() =>
      expect(document.querySelector('.pdf-page[data-page-number="10"] canvas')).not.toBeNull(),
    )
    release()
    await tick()
    await tick()
    expect(document.querySelector('.pdf-page[data-page-number="10"] canvas')).not.toBeNull()
  } finally {
    release()
  }
})
test("new translations and cached translations update active search visibility", async () => {
  const { port } = await setup()
  choose("search")
  await vi.waitFor(() =>
    expect(document.querySelectorAll(".translation-block").length).toBeGreaterThan(0),
  )
  const block = document.querySelector(".translation-block")
  const search = document.querySelector("#translation-search")
  search.value = "needle"
  search.dispatchEvent(new dom.window.Event("input"))
  expect(block.hidden).toBe(true)
  port.emit({
    type: Pdf.SERVER_MESSAGE_TYPES.TRANSLATION_UPDATE,
    sessionId: "owned-session",
    translations: [{ id: block.dataset.blockId, translation: "needle translated match" }],
  })
  await vi.waitFor(() => expect(block.hidden).toBe(false))
  port.emit({
    type: Pdf.SERVER_MESSAGE_TYPES.TRANSLATION_UPDATE,
    sessionId: "owned-session",
    translations: [{ id: block.dataset.blockId, translation: "no match" }],
  })
  await vi.waitFor(() => expect(block.hidden).toBe(true))
  mocks.cached = "needle cached match"
  choose("cached")
  await vi.waitFor(() =>
    expect(document.querySelector("#document-title").textContent).toBe("cached"),
  )
  await vi.waitFor(() =>
    expect(document.querySelector('.translation-block[data-state="ready"]')?.hidden).toBe(false),
  )
})
test("Cancel disconnects its port before a later explicit session connects", async () => {
  const { reader, port } = await setup()
  const stopped = vi.fn()
  reader.onSessionStopped(stopped)
  port.emit({ type: Pdf.SERVER_MESSAGE_TYPES.CANCELLED, sessionId: "owned-session" })
  expect(port.disconnect).toHaveBeenCalledTimes(1)
  expect(stopped).toHaveBeenCalledTimes(1)
  reader.connectPort()
  expect(stopped).toHaveBeenCalledTimes(1)
  expect(mocks.ports).toHaveLength(2)
})

test("source highlighting updates the page label and navigation controls", async () => {
  await setup()
  choose("highlight")
  await vi.waitFor(() => expect(document.querySelector("#next-page").disabled).toBe(false))
  document.querySelector('.translation-page[data-page-number="6"] .translation-block').click()
  expect(document.querySelector("#page-status").textContent).toBe("Page 6 / 6")
  expect(document.querySelector("#next-page").disabled).toBe(true)
  expect(document.querySelector("#previous-page").disabled).toBe(false)
})
test("whole-document confirmation cannot enqueue a replacement document", async () => {
  const { port } = await setup()
  vi.stubGlobal("confirm", () => true)
  choose("confirmed")
  await vi.waitFor(() => expect(document.querySelector("#translate-all").disabled).toBe(false))
  await tick()
  await tick()
  let release = () => {}
  let entered = false
  const gate = new Promise((resolve) => {
    release = resolve
  })
  mocks.cacheGate = async () => {
    if (!entered) {
      entered = true
      await gate
    }
  }
  try {
    document.querySelector("#translate-all").click()
    await vi.waitFor(() => expect(entered).toBe(true))
    mocks.cacheGate = null
    choose("unconfirmed")
    await vi.waitFor(() =>
      expect(document.querySelector("#document-title").textContent).toBe("unconfirmed"),
    )
    release()
    for (let count = 0; count < 6; count += 1) await tick()
    expect(
      port.posted.some(
        (message) =>
          message.placement === "back" &&
          message.items?.some((item) => item.text.includes("unconfirmed")),
      ),
    ).toBe(false)
  } finally {
    release()
  }
})
