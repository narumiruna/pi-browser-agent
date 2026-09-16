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

test.beforeAll(async () => {
  fixture = await startFixture()
  const directory = await mkdtemp(join(tmpdir(), "pi-chrome-e2e-"))
  profileDirectory = join(directory, "profile")
  extensionPath = join(directory, "extension")
  await cp(resolve("dist/chrome"), extensionPath, { recursive: true })
  const manifestPath = join(extensionPath, "manifest.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>
  manifest.host_permissions = ["<all_urls>"]
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
  const builtManifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    side_panel?: { default_path?: string }
  }
  panelPath = builtManifest.side_panel?.default_path ?? "sidepanel/index.html"
  await controller.goto(`chrome-extension://${extensionId}/${panelPath}`)
  const fixtureTabId = await controller.evaluate(async (fixtureUrl) => {
    const tabs = await chrome.tabs.query({})
    const tab = tabs.find((candidate) => candidate.url?.startsWith(fixtureUrl))
    if (tab?.id === undefined) throw new Error("Fixture tab not found")
    await chrome.tabs.update(tab.id, { active: true })
    return tab.id
  }, `http://127.0.0.1:${fixture.port}/`)
  tabContext = (await request("tabs.bindActive")) as unknown as typeof tabContext
  expect(tabContext.tabId).toBe(fixtureTabId)
})

test.afterAll(async () => {
  await context?.close()
  await new Promise<void>((resolvePromise, reject) =>
    fixture?.server.close((error) => (error ? reject(error) : resolvePromise())),
  )
})

test("runs mocked model tool calls from the Side Panel through the bound tab", async () => {
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
  await expect(controller.locator("#auth-status")).toContainText("Logged in")

  await page.locator("h1").selectText()
  const responses = [
    toolCall(1, "browser_read_page", {}),
    toolCall(2, "browser_get_selection", {}),
    toolCall(3, "browser_capture_visible", {}),
    toolCall(4, "browser_type", { selector: "#title", text: "mocked-agent" }),
    toolCall(5, "browser_click", { selector: "#ordinary" }),
    toolCall(6, "browser_webmcp", { action: "list" }),
    toolCall(7, "browser_navigate", { url: `http://127.0.0.1:${fixture.port}/second` }),
    finalText(8, "Mock agent completed the browser round trip."),
  ]
  let requestCount = 0
  const codexUrl = "https://chatgpt.com/backend-api/codex/responses"
  await context.route(codexUrl, async (route) => {
    expect(route.request().method()).toBe("POST")
    expect(route.request().headers().accept).toContain("text/event-stream")
    const body = route.request().postDataJSON() as { tools?: Array<{ name?: string }> }
    expect(body.tools?.map((tool) => tool.name)).toContain("browser_read_page")
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

  await controller.locator("#prompt").fill("Exercise the browser tools")
  await controller.locator("#send").click()
  await expect(controller.locator("#confirm-dialog")).toBeVisible()
  await controller.locator('#confirm-dialog button[value="confirm"]').click()
  await expect(controller.locator("#transcript")).toContainText(
    "Mock agent completed the browser round trip.",
  )
  expect(requestCount).toBe(responses.length)
  await expect(page).toHaveURL(`http://127.0.0.1:${fixture.port}/second`)
  await expect(page.locator("main")).toHaveText("Second page")
  await context.unroute(codexUrl)

  await page.goto(`http://127.0.0.1:${fixture.port}/`)
  await page.bringToFront()
  tabContext = (await request("tabs.bindActive")) as unknown as typeof tabContext
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

test("restores the bound tab after a service-worker restart", async () => {
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
