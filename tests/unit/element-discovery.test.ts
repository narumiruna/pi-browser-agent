// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { executePageOperation } from "../../src/browser/content/page-operations.js"
import {
  ELEMENT_LIMITS,
  type ElementSnapshot,
  formatUntrusted,
} from "../../src/browser/runtime/types.js"

const context = { tabId: 1, url: location.href, epoch: 0 }
let snapshot: ElementSnapshot

async function discover() {
  const outcome = await executePageOperation("listElements", {}, false, null, context, snapshot)
  expect(outcome.ok).toBe(true)
  if (!outcome.ok) throw new Error(outcome.error.message)
  return outcome.result as {
    snapshotId: string
    elements: Array<{ ref: string; name: string; actions: string[] }>
    truncated: boolean
  }
}
function click(ref = "e1", confirmed = false) {
  return executePageOperation(
    "click",
    { snapshotId: snapshot.id, ref },
    confirmed,
    null,
    context,
    snapshot,
  )
}

beforeEach(() => {
  snapshot = {
    id: crypto.randomUUID(),
    context,
    expiresAt: Date.now() + ELEMENT_LIMITS.lifetimeMs,
    limits: ELEMENT_LIMITS,
  }
  document.body.innerHTML = ""
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: undefined })
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 10,
    bottom: 10,
    width: 10,
    height: 10,
    toJSON: () => ({}),
  })
  vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn(async () => ({ ok: true })) } })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("element snapshots", () => {
  test("discovers labels and duplicate names without field values or sensitive targets", async () => {
    document.body.innerHTML = `<label for="input">Name</label><input id="input" value="private-value"><textarea aria-label="Notes">private-notes</textarea><input placeholder="Search"><button type="button">Same</button><button type="button">Same</button><input type="password" value="secret"><input type="file"><label role="button" for="password">Private</label><input id="password" type="password"><button disabled>Disabled</button><input readonly aria-label="Read only"><div role="textbox" contenteditable="true" aria-label="Editor">private-editor</div>`
    const result = await discover()
    expect(result.elements.map((e) => e.name)).toEqual([
      "Name",
      "Notes",
      "Search",
      "Same",
      "Same",
      "Disabled",
      "Read only",
      "Editor",
    ])
    expect(new Set(result.elements.map((e) => e.ref)).size).toBe(result.elements.length)
    expect(result.elements[5]?.actions).toEqual([])
    expect(result.elements[6]?.actions).toEqual(["click"])
    expect(JSON.stringify(result)).not.toMatch(/private-|secret|password|file/)
  })

  test("excludes hidden, off-screen, and covered elements and hidden label text", async () => {
    document.body.innerHTML = `<button id="good" type="button" aria-labelledby="name">Fallback</button><span id="name">Visible<span hidden>Hidden</span></span><button style="display:none">Hidden</button><button id="off">Off</button><button id="covered">Covered</button><div id="overlay"></div>`
    Object.defineProperty(document.querySelector("#off"), "getBoundingClientRect", {
      value: () => ({ top: -20, bottom: -10, left: 0, right: 10 }),
    })
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => document.querySelector("#good"),
    })
    const result = await discover()
    expect(result.elements.map((e) => e.name)).toEqual(["Fallback"])
  })

  test("caps names, candidate scanning, result count, and encoded output", async () => {
    document.body.innerHTML = Array.from(
      { length: 60 },
      () => `<button type="button" aria-label="${"&quot;".repeat(400)}">Long</button>`,
    ).join("")
    const result = await discover()
    expect(result.truncated).toBe(true)
    expect(result.elements.length).toBeLessThanOrEqual(50)
    expect(result.elements[0]?.name).toHaveLength(256)
    expect(
      new TextEncoder().encode(formatUntrusted("element descriptions", result)).byteLength,
    ).toBeLessThanOrEqual(50 * 1024)
    document.body.innerHTML = `${"<div></div>".repeat(2000)}<button>Beyond budget</button>`
    expect(await discover()).toMatchObject({ elements: [], truncated: true })
  })

  test("uses node identity rather than a position or guessed selector", async () => {
    document.body.innerHTML =
      '<button type="button">First</button><button type="button">Second</button>'
    await discover()
    const first = document.querySelector("button") as HTMLButtonElement
    const clicked = vi.spyOn(first, "click").mockImplementation(() => undefined)
    first.before(document.createElement("button"))
    expect(await click()).toMatchObject({
      ok: true,
      result: { ref: "e1", snapshotId: snapshot.id },
    })
    expect(clicked).toHaveBeenCalledOnce()
    first.replaceWith(first.cloneNode(true))
    expect(await click()).toMatchObject({ ok: false, error: { code: "STALE_CONTEXT" } })
  })

  test.each([
    "expired",
    "replacement",
    "context",
    "unknown",
    "name",
    "type",
    "disabled",
    "form",
    "destination",
  ])("rejects %s references before clicking", async (reason) => {
    document.body.innerHTML =
      '<form id="one"></form><form id="two"></form><button type="button" form="one">Go</button>'
    if (reason === "destination") document.body.innerHTML = '<a href="/one">Go</a>'
    await discover()
    const node = document.querySelector("button, a") as HTMLElement
    const clicked = vi.spyOn(node, "click").mockImplementation(() => undefined)
    if (reason === "expired") snapshot.expiresAt = Date.now() - 1
    if (reason === "replacement") {
      const previous = snapshot
      snapshot = { ...snapshot, id: crypto.randomUUID() }
      await discover()
      snapshot = previous
    }
    if (reason === "context") snapshot = { ...snapshot, context: { ...context, epoch: 1 } }
    if (reason === "name") node.textContent = "Delete instead"
    if (reason === "type") node.setAttribute("type", "submit")
    if (reason === "disabled") node.setAttribute("disabled", "")
    if (reason === "form") node.setAttribute("form", "two")
    if (reason === "destination") node.setAttribute("href", "/other")
    expect(await click(reason === "unknown" ? "e999" : "e1", true)).toMatchObject({
      ok: false,
      error: { code: "STALE_CONTEXT" },
    })
    expect(clicked).not.toHaveBeenCalled()
  })

  test("revalidates target changes while awaiting the worker assertion", async () => {
    document.body.innerHTML = '<button type="button">Go</button>'
    await discover()
    const node = document.querySelector("button") as HTMLButtonElement
    const clicked = vi.spyOn(node, "click").mockImplementation(() => undefined)
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async () => {
      node.textContent = "Changed"
      return { ok: true }
    })
    expect(await click()).toMatchObject({ ok: false, error: { code: "STALE_CONTEXT" } })
    expect(clicked).not.toHaveBeenCalled()
  })

  test("rechecks type and editability after page focus handlers", async () => {
    document.body.innerHTML = '<input aria-label="Title">'
    await discover()
    const input = document.querySelector("input") as HTMLInputElement
    input.addEventListener("focus", () => {
      input.type = "password"
    })
    expect(
      await executePageOperation(
        "type",
        { snapshotId: snapshot.id, ref: "e1", text: "Never write" },
        false,
        null,
        context,
        snapshot,
      ),
    ).toMatchObject({ ok: false, error: { code: "STALE_CONTEXT" } })
    expect(input.value).toBe("")
  })

  test("rejects changed label associations and resolved link destinations", async () => {
    document.body.innerHTML =
      '<label role="button" for="one">Go</label><input id="one"><input id="two">'
    await discover()
    document.querySelector("label")?.setAttribute("for", "two")
    expect(await click()).toMatchObject({ ok: false, error: { code: "STALE_CONTEXT" } })
    document.body.innerHTML = '<a href="relative">Go</a>'
    await discover()
    const base = document.createElement("base")
    base.href = "https://changed.test/"
    document.head.append(base)
    try {
      expect(await click("e1", true)).toMatchObject({ ok: false, error: { code: "STALE_CONTEXT" } })
    } finally {
      base.remove()
    }
  })

  test("preserves valid bounded JSON with multibyte names and escaped data", async () => {
    document.body.innerHTML = Array.from(
      { length: 50 },
      () =>
        `<button type="button" role="${"button".repeat(30)}" aria-label="${"漢".repeat(230)}${"😀&quot;".repeat(100)}">Name</button>`,
    ).join("")
    const result = await discover()
    expect(result.truncated).toBe(true)
    const text = formatUntrusted("element descriptions", result)
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(50 * 1024)
    expect(JSON.parse(text.slice(text.indexOf("\n") + 1))).toEqual(result)
  })

  test("retains confirmation and native typing semantics", async () => {
    document.body.innerHTML = '<input aria-label="Title"><form><button>Submit</button></form>'
    await discover()
    const input = document.querySelector("input") as HTMLInputElement
    const changed = vi.fn()
    input.addEventListener("input", changed)
    expect(
      await executePageOperation(
        "type",
        { snapshotId: snapshot.id, ref: "e1", text: "Hello" },
        false,
        null,
        context,
        snapshot,
      ),
    ).toMatchObject({ ok: true })
    expect(input.value).toBe("Hello")
    expect(changed).toHaveBeenCalledOnce()
    const button = document.querySelector("button") as HTMLButtonElement
    const clicked = vi.spyOn(button, "click").mockImplementation(() => undefined)
    expect(await click("e2")).toMatchObject({
      ok: false,
      error: { code: "CONFIRMATION_REQUIRED", details: { ref: "e2" } },
    })
    expect(clicked).not.toHaveBeenCalled()
    expect(await click("e2", true)).toMatchObject({ ok: true })
    expect(clicked).toHaveBeenCalledOnce()
  })
})
