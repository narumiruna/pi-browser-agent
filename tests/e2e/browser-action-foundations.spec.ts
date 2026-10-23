import { chromium, expect, test } from "@playwright/test"
import type { RuntimeResponse } from "../../src/browser/runtime/messages.js"
import {
  configureMockCodex,
  type ExtensionHarness,
  launchExtensionHarness,
} from "./support/extension-harness.js"
import { CODEX_RESPONSES_URL, finalTextResponse, toolCallResponse } from "./support/mock-codex.js"

test("native semantics: one activation, cancellation rollback, radio groups and removal", async () => {
  const browser = await chromium.launch({ channel: "chromium", headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(`<input id="check" type="checkbox"><input id="cancel" type="checkbox">
      <input id="radio1" type="radio" name="group" checked><input id="radio2" type="radio" name="group">
      <input id="remove" type="checkbox">`)
    const observed = await page.evaluate(() => {
      const events: string[] = []
      for (const type of ["click", "input", "change"]) {
        document.addEventListener(type, (event) => {
          const input = event.target as HTMLInputElement
          events.push(`${input.id}:${type}:${input.checked}`)
        })
      }
      const input = (id: string) => document.getElementById(id) as HTMLInputElement
      input("cancel").addEventListener("click", (event) => event.preventDefault())
      input("remove").addEventListener("click", (event) => (event.target as Element).remove())
      input("check").click()
      input("cancel").click()
      input("radio2").click()
      const removed = input("remove")
      removed.click()
      return {
        events,
        checked: input("check").checked,
        cancelled: input("cancel").checked,
        radios: [input("radio1").checked, input("radio2").checked],
        removed: { connected: removed.isConnected, checked: removed.checked },
      }
    })
    expect(observed).toEqual({
      events: [
        "check:click:true",
        "check:input:true",
        "check:change:true",
        "cancel:click:true",
        "radio2:click:true",
        "radio2:input:true",
        "radio2:change:true",
        "remove:click:true",
      ],
      checked: true,
      cancelled: false,
      radios: [false, true],
      removed: { connected: false, checked: true },
    })
  } finally {
    await browser.close()
  }
})

test("native semantics: activation can navigate before a later observation", async () => {
  const browser = await chromium.launch({ channel: "chromium", headless: true })
  try {
    const page = await browser.newPage()
    await page.route("http://fixture.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: route.request().url().endsWith("/after")
          ? "<p>After activation</p>"
          : `<input type="checkbox" onclick="location.href='/after'">`,
      }),
    )
    await page.goto("http://fixture.test/before")
    await Promise.all([
      page.waitForURL("http://fixture.test/after"),
      page.evaluate(() => (document.querySelector("input") as HTMLInputElement).click()),
    ])
    await expect(page.locator("p")).toHaveText("After activation")
    expect(await page.locator("input").count()).toBe(0)
  } finally {
    await browser.close()
  }
})

test("native semantics: option labels and inline rendered text need explicit normalization", async () => {
  const browser = await chromium.launch({ channel: "chromium", headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(`<select><option value="private" label="Exact label">Other text</option>
      <optgroup label="Disabled group" disabled><option hidden> Hidden   option </option></optgroup>
      <option style="display:none">CSS hidden</option></select>
      <p id="text">Alpha <b>beta</b>  gamma\n delta <span hidden>SECRET</span><span>😀end</span></p>`)
    const observed = await page.evaluate(() => ({
      options: Array.from(document.querySelectorAll("option"), (option) => ({
        label: option.label,
        hidden: option.hidden,
        disabled: option.disabled || option.parentElement?.hasAttribute("disabled"),
      })),
      // biome-ignore lint/performance/useDomNodeTextContent: This test checks rendered whitespace and hidden-text behavior.
      text: (document.querySelector("#text") as HTMLElement).innerText,
    }))
    expect(observed).toEqual({
      options: [
        { label: "Exact label", hidden: false, disabled: false },
        { label: "Hidden option", hidden: true, disabled: true },
        { label: "CSS hidden", hidden: false, disabled: false },
      ],
      text: "Alpha beta gamma delta 😀end",
    })
  } finally {
    await browser.close()
  }
})

const FIXTURE = `<!doctype html><html><head><title>Action foundations fixture</title>
  <style>body { margin: 16px; } label { display: block; margin: 8px 0; }
  #offscreen { margin-top: 1600px; } #clipped { height: 0; overflow: hidden; }</style></head><body>
  <button type="button">Alpha action</button><button type="button">Beta action</button>
  <label><input id="check" type="checkbox">Confirm checkbox</label>
  <label><input id="cancel" type="checkbox">Cancelled checkbox</label>
  <label><input id="remove" type="checkbox">Removed checkbox</label>
  <label><input id="navigate" type="checkbox">Navigation checkbox</label>
  <label><input id="radio1" type="radio" name="choice" checked>First radio</label>
  <label><input id="radio2" type="radio" name="choice">Second radio</label>
  <select id="catalog" aria-label="Catalog">
    <option value="private-initial" label="Exact label">Not the native label</option>
    <option value="private-duplicate-a">Duplicate</option><option value="private-duplicate-b">Duplicate</option>
    <optgroup label="Disabled" disabled><option value="private-disabled">Disabled option</option></optgroup>
    <option hidden value="private-hidden">Hidden catalog label</option>
  </select>
  <p id="text">Alpha <b>beta</b>  gamma\n delta <span hidden>hidden-secret</span><span>😀end</span></p>
  <input aria-label="Private field" value="private-editable-secret"><div contenteditable>editable-secret</div>
  <div id="clipped">clipped-secret</div><p id="offscreen">Offscreen literal needle</p>
</body></html>`

type Target = { snapshotId: string; ref: string }
type TabContext = { tabId: number; url: string; epoch: number }
interface Discovery {
  snapshotId: string
  elements: Array<{ name: string; ref: string; role: string; type: string }>
  hasMore: boolean
  nextOffset?: number
  scanTruncated: boolean
}

async function prepare(harness: ExtensionHarness) {
  await harness.fixturePage.setViewportSize({ width: 1000, height: 900 })
  await harness.fixturePage.setContent(FIXTURE)
  await harness.fixturePage.evaluate(() => {
    const events: string[] = []
    for (const type of ["click", "input", "change"]) {
      document.addEventListener(type, (event) => {
        if (event.target instanceof HTMLInputElement) {
          events.push(`${event.target.id}:${event.type}`)
          document.body.dataset.events = JSON.stringify(events)
        }
      })
    }
    document.getElementById("cancel")?.addEventListener("click", (event) => event.preventDefault())
    document
      .getElementById("remove")
      ?.addEventListener("click", (event) => (event.target as Element).remove())
    document.getElementById("navigate")?.addEventListener("click", () => {
      location.hash = "activated"
    })
  })
  await harness.controller.evaluate(async (url) => {
    const parsed = new URL(url)
    await chrome.storage.local.set({
      piBrowserAgentApprovedHostPermissions: [`${parsed.protocol}//${parsed.hostname}/*`],
    })
  }, harness.fixtureUrl)
  await harness.fixturePage.bringToFront()
  const state = (await harness.controller.evaluate(
    async () =>
      await chrome.runtime.sendMessage({
        kind: "request",
        requestId: crypto.randomUUID(),
        method: "app.getState",
        params: {},
      }),
  )) as { ok: boolean; result?: { tabContext?: TabContext } }
  const tabContext = state.result?.tabContext
  if (!tabContext) throw new Error("Missing local fixture tab context")
  const request = async (
    method: string,
    params: Record<string, unknown>,
    confirmed = false,
  ): Promise<RuntimeResponse> =>
    await harness.controller.evaluate(
      async ({ method, params, confirmed, tabContext }) =>
        await chrome.runtime.sendMessage({
          kind: "request",
          requestId: crypto.randomUUID(),
          method,
          params,
          confirmed,
          tabContext,
        }),
      { method, params, confirmed, tabContext },
    )
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
    const result = await run<Discovery>("page.listElements", {})
    const element = result.elements.find((entry) => entry.name === name)
    if (!element) throw new Error(`Missing fixture target ${name}`)
    return { snapshotId: result.snapshotId, ref: element.ref }
  }
  const stale = async (target: Target) =>
    expect(await request("page.getElementDetails", target)).toMatchObject({
      ok: false,
      error: { code: "STALE_CONTEXT" },
    })
  return { request, run, discover, stale, tabContext }
}

test("extension: exact discovery filters, result pagination and snapshot replacement", async () => {
  const harness = await launchExtensionHarness()
  try {
    const { run, discover, stale } = await prepare(harness)
    const old = await discover("Confirm checkbox")
    const first = await run<Discovery>("page.listElements", {
      role: "button",
      type: "button",
      name: "action",
    })
    expect(first.elements.map((element) => element.name)).toEqual(["Alpha action", "Beta action"])
    expect(first).toMatchObject({ hasMore: false, scanTruncated: false })
    await stale(old)
    const second = await run<Discovery>("page.listElements", {
      role: "button",
      name: "action",
      offset: 1,
    })
    expect(second.elements.map((element) => element.name)).toEqual(["Beta action"])
    expect(second.snapshotId).not.toBe(first.snapshotId)
    expect((await run<Discovery>("page.listElements", { role: "Button" })).elements).toEqual([])
    expect((await run<Discovery>("page.listElements", { name: "ACTION" })).elements).toEqual([])
    expect((await run<Discovery>("page.listElements", { offset: 2000 })).elements).toEqual([])
    await harness.fixturePage.evaluate(() => {
      const buttons = document.createElement("div")
      buttons.style.cssText =
        "position:fixed;inset:0;display:grid;grid-template-columns:repeat(10,80px);grid-auto-rows:30px;background:white"
      for (let index = 0; index < 60; index++) {
        const button = document.createElement("button")
        button.textContent = `Paged ${index}`
        buttons.append(button)
      }
      document.body.replaceChildren(buttons)
    })
    const page = await run<Discovery>("page.listElements", { name: "Paged" })
    expect(page.elements).toHaveLength(50)
    expect(page).toMatchObject({ hasMore: true, nextOffset: 50, scanTruncated: false })
    const last = await run<Discovery>("page.listElements", {
      name: "Paged",
      offset: page.nextOffset,
    })
    expect(last.elements).toHaveLength(10)
    expect(last).toMatchObject({ hasMore: false, scanTruncated: false })
    await harness.fixturePage.evaluate(() => {
      const fragment = document.createDocumentFragment()
      for (let index = 0; index < 2000; index++) fragment.append(document.createElement("span"))
      const late = document.createElement("button")
      late.textContent = "Beyond scan budget"
      fragment.append(late)
      document.body.replaceChildren(fragment)
    })
    expect(await run<Discovery>("page.listElements", { name: "Beyond scan budget" })).toMatchObject(
      { elements: [], hasMore: false, scanTruncated: true },
    )
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("extension: text search is literal, scoped, offscreen and does not replace references or scroll", async () => {
  const harness = await launchExtensionHarness()
  try {
    const { run, request, discover } = await prepare(harness)
    const target = await discover("Confirm checkbox")
    const inline = await run<{ matches: Record<string, unknown>[]; scanTruncated: boolean }>(
      "page.findText",
      {
        query: "gamma delta",
        selector: "#text",
      },
    )
    expect(inline.matches).toHaveLength(1)
    expect(inline.matches[0]).toMatchObject({ start: 12, end: 24 })
    expect(
      (
        await run<{ matches: unknown[] }>("page.findText", {
          query: "beta gamma",
          selector: "#text",
        })
      ).matches,
    ).toEqual([])
    const unicodeSource = await harness.fixturePage.locator("#text").textContent()
    const unicode = await run<{ matches: unknown[] }>("page.findText", {
      query: "😀end",
      selector: "#text",
    })
    expect(unicode.matches[0]).toMatchObject({
      start: unicodeSource?.indexOf("😀end"),
      end: (unicodeSource?.indexOf("😀end") ?? 0) + 5,
    })
    expect(JSON.stringify(inline)).not.toMatch(/hidden-secret|snapshotId|"ref"/)
    expect(inline.scanTruncated).toBe(false)
    for (const query of [
      "hidden-secret",
      "private-editable-secret",
      "editable-secret",
      "clipped-secret",
      "beta.*gamma",
    ]) {
      expect((await run<{ matches: unknown[] }>("page.findText", { query })).matches).toEqual([])
    }
    expect(
      (await run<{ matches: unknown[] }>("page.findText", { query: "Offscreen literal needle" }))
        .matches,
    ).toHaveLength(1)
    expect(await harness.fixturePage.evaluate(() => window.scrollY)).toBe(0)
    expect(await request("page.getElementDetails", target)).toMatchObject({ ok: true })
    for (const selector of ["#missing-scope", "["]) {
      expect(await request("page.findText", { query: "Alpha", selector })).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST" },
      })
    }
    await harness.fixturePage.locator("#text").evaluate((element) => {
      element.textContent = "echo echo echo"
    })
    const continuation = await run<{ matches: unknown[] }>("page.findText", {
      query: "echo",
      selector: "#text",
      offset: 1,
    })
    expect(continuation.matches).toHaveLength(2)
    expect(continuation.matches[0]).toMatchObject({ start: 5, end: 9 })
    await harness.fixturePage.locator("#text").evaluate((element) => {
      const fragment = document.createDocumentFragment()
      for (let index = 0; index < 2000; index++) {
        const hidden = document.createElement("span")
        hidden.hidden = true
        hidden.textContent = "Excluded but counted"
        fragment.append(hidden)
      }
      fragment.append(document.createTextNode("Beyond text scan budget"))
      element.replaceChildren(fragment)
    })
    expect(
      await run("page.findText", { query: "Beyond text scan budget", selector: "#text" }),
    ).toMatchObject({ matches: [], scanTruncated: true, hasMore: false })
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("extension: text probes exclude CSS-clipped and effectively editable text", async () => {
  const harness = await launchExtensionHarness()
  try {
    const { run, request } = await prepare(harness)
    await harness.fixturePage.evaluate(() => {
      const scope = document.createElement("div")
      scope.id = "security-scope"
      scope.innerHTML =
        '<div style="clip-path:inset(100%)">shape-clipped-secret</div><div style="position:absolute;clip:rect(0,0,0,0)">legacy-clipped-secret</div><div style="content-visibility:hidden">content-visibility-secret</div><div style="mask-image:linear-gradient(transparent,transparent)">masked-secret</div><div style="height:0;overflow:hidden;border-bottom:20px solid red">border-clipped-secret</div><div style="height:0;overflow:hidden;border-bottom:20px solid red;transform:scale(2)">scaled-clipped-secret</div><div style="display:contents;overflow:hidden"><span>boxless-public-text</span></div><div style="display:contents;content-visibility:hidden;opacity:0;transform:rotate(45deg)"><span>boxless-effects-public</span></div><div style="visibility:hidden"><span style="visibility:visible">visibility-override-public</span></div><div style="height:30px;width:300px;overflow:hidden;transform:scale(1.2);transform-origin:top left">scaled-public-text</div><p>design-mode-secret</p>'
      for (const [text, style] of [
        ["slot-clipped-secret", "height:0;overflow:hidden"],
        ["slot-hidden-secret", "visibility:hidden"],
      ]) {
        const host = document.createElement("div")
        host.textContent = text ?? ""
        host.attachShadow({ mode: "open" }).innerHTML = `<div style="${style}"><slot></slot></div>`
        scope.append(host)
      }
      document.body.prepend(scope)
    })
    for (const query of [
      "shape-clipped-secret",
      "legacy-clipped-secret",
      "content-visibility-secret",
      "masked-secret",
      "border-clipped-secret",
      "scaled-clipped-secret",
      "slot-clipped-secret",
      "slot-hidden-secret",
    ]) {
      expect(await run("page.findText", { query, selector: "#security-scope" })).toMatchObject({
        matches: [],
      })
      expect(
        await request("page.waitFor", {
          text: query,
          selector: "#security-scope",
          timeoutMs: 50,
        }),
      ).toMatchObject({ ok: false, error: { code: "TIMEOUT" } })
    }
    for (const query of [
      "boxless-public-text",
      "boxless-effects-public",
      "visibility-override-public",
      "scaled-public-text",
    ]) {
      expect(
        (await run<{ matches: unknown[] }>("page.findText", { query, selector: "#security-scope" }))
          .matches,
      ).toHaveLength(1)
      expect(await run("page.waitFor", { text: query, selector: "#security-scope" })).toMatchObject(
        { matched: true },
      )
    }
    await harness.fixturePage.evaluate(() => {
      document.documentElement.style.overflow = "auto"
      document.body.style.cssText = "height:0;overflow:hidden"
    })
    expect(await run("page.findText", { query: "visibility-override-public" })).toMatchObject({
      matches: [],
    })
    expect(
      await request("page.waitFor", { text: "visibility-override-public", timeoutMs: 50 }),
    ).toMatchObject({ ok: false, error: { code: "TIMEOUT" } })
    await harness.fixturePage.evaluate(() => {
      document.documentElement.style.overflow = ""
      document.body.style.cssText = ""
      document.designMode = "on"
    })
    expect(await run("page.findText", { query: "design-mode-secret" })).toMatchObject({
      matches: [],
    })
    expect(
      await request("page.findText", {
        query: "design-mode-secret",
        selector: "#security-scope",
      }),
    ).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } })
    expect(
      await request("page.waitFor", {
        text: "design-mode-secret",
        timeoutMs: 50,
      }),
    ).toMatchObject({ ok: false, error: { code: "TIMEOUT" } })
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("extension: new string inputs use Unicode code points and retain UTF-16 source offsets", async () => {
  const harness = await launchExtensionHarness()
  try {
    const { run, request } = await prepare(harness)
    const query = "😀".repeat(256)
    const selector = `#${"😀".repeat(2047)}`
    await harness.fixturePage.evaluate(
      ({ query, id }) => {
        const element = document.createElement("p")
        element.id = id
        element.textContent = query
        document.body.prepend(element)
      },
      { query, id: selector.slice(1) },
    )
    expect(
      (await run<{ matches: unknown[] }>("page.findText", { query, selector })).matches,
    ).toMatchObject([{ start: 0, end: 512 }])
    expect(await run("page.waitFor", { text: query, selector })).toMatchObject({ matched: true })
    expect(await request("page.findText", { query: `${query}😀` })).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    })
    expect(await request("page.waitFor", { text: `${query}😀` })).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    })
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("extension: checked-state confirmation binds private payload without disclosing it", async () => {
  const harness = await launchExtensionHarness()
  try {
    const { request, discover } = await prepare(harness)
    await harness.fixturePage.locator("#check").evaluate((element) => {
      ;(element as HTMLInputElement).value = "original-private-payload"
    })
    const target = await discover("Confirm checkbox")
    const prompt = await request("page.setChecked", { ...target, checked: true })
    expect(prompt).toMatchObject({ ok: false, error: { code: "CONFIRMATION_REQUIRED" } })
    expect(JSON.stringify(prompt)).not.toContain("original-private-payload")
    await harness.fixturePage.locator("#check").evaluate((element) => {
      ;(element as HTMLInputElement).value = "changed-private-payload"
    })
    const result = await request("page.setChecked", { ...target, checked: true }, true)
    expect(result).toMatchObject({ ok: false, error: { code: "STALE_CONTEXT" } })
    expect(JSON.stringify(result)).not.toContain("changed-private-payload")
    await expect(harness.fixturePage.locator("#check")).not.toBeChecked()
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("extension: waits observe the current document, preserve references and distinguish timeout", async () => {
  const harness = await launchExtensionHarness()
  try {
    const { run, request, discover, tabContext } = await prepare(harness)
    const target = await discover("Confirm checkbox")
    for (const state of ["absent", "hidden"]) {
      expect(
        await request("page.waitFor", { selector: "#missing", state, timeoutMs: 1000 }),
      ).toMatchObject({ ok: true })
    }
    for (const state of ["present", "visible", "enabled", "disabled"]) {
      expect(
        await request("page.waitFor", { selector: "#missing", state, timeoutMs: 50 }),
      ).toMatchObject({ ok: false, error: { code: "TIMEOUT" } })
    }
    await harness.fixturePage.evaluate(() => {
      setTimeout(() => {
        const button = document.createElement("button")
        button.id = "delayed"
        button.textContent = "Ready literal text"
        document.body.prepend(button)
      }, 400)
    })
    const waited = await run<{ matched: boolean; elapsedMs: number }>("page.waitFor", {
      selector: "#delayed",
      state: "enabled",
      timeoutMs: 3000,
    })
    expect(waited.matched).toBe(true)
    expect(waited.elapsedMs).toBeGreaterThanOrEqual(0)
    await run("page.waitFor", { text: "Ready literal text", selector: "#delayed", timeoutMs: 1000 })
    await harness.fixturePage.locator("#delayed").evaluate((element) => {
      ;(element as HTMLButtonElement).disabled = true
    })
    await run("page.waitFor", { selector: "#delayed", state: "disabled", timeoutMs: 1000 })
    await harness.fixturePage.locator("#delayed").evaluate((element) => {
      ;(element as HTMLElement).hidden = true
    })
    await run("page.waitFor", { selector: "#delayed", state: "present", timeoutMs: 1000 })
    await run("page.waitFor", { selector: "#delayed", state: "hidden", timeoutMs: 1000 })
    expect(
      await request("page.waitFor", { selector: "#delayed", state: "disabled", timeoutMs: 50 }),
    ).toMatchObject({ ok: false, error: { code: "TIMEOUT" } })
    expect(await request("page.getElementDetails", target)).toMatchObject({ ok: true })
    expect(
      await request("page.waitFor", { selector: "[", state: "present", timeoutMs: 1000 }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } })
    const cancelled = await harness.controller.evaluate(async (tabContext) => {
      const requestId = crypto.randomUUID()
      const pending = chrome.runtime.sendMessage({
        kind: "request",
        requestId,
        method: "page.waitFor",
        params: { selector: "#never", state: "present", timeoutMs: 3000 },
        tabContext,
      })
      await new Promise((resolve) => setTimeout(resolve, 100))
      await chrome.runtime.sendMessage({
        kind: "request",
        requestId: crypto.randomUUID(),
        method: "requests.cancel",
        params: { requestId },
      })
      return await pending
    }, tabContext)
    expect(cancelled).toMatchObject({ ok: false, error: { code: "REQUEST_CANCELLED" } })
    const pending = request("page.waitFor", {
      selector: "#never",
      state: "present",
      timeoutMs: 3000,
    })
    await harness.fixturePage.evaluate(() => {
      location.hash = "changed-document-context"
    })
    expect(await pending).toMatchObject({ ok: false, error: { code: "STALE_CONTEXT" } })
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("extension: option catalog exposes labels only, pages safely and keeps the reference", async () => {
  const harness = await launchExtensionHarness()
  try {
    const { run, request, discover } = await prepare(harness)
    await harness.fixturePage.locator("#catalog").evaluate((element) => {
      const select = element as HTMLSelectElement
      const long = document.createElement("option")
      long.label = "L".repeat(300)
      long.value = "private-long"
      select.add(long)
      for (let index = 0; index < 55; index++) {
        const option = document.createElement("option")
        option.label = `Catalog ${index}`
        option.value = `private-${index}`
        select.add(option)
      }
      const cssHidden = document.createElement("option")
      cssHidden.style.display = "none"
      cssHidden.label = "secret-css-hidden"
      select.add(cssHidden)
      const ariaHidden = document.createElement("option")
      ariaHidden.setAttribute("aria-hidden", "true")
      ariaHidden.label = "secret-aria-hidden"
      select.add(ariaHidden)
      const group = document.createElement("optgroup")
      group.hidden = true
      const grouped = document.createElement("option")
      grouped.label = "secret-group-hidden"
      group.append(grouped)
      select.append(group)
    })
    const target = await discover("Catalog")
    type Options = {
      options: Array<{ label: string; index: number; disabled: boolean; labelTruncated: boolean }>
      hasMore: boolean
      nextOffset?: number
    }
    const result = await run<Options>("page.getSelectOptions", target)
    expect(result.options).toHaveLength(50)
    expect(result).toMatchObject({ hasMore: true, nextOffset: 51 })
    expect(result.options.slice(0, 4)).toMatchObject([
      { label: "Exact label", index: 0, disabled: false, labelTruncated: false },
      { label: "Duplicate", index: 1 },
      { label: "Duplicate", index: 2 },
      { label: "Disabled option", index: 3, disabled: true },
    ])
    expect(result.options[4]).toMatchObject({ index: 5, labelTruncated: true })
    expect(result.options[4]?.label.length).toBeLessThanOrEqual(256)
    expect(JSON.stringify(result)).not.toContain("Hidden catalog label")
    const last = await run<Options>("page.getSelectOptions", {
      ...target,
      offset: result.nextOffset,
    })
    expect(last.options).toHaveLength(10)
    expect(last.hasMore).toBe(false)
    for (const option of [...result.options, ...last.options]) {
      expect(Object.keys(option).sort()).toEqual(["disabled", "index", "label", "labelTruncated"])
    }
    expect(JSON.stringify([result, last])).not.toContain("private-")
    expect(JSON.stringify([result, last])).not.toContain("secret-")
    expect(JSON.stringify([result, last])).not.toMatch(/selected|"value"/)
    expect(await request("page.getElementDetails", target)).toMatchObject({ ok: true })
    expect(
      await request("page.selectOption", { ...target, label: "Duplicate" }, true),
    ).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } })
    await harness.fixturePage
      .locator("#catalog option")
      .first()
      .evaluate((element) => {
        element.setAttribute("label", "Changed label")
      })
    expect(await request("page.getSelectOptions", target)).toMatchObject({
      ok: false,
      error: { code: "STALE_CONTEXT" },
    })
    await harness.fixturePage.locator("#catalog").evaluate((element) => {
      const select = element as HTMLSelectElement
      while (select.options.length <= 2000) select.add(document.createElement("option"))
    })
    const oversized = await discover("Catalog")
    expect(await request("page.getSelectOptions", oversized)).toMatchObject({
      ok: false,
      error: { code: "NOT_SUPPORTED" },
    })
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("extension: checked mutations require confirmation, emit once, reject radio deselection and invalidate references", async () => {
  const harness = await launchExtensionHarness()
  try {
    const { run, request, discover, stale } = await prepare(harness)
    let target = await discover("Confirm checkbox")
    expect(await run("page.setChecked", { ...target, checked: false })).toMatchObject({
      changed: false,
      activated: false,
      finalStateVerified: true,
      requestedReached: true,
      snapshotInvalidated: false,
    })
    expect(await request("page.getElementDetails", target)).toMatchObject({ ok: true })
    expect(await harness.fixturePage.locator("body").getAttribute("data-events")).toBeNull()
    expect(await request("page.setChecked", { ...target, checked: true })).toMatchObject({
      ok: false,
      error: { code: "CONFIRMATION_REQUIRED" },
    })
    await expect(harness.fixturePage.locator("#check")).not.toBeChecked()
    expect(await run("page.setChecked", { ...target, checked: true }, true)).toMatchObject({
      changed: true,
      checked: true,
      snapshotInvalidated: true,
    })
    await stale(target)
    expect(
      JSON.parse((await harness.fixturePage.locator("body").getAttribute("data-events")) ?? "[]"),
    ).toEqual(["check:click", "check:input", "check:change"])
    target = await discover("Second radio")
    expect(await request("page.setChecked", { ...target, checked: false }, true)).toMatchObject({
      ok: false,
      error: { code: "NOT_SUPPORTED" },
    })
    await run("page.setChecked", { ...target, checked: true }, true)
    await expect(harness.fixturePage.locator("#radio1")).not.toBeChecked()
    await expect(harness.fixturePage.locator("#radio2")).toBeChecked()
    await stale(target)
    const cancelled = await discover("Cancelled checkbox")
    const reverted = await run<Record<string, unknown>>(
      "page.setChecked",
      { ...cancelled, checked: true },
      true,
    )
    expect(reverted).toMatchObject({
      changed: true,
      activated: true,
      checked: false,
      requestedReached: false,
      finalStateVerified: true,
      snapshotInvalidated: true,
    })
    await expect(harness.fixturePage.locator("#cancel")).not.toBeChecked()
    await stale(cancelled)
    const removed = await discover("Removed checkbox")
    const uncertain = await run<Record<string, unknown>>(
      "page.setChecked",
      { ...removed, checked: true },
      true,
    )
    expect(uncertain).toMatchObject({
      changed: true,
      activated: true,
      requestedReached: null,
      finalStateVerified: false,
      snapshotInvalidated: true,
    })
    expect(uncertain).not.toHaveProperty("checked")
    await expect(harness.fixturePage.locator("#remove")).toHaveCount(0)
    await stale(removed)
    const navigation = await discover("Navigation checkbox")
    expect(await request("page.setChecked", { ...navigation, checked: true }, true)).toMatchObject({
      ok: true,
      result: {
        activated: true,
        finalStateVerified: false,
        requestedReached: null,
        snapshotInvalidated: true,
      },
    })
    await expect(harness.fixturePage).toHaveURL(`${harness.fixtureUrl}#activated`)
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

for (const mode of ["strict", "balanced", "convenient"] as const) {
  test(`extension: mocked model requires fresh checked confirmation in ${mode} mode`, async () => {
    const harness = await launchExtensionHarness()
    try {
      await configureMockCodex(harness)
      const settings = await harness.context.newPage()
      await settings.goto(`${harness.controller.url()}?view=settings`)
      await settings.locator("#confirmation-mode").selectOption(mode)
      const closed = settings.waitForEvent("close")
      await settings.locator("#save-settings").click()
      await closed
      await prepare(harness)
      let turn = 0
      let target: Target | undefined
      const findSnapshot = (value: unknown): Discovery | undefined => {
        if (
          typeof value === "string" &&
          value.startsWith("[Untrusted browser element descriptions")
        ) {
          return JSON.parse(value.slice(value.indexOf("\n") + 1)) as Discovery
        }
        let latest: Discovery | undefined
        if (value && typeof value === "object") {
          for (const child of Object.values(value)) {
            latest = findSnapshot(child) ?? latest
          }
        }
        return latest
      }
      const modelRequests: unknown[] = []
      await harness.context.route(CODEX_RESPONSES_URL, async (route) => {
        const input = route.request().postDataJSON()
        modelRequests.push(input)
        const snapshot = findSnapshot(input)
        const element = snapshot?.elements.find((entry) => entry.name === "Confirm checkbox")
        if (snapshot && element) target = { snapshotId: snapshot.snapshotId, ref: element.ref }
        const index = turn++
        let body: string
        if (index === 0 || index === 2 || index === 4 || index === 6) {
          body = toolCallResponse(index, "browser_list_elements", {
            type: "checkbox",
            name: "Confirm checkbox",
          })
        } else if (index === 1 || index === 3 || index === 5 || index === 7) {
          if (!target) throw new Error("Model did not receive discovered checkbox")
          body = toolCallResponse(index, "browser_set_checked", { ...target, checked: index !== 3 })
        } else {
          body = finalTextResponse(index, "Confirmed changes complete")
        }
        await route.fulfill({ status: 200, contentType: "text/event-stream", body })
      })
      await harness.controller
        .locator("#prompt")
        .fill("Check, uncheck, then check the confirmation checkbox. Confirm each change.")
      await harness.controller.locator("#send").click()
      for (const checked of [false, true, false]) {
        await expect(harness.controller.locator("#confirm-dialog")).toBeVisible()
        await expect(harness.fixturePage.locator("#check")).toBeChecked({ checked })
        await harness.controller.locator('#confirm-dialog button[value="confirm"]').click()
        await expect(harness.fixturePage.locator("#check")).toBeChecked({ checked: !checked })
      }
      await expect(
        harness.controller.locator("#transcript .message.assistant").last(),
      ).toContainText("Confirmed changes complete")
      expect(turn).toBe(9)
      await expect(harness.controller.locator("#confirm-dialog")).toBeHidden()
      expect(JSON.stringify(modelRequests)).not.toContain("private-editable-secret")
      expect(
        JSON.parse((await harness.fixturePage.locator("body").getAttribute("data-events")) ?? "[]"),
      ).toEqual([
        "check:click",
        "check:input",
        "check:change",
        "check:click",
        "check:input",
        "check:change",
        "check:click",
        "check:input",
        "check:change",
      ])
      expect(harness.pageErrors).toEqual([])
    } finally {
      await harness.close()
    }
  })
}
