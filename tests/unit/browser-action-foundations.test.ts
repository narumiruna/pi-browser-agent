// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  executePageOperation,
  type PageOperation,
} from "../../src/browser/content/page-operations.js"
import {
  ELEMENT_LIMITS,
  type ElementSnapshot,
  type JsonObject,
} from "../../src/browser/runtime/types.js"

const context = { tabId: 1, url: location.href, epoch: 0 }
let snapshot: ElementSnapshot
const target = (ref = "e1") => ({ snapshotId: snapshot.id, ref })
const run = (operation: PageOperation, params: JsonObject = {}, confirmed = false) =>
  executePageOperation(operation, params, confirmed, null, context, snapshot)
async function result(operation: PageOperation, params: JsonObject = {}, confirmed = false) {
  const outcome = await run(operation, params, confirmed)
  expect(outcome.ok).toBe(true)
  if (!outcome.ok) throw new Error(outcome.error.message)
  return outcome.result as JsonObject
}
const discover = (params: JsonObject = {}) => result("listElements", params)
const input = () => document.querySelector("input") as HTMLInputElement
const rect = (left = 0, top = 0) => ({
  x: left,
  y: top,
  left,
  top,
  right: left + 20,
  bottom: top + 20,
  width: 20,
  height: 20,
  toJSON: () => ({}),
})

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
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect())
  vi.spyOn(document, "createRange").mockImplementation(() => {
    const range = new Range()
    range.getClientRects = () =>
      [range.startContainer.parentElement?.getBoundingClientRect()].filter(
        Boolean,
      ) as unknown as DOMRectList
    return range
  })
  vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn(async () => ({ ok: true })) } })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("native DOM semantics (executed before implementation in bare Chromium)", () => {
  test("native checkbox activation fires click/input/change once; cancellation rolls back", () => {
    document.body.innerHTML = '<input type="checkbox">'
    const events: string[] = []
    for (const event of ["click", "input", "change"])
      input().addEventListener(event, () => events.push(`${event}:${input().checked}`))
    input().click()
    expect(events).toEqual(["click:true", "input:true", "change:true"])
    events.length = 0
    input().addEventListener("click", (event) => event.preventDefault(), { once: true })
    input().click()
    expect(events).toEqual(["click:false"])
    expect(input().checked).toBe(true)
  })
  test("radio group membership follows live name/form ownership; detached state is still readable", () => {
    document.body.innerHTML =
      '<input type="radio" name="group" checked><input type="radio" name="group">'
    const [a, b] = Array.from(document.querySelectorAll("input"))
    b?.click()
    expect(a?.checked).toBe(false)
    if (!a || !b) throw new Error("Missing radios")
    b.name = "other"
    a.click()
    expect([a.checked, b.checked]).toEqual([true, true])
    a.addEventListener("click", () => a.remove())
    a.click()
    expect(a.isConnected).toBe(false)
    expect(a.checked).toBe(true)
  })
})

test("fully clipped whitespace does not satisfy rendered-text search or a text condition", async () => {
  document.body.innerHTML =
    '<div style="overflow-x:hidden;overflow-y:hidden;height:0"><span>   </span></div>'
  expect(await result("findText", { query: " " })).toMatchObject({ matches: [] })
  expect(await result("probeCondition", { text: " " })).toEqual({ matched: false })
})

describe("Unicode input contracts", () => {
  test("counts input characters as code points while source offsets and snippets use UTF-16", async () => {
    const query = "😀".repeat(256)
    document.body.textContent = query
    expect((await result("findText", { query })).matches).toMatchObject([{ start: 0, end: 512 }])
    expect(await result("probeCondition", { text: query })).toEqual({ matched: true })
    expect(await run("findText", { query: `${query}😀` })).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    })
    expect(await discover({ name: query })).toMatchObject({ elements: [] })
    expect(await discover({ role: "😀".repeat(64), type: "😀".repeat(64) })).toMatchObject({
      elements: [],
    })
  })
})

describe("filtered discovery", () => {
  test("keeps empty arguments and uses effective native roles and literal exact filters", async () => {
    document.body.innerHTML =
      '<button type="button" aria-label="Save A"></button><button type="submit" aria-label="Save B"></button><input type="checkbox" aria-label="Save C"><select aria-label="Choice"><option>X</option></select>'
    expect((await discover()).elements).toMatchObject([
      { role: "button" },
      { role: "button" },
      { role: "checkbox" },
      { role: "combobox" },
    ])
    expect(
      (await discover({ role: "button", type: "button", name: "ave A" })).elements,
    ).toMatchObject([{ name: "Save A" }])
    expect((await discover({ name: "save" })).elements).toEqual([])
    expect((await discover({ role: "but" })).elements).toEqual([])
  })
  test("paginates match ordinals inside the same first 2000 candidates and replaces refs", async () => {
    document.body.innerHTML = '<button type="button" aria-label="Match"></button>'.repeat(52)
    const first = await discover()
    expect(first).toMatchObject({
      hasMore: true,
      scanTruncated: false,
      nextOffset: 50,
      truncated: true,
    })
    expect(first.elements).toHaveLength(50)
    snapshot = { ...snapshot, id: crypto.randomUUID() }
    const page = await discover({ name: "Match", offset: 50 })
    expect(page.elements).toHaveLength(2)
    expect(page).toMatchObject({ hasMore: false, scanTruncated: false, truncated: false })
    expect(page).not.toHaveProperty("nextOffset")
    document.body.innerHTML = `${"<div></div>".repeat(2000)}<button>Beyond</button>`
    expect(await discover()).toMatchObject({
      elements: [],
      scanTruncated: true,
      hasMore: false,
      truncated: true,
    })
  })
  test("distinguishes full pages from exhaustion and scan truncation", async () => {
    document.body.innerHTML = '<button type="button" aria-label="Match"></button>'.repeat(50)
    expect(await discover()).toMatchObject({ hasMore: false, scanTruncated: false })
    document.body.innerHTML += "<div></div>".repeat(2000)
    expect(await discover()).toMatchObject({ hasMore: false, scanTruncated: true })
  })
  test.each<JsonObject>([
    { offset: -1 },
    { offset: 2001 },
    { offset: 0.5 },
    { role: "x".repeat(65) },
    { type: 1 },
    { name: "x".repeat(257) },
  ])("rejects unsafe filters %j", async (params) => {
    expect(await run("listElements", params)).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    })
  })
  test("bounds pretty-printed JSON even for escaped multibyte names", async () => {
    document.body.innerHTML =
      `<button type="button" aria-label='${'漢\\"'.repeat(256)}'></button>`.repeat(100)
    const page = await discover()
    expect(new TextEncoder().encode(JSON.stringify(page, null, 2)).byteLength).toBeLessThanOrEqual(
      48 * 1024,
    )
    expect(page.hasMore).toBe(true)
  })
})

describe("bounded rendered-text search", () => {
  test("normalizes whitespace per node, never crosses nodes, and reports raw UTF-16 source offsets", async () => {
    document.body.innerHTML = '<div id="scope">A\n  😀word<span>nested</span>end</div>'
    const found = await result("findText", { query: " 😀word", selector: "#scope" })
    expect(found).toMatchObject({
      matches: [{ snippet: "A 😀word", start: 1, end: 10 }],
      scanTruncated: false,
      hasMore: false,
    })
    expect((await result("findText", { query: "wordnested", selector: "#scope" })).matches).toEqual(
      [],
    )
    expect((await result("findText", { query: "Word", selector: "#scope" })).matches).toEqual([])
  })
  test("excludes fields, editable, hidden, transparent and script text but includes offscreen text", async () => {
    document.body.innerHTML =
      '<input value="secret"><textarea>secret</textarea><select><option>secret</option></select><div contenteditable="false">secret</div><div hidden>secret</div><div aria-hidden="true">secret</div><script>secret</script><style>.secret{color:red}</style><div style="opacity:0">secret</div><div id="off">public</div>'
    Object.defineProperty(document.querySelector("#off"), "getBoundingClientRect", {
      value: () => rect(0, 2000),
    })
    expect((await result("findText", { query: "secret" })).matches).toEqual([])
    expect((await result("findText", { query: "public" })).matches).toMatchObject([
      { snippet: "public", rect: { y: 2000 } },
    ])
  })
  test("omits overflow-clipped text and does not match across a clipped run", async () => {
    document.body.innerHTML =
      '<div style="overflow-x:hidden;overflow-y:hidden"><span>secret</span></div>'
    Object.defineProperty(document.querySelector("span"), "getBoundingClientRect", {
      value: () => rect(100, 100),
    })
    expect((await result("findText", { query: "secret" })).matches).toEqual([])
  })
  test.each(["clip-path:inset(100%)", "position:absolute;clip:rect(0px,0px,0px,0px)"])(
    "excludes CSS-masked text for search and text probes: %s",
    async (style) => {
      document.body.innerHTML = `<div style="${style}"><span>Private</span></div><p>Public</p>`
      expect((await result("findText", { query: "Private" })).matches).toEqual([])
      expect(await result("probeCondition", { text: "Private" })).toEqual({ matched: false })
      expect(await run("findText", { query: "Private", selector: "span" })).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST" },
      })
    },
  )
  test("ignores overflow clipping and masks on boxless display:contents ancestors", async () => {
    document.body.innerHTML =
      '<div id="boxless" style="display:contents;overflow:hidden;clip-path:inset(100%);clip:rect(0px,0px,0px,0px)"><span>Public</span></div>'
    Object.defineProperty(document.querySelector("#boxless"), "getBoundingClientRect", {
      value: () => ({ ...rect(), width: 0, height: 0, right: 0, bottom: 0 }),
    })
    expect((await result("findText", { query: "Public" })).matches).toHaveLength(1)
    expect(await result("probeCondition", { text: "Public" })).toEqual({ matched: true })
  })
  test("never reads effective editable text when document.designMode is on", async () => {
    document.body.innerHTML = '<div id="scope">Private</div>'
    Object.defineProperty(document, "designMode", { configurable: true, value: "on" })
    try {
      expect((await result("findText", { query: "Private" })).matches).toEqual([])
      expect(await result("probeCondition", { text: "Private" })).toEqual({ matched: false })
      expect(await run("findText", { query: "Private", selector: "#scope" })).toMatchObject({
        ok: false,
        error: { code: "PERMISSION_DENIED" },
      })
    } finally {
      Object.defineProperty(document, "designMode", { configurable: true, value: "off" })
    }
  })
  test("counts excluded nodes and UTF-16 units against traversal budgets", async () => {
    document.body.innerHTML = `<div hidden>${"x".repeat(100000)}</div><p>needle</p>`
    expect(await result("findText", { query: "needle" })).toMatchObject({
      matches: [],
      scanTruncated: true,
      hasMore: false,
      truncated: true,
    })
    document.body.innerHTML = `${"<span hidden>x</span>".repeat(2000)}<p>needle</p>`
    expect(await result("findText", { query: "needle" })).toMatchObject({
      matches: [],
      scanTruncated: true,
    })
    document.body.innerHTML = `<div hidden>${"x".repeat(100001)}</div>`
    expect(await result("findText", { query: "needle" })).toMatchObject({ scanTruncated: true })
  })
  test("returns 50 non-overlapping matches, correct ordinals, separate scan and page flags", async () => {
    document.body.innerHTML = `<p>${"aa ".repeat(52)}</p>`
    const first = await result("findText", { query: "aa" })
    expect(first.matches).toHaveLength(50)
    expect(first).toMatchObject({ hasMore: true, nextOffset: 50, scanTruncated: false })
    const last = await result("findText", { query: "aa", offset: 50 })
    expect(last.matches).toHaveLength(2)
    expect(last).toMatchObject({ hasMore: false, scanTruncated: false })
    expect(last).not.toHaveProperty("nextOffset")
    document.body.innerHTML += `<div hidden>${"x".repeat(100000)}</div>`
    expect(await result("findText", { query: "aa" })).toMatchObject({
      hasMore: true,
      scanTruncated: true,
    })
    document.body.innerHTML = "aaaa"
    expect((await result("findText", { query: "aa" })).matches).toHaveLength(2)
  })
  test("does not split source surrogate pairs at snippet boundaries", async () => {
    document.body.textContent = `needl${"😀".repeat(200)}`
    const found = await result("findText", { query: "needl" })
    const snippet = String((found.matches as JsonObject[])[0]?.snippet)
    expect(snippet.length).toBeLessThanOrEqual(256)
    expect(snippet).not.toMatch(/[\uD800-\uDBFF]$/)
  })
  test("caps snippets and serialized output, returns no references and keeps snapshots", async () => {
    document.body.innerHTML = `<button type="button" aria-label="Keep"></button><p>${`needle${"漢".repeat(250)} `.repeat(60)}</p>`
    await discover()
    const found = await result("findText", { query: "needle" })
    for (const match of found.matches as JsonObject[])
      expect(String(match.snippet).length).toBeLessThanOrEqual(256)
    expect(new TextEncoder().encode(JSON.stringify(found, null, 2)).byteLength).toBeLessThanOrEqual(
      48 * 1024,
    )
    expect(JSON.stringify(found)).not.toMatch(/snapshotId|"ref"/)
    expect(await run("getElementDetails", target())).toMatchObject({ ok: true })
  })
  test.each<JsonObject>([
    { query: "" },
    { query: "x".repeat(257) },
    { query: "x", offset: 100001 },
    { query: "x", offset: -1 },
    { query: "x", selector: "[" },
    { query: "x", selector: "#missing" },
    { query: "x", selector: "" },
  ])("fails closed for invalid search %j", async (params) => {
    expect(await run("findText", params)).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    })
  })
  test("rejects non-rendered scopes but accepts offscreen scopes for search and text probes", async () => {
    document.body.innerHTML =
      '<div hidden id="hidden">Needle</div><div style="display:none"><span id="nested">Needle</span></div><div id="off">Needle</div>'
    Object.defineProperty(document.querySelector("#off"), "getBoundingClientRect", {
      value: () => rect(0, 2000),
    })
    for (const operation of ["findText", "probeCondition"] as const) {
      const condition: JsonObject =
        operation === "findText" ? { query: "Needle" } : { text: "Needle" }
      for (const selector of ["#hidden", "#nested"])
        expect(await run(operation, { ...condition, selector })).toMatchObject({
          ok: false,
          error: { code: "INVALID_REQUEST" },
        })
      expect(await run(operation, { ...condition, selector: "#off" })).toMatchObject({
        ok: true,
      })
    }
  })
  test("validates boxless scopes with bounded single-unit geometry, never a subtree range", async () => {
    document.body.innerHTML = '<div id="scope" style="display:contents">Needle</div>'
    const scope = document.querySelector("#scope") as HTMLElement
    Object.defineProperty(scope, "getBoundingClientRect", {
      value: () => ({ ...rect(), width: 0, height: 0 }),
    })
    const selectContents = vi.fn(() => {
      throw new Error("Unbounded subtree range")
    })
    vi.mocked(document.createRange).mockImplementation(() => {
      const range = new Range()
      range.selectNodeContents = selectContents
      range.getClientRects = () => [rect()] as unknown as DOMRectList
      return range
    })
    expect(
      (await result("findText", { query: "Needle", selector: "#scope" })).matches,
    ).toHaveLength(1)
    expect(selectContents).not.toHaveBeenCalled()
    scope.innerHTML = `${"<span hidden>x</span>".repeat(2000)}<span>Needle</span>`
    expect(await run("findText", { query: "Needle", selector: "#scope" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    })
    scope.innerHTML = `<span hidden>${"x".repeat(100000)}</span><span>Needle</span>`
    expect(await run("findText", { query: "Needle", selector: "#scope" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    })
  })
  test("rejects private scopes instead of falling back", async () => {
    document.body.innerHTML =
      '<textarea>secret</textarea><div contenteditable="true"><span>secret</span></div>'
    for (const selector of ["textarea", "span"])
      expect(await run("findText", { query: "secret", selector })).toMatchObject({
        ok: false,
        error: { code: "PERMISSION_DENIED" },
      })
  })
})

describe("synchronous read-only condition probes", () => {
  test.each(["present", "absent", "visible", "hidden", "enabled", "disabled"])(
    "defines missing target state %s",
    async (state) => {
      expect(await result("probeCondition", { selector: "#missing", state })).toEqual({
        matched: state === "absent" || state === "hidden",
      })
    },
  )
  test("applies current visibility and native/ARIA disabled state without snapshot replacement", async () => {
    document.body.innerHTML =
      '<button type="button" aria-label="Keep">Needle</button><button hidden id="hidden"></button><button disabled id="disabled"></button><div aria-disabled="true" id="aria"></div>'
    await discover()
    for (const [selector, state, matched] of [
      ["button", "present", true],
      ["button", "enabled", true],
      ["#hidden", "hidden", true],
      ["#hidden", "disabled", false],
      ["#disabled", "disabled", true],
      ["#disabled", "enabled", false],
      ["#aria", "disabled", true],
    ] as const)
      expect(await result("probeCondition", { selector, state })).toEqual({ matched })
    expect(await result("probeCondition", { text: "Needle", selector: "button" })).toEqual({
      matched: true,
    })
    expect(await run("getElementDetails", target())).toMatchObject({ ok: true })
  })
  test("rejects sensitive controls, invalid selectors, conflicting/invalid conditions and absent scopes", async () => {
    document.body.innerHTML =
      '<input id="secret" type="password"><label for="secret">Secret</label>'
    for (const selector of ["input", "label"])
      expect(await run("probeCondition", { selector, state: "present" })).toMatchObject({
        ok: false,
        error: { code: "PERMISSION_DENIED" },
      })
    const invalidConditions: JsonObject[] = [
      { text: "" },
      { text: "x", state: "present" },
      { text: "x", selector: "#missing" },
      { selector: "[", state: "hidden" },
      { selector: "body", state: "bad" },
      { text: "x", timeoutMs: 0 },
    ]
    for (const params of invalidConditions)
      expect(await run("probeCondition", params)).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST" },
      })
  })
})

describe("label-only native option catalog", () => {
  test("preserves exact labels/indices, duplicate labels and effective disabled state without private state", async () => {
    document.body.innerHTML =
      '<select aria-label="Catalog"><option value="private-a" label="  Exact  label  ">Other</option><option value="private-b">Duplicate</option><optgroup disabled><option value="private-c" selected>Duplicate</option></optgroup><option disabled>Last</option></select>'
    await discover()
    const page = await result("getSelectOptions", target())
    expect(page.options).toEqual([
      { index: 0, label: "  Exact  label  ", labelTruncated: false, disabled: false },
      { index: 1, label: "Duplicate", labelTruncated: false, disabled: false },
      { index: 2, label: "Duplicate", labelTruncated: false, disabled: true },
      { index: 3, label: "Last", labelTruncated: false, disabled: true },
    ])
    expect(JSON.stringify(page)).not.toMatch(/private|value|selected/)
    expect(await run("getElementDetails", target())).toMatchObject({ ok: true })
  })
  test("paginates, bounds long labels with an explicit marker, and preserves snapshot", async () => {
    document.body.innerHTML = `<select aria-label="Catalog"><option label="${"漢".repeat(255)}😀">Long</option>${"<option>Same</option>".repeat(52)}</select>`
    await discover()
    const first = await result("getSelectOptions", target())
    expect(first.options).toHaveLength(50)
    expect((first.options as JsonObject[])[0]).toMatchObject({
      label: "漢".repeat(255),
      labelTruncated: true,
    })
    expect(first).toMatchObject({ hasMore: true, nextOffset: 50 })
    expect((await result("getSelectOptions", { ...target(), offset: 50 })).options).toHaveLength(3)
    expect((await result("getSelectOptions", { ...target(), offset: 2000 })).options).toEqual([])
    expect(new TextEncoder().encode(JSON.stringify(first, null, 2)).byteLength).toBeLessThanOrEqual(
      48 * 1024,
    )
  })
  test("omits hidden options and groups, paginates native indices, and fingerprints visibility", async () => {
    document.body.innerHTML = `<select aria-label="Catalog"><option hidden>Private</option><optgroup hidden><option>Private group</option></optgroup>${"<option>Visible</option>".repeat(51)}<option hidden>Private tail</option></select>`
    await discover()
    const first = await result("getSelectOptions", target())
    expect(first.options).toHaveLength(50)
    expect((first.options as JsonObject[])[0]?.index).toBe(2)
    expect(first.nextOffset).toBe(52)
    expect(JSON.stringify(first)).not.toContain("Private")
    const last = await result("getSelectOptions", { ...target(), offset: 52 })
    expect(last.options).toEqual([
      { index: 52, label: "Visible", labelTruncated: false, disabled: false },
    ])
    expect(last.hasMore).toBe(false)
    const option = document.querySelector("option") as HTMLOptionElement
    option.hidden = false
    expect(await run("getSelectOptions", target())).toMatchObject({
      ok: false,
      error: { code: "STALE_CONTEXT" },
    })
  })
  test("fails stale after catalog changes, rejects hidden/multiple/oversized catalogs", async () => {
    document.body.innerHTML = '<select aria-label="Catalog"><option>First</option></select>'
    await discover()
    const select = document.querySelector("select") as HTMLSelectElement
    const firstOption = select.options.item(0)
    if (!firstOption) throw new Error("Missing option")
    firstOption.label = "Changed"
    expect(await run("getSelectOptions", target())).toMatchObject({
      ok: false,
      error: { code: "STALE_CONTEXT" },
    })
    await discover()
    select.style.display = "none"
    expect(await run("getSelectOptions", target())).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    })
    select.style.display = "block"
    select.multiple = true
    await discover()
    expect(await run("getSelectOptions", target())).toMatchObject({
      ok: false,
      error: { code: "NOT_SUPPORTED" },
    })
    select.multiple = false
    select.innerHTML = "<option>X</option>".repeat(2001)
    await discover()
    expect(await run("getSelectOptions", target())).toMatchObject({
      ok: false,
      error: { code: "NOT_SUPPORTED" },
    })
    expect(await run("getSelectOptions", { ...target(), offset: 2001 })).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    })
  })
})

describe("explicit checked-state mutation", () => {
  test("matching state is a no-op without confirmation, events, or snapshot invalidation", async () => {
    document.body.innerHTML = '<input type="checkbox" checked aria-label="Accept">'
    await discover()
    const click = vi.spyOn(HTMLElement.prototype, "click")
    const events = vi.fn()
    for (const event of ["click", "input", "change"]) input().addEventListener(event, events)
    expect(await result("setChecked", { ...target(), checked: true })).toMatchObject({
      changed: false,
      activated: false,
      requestedReached: true,
      finalStateVerified: true,
      checked: true,
      snapshotInvalidated: false,
    })
    expect(click).not.toHaveBeenCalled()
    expect(events).not.toHaveBeenCalled()
    expect(await run("getElementDetails", target())).toMatchObject({ ok: true })
  })
  test.each([false, true])(
    "requires confirmation for every actual change to %s and uses one native activation",
    async (checked) => {
      document.body.innerHTML = `<input type="checkbox" ${checked ? "" : "checked"} aria-label="Accept">`
      await discover()
      const events: string[] = []
      for (const event of ["click", "input", "change"])
        input().addEventListener(event, () => events.push(event))
      expect(await run("setChecked", { ...target(), checked })).toMatchObject({
        ok: false,
        error: { code: "CONFIRMATION_REQUIRED", details: { action: "setChecked", checked } },
      })
      expect(events).toEqual([])
      const click = vi.spyOn(HTMLElement.prototype, "click")
      expect(await result("setChecked", { ...target(), checked }, true)).toMatchObject({
        activated: true,
        requestedReached: true,
        finalStateVerified: true,
        checked,
        snapshotInvalidated: true,
      })
      expect(click).toHaveBeenCalledOnce()
      expect(events).toEqual(["click", "input", "change"])
      expect(await run("setChecked", { ...target(), checked }, true)).toMatchObject({
        ok: false,
        error: { code: "STALE_CONTEXT" },
      })
    },
  )
  test.each(["checkbox", "radio"])(
    "binds private %s payload values across confirmation without exposing them",
    async (type) => {
      document.body.innerHTML = `<input type="${type}" value="private-subscribe" aria-label="Accept">`
      await discover()
      const approval = await run("setChecked", { ...target(), checked: true })
      expect(approval).toMatchObject({ ok: false, error: { code: "CONFIRMATION_REQUIRED" } })
      expect(JSON.stringify(approval)).not.toContain("private-subscribe")
      input().value = "private-purchase"
      const click = vi.spyOn(HTMLElement.prototype, "click")
      const outcome = await run("setChecked", { ...target(), checked: true }, true)
      expect(outcome).toMatchObject({ ok: false, error: { code: "STALE_CONTEXT" } })
      expect(JSON.stringify(outcome)).not.toContain("private-purchase")
      expect(click).not.toHaveBeenCalled()
    },
  )
  test("reports cancellation/reversion as activation, not a rejected or retried action", async () => {
    for (const handler of [
      (event: Event) => event.preventDefault(),
      () => {
        input().checked = false
      },
    ]) {
      document.body.innerHTML = '<input type="checkbox" aria-label="Accept">'
      await discover()
      input().addEventListener("click", handler)
      expect(await result("setChecked", { ...target(), checked: true }, true)).toMatchObject({
        activated: true,
        finalStateVerified: true,
        requestedReached: false,
        checked: false,
      })
    }
  })
  test.each(["remove", "navigation", "registry"])(
    "preserves activation success when handler changes %s",
    async (change) => {
      document.body.innerHTML = '<input type="checkbox" aria-label="Accept">'
      await discover()
      input().addEventListener("click", () => {
        if (change === "remove") input().remove()
        if (change === "navigation")
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            value: "hidden",
          })
        if (change === "registry")
          delete (globalThis as { __piBrowserAgentElements?: unknown }).__piBrowserAgentElements
      })
      const activation = await result("setChecked", { ...target(), checked: true }, true)
      expect(activation).toMatchObject({
        activated: true,
        snapshotInvalidated: true,
        finalStateVerified: change === "registry",
        requestedReached: change === "registry" ? true : null,
      })
      if (change !== "registry") expect(activation).not.toHaveProperty("checked")
    },
  )
  test.each(["checked", "name", "form", "replacement", "value"])(
    "rejects changed approval-relevant %s across confirmation",
    async (change) => {
      document.body.innerHTML =
        '<form id="a"><input type="radio" name="group" aria-label="Accept"></form><form id="b"></form>'
      await discover()
      expect(await run("setChecked", { ...target(), checked: true })).toMatchObject({
        ok: false,
        error: { code: "CONFIRMATION_REQUIRED" },
      })
      if (change === "checked") input().checked = true
      if (change === "name") input().name = "other"
      if (change === "value") input().value = "private-purchase"
      if (change === "form") input().setAttribute("form", "b")
      if (change === "replacement") input().replaceWith(input().cloneNode(true))
      const click = vi.spyOn(HTMLElement.prototype, "click")
      expect(await run("setChecked", { ...target(), checked: true }, true)).toMatchObject({
        ok: false,
        error: { code: "STALE_CONTEXT" },
      })
      expect(click).not.toHaveBeenCalled()
      expect(
        JSON.stringify(await run("setChecked", { ...target(), checked: true }, true)),
      ).not.toContain("private-purchase")
    },
  )
  test.each(["add", "remove", "replace", "peerChecked", "peerDisabled"])(
    "binds confirmation to actual radio group membership/state: %s",
    async (change) => {
      document.body.innerHTML =
        '<input type="radio" name="group" aria-label="Target"><input type="radio" name="group" aria-label="Peer">'
      await discover()
      expect(await run("setChecked", { ...target(), checked: true })).toMatchObject({
        ok: false,
        error: { code: "CONFIRMATION_REQUIRED" },
      })
      const peer = document.querySelectorAll("input")[1] as HTMLInputElement
      if (change === "add") document.body.append(peer.cloneNode(true))
      if (change === "remove") peer.remove()
      if (change === "replace") peer.replaceWith(peer.cloneNode(true))
      if (change === "peerChecked") peer.checked = true
      if (change === "peerDisabled") peer.disabled = true
      const click = vi.spyOn(HTMLElement.prototype, "click")
      expect(await run("setChecked", { ...target(), checked: true }, true)).toMatchObject({
        ok: false,
        error: { code: "STALE_CONTEXT" },
      })
      expect(click).not.toHaveBeenCalled()
    },
  )
  test("fails closed if a radio group cannot be fully checked within the scan bound", async () => {
    document.body.innerHTML = `<input type="radio" name="group" aria-label="Target">${"<div></div>".repeat(2000)}`
    await discover()
    expect(await run("setChecked", { ...target(), checked: true }, true)).toMatchObject({
      ok: false,
      error: { code: "NOT_SUPPORTED" },
    })
  })
  test("already-checked radios remain no-ops even when group scanning would exceed bounds", async () => {
    document.body.innerHTML = `<input type="radio" checked name="group" aria-label="Target">${"<div></div>".repeat(2000)}`
    await discover()
    const click = vi.spyOn(HTMLElement.prototype, "click")
    expect(await result("setChecked", { ...target(), checked: true })).toMatchObject({
      activated: false,
      changed: false,
    })
    expect(click).not.toHaveBeenCalled()
  })
  test("native radio activation reaches true, updates its group once, and invalidates references", async () => {
    document.body.innerHTML =
      '<input type="radio" name="group" aria-label="Target"><input type="radio" name="group" checked aria-label="Peer">'
    await discover()
    const peer = document.querySelectorAll("input")[1] as HTMLInputElement
    const click = vi.spyOn(HTMLElement.prototype, "click")
    expect(await result("setChecked", { ...target(), checked: true }, true)).toMatchObject({
      activated: true,
      requestedReached: true,
      checked: true,
    })
    expect(peer.checked).toBe(false)
    expect(click).toHaveBeenCalledOnce()
  })
  test("allows radio activation only for true and rejects ARIA-only, disabled and hidden controls", async () => {
    document.body.innerHTML =
      '<input type="radio" aria-label="Radio"><div role="button" aria-checked="false" aria-label="ARIA"></div><input type="checkbox" disabled aria-label="Disabled">'
    await discover()
    expect(await run("setChecked", { ...target(), checked: false })).toMatchObject({
      ok: false,
      error: { code: "NOT_SUPPORTED" },
    })
    expect(await run("setChecked", { ...target("e2"), checked: true }, true)).toMatchObject({
      ok: false,
      error: { code: "NOT_SUPPORTED" },
    })
    expect(await run("setChecked", { ...target("e3"), checked: true }, true)).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    })
    input().style.display = "none"
    expect(await run("setChecked", { ...target(), checked: true }, true)).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    })
  })
  test.each(["REQUEST_CANCELLED", "PERMISSION_DENIED", "STALE_CONTEXT"])(
    "honors the final worker guard: %s",
    async (code) => {
      document.body.innerHTML = '<input type="checkbox" aria-label="Accept">'
      await discover()
      vi.mocked(chrome.runtime.sendMessage).mockImplementation(async () => ({
        ok: false,
        error: { code, message: "Rejected" },
      }))
      const click = vi.spyOn(HTMLElement.prototype, "click")
      expect(await run("setChecked", { ...target(), checked: true }, true)).toMatchObject({
        ok: false,
        error: { code },
      })
      expect(click).not.toHaveBeenCalled()
    },
  )
  test("rechecks live context after the asynchronous mutation assertion", async () => {
    document.body.innerHTML = '<input type="checkbox" aria-label="Accept">'
    await discover()
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async () => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
      return { ok: true }
    })
    const click = vi.spyOn(HTMLElement.prototype, "click")
    expect(await run("setChecked", { ...target(), checked: true }, true)).toMatchObject({
      ok: false,
      error: { code: "STALE_CONTEXT" },
    })
    expect(click).not.toHaveBeenCalled()
  })
  test("rechecks the target after the asynchronous mutation assertion", async () => {
    document.body.innerHTML = '<input type="checkbox" aria-label="Accept">'
    await discover()
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async () => {
      input().checked = true
      return { ok: true }
    })
    expect(await run("setChecked", { ...target(), checked: true }, true)).toMatchObject({
      ok: false,
      error: { code: "STALE_CONTEXT" },
    })
  })
})
