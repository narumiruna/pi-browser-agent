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
  // jsdom has no text layout; native range geometry is covered by the extension E2E tests.
  vi.spyOn(document, "createRange").mockImplementation(() => {
    const range = new Range()
    range.getClientRects = () =>
      [range.startContainer.parentElement?.getBoundingClientRect()].filter(
        (rect): rect is DOMRect => rect !== undefined,
      ) as unknown as DOMRectList
    return range
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

  test.each(["#clip", "body"])(
    "does not discover controls when only ancestor %s is hit",
    async (selector) => {
      document.body.innerHTML =
        '<div id="clip" style="overflow:hidden"><button type="button" aria-label="Clipped button">Go</button><input aria-label="Clipped input"></div>'
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: () => document.querySelector(selector),
      })
      expect(await discover()).toMatchObject({ elements: [] })
    },
  )

  test.each(["click", "type"] as const)(
    "rejects reference %s if hit testing changes to an ancestor during the worker assertion",
    async (operation) => {
      document.body.innerHTML = '<div id="clip"><input aria-label="Target"></div>'
      const input = document.querySelector("input") as HTMLInputElement
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: () => input,
      })
      await discover()
      const clicked = vi.spyOn(input, "click")
      vi.mocked(chrome.runtime.sendMessage).mockImplementation(async () => {
        Object.defineProperty(document, "elementFromPoint", {
          configurable: true,
          value: () => document.querySelector("#clip"),
        })
        return { ok: true }
      })
      expect(
        await executePageOperation(
          operation,
          { snapshotId: snapshot.id, ref: "e1", text: "Never write" },
          true,
          null,
          context,
          snapshot,
        ),
      ).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } })
      expect(clicked).not.toHaveBeenCalled()
      expect(input.value).toBe("")
    },
  )

  test("accepts discovered controls hit through a descendant and partially visible controls", async () => {
    document.body.innerHTML = '<button type="button" aria-label="Partial"><span>Go</span></button>'
    const button = document.querySelector("button") as HTMLButtonElement
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: (x: number, y: number) =>
        x === 1 && y === 1 ? button.firstElementChild : document.body,
    })
    expect(await discover()).toMatchObject({ elements: [{ name: "Partial", ref: "e1" }] })
    const clicked = vi.spyOn(button, "click")
    expect(await click()).toMatchObject({ ok: true })
    expect(clicked).toHaveBeenCalledOnce()
  })

  test.each([
    '<div><span id="label">Hidden label</span></div><button id="control" type="button" aria-labelledby="label" aria-label="Visible fallback">Answer</button>',
    '<div><label id="label" for="control">Hidden label</label></div><input id="control" placeholder="Visible fallback">',
    '<button id="control" type="button">Visible fallback<span id="label">Hidden label</span></button>',
  ])("excludes ancestor-only hits from discovered names: %s", async (markup) => {
    document.body.innerHTML = markup
    const control = document.querySelector("#control") as HTMLElement
    const label = document.querySelector("#label") as HTMLElement
    Object.defineProperty(control, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 20, right: 30, top: 0, bottom: 10 }),
    })
    let labelVisible = false
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: (x: number) => (x >= 20 ? control : labelVisible ? label : document.body),
    })
    expect((await discover()).elements.map((element) => element.name)).toEqual(["Visible fallback"])
    labelVisible = true
    expect((await discover()).elements[0]?.name).toContain("Hidden label")
  })

  test.each([
    '<span id="label">Hidden range</span><button id="control" type="button" aria-labelledby="label" aria-label="Visible fallback">Answer</button>',
    '<label id="label" for="control">Hidden range</label><input id="control" placeholder="Visible fallback">',
    '<button id="control" type="button">Visible fallback<span id="label">Hidden range</span></button>',
  ])("checks text ranges even when their parent is hit: %s", async (markup) => {
    document.body.innerHTML = markup
    const label = document.querySelector("#label") as HTMLElement
    const control = document.querySelector("#control") as HTMLElement
    Object.defineProperty(control, "getBoundingClientRect", {
      value: () => new DOMRect(20, 0, 10, 10),
    })
    let exposed = false
    vi.mocked(document.createRange).mockImplementation(() => {
      const range = new Range()
      range.getClientRects = () =>
        [
          range.startContainer.parentElement === label && !exposed
            ? new DOMRect(40, 0, 10, 10)
            : range.startContainer.parentElement?.getBoundingClientRect(),
        ] as unknown as DOMRectList
      return range
    })
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: (x: number) => (x < 10 ? label : x < 30 ? control : document.body),
    })
    expect((await discover()).elements[0]?.name).toBe("Visible fallback")
    exposed = true
    expect((await discover()).elements[0]?.name).toContain("Hidden range")
    exposed = false
    const clicked = vi.spyOn(control, "click")
    expect(await click()).toMatchObject({ ok: false, error: { code: "STALE_CONTEXT" } })
    expect(clicked).not.toHaveBeenCalled()
  })

  test("excludes clipped suffixes, empty ranges, and text covered by a descendant", async () => {
    document.body.innerHTML =
      '<span id="label">VisibleHIDDEN</span><button type="button" aria-labelledby="label" aria-label="Fallback">Go</button>'
    const label = document.querySelector("#label") as HTMLElement
    const button = document.querySelector("button") as HTMLElement
    Object.defineProperty(button, "getBoundingClientRect", {
      value: () => new DOMRect(200, 0, 10, 10),
    })
    const overlay = document.createElement("span")
    label.append(overlay)
    const rects = vi.fn((offset: number) => [new DOMRect(offset * 10, 0, 10, 10)])
    vi.mocked(document.createRange).mockImplementation(() => {
      const range = new Range()
      range.getClientRects = () => rects(range.startOffset) as unknown as DOMRectList
      return range
    })
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: (x: number) => (x >= 200 ? button : x < 70 ? label : overlay),
    })
    expect((await discover()).elements[0]?.name).toBe("Visible")
    rects.mockReturnValue([])
    expect((await discover()).elements[0]?.name).toBe("Fallback")
  })

  test("keeps Unicode code points and bounds fully clipped text inspection", async () => {
    document.body.innerHTML =
      '<span id="label">漢😀 text</span><button type="button" aria-labelledby="label" aria-label="Fallback">Go</button>'
    const label = document.querySelector("#label") as HTMLElement
    const offsets: number[] = []
    let clipped = false
    vi.mocked(document.createRange).mockImplementation(() => {
      const range = new Range()
      range.getClientRects = () => {
        offsets.push(range.startOffset, range.endOffset)
        return (clipped ? [] : [new DOMRect(0, 0, 10, 10)]) as unknown as DOMRectList
      }
      return range
    })
    expect((await discover()).elements[0]?.name).toBe("漢😀 text")
    expect(offsets).not.toContain(2)
    label.textContent = "x".repeat(10_000)
    offsets.length = 0
    clipped = true
    expect((await discover()).elements[0]?.name).toBe("Fallback")
    // Discovery name plus fingerprint; each is limited to 256 inspected UTF-16 units.
    expect(offsets).toHaveLength(2 * 256 * 2)
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

  test("rejects reference typing when a focus handler makes only an ancestor hittable", async () => {
    document.body.innerHTML = '<input aria-label="Title">'
    const input = document.querySelector("input") as HTMLInputElement
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => input })
    await discover()
    input.addEventListener("focus", () => {
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: () => document.body,
      })
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
