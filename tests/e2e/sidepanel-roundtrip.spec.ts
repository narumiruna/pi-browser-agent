import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
  type Worker,
} from "@playwright/test"

function startFixture(): Promise<{ port: number; server: Server }> {
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8")
    if (request.url?.startsWith("/second")) {
      response.end("<!doctype html><title>Second</title><main>Second page</main>")
      return
    }
    response.end(`<!doctype html>
      <title>Pi Browser Agent fixture</title>
      <main>
        <h1>Visible browser text</h1>
        <input id="title" type="text" aria-label="Title">
        <input id="password" type="password">
        <button id="ordinary" type="button">Click</button>
        <a id="download" href="data:text/plain,hello" download="hello.txt">Download</a>
        <form><button id="submit" type="submit">Submit</button></form>
        <p id="result">idle</p>
      </main>
      <script>
        document.querySelector('#ordinary').onclick = () => document.querySelector('#result').textContent = 'clicked'
        document.querySelector('form').onsubmit = (event) => {
          event.preventDefault()
          document.querySelector('#result').textContent = 'submitted'
        }
      </script>`)
  })
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("Unable to start fixture")
      resolvePromise({ port: address.port, server })
    })
  })
}

let context: BrowserContext
let page: Page
let controller: Page
let worker: Worker
let fixture: { port: number; server: Server }
let extensionId: string
let extensionPath: string
let panelPath: string
let profileDirectory: string
let savedSessionId: string
let controllerErrors: string[]
let testBookmarkIds: string[]
let tabContext: { tabId: number; url: string; epoch: number }

function sseResponse(item: Record<string, unknown>, index: number): string {
  const response = {
    id: `response-${index}`,
    status: "completed",
    output: [item],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  }
  return [
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("")
}

function toolCall(index: number, name: string, args: Record<string, unknown>): string {
  return sseResponse(
    {
      type: "function_call",
      id: `fc_${index}`,
      call_id: `call_${index}`,
      name,
      arguments: JSON.stringify(args),
    },
    index,
  )
}

function finalText(index: number, text: string): string {
  return sseResponse(
    {
      type: "message",
      id: `message_${index}`,
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text, annotations: [] }],
    },
    index,
  )
}

async function request(
  method: string,
  params: Record<string, unknown> = {},
  options: { confirmed?: boolean; tabContext?: typeof tabContext } = {},
): Promise<Record<string, unknown>> {
  const response = await controller.evaluate(
    async ({ method, params, options }) =>
      chrome.runtime.sendMessage({
        kind: "request",
        requestId: crypto.randomUUID(),
        method,
        params,
        ...options,
      }),
    { method, params, options },
  )
  if (!response?.ok)
    throw Object.assign(new Error(response?.error?.message ?? "Request failed"), response?.error)
  return response.result as Record<string, unknown>
}

async function waitForCurrentTab(url: string): Promise<typeof tabContext> {
  let current: typeof tabContext | undefined
  await expect
    .poll(async () => {
      const active = (await request("tabs.getActive")) as unknown as typeof tabContext
      if (active.url === url) current = active
      return active.url
    })
    .toBe(url)
  if (!current) throw new Error(`Current tab did not reach ${url}`)
  return current
}

async function pastePngIntoComposer(): Promise<void> {
  await controller.locator("#prompt").evaluate((target) => {
    const encoded =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nL8AAAAASUVORK5CYII="
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))
    const clipboard = new DataTransfer()
    clipboard.items.add(new File([bytes], "clipboard.png", { type: "image/png" }))
    target.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }),
    )
  })
}

async function gateNextSubmissionPreflight(): Promise<void> {
  await controller.evaluate(() => {
    const originalRequest = chrome.permissions.request.bind(chrome.permissions)
    let markEntered: () => void = () => undefined
    let release: () => void = () => undefined
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    chrome.permissions.request = (async (permissions) => {
      markEntered()
      await gate
      chrome.permissions.request = originalRequest
      return originalRequest(permissions)
    }) as typeof chrome.permissions.request
    ;(
      window as typeof window & {
        submissionGate?: { entered: Promise<void>; release: () => void }
      }
    ).submissionGate = { entered, release }
  })
}

async function waitForSubmissionPreflight(): Promise<void> {
  await controller.evaluate(async () => {
    const gate = (
      window as typeof window & {
        submissionGate?: { entered: Promise<void> }
      }
    ).submissionGate
    if (!gate) throw new Error("Submission preflight gate is not installed")
    await gate.entered
  })
}

async function releaseSubmissionPreflight(): Promise<void> {
  await controller.evaluate(() => {
    const gate = (
      window as typeof window & {
        submissionGate?: { release: () => void }
      }
    ).submissionGate
    if (!gate) throw new Error("Submission preflight gate is not installed")
    gate.release()
  })
}

test.beforeAll(async () => {
  fixture = await startFixture()
  const directory = await mkdtemp(join(tmpdir(), "pi-browser-agent-e2e-"))
  profileDirectory = join(directory, "profile")
  extensionPath = join(directory, "extension")
  await cp(resolve("dist/chrome"), extensionPath, { recursive: true })
  const manifestPath = join(extensionPath, "manifest.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>
  manifest.host_permissions = ["<all_urls>"]
  manifest.permissions = [...((manifest.permissions as string[] | undefined) ?? []), "bookmarks"]
  manifest.optional_permissions = (
    (manifest.optional_permissions as string[] | undefined) ?? []
  ).filter((permission) => permission !== "bookmarks")
  await writeFile(manifestPath, JSON.stringify(manifest))

  context = await chromium.launchPersistentContext(profileDirectory, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  })
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"))
  extensionId = new URL(worker.url()).host
  page = await context.newPage()
  await page.goto(`http://127.0.0.1:${fixture.port}/`)
  controller = await context.newPage()
  controllerErrors = []
  controller.on("pageerror", (error) => controllerErrors.push(error.message))
  const builtManifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    side_panel?: { default_path?: string }
  }
  panelPath = builtManifest.side_panel?.default_path ?? "sidepanel/index.html"
  await controller.goto(`chrome-extension://${extensionId}/${panelPath}`)
  await controller.evaluate(async () => {
    await chrome.storage.local.set({
      piBrowserAgentApprovedHostPermissions: ["http://127.0.0.1/*"],
    })
  })
  testBookmarkIds = await controller.evaluate(async () => {
    const bookmarks = await Promise.all([
      chrome.bookmarks.create({
        title: "Pi Browser Agent pibrowseragentbookmarkneedle",
        url: "https://bookmark.example.test/matching",
      }),
      chrome.bookmarks.create({
        title: "Private unrelated bookmark",
        url: "https://bookmark.example.test/private",
      }),
    ])
    return bookmarks.map((bookmark) => bookmark.id)
  })
  const fixtureTabId = await controller.evaluate(async (fixtureUrl) => {
    const tabs = await chrome.tabs.query({})
    const tab = tabs.find((candidate) => candidate.url?.startsWith(fixtureUrl))
    if (tab?.id === undefined) throw new Error("Fixture tab not found")
    await chrome.tabs.update(tab.id, { active: true })
    return tab.id
  }, `http://127.0.0.1:${fixture.port}/`)
  tabContext = await waitForCurrentTab(`http://127.0.0.1:${fixture.port}/`)
  expect(tabContext.tabId).toBe(fixtureTabId)
})

test.afterAll(async () => {
  if (!controller?.isClosed() && testBookmarkIds?.length > 0) {
    await controller
      .evaluate(
        async (ids) => Promise.all(ids.map((id) => chrome.bookmarks.remove(id))),
        testBookmarkIds,
      )
      .catch(() => undefined)
  }
  await context?.close()
  await new Promise<void>((resolvePromise, reject) =>
    fixture?.server.close((error) => (error ? reject(error) : resolvePromise())),
  )
})

test("discovers isolated node references and fails closed across replacement and tab lifecycle", async () => {
  const discover = async () =>
    (await request("page.listElements", {}, { tabContext })) as unknown as {
      snapshotId: string
      elements: Array<{ ref: string; name: string; type: string }>
    }
  let snapshot = await discover()
  expect(snapshot.elements.some((element) => element.type === "password")).toBe(false)
  expect(await page.evaluate(() => "__piBrowserAgentElements" in globalThis)).toBe(false)
  const title = snapshot.elements.find((element) => element.name === "Title")
  const click = snapshot.elements.find((element) => element.name === "Click")
  if (!title || !click) throw new Error("Missing discovered fixture controls")
  await request(
    "page.type",
    { snapshotId: snapshot.snapshotId, ref: title.ref, text: "By reference" },
    { tabContext },
  )
  await request("page.click", { snapshotId: snapshot.snapshotId, ref: click.ref }, { tabContext })
  await expect(page.locator("#title")).toHaveValue("By reference")
  await expect(page.locator("#result")).toHaveText("clicked")
  await page.evaluate(() => {
    const button = document.querySelector("#ordinary")
    if (button) button.replaceWith(button.cloneNode(true))
  })
  await expect(
    request("page.click", { snapshotId: snapshot.snapshotId, ref: click.ref }, { tabContext }),
  ).rejects.toMatchObject({ code: "STALE_CONTEXT" })
  snapshot = await discover()
  await page.reload()
  tabContext = await waitForCurrentTab(page.url())
  await expect(
    request("page.click", { snapshotId: snapshot.snapshotId, ref: "e1" }, { tabContext }),
  ).rejects.toMatchObject({ code: "STALE_CONTEXT" })
  snapshot = await discover()
  const second = await context.newPage()
  await second.goto(`http://127.0.0.1:${fixture.port}/second`)
  await second.bringToFront()
  await waitForCurrentTab(second.url())
  await second.close()
  await page.bringToFront()
  tabContext = await waitForCurrentTab(page.url())
  await expect(
    request("page.click", { snapshotId: snapshot.snapshotId, ref: "e1" }, { tabContext }),
  ).rejects.toMatchObject({ code: "STALE_CONTEXT" })
})

test("excludes ancestor-clipped controls and rejects references clipped after discovery", async () => {
  await page.evaluate(() => {
    const fixture = document.createElement("div")
    fixture.id = "clipping-fixture"
    fixture.style.cssText =
      "position:fixed;left:50px;top:250px;width:500px;height:150px;z-index:1000"
    fixture.innerHTML = `<div id="clip" style="position:relative;overflow:hidden;width:140px;height:110px">
      <button id="clipped-button" type="button" aria-label="Clipped button" style="position:absolute;left:180px;top:5px;width:100px;height:30px">Clipped</button>
      <input id="clipped-input" aria-label="Clipped input" style="position:absolute;left:180px;top:45px;width:100px;height:25px">
      <button id="partial-button" type="button" aria-label="Partial button" style="position:absolute;left:110px;top:80px;width:90px;height:25px"><span>Partial</span></button>
    </div>`
    fixture.addEventListener("click", (event) => {
      if (event.target instanceof Element)
        fixture.dataset.clicked = event.target.closest("button")?.id ?? ""
    })
    document.body.append(fixture)
  })
  const discover = async () =>
    (await request("page.listElements", {}, { tabContext })) as unknown as {
      snapshotId: string
      elements: Array<{ ref: string; name: string }>
    }
  try {
    // Native layout/hit testing, not mocked geometry: the clipped control is still in the viewport.
    expect(
      await page.locator("#clipped-button").evaluate((button) => {
        const rect = button.getBoundingClientRect()
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        )
        return (
          rect.right < innerWidth &&
          rect.bottom < innerHeight &&
          hit !== button &&
          hit?.contains(button)
        )
      }),
    ).toBe(true)
    let snapshot = await discover()
    expect(snapshot.elements.map((element) => element.name)).not.toContain("Clipped button")
    expect(snapshot.elements.map((element) => element.name)).not.toContain("Clipped input")
    const partial = snapshot.elements.find((element) => element.name === "Partial button")
    if (!partial) throw new Error("Missing partially visible control")
    await request(
      "page.click",
      { snapshotId: snapshot.snapshotId, ref: partial.ref },
      { tabContext },
    )
    await expect(page.locator("#clipping-fixture")).toHaveAttribute(
      "data-clicked",
      "partial-button",
    )
    await page.locator("#clip").evaluate((clip) => {
      clip.style.overflow = "visible"
    })
    snapshot = await discover()
    const button = snapshot.elements.find((element) => element.name === "Clipped button")
    const input = snapshot.elements.find((element) => element.name === "Clipped input")
    if (!button || !input) throw new Error("Missing exposed controls")
    await page.locator("#clip").evaluate((clip) => {
      clip.style.overflow = "hidden"
    })
    await expect(
      request("page.click", { snapshotId: snapshot.snapshotId, ref: button.ref }, { tabContext }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" })
    await expect(
      request(
        "page.type",
        { snapshotId: snapshot.snapshotId, ref: input.ref, text: "Never write" },
        { tabContext },
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" })
    await expect(page.locator("#clipping-fixture")).toHaveAttribute(
      "data-clicked",
      "partial-button",
    )
    await expect(page.locator("#clipped-input")).toHaveValue("")
  } finally {
    await page.locator("#clipping-fixture").evaluate((fixture) => fixture.remove())
  }
})

test("excludes filter-transparent references and rechecks visibility before click and typing", async () => {
  await page.evaluate(() => {
    const fixture = document.createElement("div")
    fixture.id = "filter-fixture"
    fixture.style.cssText =
      "position:fixed;left:50px;top:250px;width:600px;height:180px;z-index:1000;background:white"
    fixture.innerHTML = `<div id="filter-controls">
      <button id="filter-button" type="button" aria-label="Filtered button">Button</button>
      <input id="filter-input" aria-label="Filtered input">
    </div>
    <div style="filter:opacity(0)"><span id="filter-label">Invisible label</span></div>
    <button type="button" aria-labelledby="filter-label" aria-label="Visible filter fallback">Answer</button>`
    fixture.dataset.clicks = "0"
    fixture.dataset.inputs = "0"
    fixture.querySelector("#filter-button")?.addEventListener("click", () => {
      fixture.dataset.clicks = String(Number(fixture.dataset.clicks) + 1)
    })
    fixture.querySelector("#filter-input")?.addEventListener("input", () => {
      fixture.dataset.inputs = String(Number(fixture.dataset.inputs) + 1)
    })
    document.body.append(fixture)
  })
  const discover = async () =>
    (await request("page.listElements", {}, { tabContext })) as unknown as {
      snapshotId: string
      elements: Array<{ ref: string; name: string }>
    }
  try {
    for (const filter of [
      "opacity(0)",
      "opacity(0%)",
      "blur(1px) opacity(0) contrast(2)",
      "opacity(calc(1 - 1))",
    ]) {
      for (const selector of ["#filter-controls", "#filter-button, #filter-input"]) {
        await page.evaluate(
          ({ filter, selector }) => {
            for (const element of document.querySelectorAll<HTMLElement>(
              "#filter-controls, #filter-button, #filter-input",
            ))
              element.style.filter = element.matches(selector) ? filter : "none"
          },
          { filter, selector },
        )
        expect(
          await page.locator("#filter-input").evaluate((input, selector) => {
            const rect = input.getBoundingClientRect()
            const filtered = document.querySelector(selector) as HTMLElement
            return {
              opacity: getComputedStyle(filtered).opacity,
              filter: getComputedStyle(filtered).filter,
              hit:
                document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) ===
                input,
            }
          }, selector),
        ).toMatchObject({ opacity: "1", filter: expect.stringContaining("opacity(0)"), hit: true })
        const names = (await discover()).elements.map((element) => element.name)
        expect(names).not.toContain("Filtered button")
        expect(names).not.toContain("Filtered input")
        expect(names).not.toContain("Invisible label")
        expect(names).toContain("Visible filter fallback")
      }
    }
    await page.evaluate(() => {
      for (const element of document.querySelectorAll<HTMLElement>(
        "#filter-controls, #filter-button, #filter-input",
      ))
        element.style.filter = "opacity(0.5)"
    })
    const snapshot = await discover()
    const target = (name: string) => {
      const element = snapshot.elements.find((element) => element.name === name)
      if (!element) throw new Error(`Missing ${name}`)
      return { snapshotId: snapshot.snapshotId, ref: element.ref }
    }
    await request("page.click", target("Filtered button"), { tabContext })
    await request(
      "page.type",
      { ...target("Filtered input"), text: "Visible write" },
      { tabContext },
    )
    await page.locator("#filter-controls").evaluate((element) => {
      element.style.filter = "opacity(0)"
    })
    await expect(
      request("page.click", target("Filtered button"), { tabContext }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" })
    await expect(
      request("page.type", { ...target("Filtered input"), text: "Never write" }, { tabContext }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" })
    await page.locator("#filter-input").evaluate((input: HTMLInputElement) => {
      input.blur()
      const parent = input.parentElement as HTMLElement
      parent.style.filter = "none"
      input.addEventListener("focus", () => {
        parent.style.filter = "opacity(0)"
      })
    })
    await expect(
      request("page.type", { ...target("Filtered input"), text: "Never write" }, { tabContext }),
    ).rejects.toMatchObject({ code: "STALE_CONTEXT" })
    await expect(page.locator("#filter-fixture")).toHaveAttribute("data-clicks", "1")
    await expect(page.locator("#filter-fixture")).toHaveAttribute("data-inputs", "1")
    await expect(page.locator("#filter-input")).toHaveValue("Visible write")
  } finally {
    await page.locator("#filter-fixture").evaluate((fixture) => fixture.remove())
  }
})

for (const mode of ["modal", "popover", "fullscreen"] as const) {
  test(`keeps ${mode} references visible across outside filter boundaries`, async () => {
    await page.evaluate((mode) => {
      const fixture = document.createElement("div")
      fixture.id = "top-layer-fixture"
      fixture.dataset.clicks = "0"
      const tag = mode === "modal" ? "dialog" : "div"
      fixture.innerHTML = `<button id="top-layer-activate" type="button">Open fullscreen</button>
        <div id="top-layer-outside"><${tag} id="top-layer-surface" ${mode === "popover" ? 'popover="manual"' : ""}
          style="background:white;color:black;padding:20px">
          <button id="top-layer-button" type="button" aria-label="Top-layer button">Go</button>
          <span id="top-layer-label">Top-layer input</span><input id="top-layer-input" aria-labelledby="top-layer-label">
        </${tag}></div>`
      fixture.querySelector("#top-layer-button")?.addEventListener("click", () => {
        fixture.dataset.clicks = String(Number(fixture.dataset.clicks) + 1)
      })
      document.body.append(fixture)
      const surface = document.querySelector("#top-layer-surface") as HTMLElement
      if (mode === "modal") (surface as HTMLDialogElement).showModal()
      else if (mode === "popover") surface.showPopover()
      else
        fixture.querySelector("#top-layer-activate")?.addEventListener("click", () => {
          void surface.requestFullscreen()
        })
    }, mode)
    const discover = async () =>
      (await request("page.listElements", {}, { tabContext })) as unknown as {
        snapshotId: string
        elements: Array<{ ref: string; name: string }>
      }
    try {
      if (mode === "fullscreen") {
        await page.locator("#top-layer-activate").click()
        await expect
          .poll(() => page.evaluate(() => document.fullscreenElement?.id))
          .toBe("top-layer-surface")
        tabContext = await waitForCurrentTab(page.url())
      }
      for (const filter of ["opacity(0)", `url("data:image/svg+xml,${"x".repeat(4096)}")`]) {
        await page.locator("#top-layer-outside").evaluate((outside, filter) => {
          outside.style.filter = filter
        }, filter)
        expect(
          await page.locator("#top-layer-input").evaluate((input) => {
            const rect = input.getBoundingClientRect()
            return (
              input.parentElement?.matches(":modal, :popover-open, :fullscreen") &&
              document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === input
            )
          }),
        ).toBe(true)
        const snapshot = await discover()
        const target = (name: string) => {
          const element = snapshot.elements.find((element) => element.name === name)
          if (!element) throw new Error(`Missing ${name}`)
          return { snapshotId: snapshot.snapshotId, ref: element.ref }
        }
        await request("page.click", target("Top-layer button"), { tabContext })
        await request(
          "page.type",
          { ...target("Top-layer input"), text: "Allowed" },
          { tabContext },
        )
        await page.locator("#top-layer-surface").evaluate((surface, filter) => {
          surface.style.filter = filter
        }, filter)
        await expect(
          request("page.click", target("Top-layer button"), { tabContext }),
        ).rejects.toMatchObject({ code: "INVALID_REQUEST" })
        await expect(
          request(
            "page.type",
            { ...target("Top-layer input"), text: "Never write" },
            { tabContext },
          ),
        ).rejects.toMatchObject({ code: "STALE_CONTEXT" })
        await page.locator("#top-layer-surface").evaluate((surface) => {
          surface.style.filter = "none"
        })
      }
      const snapshot = await discover()
      const input = snapshot.elements.find((element) => element.name === "Top-layer input")
      if (!input) throw new Error("Missing top-layer input")
      await page.locator("#top-layer-input").evaluate((input: HTMLInputElement) => {
        input.blur()
        input.addEventListener("focus", () => {
          ;(input.parentElement as HTMLElement).style.filter = "opacity(0)"
        })
      })
      await expect(
        request(
          "page.type",
          { snapshotId: snapshot.snapshotId, ref: input.ref, text: "Never write" },
          { tabContext },
        ),
      ).rejects.toMatchObject({ code: "STALE_CONTEXT" })
      await expect(page.locator("#top-layer-input")).toHaveValue("Allowed")
      await expect(page.locator("#top-layer-fixture")).toHaveAttribute("data-clicks", "2")
    } finally {
      await page.evaluate(async () => {
        if (document.fullscreenElement) await document.exitFullscreen()
        document.querySelector("#top-layer-fixture")?.remove()
      })
      tabContext = await waitForCurrentTab(page.url())
    }
  })
}

for (const mode of ["inline", "modal"] as const) {
  test(`checks composed filter ancestors of ${mode} slotted references`, async () => {
    await page.evaluate((mode) => {
      const fixture = document.createElement("div")
      fixture.id = "slotted-fixture"
      fixture.dataset.clicks = "0"
      fixture.dataset.inputs = "0"
      fixture.style.cssText = "position:fixed;left:50px;top:250px;z-index:1000;background:white"
      fixture.innerHTML = `<div id="slotted-host">
        <button id="slotted-button" type="button" aria-label="Slotted button">Go</button>
        <input id="slotted-input" aria-label="Slotted input">
        <span id="slotted-name">Slotted label</span>
      </div><button type="button" aria-labelledby="slotted-name" aria-label="Slotted fallback">Answer</button>`
      const host = fixture.querySelector("#slotted-host") as HTMLElement
      const root = host.attachShadow({ mode: "open" })
      root.innerHTML =
        '<div id="slotted-outer"><div id="slotted-inner-host"><slot></slot></div></div>'
      const innerHost = root.querySelector("#slotted-inner-host") as HTMLElement
      const innerRoot = innerHost.attachShadow({ mode: "open" })
      const tag = mode === "modal" ? "dialog" : "div"
      innerRoot.innerHTML = `<${tag} id="slotted-surface"><div id="slotted-wrapper"><slot id="slotted-slot" style="display:block"></slot></div></${tag}><button type="button" aria-label="Shadow-owned">Hidden from discovery</button>`
      fixture.querySelector("#slotted-button")?.addEventListener("click", () => {
        fixture.dataset.clicks = String(Number(fixture.dataset.clicks) + 1)
      })
      fixture.querySelector("#slotted-input")?.addEventListener("input", () => {
        fixture.dataset.inputs = String(Number(fixture.dataset.inputs) + 1)
      })
      document.body.append(fixture)
      if (mode === "modal") {
        host.style.filter = "opacity(0)"
        ;(root.querySelector("#slotted-outer") as HTMLElement).style.filter = "opacity(0)"
        ;(innerRoot.querySelector("dialog") as HTMLDialogElement).showModal()
      }
    }, mode)
    const discover = async () =>
      (await request("page.listElements", {}, { tabContext })) as unknown as {
        snapshotId: string
        elements: Array<{ ref: string; name: string }>
      }
    try {
      for (const filter of ["opacity(0)", `url("data:image/svg+xml,${"x".repeat(4096)}")`]) {
        await page.locator("#slotted-slot").evaluate((slot: HTMLElement, filter) => {
          slot.style.display = "contents"
          slot.style.filter = filter
        }, filter)
        const names = (await discover()).elements.map((element) => element.name)
        expect(names).toContain("Slotted button")
        expect(names).toContain("Slotted input")
      }
      await page.locator("#slotted-slot").evaluate((slot: HTMLElement) => {
        slot.style.display = "block"
        slot.style.filter = "none"
      })
      let allowed = 0
      const selectors = ["#slotted-slot", "#slotted-wrapper", "#slotted-surface"]
      if (mode === "inline") selectors.push("#slotted-outer")
      for (const selector of selectors) {
        for (const filter of ["opacity(0)", `url("data:image/svg+xml,${"x".repeat(4096)}")`]) {
          const snapshot = await discover()
          const names = snapshot.elements.map((element) => element.name)
          expect(names).toContain("Slotted button")
          expect(names).toContain("Slotted input")
          expect(names).not.toContain("Shadow-owned")
          const target = (name: string) => {
            const element = snapshot.elements.find((element) => element.name === name)
            if (!element) throw new Error(`Missing ${name}`)
            return { snapshotId: snapshot.snapshotId, ref: element.ref }
          }
          await request("page.click", target("Slotted button"), { tabContext })
          await request(
            "page.type",
            { ...target("Slotted input"), text: "Allowed" },
            { tabContext },
          )
          allowed++
          await page.locator(selector).evaluate((element: HTMLElement, filter) => {
            element.style.filter = filter
          }, filter)
          expect(
            await page.locator("#slotted-input").evaluate((input) => {
              const rect = input.getBoundingClientRect()
              return (
                input.assignedSlot?.assignedSlot?.id === "slotted-slot" &&
                document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) ===
                  input
              )
            }),
          ).toBe(true)
          await expect(
            request("page.click", target("Slotted button"), { tabContext }),
          ).rejects.toMatchObject({ code: "INVALID_REQUEST" })
          await expect(
            request(
              "page.type",
              { ...target("Slotted input"), text: "Never write" },
              { tabContext },
            ),
          ).rejects.toMatchObject({ code: "INVALID_REQUEST" })
          const blockedNames = (await discover()).elements.map((element) => element.name)
          expect(blockedNames).not.toContain("Slotted button")
          expect(blockedNames).not.toContain("Slotted input")
          expect(blockedNames).not.toContain("Slotted label")
          if (mode === "inline") expect(blockedNames).toContain("Slotted fallback")
          await page.locator(selector).evaluate((element: HTMLElement) => {
            element.style.filter = "none"
          })
        }
      }
      const snapshot = await discover()
      const input = snapshot.elements.find((element) => element.name === "Slotted input")
      if (!input) throw new Error("Missing slotted input")
      await page.locator("#slotted-input").evaluate((input: HTMLInputElement) => {
        input.blur()
        input.addEventListener("focus", () => {
          const wrapper = input.assignedSlot?.assignedSlot?.parentElement
          if (wrapper) wrapper.style.filter = "opacity(0)"
        })
      })
      await expect(
        request(
          "page.type",
          { snapshotId: snapshot.snapshotId, ref: input.ref, text: "Never write" },
          { tabContext },
        ),
      ).rejects.toMatchObject({ code: "STALE_CONTEXT" })
      await expect(page.locator("#slotted-fixture")).toHaveAttribute("data-clicks", String(allowed))
      await expect(page.locator("#slotted-fixture")).toHaveAttribute("data-inputs", String(allowed))
      await expect(page.locator("#slotted-input")).toHaveValue("Allowed")
    } finally {
      await page.locator("#slotted-fixture").evaluate((fixture) => fixture.remove())
    }
  })
}

test("filters directly slotted name text and revalidates references after name changes", async () => {
  await page.evaluate(() => {
    const fixture = document.createElement("div")
    fixture.id = "direct-text-fixture"
    fixture.dataset.clicks = "0"
    fixture.dataset.inputs = "0"
    fixture.style.cssText =
      "position:fixed;left:50px;top:250px;width:600px;z-index:1000;background:white"
    fixture.innerHTML = `<div id="direct-name">Projected name</div>
      <button id="direct-button" type="button" aria-labelledby="direct-name" aria-label="Button fallback">Go</button>
      <input id="direct-input" aria-labelledby="direct-name" placeholder="Input fallback">`
    const root = (fixture.querySelector("#direct-name") as HTMLElement).attachShadow({
      mode: "open",
    })
    root.innerHTML =
      '<div id="direct-outer"><div id="direct-inner-host"><slot></slot></div><slot name="visible"></slot></div>'
    const inner = (root.querySelector("#direct-inner-host") as HTMLElement).attachShadow({
      mode: "open",
    })
    inner.innerHTML =
      '<div id="direct-wrapper"><slot id="direct-slot" style="display:block"></slot></div>'
    fixture.querySelector("#direct-button")?.addEventListener("click", () => {
      fixture.dataset.clicks = String(Number(fixture.dataset.clicks) + 1)
    })
    fixture.querySelector("#direct-input")?.addEventListener("input", () => {
      fixture.dataset.inputs = String(Number(fixture.dataset.inputs) + 1)
    })
    document.body.append(fixture)
  })
  const discover = async () =>
    (await request("page.listElements", {}, { tabContext })) as unknown as {
      snapshotId: string
      elements: Array<{ ref: string; name: string; tag: string }>
    }
  try {
    for (const filter of ["opacity(0)", `url("data:image/svg+xml,${"x".repeat(4096)}")`]) {
      await page.locator("#direct-slot").evaluate((slot: HTMLElement, filter) => {
        slot.style.display = "contents"
        slot.style.filter = filter
      }, filter)
      expect(
        (await discover()).elements.filter((element) => element.name === "Projected name"),
      ).toHaveLength(2)
    }
    await page.locator("#direct-slot").evaluate((slot: HTMLElement) => {
      slot.style.display = "block"
      slot.style.filter = "none"
    })
    let allowed = 0
    for (const selector of ["#direct-slot", "#direct-wrapper", "#direct-outer"]) {
      for (const filter of ["opacity(0)", `url("data:image/svg+xml,${"x".repeat(4096)}")`]) {
        const snapshot = await discover()
        const target = (tag: string) => {
          const element = snapshot.elements.find(
            (element) => element.tag === tag && element.name === "Projected name",
          )
          if (!element) throw new Error(`Missing directly named ${tag}`)
          return { snapshotId: snapshot.snapshotId, ref: element.ref }
        }
        await request("page.click", target("button"), { tabContext })
        await request("page.type", { ...target("input"), text: "Allowed" }, { tabContext })
        allowed++
        await page.locator(selector).evaluate((element: HTMLElement, filter) => {
          element.style.filter = filter
        }, filter)
        expect(
          await page.locator("#direct-name").evaluate((host) => {
            const text = host.firstChild as Text
            const range = document.createRange()
            range.selectNodeContents(text)
            const rect = range.getBoundingClientRect()
            return (
              text.assignedSlot?.assignedSlot?.id === "direct-slot" &&
              document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === host
            )
          }),
        ).toBe(true)
        await expect(request("page.click", target("button"), { tabContext })).rejects.toMatchObject(
          { code: "STALE_CONTEXT" },
        )
        await expect(
          request("page.type", { ...target("input"), text: "Never write" }, { tabContext }),
        ).rejects.toMatchObject({ code: "STALE_CONTEXT" })
        const names = (await discover()).elements.map((element) => element.name)
        expect(names).not.toContain("Projected name")
        expect(names).toContain("Button fallback")
        expect(names).toContain("Input fallback")
        await page.locator(selector).evaluate((element: HTMLElement) => {
          element.style.filter = "none"
        })
      }
    }
    const snapshot = await discover()
    const input = snapshot.elements.find(
      (element) => element.tag === "input" && element.name === "Projected name",
    )
    if (!input) throw new Error("Missing directly named input")
    await page.locator("#direct-input").evaluate((input: HTMLInputElement) => {
      input.blur()
      input.addEventListener("focus", () => {
        const text = document.querySelector("#direct-name")?.firstChild as Text
        const wrapper = text.assignedSlot?.assignedSlot?.parentElement
        if (wrapper) wrapper.style.filter = "opacity(0)"
      })
    })
    await expect(
      request(
        "page.type",
        { snapshotId: snapshot.snapshotId, ref: input.ref, text: "Never write" },
        { tabContext },
      ),
    ).rejects.toMatchObject({ code: "STALE_CONTEXT" })
    await expect(page.locator("#direct-input")).toHaveValue("Allowed")
    await expect(page.locator("#direct-text-fixture")).toHaveAttribute(
      "data-clicks",
      String(allowed),
    )
    await expect(page.locator("#direct-text-fixture")).toHaveAttribute(
      "data-inputs",
      String(allowed),
    )
    await page.locator("#direct-name").evaluate((host) => {
      const sibling = document.createElement("span")
      sibling.slot = "visible"
      sibling.textContent = "Visible sibling"
      host.append(sibling)
    })
    const names = (await discover()).elements.map((element) => element.name)
    expect(names.filter((name) => name === "Visible sibling")).toHaveLength(2)
    expect(names.join(" ")).not.toContain("Projected name")
  } finally {
    await page.locator("#direct-text-fixture").evaluate((fixture) => fixture.remove())
  }
})

test("rejects oversized shared filter declarations on distinct controls", async () => {
  await page.evaluate(() => {
    const fixture = document.createElement("div")
    fixture.id = "oversized-filter-fixture"
    fixture.dataset.filtered = ""
    fixture.dataset.clicks = "0"
    fixture.style.cssText = "position:fixed;left:50px;top:250px;z-index:1000;background:white"
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><filter id="identity"><feColorMatrix type="saturate" values="1"/></filter><!--${"x".repeat(8192)}--></svg>`
    fixture.innerHTML = `<style>
      #oversized-filter-fixture[data-filtered] .target { filter: url("data:image/svg+xml,${encodeURIComponent(svg)}#identity") opacity(1); }
    </style>
    <button class="target" type="button" aria-label="Oversized button">Button</button>
    <input class="target" aria-label="Oversized input">
    <button type="button" aria-label="Unfiltered control">Continue</button>`
    fixture.querySelector("button.target")?.addEventListener("click", () => {
      fixture.dataset.clicks = String(Number(fixture.dataset.clicks) + 1)
    })
    document.body.append(fixture)
  })
  const discover = async () =>
    (await request("page.listElements", {}, { tabContext })) as unknown as {
      snapshotId: string
      elements: Array<{ ref: string; name: string }>
    }
  try {
    expect(
      await page.locator("#oversized-filter-fixture input").evaluate((input) => {
        const rect = input.getBoundingClientRect()
        return (
          getComputedStyle(input).filter.length > 4096 &&
          document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === input
        )
      }),
    ).toBe(true)
    const names = (await discover()).elements.map((element) => element.name)
    expect(names).not.toContain("Oversized button")
    expect(names).not.toContain("Oversized input")
    expect(names).toContain("Unfiltered control")
    await page.locator("#oversized-filter-fixture").evaluate((fixture) => {
      fixture.removeAttribute("data-filtered")
    })
    const snapshot = await discover()
    const target = (name: string) => {
      const element = snapshot.elements.find((element) => element.name === name)
      if (!element) throw new Error(`Missing ${name}`)
      return { snapshotId: snapshot.snapshotId, ref: element.ref }
    }
    await request("page.click", target("Oversized button"), { tabContext })
    await request("page.type", { ...target("Oversized input"), text: "Allowed" }, { tabContext })
    await page.locator("#oversized-filter-fixture").evaluate((fixture) => {
      fixture.dataset.filtered = ""
    })
    await expect(
      request("page.click", target("Oversized button"), { tabContext }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" })
    await expect(
      request("page.type", { ...target("Oversized input"), text: "Never write" }, { tabContext }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" })
    await page.locator("#oversized-filter-fixture input").evaluate((input: HTMLInputElement) => {
      input.blur()
      const fixture = input.parentElement as HTMLElement
      fixture.removeAttribute("data-filtered")
      input.addEventListener("focus", () => {
        fixture.dataset.filtered = ""
      })
    })
    await expect(
      request("page.type", { ...target("Oversized input"), text: "Never write" }, { tabContext }),
    ).rejects.toMatchObject({ code: "STALE_CONTEXT" })
    await expect(page.locator("#oversized-filter-fixture")).toHaveAttribute("data-clicks", "1")
    await expect(page.locator("#oversized-filter-fixture input")).toHaveValue("Allowed")
  } finally {
    await page.locator("#oversized-filter-fixture").evaluate((fixture) => fixture.remove())
  }
})

test("omits ancestor-clipped label text while retaining visible control-name fallbacks", async () => {
  await page.evaluate(() => {
    const fixture = document.createElement("div")
    fixture.id = "clipped-label-fixture"
    fixture.style.cssText =
      "position:fixed;left:50px;top:250px;width:600px;height:180px;z-index:1000"
    fixture.innerHTML = `<div style="position:relative;overflow:hidden;width:120px;height:30px">
      <span id="clipped-name" style="position:absolute;left:180px;top:0;white-space:nowrap">Hidden aria name</span>
      <label for="named-input" style="position:absolute;left:180px;top:25px;white-space:nowrap">Hidden associated name</label>
    </div>
    <button type="button" aria-labelledby="clipped-name" aria-label="Visible aria fallback" style="display:block">Answer</button>
    <input id="named-input" placeholder="Visible placeholder" style="display:block">`
    document.body.append(fixture)
  })
  try {
    expect(
      await page.locator("#clipped-name").evaluate((label) => {
        const rect = label.getBoundingClientRect()
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        )
        return hit !== label && hit?.contains(label)
      }),
    ).toBe(true)
    const snapshot = (await request("page.listElements", {}, { tabContext })) as unknown as {
      elements: Array<{ name: string }>
    }
    const names = snapshot.elements.map((element) => element.name)
    expect(names).toContain("Visible aria fallback")
    expect(names).toContain("Visible placeholder")
    expect(names.join("\n")).not.toContain("Hidden")
  } finally {
    await page.locator("#clipped-label-fixture").evaluate((fixture) => fixture.remove())
  }
})

test("collects only exposed text ranges from visible label containers", async () => {
  await page.evaluate(() => {
    const fixture = document.createElement("div")
    fixture.id = "text-range-fixture"
    fixture.style.cssText =
      "position:fixed;left:50px;top:250px;width:600px;height:350px;z-index:1000;background:white"
    fixture.innerHTML = `<style>
      #text-range-fixture .clipped-text { display:block; width:10px; height:10px; overflow:hidden; text-indent:100px; white-space:nowrap; }
      #text-range-fixture .partial-text { display:block; font:16px/20px monospace; width:7ch; height:20px; overflow:hidden; white-space:nowrap; }
    </style>
    <span id="range-aria" class="clipped-text">Unseen aria name</span>
    <button id="range-button" type="button" aria-labelledby="range-aria" aria-label="Visible range fallback">Answer</button>
    <label for="range-input" class="clipped-text">Unseen associated name</label>
    <input id="range-input" placeholder="Visible range placeholder">
    <button type="button">Visible nested name<span class="clipped-text">Unseen nested name</span></button>
    <span id="range-partial" class="partial-text">VisibleHIDDEN-SUFFIX</span>
    <button type="button" aria-labelledby="range-partial">Partial text</button>
    <span id="range-wrapped" style="display:block;font:16px/20px monospace;width:7ch">Wrapped label</span>
    <button type="button" aria-labelledby="range-wrapped">Wrapped text</button>`
    fixture.dataset.clicks = "0"
    fixture.querySelector("#range-button")?.addEventListener("click", () => {
      fixture.dataset.clicks = String(Number(fixture.dataset.clicks) + 1)
    })
    document.body.append(fixture)
  })
  const discover = async () =>
    (await request("page.listElements", {}, { tabContext })) as unknown as {
      snapshotId: string
      elements: Array<{ ref: string; name: string }>
    }
  try {
    expect(
      await page.locator("#range-aria").evaluate((label) => {
        const box = label.getBoundingClientRect()
        const range = document.createRange()
        range.selectNodeContents(label)
        return (
          document.elementFromPoint(box.left + 5, box.top + 5) === label &&
          range.getBoundingClientRect().left > box.right
        )
      }),
    ).toBe(true)
    let snapshot = await discover()
    const names = snapshot.elements.map((element) => element.name)
    expect(names).toEqual(
      expect.arrayContaining([
        "Visible range fallback",
        "Visible range placeholder",
        "Visible nested name",
        "Visible",
        "Wrapped label",
      ]),
    )
    expect(names.join("\n")).not.toMatch(/Unseen|HIDDEN/)
    await page.locator("#range-aria").evaluate((label) => {
      label.style.cssText = "width:250px;height:25px;text-indent:0"
    })
    snapshot = await discover()
    const button = snapshot.elements.find((element) => element.name === "Unseen aria name")
    if (!button) throw new Error("Missing newly exposed label")
    await page.locator("#range-aria").evaluate((label) => {
      label.removeAttribute("style")
    })
    await expect(
      request("page.click", { snapshotId: snapshot.snapshotId, ref: button.ref }, { tabContext }),
    ).rejects.toMatchObject({ code: "STALE_CONTEXT" })
    await expect(page.locator("#text-range-fixture")).toHaveAttribute("data-clicks", "0")
  } finally {
    await page.locator("#text-range-fixture").evaluate((fixture) => fixture.remove())
  }
})

test("reports successful reference mutations that navigate without replaying them", async () => {
  const originalUrl = page.url()
  await page.evaluate(() => {
    const fixture = document.createElement("div")
    fixture.id = "navigation-fixture"
    fixture.innerHTML =
      '<a href="#clicked" aria-label="Navigate by reference">Go</a><input aria-label="Type then navigate">'
    fixture.dataset.mutations = "0"
    const changed = () => {
      fixture.dataset.mutations = String(Number(fixture.dataset.mutations) + 1)
    }
    fixture.querySelector("a")?.addEventListener("click", changed)
    fixture.querySelector("input")?.addEventListener("input", () => {
      changed()
      location.hash = "typed"
    })
    document.body.prepend(fixture)
  })
  try {
    for (const operation of ["click", "type"]) {
      const snapshot = (await request("page.listElements", {}, { tabContext })) as unknown as {
        snapshotId: string
        elements: Array<{ ref: string; name: string }>
      }
      const target = snapshot.elements.find(
        (element) =>
          element.name === (operation === "click" ? "Navigate by reference" : "Type then navigate"),
      )
      if (!target) throw new Error("Missing navigation target")
      const params = {
        snapshotId: snapshot.snapshotId,
        ref: target.ref,
        ...(operation === "type" ? { text: "Written once" } : {}),
      }
      expect(await request(`page.${operation}`, params, { tabContext })).toMatchObject(
        operation === "click" ? { clicked: true } : { typed: true },
      )
      await expect(page).toHaveURL(`${originalUrl}#${operation === "click" ? "clicked" : "typed"}`)
      tabContext = await waitForCurrentTab(page.url())
      await expect(request(`page.${operation}`, params, { tabContext })).rejects.toMatchObject({
        code: "STALE_CONTEXT",
      })
    }
    await expect(page.locator("#navigation-fixture")).toHaveAttribute("data-mutations", "2")
    await expect(page.locator("#navigation-fixture input")).toHaveValue("Written once")
  } finally {
    await page.goto(originalUrl)
    tabContext = await waitForCurrentTab(page.url())
  }
})

test("rejects changed resolved submit overrides for direct, label and nested references", async () => {
  for (const markup of [
    '<button id="override-control" aria-label="Override target" formaction="relative-submit">Submit</button>',
    '<input id="override-control" aria-label="Override target" type="submit" formaction="relative-submit">',
    '<label role="button" aria-label="Override target" for="override-control">Submit</label><button id="override-control" formaction="relative-submit">Control</button>',
    '<button id="override-control" formaction="relative-submit"><span role="button" aria-label="Override target">Submit</span></button>',
  ]) {
    await page.evaluate((markup) => {
      const base = document.createElement("base")
      base.id = "override-base"
      base.href = new URL("/first/", location.href).href
      document.head.append(base)
      const form = document.createElement("form")
      form.id = "override-fixture"
      form.action = location.href
      form.innerHTML = markup
      form.dataset.submissions = "0"
      form.addEventListener("submit", (event) => {
        event.preventDefault()
        form.dataset.submissions = String(Number(form.dataset.submissions) + 1)
      })
      document.body.prepend(form)
    }, markup)
    try {
      const snapshot = (await request("page.listElements", {}, { tabContext })) as unknown as {
        snapshotId: string
        elements: Array<{ ref: string; name: string }>
      }
      const target = snapshot.elements.find((element) => element.name === "Override target")
      if (!target) throw new Error("Missing submit override target")
      const params = { snapshotId: snapshot.snapshotId, ref: target.ref }
      await expect(request("page.click", params, { tabContext })).rejects.toMatchObject({
        code: "CONFIRMATION_REQUIRED",
      })
      const changed = await page.evaluate(() => {
        const control = document.querySelector("#override-control") as
          | HTMLButtonElement
          | HTMLInputElement
        const action = control.form?.action
        const before = control.formAction
        const base = document.querySelector("#override-base") as HTMLBaseElement
        base.href = new URL("/changed/", location.href).href
        return (
          control.formAction !== before &&
          control.form?.action === action &&
          control.getAttribute("formaction") === "relative-submit"
        )
      })
      expect(changed).toBe(true)
      await expect(
        request("page.click", params, { tabContext, confirmed: true }),
      ).rejects.toMatchObject({ code: "STALE_CONTEXT" })
      await expect(page.locator("#override-fixture")).toHaveAttribute("data-submissions", "0")
    } finally {
      await page.evaluate(() => {
        document.querySelector("#override-fixture")?.remove()
        document.querySelector("#override-base")?.remove()
      })
    }
  }
})

test("rejects submit payload changes during confirmation without exposing submit values", async () => {
  for (const [selector, attribute, value] of [
    ["button", "name", "changed-action"],
    ["button", "value", "delete"],
    ["button", "formenctype", "multipart/form-data"],
    ["button", "formnovalidate", ""],
    ["form", "enctype", "multipart/form-data"],
    ["form", "novalidate", ""],
  ] as const) {
    await page.evaluate(() => {
      const form = document.createElement("form")
      form.id = "payload-fixture"
      form.innerHTML =
        '<label role="button" aria-label="Payload target" for="payload-control">Save</label><button id="payload-control" name="private-submit-name" value="private-submit-value">Save</button>'
      form.dataset.submissions = "0"
      form.addEventListener("submit", (event) => {
        event.preventDefault()
        form.dataset.submissions = String(Number(form.dataset.submissions) + 1)
      })
      document.body.prepend(form)
    })
    try {
      const snapshot = (await request("page.listElements", {}, { tabContext })) as unknown as {
        snapshotId: string
        elements: Array<{ ref: string; name: string }>
      }
      expect(JSON.stringify(snapshot)).not.toContain("private-submit-")
      const target = snapshot.elements.find((element) => element.name === "Payload target")
      if (!target) throw new Error("Missing payload target")
      const params = { snapshotId: snapshot.snapshotId, ref: target.ref }
      await expect(request("page.click", params, { tabContext })).rejects.toMatchObject({
        code: "CONFIRMATION_REQUIRED",
      })
      await page
        .locator(selector === "form" ? "#payload-fixture" : "#payload-control")
        .evaluate((element, { attribute, value }) => element.setAttribute(attribute, value), {
          attribute,
          value,
        })
      await expect(
        request("page.click", params, { tabContext, confirmed: true }),
      ).rejects.toMatchObject({ code: "STALE_CONTEXT" })
      await expect(page.locator("#payload-fixture")).toHaveAttribute("data-submissions", "0")
    } finally {
      await page.locator("#payload-fixture").evaluate((form) => form.remove())
    }
  }
})

test("invalidates references when native fieldset disabled state changes", async () => {
  await page.evaluate(() => {
    const fixture = document.createElement("div")
    fixture.id = "disabled-state-fixture"
    fixture.style.cssText = "position:fixed;left:50px;top:250px;z-index:1000;background:white"
    fixture.innerHTML = `<fieldset disabled>
      <legend><button type="button" aria-label="Legend exception">Legend</button></legend>
      <button id="fieldset-button" type="button" aria-label="Fieldset button">Button</button>
      <input id="fieldset-input" aria-label="Fieldset input">
    </fieldset>`
    fixture.dataset.clicks = "0"
    fixture.querySelector("#fieldset-button")?.addEventListener("click", () => {
      fixture.dataset.clicks = String(Number(fixture.dataset.clicks) + 1)
    })
    document.body.append(fixture)
  })
  const discover = async () =>
    (await request("page.listElements", {}, { tabContext })) as unknown as {
      snapshotId: string
      elements: Array<{ ref: string; name: string; disabled: boolean; actions: string[] }>
    }
  try {
    let snapshot = await discover()
    const target = (name: string) => {
      const element = snapshot.elements.find((element) => element.name === name)
      if (!element) throw new Error(`Missing ${name}`)
      return { snapshotId: snapshot.snapshotId, ref: element.ref }
    }
    for (const name of ["Fieldset button", "Fieldset input"])
      expect(snapshot.elements.find((element) => element.name === name)).toMatchObject({
        disabled: true,
        actions: [],
      })
    expect(snapshot.elements.find((element) => element.name === "Legend exception")).toMatchObject({
      disabled: false,
      actions: ["click"],
    })
    await page
      .locator("#disabled-state-fixture fieldset")
      .evaluate((fieldset: HTMLFieldSetElement) => {
        fieldset.disabled = false
      })
    await expect(page.locator("#fieldset-button")).not.toHaveAttribute("disabled")
    await expect(
      request("page.click", target("Fieldset button"), { tabContext }),
    ).rejects.toMatchObject({ code: "STALE_CONTEXT" })
    await expect(
      request("page.type", { ...target("Fieldset input"), text: "Never write" }, { tabContext }),
    ).rejects.toMatchObject({ code: "STALE_CONTEXT" })
    await expect(page.locator("#disabled-state-fixture")).toHaveAttribute("data-clicks", "0")
    await expect(page.locator("#fieldset-input")).toHaveValue("")
    await request("page.click", target("Legend exception"), { tabContext })
    snapshot = await discover()
    await request("page.click", target("Fieldset button"), { tabContext })
    await request(
      "page.type",
      { ...target("Fieldset input"), text: "After rediscovery" },
      { tabContext },
    )
    await expect(page.locator("#disabled-state-fixture")).toHaveAttribute("data-clicks", "1")
    await expect(page.locator("#fieldset-input")).toHaveValue("After rediscovery")
    await page
      .locator("#disabled-state-fixture fieldset")
      .evaluate((fieldset: HTMLFieldSetElement) => {
        fieldset.disabled = true
      })
    await expect(
      request("page.click", target("Fieldset button"), { tabContext }),
    ).rejects.toMatchObject({ code: "STALE_CONTEXT" })
    await expect(page.locator("#disabled-state-fixture")).toHaveAttribute("data-clicks", "1")
  } finally {
    await page.locator("#disabled-state-fixture").evaluate((fixture) => fixture.remove())
  }
})

test("invalidates references on a real MV3 worker restart", async () => {
  const snapshot = (await request("page.listElements", {}, { tabContext })) as {
    snapshotId: string
  }
  const cdp = await context.browser()?.newBrowserCDPSession()
  if (!cdp) throw new Error("No browser CDP session")
  try {
    const targets = await cdp.send("Target.getTargets")
    const target = targets.targetInfos.find(
      (target) => target.type === "service_worker" && target.url === worker.url(),
    )
    if (!target) throw new Error("No service worker target")
    await worker.evaluate(() => {
      ;(globalThis as typeof globalThis & { restartProbe?: boolean }).restartProbe = true
    })
    await cdp.send("Target.closeTarget", { targetId: target.targetId })
    await request("app.getState")
    expect(
      await worker.evaluate(
        () => (globalThis as typeof globalThis & { restartProbe?: boolean }).restartProbe,
      ),
    ).toBeUndefined()
    tabContext = await waitForCurrentTab(page.url())
    await expect(
      request("page.click", { snapshotId: snapshot.snapshotId, ref: "e1" }, { tabContext }),
    ).rejects.toMatchObject({ code: "STALE_CONTEXT" })
  } finally {
    await cdp.detach().catch(() => undefined)
  }
})

test("loads the Side Panel without uncaught errors", async () => {
  await controller.waitForTimeout(100)
  expect(controllerErrors).toEqual([])
  await expect(controller.locator("#send")).toBeVisible()
  await expect(controller.locator("#abort")).toBeHidden()
  await expect(controller.locator("#steer, #follow-up")).toHaveCount(0)
  await expect(controller.locator("#rename-session")).toBeHidden()
  await controller.locator(".session-disclosure > summary").click()
  await expect(controller.locator("#rename-session")).toBeVisible()
  await controller.locator(".session-disclosure > summary").click()
  await controller.locator("#account-menu-trigger").click()
  await expect(controller.locator("#grant-site")).toBeVisible()
  const addCredential = controller.locator("#login")
  await expect(addCredential).toHaveText("Add credential")
  await addCredential.click()
  const authMethodDialog = controller.locator("#auth-method-dialog")
  await expect(authMethodDialog).toBeVisible()
  await expect(
    authMethodDialog.getByRole("button", { name: "Sign in with an account" }),
  ).toBeVisible()
  await expect(
    authMethodDialog.getByRole("button", { name: "Sign in with an API key" }),
  ).toBeVisible()
  await authMethodDialog.getByRole("button", { name: "Cancel" }).click()
  await expect(authMethodDialog).toBeHidden()
  const transcriptTop = await controller
    .locator("#transcript")
    .evaluate((node) => Math.round(node.getBoundingClientRect().top))
  expect(transcriptTop).toBeLessThan(190)

  const viewport = controller.viewportSize() ?? { width: 1280, height: 720 }
  await controller.setViewportSize({ width: 360, height: 200 })
  expect(await controller.evaluate(() => document.documentElement.scrollHeight)).toBeGreaterThan(
    200,
  )
  await controller.mouse.wheel(0, 1_000)
  await expect.poll(() => controller.evaluate(() => window.scrollY)).toBeGreaterThan(0)
  await controller.setViewportSize(viewport)
  await controller.evaluate(() => window.scrollTo(0, 0))
})

test("grants microphone access from a full extension page", async () => {
  const microphonePage = await context.newPage()
  const pageErrors: string[] = []
  microphonePage.on("pageerror", (error) => pageErrors.push(error.message))
  await microphonePage.addInitScript(() => {
    const state = window as typeof window & { testMicrophonePermission: PermissionState }
    state.testMicrophonePermission = "prompt"
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: { query: async () => ({ state: state.testMicrophonePermission }) },
    })
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          state.testMicrophonePermission = "granted"
          return { getTracks: () => [{ stop: () => undefined }] }
        },
      },
    })
  })
  await microphonePage.goto(`chrome-extension://${extensionId}/${panelPath}?view=microphone`)

  await expect(microphonePage).toHaveTitle("Microphone access · Pi Browser Agent")
  await expect(microphonePage.locator("#microphone-access-page")).toBeVisible()
  await expect(microphonePage.locator("#microphone-access-status")).toContainText(
    "Select Allow microphone access",
  )
  await microphonePage.locator("#allow-microphone").click()
  await expect(microphonePage.locator("#microphone-access-status")).toContainText(
    "Microphone access is allowed",
  )

  await microphonePage.evaluate(() => {
    ;(
      window as typeof window & { testMicrophonePermission: PermissionState }
    ).testMicrophonePermission = "prompt"
    window.dispatchEvent(new Event("focus"))
  })
  await expect(microphonePage.locator("#allow-microphone")).toBeVisible()
  await expect(microphonePage.locator("#allow-microphone")).toBeEnabled()

  const pendingSelectionKey = await controller.evaluate(async () => {
    const windowId = (await chrome.windows.getCurrent()).id
    if (windowId === undefined) throw new Error("Current window has no ID")
    const key = `piBrowserAgentPendingSelection:${windowId}`
    await chrome.storage.session.set({
      [key]: {
        windowId,
        payload: { text: "Pending selection", source: "context-menu", untrusted: true },
        tabContext: { tabId: 1, url: "https://example.com/", epoch: 1 },
      },
    })
    await chrome.runtime.sendMessage({
      kind: "event",
      name: "selection.queued",
      payload: { available: true, windowId },
    })
    return key
  })
  await controller.waitForTimeout(100)
  expect(
    await controller.evaluate(
      async (key) => (await chrome.storage.session.get(key))[key] !== undefined,
      pendingSelectionKey,
    ),
  ).toBe(true)
  await controller.evaluate(async (key) => chrome.storage.session.remove(key), pendingSelectionKey)

  expect(pageErrors).toEqual([])
  await microphonePage.close()
})

test("shows only microphone settings after access is denied", async () => {
  const microphonePage = await context.newPage()
  await microphonePage.addInitScript(() => {
    const state = window as typeof window & { testMicrophonePermission: PermissionState }
    state.testMicrophonePermission = "prompt"
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: { query: async () => ({ state: state.testMicrophonePermission }) },
    })
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          state.testMicrophonePermission = "denied"
          throw new DOMException("Permission denied", "NotAllowedError")
        },
      },
    })
  })
  await microphonePage.goto(`chrome-extension://${extensionId}/${panelPath}?view=microphone`)

  await microphonePage.locator("#allow-microphone").click()
  await expect(microphonePage.locator("#allow-microphone")).toBeHidden()
  await expect(microphonePage.locator("#open-microphone-settings")).toBeVisible()
  await expect(microphonePage.locator("#microphone-access-status")).toContainText(
    "Chrome blocked microphone access",
  )

  await microphonePage.evaluate(() => {
    ;(
      window as typeof window & { testMicrophonePermission: PermissionState }
    ).testMicrophonePermission = "prompt"
    window.dispatchEvent(new Event("focus"))
  })
  await expect(microphonePage.locator("#allow-microphone")).toBeVisible()
  await expect(microphonePage.locator("#open-microphone-settings")).toBeHidden()
  await expect(microphonePage.locator("#microphone-access-status")).toContainText(
    "Select Allow microphone access",
  )
  await microphonePage.close()
})

test("opens Settings in a full browser tab and persists the selected interface font and size", async () => {
  await controller.addInitScript(() => {
    const state = globalThis as typeof globalThis & {
      settingsVoiceAbortCount: number
      SpeechRecognition?: new () => FakeSpeechRecognition
      webkitSpeechRecognition?: new () => FakeSpeechRecognition
    }
    class FakeSpeechRecognition {
      continuous = false
      interimResults = false
      lang = ""
      onresult = null
      onerror = null
      onend: (() => void) | null = null

      start(): void {}

      stop(): void {
        this.onend?.()
      }

      abort(): void {
        state.settingsVoiceAbortCount += 1
        this.onend?.()
      }
    }
    state.settingsVoiceAbortCount = 0
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: { query: async () => ({ state: "granted" }) },
    })
    for (const property of ["SpeechRecognition", "webkitSpeechRecognition"] as const) {
      Object.defineProperty(state, property, {
        configurable: true,
        value: FakeSpeechRecognition,
      })
    }
  })
  await controller.reload()
  await controller.evaluate(() => {
    let release: (state: PermissionState) => void = () => undefined
    const permission = new Promise<{ state: PermissionState }>((resolve) => {
      release = (state) => resolve({ state })
    })
    ;(
      window as typeof window & { microphonePermissionGate?: (state: PermissionState) => void }
    ).microphonePermissionGate = release
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: { query: async () => permission },
    })
  })

  const accountDisclosure = controller.locator(".account-disclosure")
  const voiceButton = controller.locator("#voice-input")
  const sessionOptions = controller.locator("#sessions option")
  await expect(sessionOptions).toHaveCount(1)
  const sessionCount = await sessionOptions.count()
  await expect(voiceButton).toBeEnabled()
  const prompt = controller.locator("#prompt")
  await prompt.fill("Voice draft")
  await voiceButton.click()
  await expect(voiceButton).toBeDisabled()
  await prompt.press("Enter")
  await expect(prompt).toHaveValue("Voice draft")
  await expect(controller.locator("#error")).toHaveText(
    "Wait for the microphone access check to finish",
  )
  await controller.evaluate(() => {
    const state = window as typeof window & {
      microphonePermissionGate?: (state: PermissionState) => void
    }
    state.microphonePermissionGate?.("granted")
    delete state.microphonePermissionGate
  })
  await expect(voiceButton).toHaveAttribute("aria-pressed", "true")
  await controller.locator("#account-menu-trigger").click()
  await expect(controller.locator("#open-settings")).toBeVisible()
  const settingsTabPromise = context.waitForEvent("page")
  await controller.locator("#open-settings").click()
  const settingsTab = await settingsTabPromise
  const settingsPage = settingsTab.locator("#settings-page")
  const settingsError = settingsTab.locator("#settings-error")

  await expect(settingsTab).toHaveTitle("Settings · Pi Browser Agent")
  expect(new URL(settingsTab.url()).searchParams.get("view")).toBe("settings")
  await expect(settingsPage).toBeVisible()
  await expect(accountDisclosure).toHaveJSProperty("open", false)
  await expect(settingsPage.getByRole("heading", { name: "Appearance" })).toBeVisible()
  await expect(settingsPage.getByRole("heading", { name: "Instructions" })).toBeVisible()
  const configureProvider = settingsTab.locator("#configure-provider")
  const initialModelId = await settingsTab.locator("#model").inputValue()
  await expect(configureProvider).toHaveText("Configure authentication")
  await settingsTab.evaluate(() => {
    const originalGet = chrome.storage.local.get
    chrome.storage.local.get = (async () => {
      chrome.storage.local.get = originalGet
      throw new Error("Test auth status failed")
    }) as typeof chrome.storage.local.get
  })
  await settingsTab.locator("#provider").dispatchEvent("change")
  await expect(settingsError).toHaveText("Test auth status failed")
  await expect(configureProvider).toBeEnabled()
  await expect(configureProvider).toHaveText("Configure authentication")
  await settingsTab.locator("#provider").dispatchEvent("change")
  await expect(settingsError).toBeEmpty()

  await configureProvider.click()
  const authMethodDialog = settingsTab.locator("#auth-method-dialog")
  const authProviderDialog = settingsTab.locator("#auth-provider-dialog")
  await authMethodDialog.getByRole("button", { name: "Sign in with an API key" }).click()
  await expect(authProviderDialog).toBeVisible()
  await expect(authProviderDialog.locator("option[value='openai']")).toHaveCount(1)
  await expect(authProviderDialog.locator("option[value='openai-codex']")).toHaveCount(0)
  await authProviderDialog.getByRole("button", { name: "Back" }).click()
  await expect(authMethodDialog).toBeVisible()
  await authMethodDialog.getByRole("button", { name: "Sign in with an API key" }).click()
  await authProviderDialog.getByRole("button", { name: "Cancel" }).click()
  await expect(configureProvider).toBeEnabled()

  const existingCodexCredential = {
    type: "oauth",
    access: "existing-test-access-token",
    refresh: "existing-test-refresh-token",
    expires: Date.now() + 3_600_000,
    accountId: "existing-test-account",
  }
  const previousHostApprovals = await settingsTab.evaluate(async () => {
    const stored = await chrome.storage.local.get("piBrowserAgentApprovedHostPermissions")
    const approvals = stored.piBrowserAgentApprovedHostPermissions
    return Array.isArray(approvals)
      ? approvals.filter((approval): approval is string => typeof approval === "string")
      : []
  })
  await settingsTab.evaluate(async (credential) => {
    const stored = await chrome.storage.local.get("piBrowserAgentApprovedHostPermissions")
    const approvals = Array.isArray(stored.piBrowserAgentApprovedHostPermissions)
      ? stored.piBrowserAgentApprovedHostPermissions.filter(
          (approval): approval is string => typeof approval === "string",
        )
      : []
    await chrome.storage.local.set({
      piBrowserAgentApprovedHostPermissions: [
        ...new Set([...approvals, "https://auth.openai.com/*", "https://chatgpt.com/*"]),
      ],
      piBrowserAgentCredentialsV1: { "openai-codex": credential },
    })
  }, existingCodexCredential)
  await settingsTab.evaluate(() => {
    const originalRequest = chrome.permissions.request
    let markEntered: () => void = () => undefined
    let release: (granted: boolean) => void = () => undefined
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    const gate = new Promise<boolean>((resolve) => {
      release = resolve
    })
    const state = window as typeof window & {
      providerLoginGate?: {
        entered: Promise<void>
        release: (granted: boolean) => void
        requestCount: number
      }
    }
    state.providerLoginGate = { entered, release, requestCount: 0 }
    chrome.permissions.request = (async () => {
      if (!state.providerLoginGate) return false
      state.providerLoginGate.requestCount += 1
      markEntered()
      const granted = await gate
      chrome.permissions.request = originalRequest
      return granted
    }) as typeof chrome.permissions.request
  })
  await configureProvider.click()
  await authMethodDialog.getByRole("button", { name: "Sign in with an account" }).click()
  await expect(authProviderDialog).toBeVisible()
  await expect(authProviderDialog.locator("#auth-provider option")).toHaveCount(1)
  await expect(authProviderDialog.locator("#auth-provider")).toHaveValue("openai-codex")
  expect(
    await settingsTab.evaluate(
      () =>
        (
          window as typeof window & {
            providerLoginGate?: { requestCount: number }
          }
        ).providerLoginGate?.requestCount,
    ),
  ).toBe(0)
  await authProviderDialog.getByRole("button", { name: "Continue" }).click()
  await settingsTab.evaluate(async () => {
    const gate = (
      window as typeof window & {
        providerLoginGate?: { entered: Promise<void> }
      }
    ).providerLoginGate
    if (!gate) throw new Error("Provider login gate is not installed")
    await gate.entered
  })
  await expect(configureProvider).toBeDisabled()
  await settingsTab.evaluate(() => {
    const state = window as typeof window & {
      providerLoginGate?: { release: (granted: boolean) => void }
    }
    state.providerLoginGate?.release(false)
    delete state.providerLoginGate
  })
  await expect(settingsError).toHaveText("OpenAI host access is required for login")
  await expect(configureProvider).toBeEnabled()
  await expect
    .poll(() =>
      settingsTab.evaluate(async () => {
        const stored = await chrome.storage.local.get("piBrowserAgentCredentialsV1")
        return (stored.piBrowserAgentCredentialsV1 as Record<string, unknown>)["openai-codex"]
      }),
    )
    .toEqual(existingCodexCredential)
  await controller.evaluate(async (hostApprovals) => {
    await chrome.storage.local.set({ piBrowserAgentApprovedHostPermissions: hostApprovals })
    await chrome.storage.local.remove("piBrowserAgentCredentialsV1")
  }, previousHostApprovals)

  const modelSearch = settingsTab.locator("#model-search")
  await modelSearch.fill(initialModelId)
  await modelSearch.press("Enter")
  await expect(settingsTab.locator("#model")).toHaveValue(initialModelId)
  await expect(voiceButton).toHaveAttribute("aria-pressed", "false")
  expect(
    await controller.evaluate(
      () => (window as typeof window & { settingsVoiceAbortCount: number }).settingsVoiceAbortCount,
    ),
  ).toBe(1)
  await expect(controller.locator("#transcript")).toBeVisible()
  await expect(controller.locator("#sessions option")).toHaveCount(sessionCount)
  await settingsTab.locator("#font-family").selectOption("serif")
  const fontSizeSlider = settingsTab.locator("#font-size")
  await expect(fontSizeSlider).toHaveAttribute("min", "12")
  await expect(fontSizeSlider).toHaveAttribute("max", "24")
  await fontSizeSlider.focus()
  await fontSizeSlider.press("ArrowRight")
  await fontSizeSlider.press("ArrowRight")
  await fontSizeSlider.press("ArrowRight")
  await expect(fontSizeSlider).toHaveValue("19")
  await expect(settingsTab.locator("#font-size-value")).toHaveText("19 px")
  await expect
    .poll(() => settingsTab.evaluate(() => getComputedStyle(document.documentElement).fontSize))
    .toBe("19px")
  await settingsTab.evaluate(() => {
    const state = window as typeof window & {
      originalSettingsStorageSet?: typeof chrome.storage.local.set
      restoreSettingsStorage?: () => void
    }
    const originalSet = chrome.storage.local.set
    const callOriginalSet = originalSet.bind(chrome.storage.local)
    state.originalSettingsStorageSet = originalSet
    state.restoreSettingsStorage = () => {
      chrome.storage.local.set = originalSet
    }
    chrome.storage.local.set = (async (items) => {
      if (Object.hasOwn(items, "piBrowserAgentSettings"))
        throw new Error("Test settings save failed")
      await callOriginalSet(items)
    }) as typeof chrome.storage.local.set
  })
  let storageMethodRestored = false
  try {
    await settingsTab.locator("#save-settings").click()
    await expect(settingsPage).toBeVisible()
    await expect(settingsError).toHaveText("Test settings save failed")
  } finally {
    storageMethodRestored = await settingsTab.evaluate(() => {
      const state = window as typeof window & {
        originalSettingsStorageSet?: typeof chrome.storage.local.set
        restoreSettingsStorage?: () => void
      }
      state.restoreSettingsStorage?.()
      const restored = chrome.storage.local.set === state.originalSettingsStorageSet
      delete state.originalSettingsStorageSet
      delete state.restoreSettingsStorage
      return restored
    })
  }
  expect(storageMethodRestored).toBe(true)
  const settingsTabClosed = settingsTab.waitForEvent("close")
  await settingsTab.locator("#save-settings").click()
  await settingsTabClosed

  await expect(accountDisclosure).toHaveJSProperty("open", false)
  await expect(controller.locator("#transcript")).toBeVisible()
  await expect(controller.locator("#sessions option")).toHaveCount(sessionCount)
  await expect
    .poll(() => controller.evaluate(() => document.documentElement.dataset.fontFamily))
    .toBe("serif")
  await expect
    .poll(() => controller.evaluate(() => document.documentElement.dataset.fontSize))
    .toBe("19")
  expect(
    await controller.evaluate(() => getComputedStyle(document.documentElement).fontFamily),
  ).toContain("Georgia")
  expect(await controller.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe(
    "19px",
  )

  await controller.reload()
  await controller.locator("#account-menu-trigger").click()
  const reopenedSettingsTabPromise = context.waitForEvent("page")
  await controller.locator("#open-settings").click()
  const reopenedSettingsTab = await reopenedSettingsTabPromise
  await expect(reopenedSettingsTab.locator("#font-family")).toHaveValue("serif")
  const reopenedFontSizeSlider = reopenedSettingsTab.locator("#font-size")
  await expect(reopenedFontSizeSlider).toHaveValue("19")
  await expect
    .poll(() => controller.evaluate(() => document.documentElement.dataset.fontFamily))
    .toBe("serif")
  await expect
    .poll(() => controller.evaluate(() => document.documentElement.dataset.fontSize))
    .toBe("19")

  await reopenedSettingsTab.locator("#font-family").selectOption("system")
  await reopenedFontSizeSlider.focus()
  await reopenedFontSizeSlider.press("Home")
  await reopenedFontSizeSlider.press("ArrowRight")
  await reopenedFontSizeSlider.press("ArrowRight")
  await reopenedFontSizeSlider.press("ArrowRight")
  await reopenedFontSizeSlider.press("ArrowRight")
  await expect(reopenedFontSizeSlider).toHaveValue("16")
  const reopenedSettingsTabClosed = reopenedSettingsTab.waitForEvent("close")
  await reopenedSettingsTab.locator("#save-settings").click()
  await reopenedSettingsTabClosed
  await expect
    .poll(() => controller.evaluate(() => document.documentElement.dataset.fontFamily))
    .toBe("system")
  await expect
    .poll(() => controller.evaluate(() => document.documentElement.dataset.fontSize))
    .toBe("16")
})

test("stores API keys through the method-first account flow without changing models", async () => {
  await controller.evaluate(async () => chrome.storage.local.remove("piBrowserAgentCredentialsV1"))
  await controller.evaluate(() => {
    const state = window as typeof window & {
      authSetupPermissionRequests?: number
      restoreAuthSetupPermissions?: () => void
    }
    const originalRequest = chrome.permissions.request
    const callOriginalRequest = originalRequest.bind(chrome.permissions)
    state.authSetupPermissionRequests = 0
    state.restoreAuthSetupPermissions = () => {
      chrome.permissions.request = originalRequest
    }
    chrome.permissions.request = (async (permissions) => {
      state.authSetupPermissionRequests = (state.authSetupPermissionRequests ?? 0) + 1
      return callOriginalRequest(permissions)
    }) as typeof chrome.permissions.request
  })

  const openAnthropicPrompt = async (): Promise<void> => {
    await controller.locator("#account-menu-trigger").click()
    await controller.locator("#login").click()
    await controller.locator("#api-key-auth-method").click()
    const providerSearch = controller.locator("#auth-provider-search")
    const providerDialog = controller.locator("#auth-provider-dialog")
    const continueButton = providerDialog.getByRole("button", { name: "Continue" })
    await providerSearch.fill("missing-provider")
    await continueButton.click()
    await expect(providerDialog).toBeVisible()
    await expect(controller.locator("#auth-prompt-dialog")).toBeHidden()
    await providerSearch.fill("Anthropic —")
    await expect(providerDialog.locator(".searchable-select-option")).toHaveCount(1)
    await expect(providerDialog.locator(".searchable-select-option")).toContainText("Anthropic")
    await continueButton.click()
    await expect(controller.locator("#auth-provider")).toHaveValue("anthropic")
    await expect(controller.locator("#auth-prompt-dialog")).toBeVisible()
    await expect(controller.locator("#auth-prompt-input")).toHaveAttribute("type", "password")
  }
  const storedAnthropicCredential = () =>
    controller.evaluate(async () => {
      const stored = await chrome.storage.local.get("piBrowserAgentCredentialsV1")
      return (
        stored.piBrowserAgentCredentialsV1 as
          | Record<string, { type: string; key?: string }>
          | undefined
      )?.anthropic
    })

  try {
    await openAnthropicPrompt()
    await controller.locator("#auth-prompt-dialog").getByRole("button", { name: "Cancel" }).click()
    await expect.poll(storedAnthropicCredential).toBeUndefined()

    await openAnthropicPrompt()
    await controller.locator("#auth-prompt-input").fill("first-anthropic-test-key")
    await controller
      .locator("#auth-prompt-dialog")
      .getByRole("button", { name: "Continue" })
      .click()
    await expect.poll(storedAnthropicCredential).toEqual({
      type: "api_key",
      key: "first-anthropic-test-key",
    })
    await expect(controller.locator("#run-status")).toHaveText(
      "Anthropic configured with an API key",
    )

    await openAnthropicPrompt()
    await controller.locator("#auth-prompt-dialog").getByRole("button", { name: "Cancel" }).click()
    await expect.poll(storedAnthropicCredential).toEqual({
      type: "api_key",
      key: "first-anthropic-test-key",
    })

    await openAnthropicPrompt()
    await controller.locator("#auth-prompt-input").fill("replacement-anthropic-test-key")
    await controller
      .locator("#auth-prompt-dialog")
      .getByRole("button", { name: "Continue" })
      .click()
    await expect.poll(storedAnthropicCredential).toEqual({
      type: "api_key",
      key: "replacement-anthropic-test-key",
    })

    expect(
      await controller.evaluate(
        () =>
          (window as typeof window & { authSetupPermissionRequests?: number })
            .authSetupPermissionRequests,
      ),
    ).toBe(0)
    await expect(controller.locator("#auth-status")).toHaveText("OpenAI Codex not configured")
    await expect(controller.locator("body")).not.toContainText("replacement-anthropic-test-key")
  } finally {
    await controller.evaluate(() => {
      const state = window as typeof window & { restoreAuthSetupPermissions?: () => void }
      state.restoreAuthSetupPermissions?.()
      delete state.restoreAuthSetupPermissions
      delete (state as typeof state & { authSetupPermissionRequests?: number })
        .authSetupPermissionRequests
    })
    await controller.evaluate(async () =>
      chrome.storage.local.remove("piBrowserAgentCredentialsV1"),
    )
  }
})

test("synchronizes provider controls when a new session restores the latest model", async () => {
  async function openSettingsTab(): Promise<Page> {
    await controller.locator("#account-menu-trigger").click()
    const settingsTabPromise = context.waitForEvent("page")
    await controller.locator("#open-settings").click()
    return settingsTabPromise
  }

  const sessionSelect = controller.locator("#sessions")
  const initialSessionId = await sessionSelect.inputValue()
  await controller.locator("#new-session").click()
  await expect.poll(() => sessionSelect.inputValue()).not.toBe(initialSessionId)

  const settingsTab = await openSettingsTab()
  const providerSearch = settingsTab.locator("#provider-search")
  await providerSearch.fill("anthropic")
  await expect(settingsTab.locator("#provider-options [role='option']")).toHaveCount(1)
  await providerSearch.press("Enter")
  await expect(settingsTab.locator("#provider")).toHaveValue("anthropic")
  const anthropicModelId = await settingsTab.locator("#model").inputValue()
  expect(anthropicModelId).not.toBe("")
  const modelSearch = settingsTab.locator("#model-search")
  await modelSearch.fill(anthropicModelId)
  await expect(settingsTab.locator("#model-options [role='option']").first()).toBeVisible()
  await modelSearch.press("Enter")
  await expect(settingsTab.locator("#model")).toHaveValue(anthropicModelId)
  const settingsTabClosed = settingsTab.waitForEvent("close")
  await settingsTab.locator("#save-settings").click()
  await settingsTabClosed
  const configuredSettingsTab = await openSettingsTab()
  await expect(configuredSettingsTab.locator("#provider")).toHaveValue("anthropic")
  await expect(configuredSettingsTab.locator("#model")).toHaveValue(anthropicModelId)
  const configuredSettingsTabClosed = configuredSettingsTab.waitForEvent("close")
  await configuredSettingsTab.locator("#cancel-settings").click()
  await configuredSettingsTabClosed

  await sessionSelect.selectOption(initialSessionId)
  await expect(controller.locator("#auth-status")).toHaveText("OpenAI Codex not configured")
  const restoredSessionSettingsTab = await openSettingsTab()
  await expect(restoredSessionSettingsTab.locator("#provider")).toHaveValue("openai-codex")
  await expect(restoredSessionSettingsTab.locator("#model")).toHaveValue("gpt-5.6-terra")
  const restoredSessionId = await sessionSelect.inputValue()
  await controller.locator("#new-session").click()
  await expect.poll(() => sessionSelect.inputValue()).not.toBe(restoredSessionId)

  await restoredSessionSettingsTab.locator("#font-family").selectOption("serif")
  const restoredSessionSettingsTabClosed = restoredSessionSettingsTab.waitForEvent("close")
  await restoredSessionSettingsTab.locator("#save-settings").click()
  await restoredSessionSettingsTabClosed

  await expect(controller.locator("#auth-status")).toHaveText("Anthropic not configured")
  await expect
    .poll(() => controller.evaluate(() => document.documentElement.dataset.fontFamily))
    .toBe("serif")

  const restoreSettingsTab = await openSettingsTab()
  await expect(restoreSettingsTab.locator("#provider")).toHaveValue("anthropic")
  await expect(restoreSettingsTab.locator("#model")).toHaveValue(anthropicModelId)
  const restoreProviderSearch = restoreSettingsTab.locator("#provider-search")
  await restoreProviderSearch.fill("openai-codex")
  await restoreProviderSearch.press("Enter")
  const restoreModelSearch = restoreSettingsTab.locator("#model-search")
  await restoreModelSearch.fill("gpt-5.6-terra")
  await restoreModelSearch.press("Enter")
  await restoreSettingsTab.locator("#font-family").selectOption("system")
  const restoreSettingsTabClosed = restoreSettingsTab.waitForEvent("close")
  await restoreSettingsTab.locator("#save-settings").click()
  await restoreSettingsTabClosed
})

test("keeps header and composer controls usable at normal and narrow widths", async () => {
  const testInfo = test.info()
  const originalViewport = controller.viewportSize() ?? { width: 1280, height: 720 }
  const originalUi = await controller.evaluate(() => {
    const status = document.querySelector<HTMLElement>("#run-status")
    return {
      fontSize: document.documentElement.style.getPropertyValue("--app-font-size"),
      status: status?.textContent ?? "Ready",
      statusTitle: status?.title ?? "",
      state: document.body.dataset.state ?? "idle",
      sendLabel: document.querySelector<HTMLElement>("#send-label")?.textContent ?? "Send",
      queueHidden: document.querySelector<HTMLButtonElement>("#queue-instruction")?.hidden ?? true,
    }
  })

  try {
    await controller.setViewportSize({ width: 480, height: 720 })
    await expect(controller.locator(".brand, .brand-mark")).toHaveCount(0)
    await expect(controller.locator(".app-header")).not.toContainText("Pi Browser Agent")
    await expect(controller.locator(".page-context, #tab-status")).toHaveCount(0)

    const sharesRow = await controller.locator(".header-row").evaluate((header) => {
      const selectors = ["#sessions", "#new-session", ".session-disclosure", ".account-disclosure"]
      const rectangles = selectors.map((selector) => {
        const element = header.querySelector(selector)
        if (!(element instanceof HTMLElement)) throw new Error(`Missing ${selector}`)
        return element.getBoundingClientRect()
      })
      return (
        Math.max(...rectangles.map((rectangle) => rectangle.top)) <
        Math.min(...rectangles.map((rectangle) => rectangle.bottom))
      )
    })
    expect(sharesRow).toBe(true)
    await expect(controller.locator(".app-header #run-status")).toHaveCount(0)
    await expect(controller.locator(".composer-toolbar #run-status")).toBeVisible()
    await expect(controller.locator("#composer-hint")).toBeVisible()
    const transcriptTop = await controller
      .locator("#transcript")
      .evaluate((element) => element.getBoundingClientRect().top)
    expect(transcriptTop).toBeLessThan(70)

    const headerColors = []
    for (const colorScheme of ["light", "dark"] as const) {
      await controller.emulateMedia({ colorScheme })
      headerColors.push(
        await controller
          .locator(".app-header")
          .evaluate((element) => getComputedStyle(element).backgroundColor),
      )
      for (const fontSize of [16, 24]) {
        for (const width of [320, 360, 480, 654]) {
          await controller.setViewportSize({ width, height: 720 })
          for (const running of [false, true]) {
            await controller.evaluate(
              ({ fontSize, running }) => {
                document.documentElement.style.setProperty("--app-font-size", `${fontSize}px`)
                document.body.dataset.state = running ? "running" : "idle"
                const status = document.querySelector<HTMLElement>("#run-status")
                if (status) {
                  const text = running ? "Using browser_read_visible_page_text" : "Ready"
                  status.textContent = text
                  status.title = text
                }
                const abort = document.querySelector<HTMLButtonElement>("#abort")
                if (abort) abort.hidden = !running
                const queue = document.querySelector<HTMLButtonElement>("#queue-instruction")
                if (queue) queue.hidden = !running
                const sendLabel = document.querySelector<HTMLElement>("#send-label")
                if (sendLabel) sendLabel.textContent = running ? "Add instruction" : "Send"
              },
              { fontSize, running },
            )
            const layout = await controller.evaluate(() => {
              const narrowRunning =
                document.body.dataset.state === "running" &&
                document.documentElement.clientWidth <= 360
              const selectors = [
                "#sessions",
                "#new-session",
                ".session-disclosure > summary",
                "#account-menu-trigger",
                "#prompt",
                "#run-status",
                ...(narrowRunning ? [] : ["#voice-input"]),
                "#send",
                ...(document.body.dataset.state === "running"
                  ? ["#abort", "#queue-instruction"]
                  : []),
              ]
              const controls = selectors.map((selector) => {
                const element = document.querySelector(selector)
                if (!(element instanceof HTMLElement)) throw new Error(`Missing ${selector}`)
                const rectangle = element.getBoundingClientRect()
                return {
                  selector,
                  left: rectangle.left,
                  right: rectangle.right,
                  bottom: rectangle.bottom,
                  width: rectangle.width,
                }
              })
              const status = document.querySelector(".status-pill")?.getBoundingClientRect()
              const actions = document.querySelector(".composer-actions")?.getBoundingClientRect()
              if (!status || !actions) throw new Error("Missing composer controls")
              return {
                controls,
                statusRight: status.right,
                actionsLeft: actions.left,
                viewportWidth: document.documentElement.clientWidth,
                viewportHeight: document.documentElement.clientHeight,
                pageWidth: document.documentElement.scrollWidth,
              }
            })
            expect(layout.pageWidth).toBeLessThanOrEqual(layout.viewportWidth)
            expect(layout.statusRight).toBeLessThanOrEqual(layout.actionsLeft)
            for (const control of layout.controls) {
              expect(control.width, control.selector).toBeGreaterThan(0)
              expect(control.left).toBeGreaterThanOrEqual(0)
              expect(control.right).toBeLessThanOrEqual(layout.viewportWidth)
              expect(control.bottom).toBeLessThanOrEqual(layout.viewportHeight)
            }
            if (
              (!running && fontSize === 16 && (width === 320 || width === 654)) ||
              (running && fontSize === 24 && width === 320)
            ) {
              const name = `sidepanel-${colorScheme}-${width}${running ? "-working-large-text" : ""}`
              const path = testInfo.outputPath(`${name}.png`)
              await controller.screenshot({ path })
              await testInfo.attach(name, {
                path,
                contentType: "image/png",
              })
            }
          }
        }
      }
    }
    expect(headerColors[0]).not.toBe(headerColors[1])

    await controller.setViewportSize({ width: 320, height: 720 })
    const accountTrigger = controller.locator("#account-menu-trigger")
    await controller.locator(".session-disclosure > summary").focus()
    await controller.keyboard.press("Tab")
    await expect(accountTrigger).toBeFocused()
    const focusOutline = await accountTrigger.evaluate((element) => {
      const style = getComputedStyle(element)
      return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) }
    })
    expect(focusOutline.style).not.toBe("none")
    expect(focusOutline.width).toBeGreaterThan(0)

    await accountTrigger.click()
    const accountMenu = controller.locator(".account-menu")
    await expect(accountMenu).toBeVisible()
    const menuBounds = await accountMenu.evaluate((element) => {
      const rectangle = element.getBoundingClientRect()
      return { left: rectangle.left, right: rectangle.right }
    })
    expect(menuBounds.left).toBeGreaterThanOrEqual(0)
    expect(menuBounds.right).toBeLessThanOrEqual(320)
    await accountTrigger.click()
    await controller.locator(".session-disclosure > summary").click()
    const sessionMenu = controller.locator(".session-menu")
    await expect(sessionMenu).toBeVisible()
    const sessionBounds = await sessionMenu.boundingBox()
    if (!sessionBounds) throw new Error("Missing session menu bounds")
    expect(sessionBounds.x).toBeGreaterThanOrEqual(0)
    expect(sessionBounds.x + sessionBounds.width).toBeLessThanOrEqual(320)
    await controller.locator(".session-disclosure > summary").click()
  } finally {
    await controller.evaluate((original) => {
      document.documentElement.style.setProperty("--app-font-size", original.fontSize)
      document.body.dataset.state = original.state
      const status = document.querySelector<HTMLElement>("#run-status")
      if (status) {
        status.textContent = original.status
        status.title = original.statusTitle
      }
      const abort = document.querySelector<HTMLButtonElement>("#abort")
      if (abort) abort.hidden = original.state !== "running"
      const queue = document.querySelector<HTMLButtonElement>("#queue-instruction")
      if (queue) queue.hidden = original.queueHidden
      const sendLabel = document.querySelector<HTMLElement>("#send-label")
      if (sendLabel) sendLabel.textContent = original.sendLabel
    }, originalUi)
    await controller.emulateMedia({ colorScheme: null })
    await controller.setViewportSize(originalViewport)
  }
})

test("does not use all-sites Chrome access without exact app approval", async () => {
  await page.bringToFront()
  tabContext = await waitForCurrentTab(`http://127.0.0.1:${fixture.port}/`)
  await controller.evaluate(async () => {
    await chrome.storage.local.remove("piBrowserAgentApprovedHostPermissions")
  })
  try {
    await expect(request("page.getVisibleText", {}, { tabContext })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    })
  } finally {
    await controller.evaluate(async () => {
      await chrome.storage.local.set({
        piBrowserAgentApprovedHostPermissions: ["http://127.0.0.1/*"],
      })
    })
  }
})

test("automatically follows the visible tab and rejects the previous tab context", async () => {
  const first = { ...tabContext }
  const secondPage = await context.newPage()
  await secondPage.goto(`http://127.0.0.1:${fixture.port}/second`)
  await secondPage.bringToFront()
  const second = await waitForCurrentTab(`http://127.0.0.1:${fixture.port}/second`)

  expect(second.tabId).not.toBe(first.tabId)
  await expect(request("page.getVisibleText", {}, { tabContext: first })).rejects.toMatchObject({
    code: "STALE_CONTEXT",
  })
  await expect(request("page.getVisibleText", {}, { tabContext: second })).resolves.toMatchObject({
    text: "Second page",
  })

  await secondPage.close()
  await page.bringToFront()
  tabContext = await waitForCurrentTab(`http://127.0.0.1:${fixture.port}/`)
})

test("runs mocked model tool calls from the Side Panel through the current tab", async () => {
  const fakePayload = btoa(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } }),
  )
  const credential = {
    type: "oauth",
    access: `e30.${fakePayload}.signature`,
    refresh: "test-refresh-token",
    expires: Date.now() + 3_600_000,
    accountId: "test-account",
  }
  await controller.evaluate(async (credential) => {
    await chrome.storage.local.set({
      piBrowserAgentApprovedHostPermissions: ["https://auth.openai.com/*", "https://chatgpt.com/*"],
      piBrowserAgentCredentialsV1: { "openai-codex": credential },
    })
  }, credential)
  await controller.reload()
  await expect(controller.locator("#auth-status")).toHaveText(
    "OpenAI Codex configured with an account",
  )

  await controller.locator("#account-menu-trigger").click()
  const settingsTabPromise = context.waitForEvent("page")
  await controller.locator("#open-settings").click()
  const settingsTab = await settingsTabPromise
  const configureProvider = settingsTab.locator("#configure-provider")
  await expect(configureProvider).toHaveText("Configure authentication")

  await controller.evaluate(() => {
    const originalGet = chrome.storage.local.get
    const callOriginalGet = originalGet.bind(chrome.storage.local)
    let markEntered: () => void = () => undefined
    let release: () => void = () => undefined
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let credentialGetCount = 0
    chrome.storage.local.get = (async (key: string) => {
      const result = await callOriginalGet(key)
      if (key !== "piBrowserAgentCredentialsV1") return result
      credentialGetCount += 1
      if (credentialGetCount !== 1) return result
      markEntered()
      await gate
      chrome.storage.local.get = originalGet
      return result
    }) as typeof chrome.storage.local.get
    ;(
      window as typeof window & {
        authStatusGate?: { entered: Promise<void>; release: () => void; getCount: () => number }
      }
    ).authStatusGate = { entered, release, getCount: () => credentialGetCount }
  })
  await settingsTab.evaluate(async (credential) => {
    await chrome.storage.local.set({
      piBrowserAgentCredentialsV1: {
        "openai-codex": { ...credential, refresh: "updated-test-refresh-token" },
      },
    })
  }, credential)
  await controller.evaluate(async () => {
    const gate = (
      window as typeof window & {
        authStatusGate?: { entered: Promise<void> }
      }
    ).authStatusGate
    if (!gate) throw new Error("Auth status gate is not installed")
    await gate.entered
  })

  await settingsTab.evaluate(async () => chrome.storage.local.remove("piBrowserAgentCredentialsV1"))
  await expect(configureProvider).toHaveText("Configure authentication")
  await expect(controller.locator("#auth-status")).toHaveText("OpenAI Codex not configured")
  await controller.evaluate(() => {
    const state = window as typeof window & {
      authStatusGate?: { release: () => void }
    }
    state.authStatusGate?.release()
  })
  await controller.waitForTimeout(50)
  await expect(controller.locator("#auth-status")).toHaveText("OpenAI Codex not configured")
  expect(
    await controller.evaluate(() =>
      (
        window as typeof window & {
          authStatusGate?: { getCount: () => number }
        }
      ).authStatusGate?.getCount(),
    ),
  ).toBe(2)
  await controller.evaluate(() => {
    delete (window as typeof window & { authStatusGate?: unknown }).authStatusGate
  })

  await controller.evaluate(async (credential) => {
    await chrome.storage.local.set({
      piBrowserAgentCredentialsV1: { "openai-codex": credential },
    })
  }, credential)
  await expect(configureProvider).toHaveText("Configure authentication")
  await expect(controller.locator("#auth-status")).toHaveText(
    "OpenAI Codex configured with an account",
  )

  const settingsTabClosed = settingsTab.waitForEvent("close")
  await settingsTab.locator("#cancel-settings").click()
  await settingsTabClosed

  const codexUrl = "https://chatgpt.com/backend-api/codex/responses"
  let markFirstRequestStarted: () => void = () => undefined
  let releaseFirstResponse: () => void = () => undefined
  const firstRequestStarted = new Promise<void>((resolve) => {
    markFirstRequestStarted = resolve
  })
  const firstResponseGate = new Promise<void>((resolve) => {
    releaseFirstResponse = resolve
  })
  await context.route(codexUrl, async (route) => {
    markFirstRequestStarted()
    await firstResponseGate
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "cache-control": "no-cache" },
      body: finalText(0, "Submission guard test complete."),
    })
  })

  await controller.locator("#prompt").fill("Start the submission guard test")
  await controller.locator("#send").click()
  await firstRequestStarted
  await expect(controller.locator("#send-label")).toHaveText("Add instruction")
  await expect(controller.locator("#queue-instruction")).toBeVisible()
  await gateNextSubmissionPreflight()
  await controller.locator("#prompt").fill("Queue while the current task finishes")
  await controller.locator("#queue-instruction").click()
  await waitForSubmissionPreflight()
  releaseFirstResponse()
  await expect(controller.locator("#transcript")).toContainText("Submission guard test complete.")
  await expect(controller.locator("#run-status")).toHaveText("Ready")
  await controller.evaluate(() => new Promise((resolve) => setTimeout(resolve)))
  await expect(controller.locator("#send")).toBeDisabled()
  await releaseSubmissionPreflight()
  await expect(controller.locator("#send")).toBeEnabled()
  await expect(controller.locator("#error")).toContainText(
    "The current task finished before the instruction could be queued. Send it again.",
  )
  await context.unroute(codexUrl)

  await pastePngIntoComposer()
  await expect(controller.locator("#pasted-images img")).toBeVisible()
  await controller.locator(".remove-pasted-image").click()
  await expect(controller.locator("#pasted-images")).toBeHidden()
  await pastePngIntoComposer()
  await expect(controller.locator("#pasted-images img")).toBeVisible()

  await page.locator("h1").selectText()
  const responses = [
    toolCall(1, "browser_read_page", {}),
    toolCall(2, "browser_get_selection", {}),
    toolCall(3, "browser_capture_visible", {}),
    toolCall(4, "browser_type", { selector: "#title", text: "mocked-agent" }),
    toolCall(5, "browser_click", { selector: "#ordinary" }),
    toolCall(6, "browser_click", { selector: "#download" }),
    toolCall(7, "browser_webmcp", { action: "list" }),
    toolCall(8, "browser_navigate", { url: `http://127.0.0.1:${fixture.port}/second` }),
    finalText(9, "Mock agent completed the browser round trip."),
  ]
  let requestCount = 0
  await context.route(codexUrl, async (route) => {
    expect(route.request().method()).toBe("POST")
    expect(route.request().headers().accept).toContain("text/event-stream")
    const body = route.request().postDataJSON() as { tools?: Array<{ name?: string }> }
    expect(body.tools?.map((tool) => tool.name)).toContain("browser_read_page")
    if (requestCount === 0) {
      expect(JSON.stringify(body).match(/data:image\/png;base64,/g)).toHaveLength(1)
    }
    const response = responses[requestCount]
    requestCount += 1
    if (!response) throw new Error(`Unexpected Codex request ${requestCount}`)
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "cache-control": "no-cache" },
      body: response,
    })
  })

  await gateNextSubmissionPreflight()
  await controller.locator("#prompt").fill("Exercise the browser tools")
  await controller.locator("#send").click()
  await waitForSubmissionPreflight()
  await controller.locator(".remove-pasted-image").click()
  await pastePngIntoComposer()
  await expect(controller.locator("#pasted-images img")).toHaveCount(1)
  await releaseSubmissionPreflight()

  await expect(controller.locator("#pasted-images img")).toHaveCount(1)
  const transcriptImage = controller.locator('#transcript img[alt="Pasted image"]')
  await expect(transcriptImage).toBeVisible()
  const transcriptImageHandle = await transcriptImage.elementHandle()
  await expect(controller.locator("#confirm-dialog")).toBeVisible()
  await controller.locator('#confirm-dialog button[value="confirm"]').click()
  await expect(controller.locator("#confirm-dialog")).toBeHidden()
  await expect(controller.locator("#confirm-dialog")).toBeVisible()
  await controller.locator('#confirm-dialog button[value="confirm"]').click()
  await expect(controller.locator("#transcript")).toContainText(
    "Mock agent completed the browser round trip.",
  )
  await expect(controller.locator('#transcript img[alt="Image result"]')).toBeVisible()
  expect(await transcriptImageHandle?.evaluate((image) => image.isConnected)).toBe(true)
  await expect(
    controller.locator("#transcript details.toolResult").filter({ has: controller.locator("img") }),
  ).toHaveJSProperty("open", true)
  await expect(controller.locator("#transcript")).not.toContainText("browser_read_page")
  expect(requestCount).toBe(responses.length)
  await expect(page).toHaveURL(`http://127.0.0.1:${fixture.port}/second`)
  await expect(page.locator("main")).toHaveText("Second page")
  await context.unroute(codexUrl)
  await controller.reload()
  await expect(controller.locator('#transcript img[alt="Pasted image"]')).toBeVisible()
  await expect(controller.locator('#transcript img[alt="Image result"]')).toBeVisible()

  await page.goto(`http://127.0.0.1:${fixture.port}/`)
  await page.bringToFront()
  tabContext = await waitForCurrentTab(`http://127.0.0.1:${fixture.port}/`)
})

async function prepareFeatureSession(): Promise<void> {
  await controller.evaluate(async () => {
    const access = `e30.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } }))}.signature`
    const stored = await chrome.storage.local.get("piBrowserAgentSettings")
    await chrome.storage.local.set({
      piBrowserAgentCredentialsV1: {
        "openai-codex": {
          type: "oauth",
          access,
          refresh: "test-refresh",
          expires: Date.now() + 3_600_000,
          accountId: "test-account",
        },
      },
      piBrowserAgentSettings: {
        ...(stored.piBrowserAgentSettings as Record<string, unknown> | undefined),
        modelProvider: "openai-codex",
        modelId: "gpt-5.6-terra",
      },
      piBrowserAgentApprovedHostPermissions: [
        "http://127.0.0.1/*",
        "https://auth.openai.com/*",
        "https://chatgpt.com/*",
      ],
    })
  })
  await controller.reload()
  await expect(controller.locator("#auth-status")).toHaveText(
    "OpenAI Codex configured with an account",
  )
  await controller.locator("#new-session").click()
  await page.bringToFront()
  tabContext = await waitForCurrentTab(page.url())
}

test("feeds actual discovered references back through mocked model tools and confirmations", async () => {
  await prepareFeatureSession()
  const url = "https://chatgpt.com/backend-api/codex/responses"
  let turn = 0
  let snapshot: { snapshotId: string; elements: Array<{ name: string; ref: string }> } | undefined
  function findSnapshot(value: unknown): typeof snapshot {
    if (typeof value === "string" && value.startsWith("[Untrusted browser element descriptions"))
      return JSON.parse(value.slice(value.indexOf("\n") + 1))
    if (value && typeof value === "object")
      for (const item of Object.values(value)) {
        const found = findSnapshot(item)
        if (found) return found
      }
    return undefined
  }
  const target = (name: string) => {
    const element = snapshot?.elements.find((element) => element.name === name)
    if (!snapshot || !element) throw new Error(`Missing discovered ${name}`)
    return { snapshotId: snapshot.snapshotId, ref: element.ref }
  }
  await context.route(url, async (route) => {
    const input = route.request().postDataJSON()
    snapshot ??= findSnapshot(input)
    const index = turn++
    const body =
      index === 0
        ? toolCall(100, "browser_list_elements", {})
        : index === 1
          ? toolCall(101, "browser_type", { ...target("Title"), text: "Model reference" })
          : index === 2
            ? toolCall(102, "browser_click", target("Click"))
            : index === 3 || index === 4
              ? toolCall(100 + index, "browser_click", target("Submit"))
              : finalText(105, "# Reference round trip\n\nDone.")
    await route.fulfill({ status: 200, contentType: "text/event-stream", body })
  })
  try {
    await controller
      .locator("#prompt")
      .fill("Discover, fill and click. Test cancelling then approving submit.")
    await controller.locator("#send").click()
    await expect(controller.locator("#confirm-dialog")).toBeVisible()
    await expect(page.locator("#title")).toHaveValue("Model reference")
    await expect(page.locator("#result")).toHaveText("clicked")
    await controller.locator('#confirm-dialog button[value="cancel"]').click()
    await expect(controller.locator("#confirm-dialog")).toBeVisible()
    await expect(page.locator("#result")).toHaveText("clicked")
    await controller.locator('#confirm-dialog button[value="confirm"]').click()
    await expect(controller.locator("#transcript h1")).toHaveText("Reference round trip")
    await expect(page.locator("#result")).toHaveText("submitted")
    expect(turn).toBe(6)
  } finally {
    await context.unroute(url)
  }
})

test("preserves streamed Markdown disclosures, focus, scroll, copying and safe restored content", async () => {
  await prepareFeatureSession()
  const external: string[] = []
  const trackRequest = (request: import("@playwright/test").Request) => {
    if (request.url().includes("render-probe.invalid")) external.push(request.url())
  }
  context.on("request", trackRequest)
  const wideTable = `|${" Header |".repeat(20)}\n|${" --- |".repeat(20)}\n|${" cell |".repeat(20)}`
  const initial = `# Streamed answer\n\n${"Paragraph of safe text.\n\n".repeat(25)}| A | B |\n| - | - |\n| one | two |\n\n${wideTable}\n\n[safe](http://127.0.0.1:${fixture.port}/second)\n\n<script>globalThis.renderPwned = true</script>\n\n![pixel](https://render-probe.invalid/pixel)\n\n[bad](javascript:alert(1))\n\n\`\`\`ts\nconst text = "<tag>"`
  const tail = `\n${"long_identifier_".repeat(100)}\n\`\`\`\n\nFinished.`
  await controller.evaluate(() => {
    type StreamState = {
      send: (event: unknown) => void
      close: () => void
      restore: () => void
      copied: string[]
      settleCopies: () => void
      copyImmediately: () => void
    }
    const original = window.fetch
    const copied: string[] = []
    const pendingCopies: { resolve: () => void; reject: (error: Error) => void }[] = []
    let copyImmediately = false
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) => {
          copied.push(text)
          return copyImmediately
            ? Promise.resolve()
            : new Promise<void>((resolve, reject) => pendingCopies.push({ resolve, reject }))
        },
      },
    })
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes("chatgpt.com/backend-api/codex/responses"))
        return original(input, init)
      return new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            let closed = false
            const close = () => {
              if (closed) return
              closed = true
              stream.close()
            }
            const state: StreamState = {
              send: (event) =>
                stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)),
              close,
              restore: () => {
                window.fetch = original
                close()
              },
              copied,
              settleCopies: () => {
                const [answer, code] = pendingCopies
                if (!answer || !code) throw new Error("Missing pending copy attempts")
                answer.resolve()
                code.reject(new Error("Denied"))
              },
              copyImmediately: () => {
                copyImmediately = true
                copied.length = 0
              },
            }
            ;(window as typeof window & { featureStream?: StreamState }).featureStream = state
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    }) as typeof fetch
  })
  const sendEvents = async (events: unknown[], close = false) =>
    controller.evaluate(
      ({ events, close }) => {
        const stream = (
          window as typeof window & {
            featureStream?: { send: (event: unknown) => void; close: () => void }
          }
        ).featureStream
        if (!stream) throw new Error("No mock stream")
        for (const event of events) stream.send(event)
        if (close) stream.close()
      },
      { events, close },
    )
  try {
    await controller.locator("#prompt").fill("Render the stream safely")
    await controller.locator("#send").click()
    await expect.poll(() => controller.evaluate(() => "featureStream" in window)).toBe(true)
    await expect(controller.locator("#send-label")).toHaveText("Add instruction")
    await expect(controller.locator("#queue-instruction")).toBeVisible()
    await expect(controller.locator("#composer-hint")).not.toContainText("Alt+Enter")
    await sendEvents([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "thinking", type: "reasoning", summary: [] },
      },
      { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "Thinking safely" },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { id: "answer", type: "message", role: "assistant", content: [] },
      },
      { type: "response.output_text.delta", output_index: 1, delta: initial },
    ])
    await expect(controller.locator("#transcript h1")).toHaveText("Streamed answer")
    const copyAnswer = controller.getByRole("button", { name: "Copy answer", exact: true })
    const copyCode = controller.getByRole("button", { name: "Copy code", exact: true })
    for (const [button, label] of [
      [copyAnswer, "Copy answer"],
      [copyCode, "Copy code"],
    ] as const) {
      await expect(button).toHaveText("")
      await expect(button).toHaveAttribute("title", label)
      await expect(button.locator("svg[aria-hidden='true']")).toBeVisible()
    }
    await copyAnswer.focus()
    await copyAnswer.press("Enter")
    await copyCode.focus()
    await copyCode.press("Space")
    await expect(copyAnswer).toHaveText("Copying…")
    await expect(copyCode).toHaveText("Copying…")
    await expect(copyAnswer).toHaveAttribute("title", "Copy answer: Copying…")
    await expect(copyCode).toHaveAttribute("title", "Copy code: Copying…")
    const thinking = controller.locator("#transcript details.thinking")
    await expect(thinking).toHaveJSProperty("open", false)
    const summary = thinking.locator("summary")
    await summary.focus()
    await summary.press("Enter")
    await expect(thinking).toHaveJSProperty("open", true)
    const scrollTop = 10
    await controller.locator("#transcript").evaluate((element, top) => {
      element.scrollTop = top
    }, scrollTop)
    // CSS smooth scrolling must settle before capturing the reader's position.
    await expect
      .poll(() => controller.locator("#transcript").evaluate((element) => element.scrollTop))
      .toBe(scrollTop)
    await sendEvents([{ type: "response.output_text.delta", output_index: 1, delta: tail }])
    await expect(controller.locator("#transcript")).toContainText("Finished.")
    await expect(thinking).toHaveJSProperty("open", true)
    await expect(summary).toBeFocused()
    expect(
      await controller.locator("#transcript").evaluate((element) => element.scrollTop),
    ).toBeCloseTo(scrollTop, 0)
    await expect(copyAnswer).toHaveText("Copying…")
    await expect(copyCode).toHaveText("Copying…")
    const copiedDuringStream = await controller.evaluate(() => {
      const stream = (
        window as typeof window & {
          featureStream?: { settleCopies: () => void; copied: string[] }
        }
      ).featureStream
      if (!stream) throw new Error("No mock stream")
      stream.settleCopies()
      return stream.copied
    })
    expect(copiedDuringStream).toEqual([initial, 'const text = "<tag>"'])
    await expect(copyAnswer).toHaveText("Copied")
    await expect(copyCode).toHaveText("Copy failed")
    await expect(copyAnswer).toHaveAttribute("title", "Copy answer: Copied")
    await expect(copyCode).toHaveAttribute("title", "Copy code: Copy failed")
    const output = [
      {
        id: "thinking",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Thinking safely" }],
      },
      {
        id: "answer",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: initial + tail, annotations: [] }],
      },
    ]
    await sendEvents(
      [
        ...output.map((item, output_index) => ({
          type: "response.output_item.done",
          output_index,
          item,
        })),
        {
          type: "response.completed",
          response: {
            id: "streamed",
            status: "completed",
            output,
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ],
      true,
    )
    await expect(controller.locator("#run-status")).toHaveText("Ready")
    await expect(controller.locator("#send-label")).toHaveText("Send")
    await expect(controller.locator("#queue-instruction")).toBeHidden()
    await expect(summary).toBeFocused()
    await expect(thinking).toHaveJSProperty("open", true)
    await expect(copyAnswer).toHaveText("Copied")
    await expect(copyCode).toHaveText("Copy failed")
    await controller.evaluate(() => {
      const stream = (
        window as typeof window & {
          featureStream?: { copyImmediately: () => void }
        }
      ).featureStream
      if (!stream) throw new Error("No mock stream")
      stream.copyImmediately()
    })
    await controller.getByRole("button", { name: "Copy answer", exact: true }).click()
    expect(
      await controller.evaluate(
        () =>
          (window as typeof window & { featureStream?: { copied: string[] } }).featureStream
            ?.copied,
      ),
    ).toEqual([initial + tail])
    await controller.getByRole("button", { name: "Copy code", exact: true }).click()
    expect(
      await controller.evaluate(() =>
        (
          window as typeof window & { featureStream?: { copied: string[] } }
        ).featureStream?.copied.at(-1),
      ),
    ).toBe(`const text = "<tag>"\n${"long_identifier_".repeat(100)}`)
    await controller.evaluate(() =>
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async () => {
            throw new Error("Denied")
          },
        },
      }),
    )
    await controller.getByRole("button", { name: "Copy answer", exact: true }).click()
    await expect(controller.getByRole("button", { name: "Copy answer", exact: true })).toHaveText(
      "Copy failed",
    )
    for (const width of [320, 360])
      for (const size of [12, 24])
        for (const colorScheme of ["light", "dark"] as const) {
          await controller.setViewportSize({ width, height: 720 })
          await controller.emulateMedia({ colorScheme })
          await controller.evaluate((size) => {
            document.documentElement.style.setProperty("--app-font-size", `${size}px`)
          }, size)
          expect(
            await controller.evaluate(
              () => document.documentElement.scrollWidth <= window.innerWidth,
            ),
          ).toBe(true)
          for (const button of [copyAnswer, copyCode]) {
            const layout = await button.evaluate((element) => {
              const bounds = element.getBoundingClientRect()
              const parent = element.parentElement as HTMLElement
              const icon = element.querySelector("svg") as SVGSVGElement
              const status = element.querySelector("[role='status']") as HTMLElement
              return {
                rightGap: parent.getBoundingClientRect().right - bounds.right,
                width: bounds.width,
                height: bounds.height,
                iconWidth: icon.getBoundingClientRect().width,
                statusClip: getComputedStyle(status).clip,
              }
            })
            expect(layout.rightGap).toBeCloseTo(0, 0)
            expect(layout.width).toBe(40)
            expect(layout.height).toBe(40)
            expect(layout.iconWidth).toBe(16)
            expect(layout.statusClip).toBe("rect(0px, 0px, 0px, 0px)")
          }
          expect(
            await controller
              .locator("#transcript pre")
              .evaluate((element) => element.scrollWidth > element.clientWidth),
          ).toBe(true)
          expect(
            await controller
              .locator("#transcript .table-scroll")
              .last()
              .evaluate((element) => element.scrollWidth > element.clientWidth),
          ).toBe(true)
        }
    expect(external).toEqual([])
    expect(await controller.evaluate(() => "renderPwned" in globalThis)).toBe(false)
    await expect(
      controller.locator(
        "#transcript script, #transcript iframe, #transcript img, #transcript a[href^='javascript:']",
      ),
    ).toHaveCount(0)
    await controller.reload()
    await expect(controller.locator("#transcript h1")).toHaveText("Streamed answer")
    await expect(controller.locator("#transcript details.thinking")).toHaveJSProperty("open", false)
    await expect(
      controller.locator("#transcript script, #transcript img, #transcript a[href^='javascript:']"),
    ).toHaveCount(0)
    expect(external).toEqual([])
    const popupPromise = context.waitForEvent("page")
    await controller.getByRole("link", { name: "safe", exact: true }).click()
    const popup = await popupPromise
    await popup.waitForLoadState()
    expect(await popup.evaluate(() => window.opener)).toBeNull()
    expect(await popup.evaluate(() => document.referrer)).toBe("")
    await popup.close()
    await page.bringToFront()
    tabContext = await waitForCurrentTab(page.url())
  } finally {
    context.off("request", trackRequest)
    await controller
      .evaluate(() =>
        (
          window as typeof window & { featureStream?: { restore: () => void } }
        ).featureStream?.restore(),
      )
      .catch(() => undefined)
    await expect(controller.locator("#run-status")).toHaveText("Ready")
    await controller.setViewportSize({ width: 654, height: 720 })
    await controller.emulateMedia({ colorScheme: "light" })
  }
})

test("confirms and returns bounded bookmark data through a mocked model call", async () => {
  const codexUrl = "https://chatgpt.com/backend-api/codex/responses"
  const responses = [
    toolCall(20, "browser_search_bookmarks", {
      query: "pibrowseragentbookmarkneedle",
      limit: 10,
    }),
    finalText(21, "Bookmark lookup complete."),
  ]
  let requestCount = 0
  await context.route(codexUrl, async (route) => {
    const body = route.request().postDataJSON() as { tools?: Array<{ name?: string }> }
    expect(body.tools?.map((tool) => tool.name)).toContain("browser_search_bookmarks")
    const response = responses[requestCount]
    requestCount += 1
    if (!response) throw new Error(`Unexpected bookmark Codex request ${requestCount}`)
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "cache-control": "no-cache" },
      body: response,
    })
  })

  await controller.locator("#prompt").fill("Find the test bookmark")
  await controller.locator("#send").click()
  await expect(controller.locator("#confirm-dialog")).toBeVisible()
  await expect(controller.locator("#confirm-message")).toContainText(
    "sent to the selected model provider",
  )
  await expect(controller.locator("#confirm-message")).toContainText("pibrowseragentbookmarkneedle")
  await controller.locator('#confirm-dialog button[value="confirm"]').click()

  await expect(controller.locator("#transcript")).toContainText("Bookmark lookup complete.")
  await expect(controller.locator("#transcript")).toContainText("Searched bookmarks")
  await expect(controller.locator("#transcript")).not.toContainText("browser_search_bookmarks")
  await expect(controller.locator("#transcript")).not.toContainText(
    "Pi Browser Agent pibrowseragentbookmarkneedle",
  )
  await expect(controller.locator("#transcript")).not.toContainText("Private unrelated bookmark")
  expect(requestCount).toBe(responses.length)
  const bookmarks = await controller.evaluate(
    async (ids) => chrome.bookmarks.get(ids as [string, ...string[]]),
    testBookmarkIds,
  )
  expect(bookmarks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: testBookmarkIds[0],
        title: "Pi Browser Agent pibrowseragentbookmarkneedle",
        url: "https://bookmark.example.test/matching",
      }),
      expect.objectContaining({
        id: testBookmarkIds[1],
        title: "Private unrelated bookmark",
        url: "https://bookmark.example.test/private",
      }),
    ]),
  )
  await context.unroute(codexUrl)
})

test("shows permission denial inside the open confirmation dialog", async () => {
  const codexUrl = "https://chatgpt.com/backend-api/codex/responses"
  const responses = [
    toolCall(22, "browser_navigate", { url: "https://denied.example.test/" }),
    finalText(23, "Denied navigation handled."),
  ]
  let requestCount = 0
  await context.route(codexUrl, async (route) => {
    const response = responses[requestCount]
    requestCount += 1
    if (!response) throw new Error(`Unexpected permission-denial Codex request ${requestCount}`)
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "cache-control": "no-cache" },
      body: response,
    })
  })

  await controller.locator("#prompt").fill("Try a denied cross-origin navigation")
  await controller.locator("#send").click()
  await expect(controller.locator("#confirm-dialog")).toBeVisible()
  await controller.evaluate(() => {
    const state = window as typeof window & {
      restorePermissionsRequest?: typeof chrome.permissions.request
    }
    state.restorePermissionsRequest = chrome.permissions.request.bind(chrome.permissions)
    chrome.permissions.request = (async () => false) as typeof chrome.permissions.request
  })
  try {
    await controller.locator('#confirm-dialog button[value="confirm"]').click()
    await expect(controller.locator("#confirm-dialog")).toBeVisible()
    await expect(controller.locator("#confirm-dialog #confirm-error")).toHaveText(
      "Site access is required for that destination",
    )
  } finally {
    await controller.evaluate(() => {
      const state = window as typeof window & {
        restorePermissionsRequest?: typeof chrome.permissions.request
      }
      if (state.restorePermissionsRequest) {
        chrome.permissions.request = state.restorePermissionsRequest
        delete state.restorePermissionsRequest
      }
    })
  }
  await controller.locator('#confirm-dialog button[value="cancel"]').click()
  await expect(controller.locator("#transcript")).toContainText("Denied navigation handled.")
  expect(requestCount).toBe(responses.length)
  await context.unroute(codexUrl)
})

test("shows optional screenshot permission denial inside the confirmation dialog", async () => {
  const codexUrl = "https://chatgpt.com/backend-api/codex/responses"
  const responses = [
    toolCall(24, "browser_capture_visible", {}),
    finalText(25, "Denied screenshot handled."),
  ]
  let requestCount = 0
  await context.route(codexUrl, async (route) => {
    const response = responses[requestCount]
    requestCount += 1
    if (!response) throw new Error(`Unexpected screenshot-denial Codex request ${requestCount}`)
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "cache-control": "no-cache" },
      body: response,
    })
  })

  await worker.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      restoreScreenshotContains?: typeof chrome.permissions.contains
    }
    state.restoreScreenshotContains = chrome.permissions.contains.bind(chrome.permissions)
    chrome.permissions.contains = (async (permissions) => {
      if (permissions.origins?.includes("<all_urls>")) return false
      return state.restoreScreenshotContains?.(permissions) ?? false
    }) as typeof chrome.permissions.contains
  })
  try {
    await controller.locator("#prompt").fill("Capture the visible page")
    await controller.locator("#send").click()
    await expect(controller.locator("#confirm-dialog")).toBeVisible()
    await expect(controller.locator("#confirm-message")).toContainText(
      "Chrome grants access to all sites",
    )
    await controller.evaluate(() => {
      const state = window as typeof window & {
        restorePermissionsRequest?: typeof chrome.permissions.request
      }
      state.restorePermissionsRequest = chrome.permissions.request.bind(chrome.permissions)
      chrome.permissions.request = (async () => false) as typeof chrome.permissions.request
    })
    await controller.locator('#confirm-dialog button[value="confirm"]').click()
    await expect(controller.locator("#confirm-dialog")).toBeVisible()
    await expect(controller.locator("#confirm-dialog #confirm-error")).toHaveText(
      "All-sites access is required to capture screenshots after tab changes",
    )
    await controller.locator('#confirm-dialog button[value="cancel"]').click()
    await expect(controller.locator("#transcript")).toContainText("Denied screenshot handled.")
    expect(requestCount).toBe(responses.length)
  } finally {
    await controller.evaluate(() => {
      const state = window as typeof window & {
        restorePermissionsRequest?: typeof chrome.permissions.request
      }
      if (state.restorePermissionsRequest) {
        chrome.permissions.request = state.restorePermissionsRequest
        delete state.restorePermissionsRequest
      }
    })
    await worker.evaluate(() => {
      const state = globalThis as typeof globalThis & {
        restoreScreenshotContains?: typeof chrome.permissions.contains
      }
      if (state.restoreScreenshotContains) {
        chrome.permissions.contains = state.restoreScreenshotContains
        delete state.restoreScreenshotContains
      }
    })
    await context.unroute(codexUrl)
  }
})

test("preserves non-permission screenshot failures", async () => {
  await worker.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      restoreCaptureVisibleTab?: typeof chrome.tabs.captureVisibleTab
    }
    state.restoreCaptureVisibleTab = chrome.tabs.captureVisibleTab
    chrome.tabs.captureVisibleTab = (async () => {
      throw new Error("Capture rate limit reached")
    }) as typeof chrome.tabs.captureVisibleTab
  })
  try {
    await expect(request("page.captureVisible", {}, { tabContext })).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Capture rate limit reached",
    })
  } finally {
    await worker.evaluate(() => {
      const state = globalThis as typeof globalThis & {
        restoreCaptureVisibleTab?: typeof chrome.tabs.captureVisibleTab
      }
      if (state.restoreCaptureVisibleTab) {
        chrome.tabs.captureVisibleTab = state.restoreCaptureVisibleTab
        delete state.restoreCaptureVisibleTab
      }
    })
  }
})

test("round-trips read, selection, screenshot, click, and type through the Side Panel path", async () => {
  const active = await request("tabs.getActive")
  expect(active.title).toBe("Pi Browser Agent fixture")

  const text = await request("page.getVisibleText", {}, { tabContext })
  expect(text.text).toContain("Visible browser text")
  expect(text.text).not.toContain("password")

  await page.locator("h1").selectText()
  await expect(request("page.getSelection", {}, { tabContext })).resolves.toMatchObject({
    text: "Visible browser text",
  })
  await expect(request("page.captureVisible", {}, { tabContext })).resolves.toMatchObject({
    mimeType: "image/png",
  })

  await request("page.type", { selector: "#title", text: "typed" }, { tabContext })
  await expect(page.locator("#title")).toHaveValue("typed")
  await request("page.click", { selector: "#ordinary" }, { tabContext })
  await expect(page.locator("#result")).toHaveText("clicked")
  await expect(
    request("page.type", { selector: "#password", text: "secret" }, { tabContext }),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  })
})

test("enforces confirmation, stale context, navigation, and WebMCP fallback", async () => {
  await expect(
    request("page.click", { selector: "#submit" }, { tabContext }),
  ).rejects.toMatchObject({
    code: "CONFIRMATION_REQUIRED",
  })
  await request("page.click", { selector: "#submit" }, { confirmed: true, tabContext })
  await expect(page.locator("#result")).toHaveText("submitted")

  await expect(request("webmcp.listTools", {}, { tabContext })).rejects.toMatchObject({
    code: "CONFIRMATION_REQUIRED",
  })
  await expect(
    request("webmcp.listTools", {}, { confirmed: true, tabContext }),
  ).rejects.toMatchObject({ code: "NOT_SUPPORTED" })

  const previous = { ...tabContext }
  await request("tabs.navigate", { url: `http://127.0.0.1:${fixture.port}/second` }, { tabContext })
  await page.waitForURL(`http://127.0.0.1:${fixture.port}/second`)
  const state = await request("app.getState")
  tabContext = state.tabContext as unknown as typeof tabContext
  await expect(request("page.getVisibleText", {}, { tabContext: previous })).rejects.toMatchObject({
    code: "STALE_CONTEXT",
  })
  await expect(request("page.getVisibleText", {}, { tabContext })).resolves.toMatchObject({
    text: "Second page",
  })
})

test("restores IndexedDB sessions after the Side Panel closes and reopens", async () => {
  await controller.bringToFront()
  const previousSessionId = await controller.locator("#sessions").inputValue()
  await controller.locator("#new-session").click()
  await expect.poll(() => controller.locator("#sessions").inputValue()).not.toBe(previousSessionId)
  savedSessionId = await controller.locator("#sessions").inputValue()
  expect(savedSessionId).not.toBe("")
  await controller.reload()
  await expect(controller.locator("#sessions")).toHaveValue(savedSessionId)
  await page.bringToFront()
})

test("rediscovers the visible tab after a service-worker restart", async () => {
  const cdp = await context.newCDPSession(page)
  const targets = (await cdp.send("Target.getTargets")) as {
    targetInfos: Array<{ targetId: string; type: string; url: string }>
  }
  const target = targets.targetInfos.find(
    (candidate) => candidate.type === "service_worker" && candidate.url.includes(extensionId),
  )
  if (!target) throw new Error("Service worker target not found")
  await cdp.send("Target.closeTarget", { targetId: target.targetId })
  await expect.poll(async () => (await request("tabs.getActive")).title).toBe("Second")
})

test("restores sessions after a full Chrome restart", async () => {
  await context.close()
  context = await chromium.launchPersistentContext(profileDirectory, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  })
  controller = await context.newPage()
  await controller.goto(`chrome-extension://${extensionId}/${panelPath}`)
  await expect(controller.locator("#sessions")).toHaveValue(savedSessionId)
})
