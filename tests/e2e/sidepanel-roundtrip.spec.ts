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
      <title>Pi Chrome fixture</title>
      <main>
        <h1>Visible browser text</h1>
        <input id="title" type="text">
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
  const directory = await mkdtemp(join(tmpdir(), "pi-chrome-e2e-"))
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
  testBookmarkIds = await controller.evaluate(async () => {
    const bookmarks = await Promise.all([
      chrome.bookmarks.create({
        title: "Pi Chrome pichromebookmarkneedle",
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
  await controller.locator("#account-menu-trigger").click()
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

test("opens a dedicated settings page and persists the selected interface font", async () => {
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
    for (const property of ["SpeechRecognition", "webkitSpeechRecognition"] as const) {
      Object.defineProperty(state, property, {
        configurable: true,
        value: FakeSpeechRecognition,
      })
    }
  })
  await controller.reload()

  const settingsPage = controller.locator("#settings-page")
  const settingsError = controller.locator("#settings-error")
  const accountDisclosure = controller.locator(".account-disclosure")
  const voiceButton = controller.locator("#voice-input")
  await expect(voiceButton).toBeEnabled()
  await voiceButton.click()
  await expect(voiceButton).toHaveAttribute("aria-pressed", "true")
  await controller.locator("#account-menu-trigger").click()
  await expect(controller.locator("#open-settings")).toBeVisible()
  await controller.locator("#open-settings").click()

  await expect(settingsPage).toBeVisible()
  await expect(accountDisclosure).toHaveJSProperty("open", false)
  await expect(settingsPage).not.toContainText("Pi Chrome")
  await expect(settingsPage.getByRole("heading", { name: "Appearance" })).toBeVisible()
  await expect(settingsPage.getByRole("heading", { name: "Instructions" })).toBeVisible()
  await expect(voiceButton).toHaveAttribute("aria-pressed", "false")
  expect(
    await controller.evaluate(
      () => (window as typeof window & { settingsVoiceAbortCount: number }).settingsVoiceAbortCount,
    ),
  ).toBe(1)
  await expect(controller.locator("#transcript")).toBeHidden()
  await controller.locator("#font-family").selectOption("serif")
  await controller.evaluate(() => {
    const state = window as typeof window & { restoreSettingsStorage?: () => void }
    const originalSet = chrome.storage.local.set.bind(chrome.storage.local)
    state.restoreSettingsStorage = () => {
      chrome.storage.local.set = originalSet
    }
    chrome.storage.local.set = (async (items) => {
      if (Object.hasOwn(items, "piChromeSettings")) throw new Error("Test settings save failed")
      await originalSet(items)
    }) as typeof chrome.storage.local.set
  })
  try {
    await controller.locator("#save-settings").click()
    await expect(settingsPage).toBeVisible()
    await expect(settingsError).toHaveText("Test settings save failed")
  } finally {
    await controller.evaluate(() => {
      const state = window as typeof window & { restoreSettingsStorage?: () => void }
      state.restoreSettingsStorage?.()
      delete state.restoreSettingsStorage
    })
  }
  await controller.locator("#save-settings").click()

  await expect(settingsPage).toBeHidden()
  await expect(settingsError).toBeHidden()
  await expect(accountDisclosure).toHaveJSProperty("open", false)
  await expect(controller.locator("#transcript")).toBeVisible()
  await expect(controller.locator("#run-status")).toHaveText("Settings saved")
  await expect
    .poll(() => controller.evaluate(() => document.documentElement.dataset.fontFamily))
    .toBe("serif")
  expect(
    await controller.evaluate(() => getComputedStyle(document.documentElement).fontFamily),
  ).toContain("Georgia")

  await controller.reload()
  await controller.locator("#account-menu-trigger").click()
  await controller.locator("#open-settings").click()
  await expect(controller.locator("#font-family")).toHaveValue("serif")
  await expect
    .poll(() => controller.evaluate(() => document.documentElement.dataset.fontFamily))
    .toBe("serif")

  await controller.locator("#font-family").selectOption("system")
  await controller.locator("#save-settings").click()
  await expect
    .poll(() => controller.evaluate(() => document.documentElement.dataset.fontFamily))
    .toBe("system")
})

test("keeps page context and controls usable at normal and narrow widths", async () => {
  const originalViewport = controller.viewportSize() ?? { width: 1280, height: 720 }
  const tabStatus = controller.locator("#tab-status")
  const originalText = await tabStatus.textContent()
  const originalTitle = await tabStatus.getAttribute("title")

  try {
    await controller.setViewportSize({ width: 480, height: 720 })
    await expect(controller.locator(".brand, .brand-mark")).toHaveCount(0)
    await expect(controller.locator(".app-header")).not.toContainText("Pi Chrome")
    await expect(tabStatus).toBeVisible()
    await expect(tabStatus).toContainText(`http://127.0.0.1:${fixture.port}/`)

    const sharesRow = await controller.locator(".header-row").evaluate((header) => {
      const selectors = [".page-context", ".status-pill", ".account-disclosure"]
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

    const longUrl = `https://example.com/${"long-path-segment/".repeat(20)}?query=current-page`
    await tabStatus.evaluate((element, url) => {
      element.textContent = url
      element.setAttribute("title", url)
    }, longUrl)
    const truncation = await tabStatus.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        textOverflow: style.textOverflow,
        whiteSpace: style.whiteSpace,
      }
    })
    expect(truncation.scrollWidth).toBeGreaterThan(truncation.clientWidth)
    expect(truncation.textOverflow).toBe("ellipsis")
    expect(truncation.whiteSpace).toBe("nowrap")

    const headerColors = []
    for (const colorScheme of ["light", "dark"] as const) {
      await controller.emulateMedia({ colorScheme })
      headerColors.push(
        await controller
          .locator(".app-header")
          .evaluate((element) => getComputedStyle(element).backgroundColor),
      )
      for (const width of [320, 360]) {
        await controller.setViewportSize({ width, height: 720 })
        const narrowLayout = await controller.evaluate(() => {
          const selectors = ["#tab-status", "#run-status", "#account-menu-trigger"]
          const controls = selectors.map((selector) => {
            const element = document.querySelector(selector)
            if (!(element instanceof HTMLElement)) throw new Error(`Missing ${selector}`)
            const rectangle = element.getBoundingClientRect()
            return { left: rectangle.left, right: rectangle.right, width: rectangle.width }
          })
          return {
            controls,
            viewportWidth: document.documentElement.clientWidth,
            pageWidth: document.documentElement.scrollWidth,
          }
        })
        expect(narrowLayout.pageWidth).toBeLessThanOrEqual(narrowLayout.viewportWidth)
        for (const control of narrowLayout.controls) {
          expect(control.width).toBeGreaterThan(0)
          expect(control.left).toBeGreaterThanOrEqual(0)
          expect(control.right).toBeLessThanOrEqual(narrowLayout.viewportWidth)
        }
      }
    }
    expect(headerColors[0]).not.toBe(headerColors[1])

    await controller.setViewportSize({ width: 320, height: 720 })
    const accountTrigger = controller.locator("#account-menu-trigger")
    await controller.locator(".page-context").click()
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
  } finally {
    await tabStatus.evaluate(
      (element, value) => {
        element.textContent = value.text
        element.setAttribute("title", value.title)
      },
      { text: originalText ?? "", title: originalTitle ?? "" },
    )
    await controller.emulateMedia({ colorScheme: null })
    await controller.setViewportSize(originalViewport)
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
  await controller.evaluate(
    async ({ access, expires }) => {
      await chrome.storage.local.set({
        piChromeCredentialsV1: {
          "openai-codex": {
            type: "oauth",
            access,
            refresh: "test-refresh-token",
            expires,
            accountId: "test-account",
          },
        },
      })
    },
    { access: `e30.${fakePayload}.signature`, expires: Date.now() + 3_600_000 },
  )
  await controller.reload()
  await expect(controller.locator("#auth-status")).toContainText("OpenAI Codex configured")

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
  await gateNextSubmissionPreflight()
  await controller.locator("#prompt").fill("Queue while the current task finishes")
  await controller.locator("#send").click()
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
  await expect(controller.locator("#transcript details.message").first()).toHaveJSProperty(
    "open",
    false,
  )
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

test("confirms and returns bounded bookmark data through a mocked model call", async () => {
  const codexUrl = "https://chatgpt.com/backend-api/codex/responses"
  const responses = [
    toolCall(20, "browser_search_bookmarks", {
      query: "pichromebookmarkneedle",
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
  await expect(controller.locator("#confirm-message")).toContainText("pichromebookmarkneedle")
  await controller.locator('#confirm-dialog button[value="confirm"]').click()

  await expect(controller.locator("#transcript")).toContainText("Bookmark lookup complete.")
  await expect(controller.locator("#transcript")).toContainText("Untrusted browser bookmark data")
  await expect(controller.locator("#transcript")).toContainText("Pi Chrome pichromebookmarkneedle")
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
        title: "Pi Chrome pichromebookmarkneedle",
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

test("round-trips read, selection, screenshot, click, and type through the Side Panel path", async () => {
  const active = await request("tabs.getActive")
  expect(active.title).toBe("Pi Chrome fixture")

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
