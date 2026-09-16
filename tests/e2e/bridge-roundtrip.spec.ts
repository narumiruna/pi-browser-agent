import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { createServer as createHttpServer, type Server } from "node:http"
import { createServer as createNetServer } from "node:net"
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
import { BridgeServer } from "../../src/pi/bridge-server.js"
import { BridgeConfigStore } from "../../src/pi/config.js"
import { BridgeError, type TabContext } from "../../src/protocol/index.js"

async function getFreePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Unable to allocate a port")
  await new Promise<void>((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise())),
  )
  return address.port
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const started = Date.now()
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error("Condition timed out")
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
  }
}

function startFixtureServer(port: number): Promise<Server> {
  const server = createHttpServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8")
    if (request.url === "/second") {
      response.end("<!doctype html><title>Second</title><main>Second page</main>")
      return
    }
    response.end(`<!doctype html>
      <title>Bridge fixture</title>
      <main>
        <h1>Visible bridge text</h1>
        <input id="title" type="text">
        <input id="password" type="password">
        <button id="ordinary" type="button">Ordinary click</button>
        <a id="external" href="http://localhost:${port}/second">External link</a>
        <a id="external-download" href="http://localhost:${port}/second" download>External download</a>
        <form id="dangerous"><button id="submit" type="submit">Submit</button></form>
        <p id="result">idle</p>
      </main>
      <script>
        document.querySelector('#ordinary').addEventListener('click', () => {
          document.querySelector('#result').textContent = 'clicked'
        })
        document.querySelector('#dangerous').addEventListener('submit', (event) => {
          event.preventDefault()
          document.querySelector('#result').textContent = 'submitted'
        })
        document.querySelector('#external').addEventListener('click', (event) => {
          event.currentTarget.href = 'http://127.0.0.1:${port}/second'
        })
      </script>`)
  })
  return new Promise((resolvePromise) =>
    server.listen(port, "127.0.0.1", () => resolvePromise(server)),
  )
}

let context: BrowserContext
let page: Page
let worker: Worker
let bridge: BridgeServer
let configStore: BridgeConfigStore
let fixtureServer: Server
let bridgePort: number
let fixturePort: number
let secret: string
let extensionId: string

test.beforeAll(async () => {
  bridgePort = await getFreePort()
  fixturePort = await getFreePort()
  secret = Buffer.alloc(32, 42).toString("base64url")
  const directory = await mkdtemp(join(tmpdir(), "pi-chrome-e2e-"))
  configStore = new BridgeConfigStore(join(directory, "config.json"))
  await configStore.save({ port: bridgePort, secret })
  bridge = new BridgeServer(configStore)
  await bridge.start()
  fixtureServer = await startFixtureServer(fixturePort)

  const extensionPath = join(directory, "chrome-extension")
  await cp(resolve("dist/chrome"), extensionPath, { recursive: true })
  const manifestPath = join(extensionPath, "manifest.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>
  // The test artifact gets broad access so headless Chromium can exercise captureVisibleTab
  // without a toolbar gesture. The production manifest remains activeTab-only.
  manifest.host_permissions = ["<all_urls>"]
  await writeFile(manifestPath, JSON.stringify(manifest))

  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  })
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"))
  page = await context.newPage()
  await page.goto(`http://127.0.0.1:${fixturePort}/`)
  await page.bringToFront()

  extensionId = new URL(worker.url()).host
  const controller = await context.newPage()
  await controller.goto(`chrome-extension://${extensionId}/action/index.html`)
  await expect(controller.locator("#status")).toHaveText("Unpaired")
  const pairing = await controller.evaluate(
    async ({ pairingSecret, port }) => {
      const current = await chrome.tabs.getCurrent()
      if (current?.openerTabId === undefined) throw new Error("Fixture opener tab not found")
      await chrome.tabs.update(current.openerTabId, { active: true })
      return chrome.runtime.sendMessage({ type: "bridge.pair", secret: pairingSecret, port })
    },
    { pairingSecret: secret, port: bridgePort },
  )
  await controller.close()
  if (!pairing?.ok) throw new Error(pairing?.error?.message ?? "Extension pairing failed")
  await waitFor(() => bridge.getStatus().connected)
})

test.afterAll(async () => {
  await context?.close()
  await bridge?.stop()
  await new Promise<void>((resolvePromise, reject) =>
    fixtureServer?.close((error) => (error ? reject(error) : resolvePromise())),
  )
})

test("completes the pi-to-service-worker-to-page read and screenshot round trip", async () => {
  const tab = (await bridge.request("tabs.getActive", {})) as {
    title: string
    tabId: number
    url: string
  }
  expect(tab.title).toBe("Bridge fixture")
  expect(tab.url).toBe(`http://127.0.0.1:${fixturePort}/`)

  const result = (await bridge.request("page.getVisibleText", {})) as { text: string }
  expect(result.text).toContain("Visible bridge text")
  expect(result.text).not.toContain("password")

  await page.locator("h1").selectText()
  const selection = (await bridge.request("page.getSelection", {})) as { text: string }
  expect(selection.text).toBe("Visible bridge text")

  const screenshot = (await bridge.request("page.captureVisible", {})) as { dataUrl: string }
  expect(screenshot.dataUrl).toMatch(/^data:image\/png;base64,/)
})

test("supports scoped interaction and blocks sensitive actions until confirmed", async () => {
  await bridge.request("page.type", { selector: "#title", text: "typed by pi" })
  await expect(page.locator("#title")).toHaveValue("typed by pi")

  await bridge.request("page.click", { selector: "#ordinary" })
  await expect(page.locator("#result")).toHaveText("clicked")

  await expect(
    bridge.request("page.type", { selector: "#password", text: "secret" }),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  })
  await expect(bridge.request("page.click", { selector: "#submit" })).rejects.toMatchObject({
    code: "CONFIRMATION_REQUIRED",
  })
  await expect(page.locator("#result")).toHaveText("clicked")

  await bridge.request("page.click", { selector: "#submit" }, { confirmed: true })
  await expect(page.locator("#result")).toHaveText("submitted")

  const localhostUrl = `http://localhost:${fixturePort}/second`
  await expect(bridge.request("tabs.navigate", { url: localhostUrl })).rejects.toMatchObject({
    code: "CONFIRMATION_REQUIRED",
  })
  await expect(page).toHaveURL(`http://127.0.0.1:${fixturePort}/`)

  await expect(bridge.request("page.click", { selector: "#external" })).rejects.toMatchObject({
    code: "CONFIRMATION_REQUIRED",
  })
  await bridge.request("page.click", { selector: "#external" }, { confirmed: true })
  await page.waitForURL(localhostUrl)
  await bridge.request(
    "tabs.navigate",
    { url: `http://127.0.0.1:${fixturePort}/` },
    { confirmed: true },
  )
  await page.waitForURL(`http://127.0.0.1:${fixturePort}/`)

  await bridge.request("page.click", { selector: "#external-download" }, { confirmed: true })
  await page.waitForURL(localhostUrl)
  await bridge.request(
    "tabs.navigate",
    { url: `http://127.0.0.1:${fixturePort}/` },
    { confirmed: true },
  )
  await page.waitForURL(`http://127.0.0.1:${fixturePort}/`)
})

test("rejects stale requests after navigation", async () => {
  const previous = bridge.getStatus().tabContext as TabContext
  await bridge.request("tabs.navigate", { url: `http://127.0.0.1:${fixturePort}/second` })
  await page.waitForURL(`http://127.0.0.1:${fixturePort}/second`)
  await waitFor(() => (bridge.getStatus().tabContext?.epoch ?? 0) > previous.epoch)

  await expect(
    bridge.request("page.getVisibleText", {}, { tabContext: previous }),
  ).rejects.toMatchObject({ code: "STALE_CONTEXT" })
})

test("publishes same-document URL changes before later requests", async () => {
  const updatedUrl = `http://127.0.0.1:${fixturePort}/second#client-state`
  await page.evaluate(() => history.pushState({}, "", "/second#client-state"))
  await waitFor(() => bridge.getStatus().tabContext?.url === updatedUrl)

  await expect(bridge.request("page.getVisibleText", {})).resolves.toMatchObject({
    text: expect.stringContaining("Second page"),
    url: updatedUrl,
  })
})

test("restores state after the MV3 service worker is restarted", async () => {
  const cdp = await context.newCDPSession(page)
  const targets = (await cdp.send("Target.getTargets")) as {
    targetInfos: Array<{ targetId: string; type: string; url: string }>
  }
  const serviceWorkerTarget = targets.targetInfos.find(
    (target) =>
      target.type === "service_worker" &&
      target.url.startsWith(`chrome-extension://${extensionId}/`),
  )
  if (!serviceWorkerTarget) throw new Error("Extension service worker target not found")
  await cdp.send("Target.closeTarget", { targetId: serviceWorkerTarget.targetId })
  await waitFor(() => !bridge.getStatus().connected)

  const controller = await context.newPage()
  await controller.goto(`chrome-extension://${extensionId}/action/index.html`)
  await controller.evaluate(() => chrome.runtime.sendMessage({ type: "bridge.getStatus" }))
  await waitFor(() => bridge.getStatus().connected, 15_000)
  await controller.close()

  await expect(bridge.request("tabs.getActive", {})).resolves.toMatchObject({ title: "Second" })
})

test("reconnects after pi reload and supports revoke", async () => {
  await bridge.stop()
  bridge = new BridgeServer(configStore)
  await bridge.start()
  await waitFor(() => bridge.getStatus().connected, 15_000)

  await expect(bridge.request("tabs.getActive", {})).resolves.toMatchObject({ title: "Second" })

  const controller = await context.newPage()
  await controller.goto(`chrome-extension://${extensionId}/action/index.html`)
  const revoked = await controller.evaluate(() =>
    chrome.runtime.sendMessage({ type: "bridge.revoke" }),
  )
  expect(revoked.ok).toBe(true)
  expect(revoked.result.warning).toBeUndefined()
  await waitFor(() => !bridge.getStatus().connected)
  expect(bridge.getStatus().paired).toBe(false)
  await expect(configStore.load()).resolves.toEqual({ port: bridgePort })
  await expect(bridge.request("tabs.getActive", {})).rejects.toBeInstanceOf(BridgeError)

  const fallback = await controller.evaluate(async (pairingSecret) => {
    const key = "piChromeBridgeSettings"
    const stored = await chrome.storage.local.get(key)
    await chrome.storage.local.set({
      [key]: { ...stored[key], enabled: true, secret: pairingSecret },
    })
    return chrome.runtime.sendMessage({ type: "bridge.revoke" })
  }, secret)
  expect(fallback.ok).toBe(true)
  expect(fallback.result.warning).toContain("Run /chrome-revoke in pi")
  const localSettings = await controller.evaluate(async () => {
    const stored = await chrome.storage.local.get("piChromeBridgeSettings")
    return stored.piChromeBridgeSettings
  })
  expect(localSettings).toMatchObject({ enabled: false, port: bridgePort })
  expect(localSettings).not.toHaveProperty("secret")
  await controller.close()
})
