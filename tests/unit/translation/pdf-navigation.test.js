import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import vm from "node:vm"
import { parse } from "acorn"
import { test } from "vitest"

async function createNavigationHarness() {
  const source = await readFile(
    new URL("../../../src/browser/pdf/reader.js", import.meta.url),
    "utf8",
  )
  const names = new Set(["activatePage", "navigateToPage", "setupPageObserver"])
  const functions = parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
  })
    .body.filter((node) => node.type === "FunctionDeclaration" && names.has(node.id.name))
    .map((node) => source.slice(node.start, node.end))
    .join("\n")
  const rendered = []
  const queued = []
  const synchronized = []
  let observer
  const state = { currentPage: 1, pageCount: 6, pageElements: new Map() }
  for (let page = 1; page <= 6; page += 1) {
    state.pageElements.set(page, { scrollIntoView() {} })
  }
  const context = vm.createContext({
    state,
    elements: {
      sourceScroll: {},
      translationPages: {
        querySelector(selector) {
          return {
            scrollIntoView() {
              synchronized.push(Number(/\d+/.exec(selector)[0]))
            },
          }
        },
      },
    },
    updateControls() {},
    showError(error) {
      throw error
    },
    async renderWindow(page) {
      rendered.push(page)
    },
    async queuePageWindow(page) {
      queued.push(page)
    },
    IntersectionObserver: class {
      constructor(callback) {
        observer = callback
      }
      observe() {}
      disconnect() {}
    },
  })
  vm.runInContext(functions, context)
  context.setupPageObserver()
  return {
    state,
    rendered,
    queued,
    synchronized,
    navigate: (page) => context.navigateToPage(page),
    observe(page) {
      observer([
        {
          isIntersecting: true,
          intersectionRatio: 0.8,
          target: { dataset: { pageNumber: String(page) } },
        },
      ])
    },
  }
}

test("PDF button navigation activates rendering, translation, and pane synchronization once", async () => {
  const harness = await createNavigationHarness()
  for (const page of [2, 3, 4, 3]) {
    await harness.navigate(page)
    harness.observe(page)
    harness.observe(page)
  }
  assert.deepEqual(harness.rendered, [2, 3, 4, 3])
  assert.deepEqual(harness.queued, [2, 3, 4, 3])
  assert.deepEqual(harness.synchronized, [2, 3, 4, 3])
})

test("PDF normal scrolling uses the same activation and ignores repeated observer delivery", async () => {
  const harness = await createNavigationHarness()
  harness.observe(4)
  harness.observe(4)
  harness.observe(5)
  assert.equal(harness.state.currentPage, 5)
  assert.deepEqual(harness.rendered, [4, 5])
  assert.deepEqual(harness.queued, [4, 5])
  assert.deepEqual(harness.synchronized, [4, 5])
})
