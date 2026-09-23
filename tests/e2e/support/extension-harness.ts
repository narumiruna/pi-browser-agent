import assert from "node:assert/strict"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { type BrowserContext, chromium, type Page, type Worker } from "@playwright/test"

const BUILD_DIRECTORY = resolve("dist/chrome")
const FIXTURE_PATH = "/smoke-page.html"
const FIXTURE_SOURCE = resolve("tests/e2e/fixtures/smoke-page.html")
const CODEX_ORIGINS = ["https://auth.openai.com/*", "https://chatgpt.com/*"]

interface FixtureServer {
  close: () => Promise<void>
  origin: string
}

export interface ExtensionHarness {
  close: () => Promise<void>
  context: BrowserContext
  controller: Page
  extensionId: string
  fixturePage: Page
  fixtureUrl: string
  pageErrors: string[]
  restart: () => Promise<void>
  worker: Worker
}

async function startFixtureServer(): Promise<FixtureServer> {
  const fixture = await readFile(FIXTURE_SOURCE)
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname
    if (pathname !== FIXTURE_PATH) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
      response.end("Not Found")
      return
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    response.end(fixture)
  })
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolvePromise)
  })
  const address = server.address()
  if (!address || typeof address === "string") {
    await closeServer(server)
    throw new Error("Unable to resolve the E2E fixture server address")
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()))
  })
}

function trackPageErrors(context: BrowserContext, errors: string[]): void {
  const track = (page: Page): void => {
    page.on("pageerror", (error) => errors.push(`${page.url()}: ${error.message}`))
  }
  for (const page of context.pages()) track(page)
  context.on("page", track)
}

function hostPermissionPattern(url: string): string {
  const parsed = new URL(url)
  return `${parsed.protocol}//${parsed.hostname}/*`
}

export async function launchExtensionHarness(
  options: { bookmarks?: boolean } = {},
): Promise<ExtensionHarness> {
  const fixtureServer = await startFixtureServer()
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-browser-agent-smoke-"))
  const profileDirectory = join(temporaryDirectory, "profile")
  const extensionDirectory = join(temporaryDirectory, "extension")
  const sourceManifestPath = join(BUILD_DIRECTORY, "manifest.json")
  let context: BrowserContext | undefined

  try {
    const sourceManifest = await readFile(sourceManifestPath, "utf8")
    await cp(BUILD_DIRECTORY, extensionDirectory, { recursive: true })
    const copiedManifestPath = join(extensionDirectory, "manifest.json")
    const copiedManifest = JSON.parse(await readFile(copiedManifestPath, "utf8")) as {
      host_permissions?: string[]
      permissions?: string[]
      optional_permissions?: string[]
      side_panel?: { default_path?: string }
    }
    const fixturePattern = hostPermissionPattern(fixtureServer.origin)
    copiedManifest.host_permissions = [
      ...new Set([...(copiedManifest.host_permissions ?? []), fixturePattern, ...CODEX_ORIGINS]),
    ]
    if (options.bookmarks) {
      copiedManifest.permissions = [...(copiedManifest.permissions ?? []), "bookmarks"]
      copiedManifest.optional_permissions = (copiedManifest.optional_permissions ?? []).filter(
        (permission) => permission !== "bookmarks",
      )
    }
    await writeFile(copiedManifestPath, JSON.stringify(copiedManifest, null, 2))
    assert.equal(
      await readFile(sourceManifestPath, "utf8"),
      sourceManifest,
      "E2E setup must not mutate dist/chrome/manifest.json",
    )

    context = await chromium.launchPersistentContext(profileDirectory, {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${extensionDirectory}`,
        `--load-extension=${extensionDirectory}`,
      ],
    })
    const pageErrors: string[] = []
    trackPageErrors(context, pageErrors)
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"))
    const extensionId = new URL(worker.url()).host
    const fixtureUrl = `${fixtureServer.origin}${FIXTURE_PATH}`
    const fixturePage = await context.newPage()
    await fixturePage.goto(fixtureUrl, { waitUntil: "domcontentloaded" })
    const controller = await context.newPage()
    const panelPath = copiedManifest.side_panel?.default_path ?? "sidepanel/index.html"
    await controller.goto(`chrome-extension://${extensionId}/${panelPath}`, {
      waitUntil: "domcontentloaded",
    })
    await fixturePage.bringToFront()

    let closed = false
    const harness: ExtensionHarness = {
      context,
      controller,
      extensionId,
      fixturePage,
      fixtureUrl,
      pageErrors,
      worker,
      async restart() {
        await context?.close()
        context = await chromium.launchPersistentContext(profileDirectory, {
          channel: "chromium",
          headless: true,
          args: [
            `--disable-extensions-except=${extensionDirectory}`,
            `--load-extension=${extensionDirectory}`,
          ],
        })
        trackPageErrors(context, pageErrors)
        harness.context = context
        harness.worker =
          context.serviceWorkers()[0] ??
          (await context.waitForEvent("serviceworker", { timeout: 15_000 }))
        assert.equal(new URL(harness.worker.url()).host, extensionId)
        harness.controller = await context.newPage()
        await harness.controller.goto(`chrome-extension://${extensionId}/${panelPath}`, {
          waitUntil: "domcontentloaded",
        })
        harness.fixturePage = await context.newPage()
        await harness.fixturePage.goto(fixtureUrl, { waitUntil: "domcontentloaded" })
        await harness.fixturePage.bringToFront()
      },
      async close() {
        if (closed) return
        closed = true
        await context?.close().catch(() => undefined)
        try {
          await fixtureServer.close()
        } finally {
          await rm(temporaryDirectory, { force: true, recursive: true })
        }
      },
    }
    return harness
  } catch (error) {
    await context?.close().catch(() => undefined)
    await fixtureServer.close().catch(() => undefined)
    await rm(temporaryDirectory, { force: true, recursive: true })
    throw error
  }
}

export async function configureMockCodex(harness: ExtensionHarness): Promise<void> {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "e2e-account" } }),
  ).toString("base64")
  const credential = {
    type: "oauth",
    access: `e30.${payload}.signature`,
    refresh: "e2e-refresh-token",
    expires: Date.now() + 3_600_000,
    accountId: "e2e-account",
  }
  const fixturePattern = hostPermissionPattern(harness.fixtureUrl)
  await harness.controller.evaluate(
    async ({ approvals, credential }) => {
      await chrome.storage.local.set({
        piBrowserAgentApprovedHostPermissions: approvals,
        piBrowserAgentCredentialsV1: { "openai-codex": credential },
      })
    },
    { approvals: [fixturePattern, ...CODEX_ORIGINS], credential },
  )
  await harness.controller.reload({ waitUntil: "domcontentloaded" })
  await harness.fixturePage.bringToFront()
}
