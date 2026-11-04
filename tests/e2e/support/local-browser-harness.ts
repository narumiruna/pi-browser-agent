import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { type BrowserContext, type CDPSession, chromium, expect, type Page } from "@playwright/test"
import { ExistingChromeConnection } from "../../../.pi/extensions/browser-tasks/chrome-connection.js"
import { LocalBrowserClient } from "../../../.pi/extensions/browser-tasks/transport.js"
import { CODEX_RESPONSES_URL } from "./mock-codex.js"

export const fakeCredential = "e2e-browser-private-credential-no-export"
export const fixtureMarker = "local-pipe-fixture-meadow-42"
const codexOrigins = ["https://auth.openai.com/*", "https://chatgpt.com/*"]
type PanelResult = { result?: { value?: unknown }; exceptionDetails?: unknown }

/** Test-only DOM and native input connection to the actual Side Panel, not a tab. */
export class SidePanelDriver {
  private sequence = 0

  private constructor(
    readonly cdp: CDPSession,
    private readonly sessionId: string,
  ) {}

  static async attach(context: BrowserContext, url: string): Promise<SidePanelDriver> {
    const browser = context.browser()
    if (!browser) throw new Error("Missing owned browser")
    const cdp = await browser.newBrowserCDPSession()
    let targetId: string | undefined
    await expect
      .poll(async () => {
        const { targetInfos } = await cdp.send("Target.getTargets")
        const targets = targetInfos.filter((target) => target.url === url && target.type === "page")
        expect(context.pages().map((page) => page.url())).not.toContain(url)
        expect(targets.length).toBeLessThanOrEqual(1)
        targetId = targets[0]?.targetId
        return Boolean(targetId)
      })
      .toBe(true)
    if (!targetId) throw new Error("Missing actual Side Panel")
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: false })
    return new SidePanelDriver(cdp, sessionId)
  }

  async send(method: string, params: Record<string, unknown>): Promise<PanelResult> {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, result?: PanelResult) => {
        clearTimeout(timer)
        this.cdp.off("Target.receivedMessageFromTarget", receive)
        if (error) reject(error)
        else resolve(result ?? {})
      }
      const receive = (event: { sessionId: string; message: string }) => {
        if (event.sessionId !== this.sessionId) return
        const message = JSON.parse(event.message)
        if (message.id !== id) return
        finish(message.error ? new Error(JSON.stringify(message.error)) : undefined, message.result)
      }
      const timer = setTimeout(() => finish(new Error(`Side Panel CDP timeout: ${method}`)), 15_000)
      this.cdp.on("Target.receivedMessageFromTarget", receive)
      void this.cdp
        .send("Target.sendMessageToTarget", {
          sessionId: this.sessionId,
          message: JSON.stringify({ id, method, params }),
        })
        .catch((error: Error) => finish(error))
    })
  }

  async mockCodex(
    requests: Record<string, unknown>[],
    responses: string[],
    unexpectedRequests: string[],
  ): Promise<void> {
    // Playwright does not own this target, so context.route cannot intercept its fetches.
    this.cdp.on("Target.receivedMessageFromTarget", (event) => {
      if (event.sessionId !== this.sessionId) return
      const message = JSON.parse(event.message)
      if (message.method !== "Fetch.requestPaused") return
      const { requestId, request } = message.params as {
        requestId: string
        request: { url: string; postData?: string }
      }
      void (async () => {
        if (request.url === CODEX_RESPONSES_URL) {
          requests.push(JSON.parse(request.postData ?? "{}"))
          const body = responses.shift()
          if (body) {
            await this.send("Fetch.fulfillRequest", {
              requestId,
              responseCode: 200,
              responseHeaders: [
                { name: "Content-Type", value: "text/event-stream" },
                { name: "Access-Control-Allow-Origin", value: "*" },
              ],
              body: Buffer.from(body).toString("base64"),
            })
            return
          }
          unexpectedRequests.push("Unscripted model request")
        } else unexpectedRequests.push(request.url)
        await this.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" })
      })().catch((error: unknown) => unexpectedRequests.push(String(error)))
    })
    await this.send("Fetch.enable", {
      patterns: [
        { urlPattern: "http://*", requestStage: "Request" },
        { urlPattern: "https://*", requestStage: "Request" },
      ],
    })
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      // Deliberately no userGesture: script must not grant missing origin access.
    })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result?.value as T
  }

  async text(selector: string): Promise<string> {
    return this.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`)
  }

  async visible(selector: string): Promise<boolean> {
    return this.evaluate(
      `Boolean(document.querySelector(${JSON.stringify(selector)})?.getClientRects().length)`,
    )
  }

  async click(selector: string): Promise<void> {
    await expect.poll(() => this.visible(selector)).toBe(true)
    const point = await this.evaluate<{ x: number; y: number }>(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      element.scrollIntoView({block: 'center'});
      const rect = element.getBoundingClientRect();
      return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
    })()`)
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...point,
      button: "left",
      clickCount: 1,
    })
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...point,
      button: "left",
      clickCount: 1,
    })
  }

  async fillPrompt(text: string): Promise<void> {
    await this.click("#prompt")
    await this.send("Input.insertText", { text })
    await expect.poll(() => this.evaluate("document.querySelector('#prompt').value")).toBe(text)
  }
}

export async function launchLocalBrowserHarness() {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-local-browser-e2e-"))
  const artifact = resolve("dist/chrome")
  const sourceManifest = await readFile(join(artifact, "manifest.json"), "utf8")
  const requests: Record<string, unknown>[] = []
  const responses: string[] = []
  const unexpectedRequests: string[] = []
  const pageErrors: string[] = []
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    response.end(
      `<!doctype html><title>Local pipe fixture</title><main><h1>${fixtureMarker}</h1><button id="ordinary" onclick="document.querySelector('output').textContent='changed'">Ordinary action</button><output>unchanged</output></main>`,
    )
  })
  let client: LocalBrowserClient | undefined
  let connection: ExistingChromeConnection | undefined
  let context: BrowserContext | undefined
  let fixturePage: Page | undefined
  let settings: Page | undefined
  let panelUrl = ""
  let setupError: unknown
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing fixture address")
  const fixtureUrl = `http://127.0.0.1:${address.port}/`
  const fixturePattern = "http://127.0.0.1/*"
  const close = async () => {
    await client?.close()
    await connection?.close()
    // Only this isolated test harness owns the temporary browser, never the adapter.
    await context?.close().catch(() => {})
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    await rm(temporaryDirectory, { force: true, recursive: true })
  }
  try {
    const copiedArtifact = join(temporaryDirectory, "dist/chrome")
    await cp(artifact, copiedArtifact, { recursive: true })
    const manifest = JSON.parse(sourceManifest)
    manifest.host_permissions = [
      ...new Set([...(manifest.host_permissions ?? []), fixturePattern, ...codexOrigins]),
    ]
    await writeFile(join(copiedArtifact, "manifest.json"), JSON.stringify(manifest))
    expect(await readFile(join(artifact, "manifest.json"), "utf8")).toBe(sourceManifest)
    context = await chromium.launchPersistentContext(join(temporaryDirectory, "profile"), {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${copiedArtifact}`,
        `--load-extension=${copiedArtifact}`,
        "--remote-debugging-port=0",
      ],
    })
    const owned = context
    const worker = owned.serviceWorkers()[0] ?? (await owned.waitForEvent("serviceworker"))
    const extensionId = new URL(worker.url()).hostname
    expect(manifest.side_panel.default_path).toBe("sidebar/index.html")
    panelUrl = `chrome-extension://${extensionId}/sidebar/index.html`
    const [port, debugPath] = (
      await readFile(join(temporaryDirectory, "profile", "DevToolsActivePort"), "utf8")
    )
      .trim()
      .split(/\r?\n/)
    connection = new ExistingChromeConnection(`ws://127.0.0.1:${port}${debugPath}`)
    const enrolling = connection.connect(
      { extensionId, clientId: crypto.randomUUID() },
      AbortSignal.timeout(100_000),
    )
    void enrolling.catch(() => {})
    try {
      const track = (page: Page) => page.on("pageerror", (error) => pageErrors.push(error.message))
      owned.pages().forEach(track)
      owned.on("page", track)
      await owned.route(/^https?:\/\//, async (route) => {
        if (route.request().url().startsWith(fixtureUrl)) return route.continue()
        unexpectedRequests.push(route.request().url())
        await route.abort()
      })
      await owned.route(CODEX_RESPONSES_URL, async (route) => {
        requests.push(route.request().postDataJSON())
        const body = responses.shift()
        if (!body) {
          unexpectedRequests.push("Unscripted model request")
          return route.abort()
        }
        await route.fulfill({ status: 200, contentType: "text/event-stream", body })
      })
      await expect
        .poll(() => {
          settings = owned.pages().find((page) => page.url() === `${panelUrl}?view=settings`)
          return Boolean(settings)
        })
        .toBe(true)
      if (!settings) throw new Error("Missing pending Settings page")
      await expect
        .poll(() => settings?.evaluate(() => window.__piBrowserLocal?.role))
        .toBe("settings")
      panelUrl = settings.url().split("?")[0] ?? ""
      const payload = Buffer.from(
        JSON.stringify({
          "https://api.openai.com/auth": { chatgpt_account_id: "e2e-account" },
        }),
      ).toString("base64")
      // Test-only seed in trusted Settings, before the real consent opens the panel.
      await settings.evaluate(
        async ({ approvals, payload, secret }) => {
          await chrome.storage.local.set({
            piBrowserAgentApprovedHostPermissions: approvals,
            piBrowserAgentCredentialsV1: {
              "openai-codex": {
                type: "oauth",
                access: `e30.${payload}.signature`,
                refresh: secret,
                expires: Date.now() + 3_600_000,
                accountId: "e2e-account",
              },
            },
          })
        },
        { approvals: [fixturePattern, ...codexOrigins], payload, secret: fakeCredential },
      )
      await settings.getByRole("tab", { name: "Tools", exact: true }).click()
      await expect(settings.locator("#coding-status")).toHaveText("Waiting for local approval")
      const section = settings.locator('[aria-labelledby="coding-connection-title"]')
      await expect(section.locator("input, textarea")).toHaveCount(0)
      await expect(settings.locator("#coding-endpoint, #coding-token")).toHaveCount(0)
      expect(requests).toEqual([])
      await settings.locator("#coding-allow").click()
      await expect(settings.locator("#settings-confirm-dialog")).toBeVisible()
      await expect(settings.locator("#settings-confirm-title")).toHaveText(
        "Allow local Coding Agent?",
      )
      expect(requests).toEqual([])
      await settings.locator("#settings-confirm-action").click()
      await expect(settings.locator("#coding-status")).toHaveText(
        "Connected to local Pi Coding Agent",
      )
      fixturePage = await owned.newPage()
      await fixturePage.goto(fixtureUrl)
      await fixturePage.bringToFront()
    } catch (error) {
      setupError = error
      throw error
    }
    const identity = await enrolling
    client = new LocalBrowserClient(connection, identity)
    if (!context || !fixturePage || !settings) throw new Error("Incomplete attached-browser setup")
    const panel = await SidePanelDriver.attach(context, panelUrl)
    await panel.mockCodex(requests, responses, unexpectedRequests)
    await expect.poll(() => panel.evaluate("document.body.dataset.conversationReady")).toBe("true")
    await expect
      .poll(() => panel.evaluate("document.querySelector('#auth-status')?.dataset.loggedIn"))
      .toBe("true")
    expect(requests).toEqual([])
    expect(await panel.evaluate("document.querySelector('#prompt').value")).toBe("")
    expect(await panel.visible("#coding-task-chip")).toBe(false)
    expect(await panel.text("#send-label")).toBe("Send")
    const contexts = await panel.evaluate<{ contextType: string; documentUrl?: string }[]>(
      "chrome.runtime.getContexts({contextTypes: ['SIDE_PANEL']})",
    )
    expect(
      contexts.some(
        (entry) => entry.contextType === "SIDE_PANEL" && entry.documentUrl === panelUrl,
      ),
    ).toBe(true)
    let args: string[]
    try {
      args = (await panel.cdp.send("Browser.getBrowserCommandLine")).arguments
    } catch (error) {
      // Chromium without --enable-automation rejects the diagnostic command. Read only
      // the owned browser PID reported by this pipe, never another Chrome process.
      if (process.platform !== "linux" || !String(error).includes("--enable-automation not set"))
        throw error
      const { processInfo } = await panel.cdp.send("SystemInfo.getProcessInfo")
      const browserProcess = processInfo.find((info) => info.type === "browser")
      if (!browserProcess) throw new Error("Missing owned Chromium PID")
      args = (await readFile(`/proc/${browserProcess.id}/cmdline`, "utf8"))
        .split(/[\0\s]+/)
        .filter(Boolean)
    }
    expect(args).toContain(`--user-data-dir=${join(temporaryDirectory, "profile")}`)
    expect(args).toContain("--remote-debugging-port=0")
    expect(await panel.evaluate("chrome.tabs.getCurrent().then(tab => tab === undefined)")).toBe(
      true,
    )
    return {
      client,
      context,
      fixturePage,
      settings,
      panel,
      requests,
      responses,
      unexpectedRequests,
      pageErrors,
      close,
    }
  } catch (error) {
    await close()
    throw setupError ?? error
  }
}
