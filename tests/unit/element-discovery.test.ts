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

function sizedFilter(length: number, opacity = "1"): string {
  const prefix = 'url("data:image/svg+xml,'
  const suffix = `") opacity(${opacity})`
  return `${prefix}${"x".repeat(length - prefix.length - suffix.length)}${suffix}`
}

function mockShadowFilterStyles() {
  const computedStyle = getComputedStyle
  // jsdom caches shadow-tree computed styles after inline changes; Chrome E2E tests use real styles.
  vi.stubGlobal("getComputedStyle", (element: Element) => {
    const style = computedStyle(element)
    return element instanceof HTMLElement && element.getRootNode() instanceof ShadowRoot
      ? new Proxy(style, {
          get(target, key) {
            if (key === "filter") return element.style.filter || "none"
            if (key === "display" && element.style.display) return element.style.display
            return Reflect.get(target, key)
          },
        })
      : style
  })
}

function slottedControl() {
  document.body.innerHTML = '<div id="host"><input aria-label="Target"></div>'
  const host = document.querySelector("#host") as HTMLElement
  const input = document.querySelector("input") as HTMLInputElement
  const root = host.attachShadow({ mode: "open" })
  root.innerHTML = '<div id="outer"><div id="inner-host"><slot></slot></div></div>'
  const innerHost = root.querySelector("#inner-host") as HTMLElement
  const innerRoot = innerHost.attachShadow({ mode: "open" })
  innerRoot.innerHTML =
    '<div id="inner"><slot style="display:block"></slot></div><button>Shadow-owned</button>'
  mockShadowFilterStyles()
  return {
    host,
    input,
    outer: root.querySelector("#outer") as HTMLElement,
    inner: innerRoot.querySelector("#inner") as HTMLElement,
    slot: innerRoot.querySelector("slot") as HTMLSlotElement,
  }
}

function slottedTextLabel() {
  const fixture = slottedControl()
  fixture.host.replaceChildren(document.createTextNode("Projected name"))
  fixture.input.removeAttribute("aria-label")
  fixture.input.setAttribute("aria-labelledby", fixture.host.id)
  fixture.input.placeholder = "Fallback"
  document.body.append(fixture.input)
  return fixture
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

  test.each([
    "opacity(0)",
    "opacity(0%)",
    "blur(1px) opacity(0.0) contrast(2)",
    "opacity(1) opacity(0e0)",
  ])("excludes filter-transparent controls on the target or an ancestor: %s", async (filter) => {
    for (const selector of ["input", "#ancestor"]) {
      document.body.innerHTML = '<div id="ancestor"><input aria-label="Target"></div>'
      const input = document.querySelector("input") as HTMLInputElement
      const filtered = document.querySelector(selector) as HTMLElement
      filtered.style.filter = filter
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: () => input,
      })
      expect(getComputedStyle(filtered).opacity || "1").toBe("1")
      expect(await discover()).toMatchObject({ elements: [] })
    }
  })

  test.each([
    "none",
    "blur(1px)",
    "opacity(0.5)",
    "opacity(50%) contrast(2)",
    "opacity(1e-8)",
    'url("https://example.test/opacity(0)") opacity(1)',
  ])("retains controls without a zero-opacity filter: %s", async (filter) => {
    document.body.innerHTML = '<div><input aria-label="Target"></div>'
    const input = document.querySelector("input") as HTMLInputElement
    input.style.filter = filter
    ;(input.parentElement as HTMLElement).style.filter = filter
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => input })
    expect(await discover()).toMatchObject({ elements: [{ name: "Target", ref: "e1" }] })
    expect(await click()).toMatchObject({ ok: true })
  })

  test.each(["0", "1"])(
    "reads a shared large filter once per discovery without caching across operations: opacity(%s)",
    async (opacity) => {
      document.body.innerHTML = `<div id="ancestor">${'<button type="button" aria-label="Target">Go</button>'.repeat(32)}</div>`
      const ancestor = document.querySelector("#ancestor") as HTMLElement
      ancestor.style.filter = sizedFilter(4096, opacity)
      const computedStyle = getComputedStyle
      let filterReads = 0
      vi.stubGlobal("getComputedStyle", (element: Element) => {
        const style = computedStyle(element)
        return element === ancestor
          ? new Proxy(style, {
              get(target, key) {
                if (key === "filter") filterReads++
                return Reflect.get(target, key)
              },
            })
          : style
      })
      expect((await discover()).elements).toHaveLength(opacity === "0" ? 0 : 32)
      expect(filterReads).toBe(1)
      ancestor.style.filter = opacity === "0" ? "opacity(1)" : "opacity(0)"
      expect((await discover()).elements).toHaveLength(opacity === "0" ? 32 : 0)
      expect(filterReads).toBe(2)
    },
  )

  test.each(["inspectClick", "click", "type"] as const)(
    "caches name-ancestor filters within each %s validation phase",
    async (operation) => {
      const depth = 8
      document.body.innerHTML = `${'<div class="layer">'.repeat(depth)}
        <span id="label">${"<span>x</span>".repeat(32)}</span><input aria-labelledby="label">
        ${"</div>".repeat(depth)}`
      for (const layer of document.querySelectorAll<HTMLElement>(".layer"))
        layer.style.filter = sizedFilter(4096)
      await discover()
      const computedStyle = getComputedStyle
      let reads = 0
      vi.stubGlobal("getComputedStyle", (element: Element) => {
        const style = computedStyle(element)
        return element.classList.contains("layer")
          ? new Proxy(style, {
              get(target, key) {
                if (key === "filter") reads++
                return Reflect.get(target, key)
              },
            })
          : style
      })
      expect(
        await executePageOperation(
          operation,
          { snapshotId: snapshot.id, ref: "e1", text: "Allowed" },
          false,
          null,
          context,
          snapshot,
        ),
      ).toMatchObject({ ok: true })
      expect(reads).toBe(depth * (operation === "type" ? 2 : 1))
      if (operation === "type")
        expect((document.querySelector("input") as HTMLInputElement).value).toBe("Allowed")
    },
  )

  test.each([":modal", ":popover-open", ":fullscreen"])(
    "stops filter inheritance at active %s roots but still checks the root and descendants",
    async (pseudo) => {
      document.body.innerHTML = `<div id="outside"><div id="surface"><div id="inside">
        <button type="button" aria-label="Target">Go</button>
        <span id="label">Named input</span><input aria-labelledby="label">
      </div></div></div>`
      const outside = document.querySelector("#outside") as HTMLElement
      const surface = document.querySelector("#surface") as HTMLElement
      const inside = document.querySelector("#inside") as HTMLElement
      const matches = surface.matches.bind(surface)
      let active = false
      // jsdom has no top-layer APIs; native activation/painting is covered in Chrome.
      vi.spyOn(surface, "matches").mockImplementation((selector) =>
        selector.includes(pseudo) ? active : matches(selector),
      )
      for (const filter of ["opacity(0)", sizedFilter(4097)]) {
        outside.style.filter = filter
        active = false
        expect((await discover()).elements).toEqual([])
        active = true
        expect((await discover()).elements.map((element) => element.name)).toEqual([
          "Target",
          "Named input",
        ])
        surface.style.filter = filter
        expect((await discover()).elements).toEqual([])
        surface.style.filter = "none"
        inside.style.filter = filter
        expect((await discover()).elements).toEqual([])
        inside.style.filter = "none"
      }
    },
  )

  test.each(["transparent", "oversized"])(
    "checks composed filter ancestors of nested slotted controls: %s",
    async (kind) => {
      const filter = kind === "transparent" ? "opacity(0)" : sizedFilter(4097)
      const { input, outer, inner, slot } = slottedControl()
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: () => input,
      })
      expect(input.assignedSlot?.assignedSlot).toBe(slot)
      for (const ancestor of [slot, inner, outer]) {
        ancestor.style.filter = filter
        expect((await discover()).elements).toEqual([])
        ancestor.style.filter = "opacity(0.5)"
        // Shadow-owned controls are not added to discovery.
        expect((await discover()).elements).toMatchObject([{ name: "Target" }])
        expect((await discover()).elements).toHaveLength(1)
        expect(await click()).toMatchObject({ ok: true })
        ancestor.style.filter = "none"
      }
    },
  )

  test.each(["transparent", "oversized"])(
    "ignores filters on boxless composed ancestors: %s",
    async (kind) => {
      const { slot, inner, host } = slottedControl()
      for (const ancestor of [slot, inner, host]) {
        ancestor.style.display = "contents"
        ancestor.style.filter = kind === "transparent" ? "opacity(0)" : sizedFilter(4097)
        expect((await discover()).elements).toMatchObject([{ name: "Target" }])
        expect(await click()).toMatchObject({ ok: true })
        ancestor.style.display = "block"
        expect((await discover()).elements).toEqual([])
        ancestor.style.filter = "none"
      }
    },
  )

  test.each(["transparent", "oversized"])(
    "excludes slotted label text hidden by a shadow wrapper: %s",
    async (kind) => {
      const filter = kind === "transparent" ? "opacity(0)" : sizedFilter(4097)
      document.body.innerHTML =
        '<div id="host"><span id="name">Hidden label</span></div><input aria-labelledby="name" placeholder="Fallback">'
      const root = document.querySelector("#host")?.attachShadow({ mode: "open" }) as ShadowRoot
      root.innerHTML = "<div><slot></slot></div>"
      mockShadowFilterStyles()
      const wrapper = root.querySelector("div") as HTMLElement
      wrapper.style.filter = filter
      expect((await discover()).elements).toMatchObject([{ name: "Fallback" }])
      wrapper.style.filter = "none"
      expect((await discover()).elements).toMatchObject([{ name: "Hidden label" }])
    },
  )

  test.each([
    ["click", "transparent"],
    ["type", "transparent"],
    ["click", "oversized"],
    ["type", "oversized"],
  ] as const)("rechecks slotted ancestors before %s with a %s filter", async (operation, kind) => {
    const { input, inner } = slottedControl()
    await discover()
    const clicked = vi.spyOn(input, "click")
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async () => {
      inner.style.filter = kind === "transparent" ? "opacity(0)" : sizedFilter(4097)
      return { ok: true }
    })
    expect(
      await executePageOperation(
        operation,
        { snapshotId: snapshot.id, ref: "e1", text: "Never write" },
        false,
        null,
        context,
        snapshot,
      ),
    ).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } })
    expect(clicked).not.toHaveBeenCalled()
    expect(input.value).toBe("")
  })

  test.each(["transparent", "oversized"])(
    "refreshes slotted filter checks after focus: %s",
    async (kind) => {
      const filter = kind === "transparent" ? "opacity(0)" : sizedFilter(4097)
      const { input, inner } = slottedControl()
      await discover()
      input.addEventListener("focus", () => {
        inner.style.filter = filter
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
    },
  )

  test("stops composed filter checks at an active top-layer root inside a shadow tree", async () => {
    const { host, input, inner, slot } = slottedControl()
    host.style.filter = "opacity(0)"
    const matches = inner.matches.bind(inner)
    vi.spyOn(inner, "matches").mockImplementation(
      (selector) => selector.includes(":modal") || matches(selector),
    )
    expect((await discover()).elements).toMatchObject([{ name: "Target" }])
    expect(await click()).toMatchObject({ ok: true })
    for (const ancestor of [inner, slot, input]) {
      ancestor.style.filter = "opacity(0)"
      expect((await discover()).elements).toEqual([])
      ancestor.style.filter = "none"
    }
  })

  test.each(["transparent", "oversized"])(
    "filters directly slotted text names through nested shadow ancestors: %s",
    async (kind) => {
      const { host, slot, inner, outer } = slottedTextLabel()
      const text = host.firstChild as Text
      expect(text.assignedSlot?.assignedSlot).toBe(slot)
      for (const ancestor of [slot, inner, outer]) {
        ancestor.style.filter = kind === "transparent" ? "opacity(0)" : sizedFilter(4097)
        expect((await discover()).elements).toMatchObject([{ name: "Fallback" }])
        ancestor.style.filter = "opacity(0.5)"
        expect((await discover()).elements).toMatchObject([{ name: "Projected name" }])
        ancestor.style.filter = "none"
      }
      slot.style.display = "contents"
      slot.style.filter = kind === "transparent" ? "opacity(0)" : sizedFilter(4097)
      expect((await discover()).elements).toMatchObject([{ name: "Projected name" }])
      host.style.filter = "opacity(0)"
      const matches = inner.matches.bind(inner)
      vi.spyOn(inner, "matches").mockImplementation(
        (selector) => selector.includes(":modal") || matches(selector),
      )
      expect((await discover()).elements).toMatchObject([{ name: "Projected name" }])
      inner.style.filter = "opacity(0)"
      expect((await discover()).elements).toMatchObject([{ name: "Fallback" }])
    },
  )

  test("keeps visible sibling text when a direct text assignment is filtered", async () => {
    const { host, inner, outer } = slottedTextLabel()
    const sibling = document.createElement("span")
    sibling.slot = "visible"
    sibling.textContent = "Visible sibling"
    host.append(sibling)
    const slot = document.createElement("slot")
    slot.name = "visible"
    outer.append(slot)
    inner.style.filter = "opacity(0)"
    expect((await discover()).elements).toMatchObject([{ name: "Visible sibling" }])
  })

  test.each(["inspectClick", "click", "type"] as const)(
    "invalidates %s when a directly slotted name becomes filtered",
    async (operation) => {
      const { input, inner } = slottedTextLabel()
      const clicked = vi.spyOn(input, "click")
      for (const filter of ["opacity(0)", sizedFilter(4097)]) {
        inner.style.filter = "none"
        await discover()
        inner.style.filter = filter
        expect(
          await executePageOperation(
            operation,
            { snapshotId: snapshot.id, ref: "e1", text: "Never write" },
            false,
            null,
            context,
            snapshot,
          ),
        ).toMatchObject({ ok: false, error: { code: "STALE_CONTEXT" } })
        expect(clicked).not.toHaveBeenCalled()
        expect(input.value).toBe("")
      }
    },
  )

  test.each(["transparent", "oversized"])(
    "rechecks directly slotted name filters after focus: %s",
    async (kind) => {
      const { input, inner } = slottedTextLabel()
      await discover()
      input.addEventListener("focus", () => {
        inner.style.filter = kind === "transparent" ? "opacity(0)" : sizedFilter(4097)
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
    },
  )

  test.each([4096, 4097, 64 * 1024])(
    "bounds parsing of a shared %i-unit filter applied to distinct controls",
    async (length) => {
      document.body.innerHTML = `<style>.target { filter: ${sizedFilter(length)} }</style>
        ${'<input class="target" aria-label="Target">'.repeat(32)}
        <button type="button" aria-label="Unfiltered">Continue</button>`
      const input = document.querySelector("input") as HTMLInputElement
      expect(getComputedStyle(input).filter).toHaveLength(length)
      const matchAll = String.prototype.matchAll
      const parsedLengths: number[] = []
      vi.spyOn(String.prototype, "matchAll").mockImplementation(function (
        this: string,
        expression: RegExp,
      ) {
        if (expression.source.includes("opacity")) parsedLengths.push(this.length)
        return matchAll.call(this, expression)
      })
      const result = await discover()
      expect(Math.max(0, ...parsedLengths)).toBeLessThanOrEqual(4096)
      expect(result.elements).toHaveLength(length <= 4096 ? 33 : 1)
      expect(result.elements.at(-1)?.name).toBe("Unfiltered")
      expect(result.truncated).toBe(false)
    },
  )

  test("omits names from labels with oversized filters while retaining visible fallbacks", async () => {
    document.body.innerHTML = `<span id="label" style='filter:${sizedFilter(4097)}'>Unsupported name</span>
      <button type="button" aria-labelledby="label" aria-label="Fallback">Go</button>`
    expect((await discover()).elements.map((element) => element.name)).toEqual(["Fallback"])
  })

  test.each([
    ["click", "transparent"],
    ["type", "transparent"],
    ["click", "oversized"],
    ["type", "oversized"],
  ] as const)(
    "rejects reference %s when a filter becomes %s before mutation",
    async (operation, filter) => {
      document.body.innerHTML = '<div><input aria-label="Target"></div>'
      const input = document.querySelector("input") as HTMLInputElement
      const ancestor = input.parentElement as HTMLElement
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: () => input,
      })
      await discover()
      const clicked = vi.spyOn(input, "click")
      vi.mocked(chrome.runtime.sendMessage).mockImplementation(async () => {
        ancestor.style.filter = filter === "transparent" ? "opacity(0)" : sizedFilter(4097)
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

  test.each(["transparent", "oversized"])(
    "rejects reference typing when focus makes an ancestor filter %s",
    async (filter) => {
      document.body.innerHTML = '<div><input aria-label="Target"></div>'
      const input = document.querySelector("input") as HTMLInputElement
      await discover()
      input.addEventListener("focus", () => {
        ;(input.parentElement as HTMLElement).style.filter =
          filter === "transparent" ? "opacity(0)" : sizedFilter(4097)
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
    },
  )

  test.each([
    '<div style="filter:opacity(0)"><span id="label">Invisible</span></div><button type="button" aria-labelledby="label" aria-label="Fallback">Answer</button>',
    '<label for="control" style="filter:opacity(0%)">Invisible</label><input id="control" placeholder="Fallback">',
    '<button type="button">Fallback<span style="filter:opacity(0)">Invisible</span></button>',
  ])("excludes filter-transparent label text while retaining fallbacks: %s", async (markup) => {
    document.body.innerHTML = markup
    expect((await discover()).elements.map((element) => element.name)).toEqual(["Fallback"])
  })

  test("preserves legacy selector visibility behavior for filters", async () => {
    document.body.innerHTML = '<button type="button" style="filter:opacity(0)">Go</button>'
    expect(await executePageOperation("click", { selector: "button" }, false)).toMatchObject({
      ok: true,
    })
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

  test.each(["inspectClick", "click", "type"] as const)(
    "rejects %s references when an ancestor fieldset enables a previously disabled control",
    async (operation) => {
      document.body.innerHTML = '<fieldset disabled><input aria-label="Target"></fieldset>'
      const fieldset = document.querySelector("fieldset") as HTMLFieldSetElement
      const input = document.querySelector("input") as HTMLInputElement
      expect(input.disabled).toBe(false)
      expect(input.matches(":disabled")).toBe(true)
      expect((await discover()).elements[0]).toMatchObject({ disabled: true, actions: [] })
      const clicked = vi.spyOn(input, "click")
      if (operation === "inspectClick") fieldset.disabled = false
      else
        vi.mocked(chrome.runtime.sendMessage).mockImplementation(async () => {
          fieldset.disabled = false
          return { ok: true }
        })
      const perform = () =>
        executePageOperation(
          operation,
          { snapshotId: snapshot.id, ref: "e1", text: "New text" },
          false,
          null,
          context,
          snapshot,
        )
      expect(await perform()).toMatchObject({ ok: false, error: { code: "STALE_CONTEXT" } })
      expect(input.getAttribute("disabled")).toBeNull()
      expect(clicked).not.toHaveBeenCalled()
      expect(input.value).toBe("")
      expect((await discover()).elements[0]).toMatchObject({
        disabled: false,
        actions: ["click", "type"],
      })
      expect(await perform()).toMatchObject({ ok: true })
    },
  )

  test("preserves first-legend references when fieldset toggles leave their disabled state unchanged", async () => {
    document.body.innerHTML =
      '<fieldset disabled><legend><button type="button">Legend</button></legend><button type="button">Other</button></fieldset>'
    expect((await discover()).elements).toMatchObject([
      { name: "Legend", disabled: false, actions: ["click"] },
      { name: "Other", disabled: true, actions: [] },
    ])
    const fieldset = document.querySelector("fieldset") as HTMLFieldSetElement
    fieldset.disabled = false
    expect(await click("e1")).toMatchObject({ ok: true })
    expect(await click("e2")).toMatchObject({ ok: false, error: { code: "STALE_CONTEXT" } })
    fieldset.disabled = true
    expect(await click("e1")).toMatchObject({ ok: true })
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
