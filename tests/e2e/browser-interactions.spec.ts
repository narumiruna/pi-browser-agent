import { expect, test } from "@playwright/test"
import type { RuntimeResponse } from "../../src/browser/runtime/messages.js"
import type { JsonObject } from "../../src/browser/runtime/types.js"
import { type ExtensionHarness, launchExtensionHarness } from "./support/extension-harness.js"

const FIXTURE = `<!doctype html>
<html><head><title>Local browser interactions</title><style>
  html { scroll-behavior: auto; }
  body { margin: 0; height: 2800px; }
  #marker { position: fixed; top: 12px; left: 12px; }
  #private { position: fixed; top: 52px; left: 12px; width: 180px; height: 24px; }
  #choice { position: fixed; top: 100px; left: 12px; }
  #outer { position: fixed; top: 180px; left: 20px; width: 480px; height: 240px; overflow: auto; }
  #inner { width: 260px; height: 120px; overflow: auto; }
  #inner-content { width: 600px; height: 600px; }
  #outer-spacer { height: 600px; }
</style></head><body>
  <button id="marker" type="button">Fixture marker</button>
  <input id="private" aria-label="Private title" role="textbox" value="private-field-value" readonly required>
  <select id="choice" aria-label="Choice"><option value="private-first">First</option><option value="private-second">Second</option></select>
  <div id="outer" tabindex="0" aria-label="Outer scroll area">
    <div id="inner" tabindex="0" aria-label="Inner scroll area"><div id="inner-content">Local nested content</div></div>
    <div id="outer-spacer"></div>
  </div>
</body></html>`

type Target = { snapshotId: string; ref: string }
type TabContext = { tabId: number; url: string; epoch: number }
interface ScrollResult {
  distance: number
  atTop: boolean
  atBottom: boolean
  position: number
  minPosition: number
  maxPosition: number
  viewport: { width: number; height: number; scrollX: number; scrollY: number }
  url: string
  title: string
  snapshotInvalidated: boolean
}

async function prepare(harness: ExtensionHarness) {
  await harness.fixturePage.setViewportSize({ width: 1000, height: 700 })
  await harness.fixturePage.setContent(FIXTURE)
  await harness.controller.evaluate(async (url) => {
    const parsed = new URL(url)
    await chrome.storage.local.set({
      piBrowserAgentApprovedHostPermissions: [`${parsed.protocol}//${parsed.hostname}/*`],
    })
  }, harness.fixtureUrl)
  await harness.fixturePage.bringToFront()
  const state = (await harness.controller.evaluate(() =>
    chrome.runtime.sendMessage({
      kind: "request",
      requestId: crypto.randomUUID(),
      method: "app.getState",
      params: {},
    }),
  )) as { ok: boolean; result?: { tabContext?: TabContext } }
  const tabContext = state.result?.tabContext
  expect(tabContext?.url).toBe(harness.fixtureUrl)
  if (!tabContext) throw new Error("Missing local fixture tab context")
  const request = (
    method: string,
    params: Record<string, unknown>,
    confirmed = false,
  ): Promise<RuntimeResponse> =>
    harness.controller.evaluate<
      unknown,
      {
        method: string
        params: Record<string, unknown>
        confirmed: boolean
        tabContext: TabContext
      }
    >(
      async ({ method, params, confirmed, tabContext }) =>
        (await chrome.runtime.sendMessage({
          kind: "request",
          requestId: crypto.randomUUID(),
          method,
          params,
          confirmed,
          tabContext,
        })) as unknown,
      { method, params, confirmed, tabContext },
    ) as Promise<RuntimeResponse>
  const run = async <T>(
    method: string,
    params: Record<string, unknown>,
    confirmed = false,
  ): Promise<T> => {
    const response = await request(method, params, confirmed)
    if (!response.ok)
      throw new Error(`${method}: ${response.error.code}: ${response.error.message}`)
    return response.result as T
  }
  const discover = async (name: string): Promise<Target> => {
    const result = await run<{
      snapshotId: string
      elements: Array<{ ref: string; name: string }>
    }>("page.listElements", {})
    const element = result.elements.find((entry) => entry.name === name)
    if (!element) throw new Error(`Missing fixture reference: ${name}`)
    return { snapshotId: result.snapshotId, ref: element.ref }
  }
  const assertInvalidated = async (target: Target) => {
    expect(await request("page.getElementDetails", target)).toMatchObject({
      ok: false,
      error: { code: "STALE_CONTEXT" },
    })
    // Check the extension's isolated registry, not the page's main world.
    const registryId = await harness.controller.evaluate(async (tabId) => {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "ISOLATED",
        func: () =>
          (
            globalThis as typeof globalThis & {
              __piBrowserAgentElements?: { snapshot: { id: string } }
            }
          ).__piBrowserAgentElements?.snapshot.id ?? null,
      })
      return results[0]?.result
    }, tabContext.tabId)
    expect(registryId).not.toBe(target.snapshotId)
  }
  return { request, run, discover, assertInvalidated }
}

test("viewport scroll reports actual geometry and invalidates references even at a boundary", async () => {
  const harness = await launchExtensionHarness()
  try {
    const { run, discover, assertInvalidated } = await prepare(harness)
    const target = await discover("Fixture marker")
    const first = await run<ScrollResult>("page.scroll", { direction: "down", amount: "page" })
    expect(first).toEqual({
      mutationOutcome: "dispatched",
      distance: 700,
      atTop: false,
      atBottom: false,
      position: 700,
      minPosition: 0,
      maxPosition: 2100,
      viewport: { width: 1000, height: 700, scrollX: 0, scrollY: 700 },
      url: harness.fixtureUrl,
      title: "Local browser interactions",
      snapshotInvalidated: true,
    })
    expect(await harness.fixturePage.evaluate(() => window.scrollY)).toBe(first.position)
    await assertInvalidated(target)
    const half = await run<ScrollResult>("page.scroll", { direction: "up", amount: "half-page" })
    expect(half).toMatchObject({ distance: -350, position: 350, atTop: false })
    const bottom = await run<ScrollResult>("page.scroll", {
      direction: "down",
      amount: "pixels",
      pixels: 10000,
    })
    expect(bottom).toMatchObject({
      distance: 1750,
      position: 2100,
      maxPosition: 2100,
      atBottom: true,
    })
    const boundaryTarget = await discover("Fixture marker")
    const boundary = await run<ScrollResult>("page.scroll", { direction: "down", amount: "page" })
    expect(boundary).toMatchObject({
      distance: 0,
      position: 2100,
      atBottom: true,
      snapshotInvalidated: true,
    })
    await assertInvalidated(boundaryTarget)
    const top = await run<ScrollResult>("page.scroll", {
      direction: "up",
      amount: "pixels",
      pixels: 10000,
    })
    expect(top).toMatchObject({ distance: -2100, position: 0, atTop: true, atBottom: false })
    const topTarget = await discover("Fixture marker")
    expect(
      await run<ScrollResult>("page.scroll", { direction: "up", amount: "half-page" }),
    ).toMatchObject({
      distance: 0,
      atTop: true,
      snapshotInvalidated: true,
    })
    await assertInvalidated(topTarget)
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("a reverse-flex viewport root retains non-negative scroll coordinates", async () => {
  const harness = await launchExtensionHarness()
  try {
    const { run, discover, assertInvalidated } = await prepare(harness)
    await harness.fixturePage.addStyleTag({
      content: "html { display: flex; flex-direction: column-reverse; }",
    })
    const target = await discover("Fixture marker")
    expect(
      await run<ScrollResult>("page.scroll", { direction: "down", amount: "page" }),
    ).toMatchObject({
      distance: 700,
      position: 700,
      minPosition: 0,
      maxPosition: 2100,
      atTop: false,
      atBottom: false,
    })
    expect(await harness.fixturePage.evaluate(() => window.scrollY)).toBe(700)
    await assertInvalidated(target)
    expect(
      await run<ScrollResult>("page.scroll", { direction: "up", amount: "pixels", pixels: 10000 }),
    ).toMatchObject({
      distance: -700,
      position: 0,
      atTop: true,
      atBottom: false,
    })
    expect(
      await run<ScrollResult>("page.scroll", {
        direction: "down",
        amount: "pixels",
        pixels: 10000,
      }),
    ).toMatchObject({
      distance: 2100,
      position: 2100,
      atTop: false,
      atBottom: true,
    })
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("nested containers scroll independently, clamp to their boundaries and report scrollability", async () => {
  const harness = await launchExtensionHarness()
  try {
    const { run, discover, assertInvalidated } = await prepare(harness)
    let inner = await discover("Inner scroll area")
    expect(await run<JsonObject>("page.getElementDetails", inner)).toMatchObject({
      name: "Inner scroll area",
      visible: true,
      scrollability: {
        vertical: true,
        horizontal: true,
        scrollTop: 0,
        scrollLeft: 0,
        scrollHeight: 600,
        scrollWidth: 600,
        clientHeight: 120,
        clientWidth: 260,
      },
    })
    const first = await run<ScrollResult>("page.scroll", {
      ...inner,
      direction: "down",
      amount: "half-page",
    })
    expect(first).toMatchObject({
      distance: 60,
      position: 60,
      maxPosition: 480,
      atTop: false,
      atBottom: false,
    })
    await assertInvalidated(inner)
    inner = await discover("Inner scroll area")
    expect(
      await run<ScrollResult>("page.scroll", {
        ...inner,
        direction: "down",
        amount: "pixels",
        pixels: 10000,
      }),
    ).toMatchObject({
      distance: 420,
      position: 480,
      atBottom: true,
    })
    inner = await discover("Inner scroll area")
    expect(
      await run<ScrollResult>("page.scroll", { ...inner, direction: "down", amount: "page" }),
    ).toMatchObject({
      distance: 0,
      position: 480,
      atBottom: true,
      snapshotInvalidated: true,
    })
    await assertInvalidated(inner)
    expect(
      await harness.fixturePage.evaluate(() => ({
        outer: document.querySelector("#outer")?.scrollTop,
        inner: document.querySelector("#inner")?.scrollTop,
        innerX: document.querySelector("#inner")?.scrollLeft,
        viewport: window.scrollY,
      })),
    ).toEqual({ outer: 0, inner: 480, innerX: 0, viewport: 0 })
    inner = await discover("Inner scroll area")
    expect(
      await run<ScrollResult>("page.scroll", {
        ...inner,
        direction: "up",
        amount: "pixels",
        pixels: 10000,
      }),
    ).toMatchObject({
      distance: -480,
      position: 0,
      atTop: true,
    })
    const outer = await discover("Outer scroll area")
    expect(
      await run<ScrollResult>("page.scroll", { ...outer, direction: "down", amount: "page" }),
    ).toMatchObject({
      distance: 240,
      position: 240,
      maxPosition: 480,
      viewport: { scrollY: 0 },
    })
    expect(
      await harness.fixturePage.evaluate(() => document.querySelector("#inner")?.scrollTop),
    ).toBe(0)
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("body scroll containers and reverse-flow flex containers expose the full vertical range", async () => {
  const harness = await launchExtensionHarness()
  try {
    const { run, discover, assertInvalidated } = await prepare(harness)
    await harness.fixturePage.setContent(`<!doctype html><style>
      html { height: 100%; overflow: hidden; }
      body { height: 100%; margin: 0; overflow-y: auto; }
      #content { height: 2000px; }
    </style><body aria-label="Body scroll area"><div id="content">Local content</div></body>`)
    const body = await discover("Body scroll area")
    expect(
      await run<ScrollResult>("page.scroll", { direction: "down", amount: "page" }),
    ).toMatchObject({ distance: 0, atTop: true, atBottom: true })
    // Even a viewport boundary scroll invalidates the body reference.
    await assertInvalidated(body)
    const freshBody = await discover("Body scroll area")
    expect(
      await run<ScrollResult>("page.scroll", { ...freshBody, direction: "down", amount: "page" }),
    ).toMatchObject({
      distance: 700,
      position: 700,
      minPosition: 0,
      maxPosition: 1300,
      atTop: false,
      atBottom: false,
      viewport: { scrollY: 0 },
    })
    expect(await harness.fixturePage.evaluate(() => document.body.scrollTop)).toBe(700)
    await assertInvalidated(freshBody)

    await harness.fixturePage.setContent(`<!doctype html><style>
      body { margin: 0; }
      #reverse { display: flex; flex-direction: column-reverse; height: 100px; width: 300px; overflow-y: auto; }
      .item { flex-shrink: 0; height: 250px; }
    </style><div id="reverse" aria-label="Reverse scroll area"><div class="item">One</div><div class="item">Two</div></div>`)
    let reverse = await discover("Reverse scroll area")
    expect(
      await run<ScrollResult>("page.scroll", { ...reverse, direction: "up", amount: "page" }),
    ).toMatchObject({
      distance: -100,
      position: -100,
      minPosition: -400,
      maxPosition: 0,
      atTop: false,
      atBottom: false,
    })
    await assertInvalidated(reverse)
    reverse = await discover("Reverse scroll area")
    expect(
      await run<ScrollResult>("page.scroll", {
        ...reverse,
        direction: "up",
        amount: "pixels",
        pixels: 10000,
      }),
    ).toMatchObject({ distance: -300, position: -400, atTop: true, atBottom: false })
    reverse = await discover("Reverse scroll area")
    expect(
      await run<ScrollResult>("page.scroll", { ...reverse, direction: "up", amount: "page" }),
    ).toMatchObject({ distance: 0, atTop: true, atBottom: false })
    reverse = await discover("Reverse scroll area")
    expect(
      await run<ScrollResult>("page.scroll", {
        ...reverse,
        direction: "down",
        amount: "pixels",
        pixels: 10000,
      }),
    ).toMatchObject({ distance: 400, position: 0, atTop: false, atBottom: true })
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("details preserves field privacy and select requires confirmation before native input/change events", async () => {
  const harness = await launchExtensionHarness()
  try {
    const { request, run, discover, assertInvalidated } = await prepare(harness)
    await harness.fixturePage.locator("#private").focus()
    const input = await discover("Private title")
    const details = await run<JsonObject>("page.getElementDetails", input)
    const rect = await harness.fixturePage.locator("#private").evaluate((element) => {
      const { x, y, top, right, bottom, left, width, height } = element.getBoundingClientRect()
      return { x, y, top, right, bottom, left, width, height }
    })
    expect(details).toMatchObject({
      name: "Private title",
      role: "textbox",
      visible: true,
      rect,
      state: { disabled: false, readOnly: true, required: true, focused: true },
    })
    expect(JSON.stringify(details)).not.toContain("private-field-value")
    expect(details).not.toHaveProperty("value")
    await harness.fixturePage.evaluate(() => {
      const select = document.querySelector("#choice") as HTMLSelectElement
      const events: Array<{ type: string; value: string; trusted: boolean }> = []
      document.body.dataset.events = JSON.stringify(events)
      for (const type of ["input", "change"]) {
        document.body.addEventListener(type, (event) => {
          events.push({ type: event.type, value: select.value, trusted: event.isTrusted })
          document.body.dataset.events = JSON.stringify(events)
        })
      }
      Object.defineProperty(select, "value", {
        get: () => select.options[select.selectedIndex]?.value,
        set: () => {
          throw new Error("Must use the native select value setter")
        },
      })
    })
    for (const option of [{ label: "Second" }, { value: "private-first" }]) {
      const target = await discover("Choice")
      const previous = await harness.fixturePage.locator("#choice").inputValue()
      const previousEvents = await harness.fixturePage.locator("body").getAttribute("data-events")
      expect(await request("page.selectOption", { ...target, ...option })).toMatchObject({
        ok: false,
        error: { code: "CONFIRMATION_REQUIRED" },
      })
      await expect(harness.fixturePage.locator("#choice")).toHaveValue(previous)
      await expect(harness.fixturePage.locator("body")).toHaveAttribute(
        "data-events",
        previousEvents ?? "[]",
      )
      await run("page.selectOption", { ...target, ...option }, true)
      await assertInvalidated(target)
    }
    await expect(harness.fixturePage.locator("#choice")).toHaveValue("private-first")
    expect(
      JSON.parse((await harness.fixturePage.locator("body").getAttribute("data-events")) ?? "[]"),
    ).toEqual([
      { type: "input", value: "private-second", trusted: false },
      { type: "change", value: "private-second", trusted: false },
      { type: "input", value: "private-first", trusted: false },
      { type: "change", value: "private-first", trusted: false },
    ])
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})
