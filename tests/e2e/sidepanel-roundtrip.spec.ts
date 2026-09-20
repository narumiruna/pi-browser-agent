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
  await controller.evaluate(async () => {
    await chrome.storage.local.set({
      piChromeApprovedHostPermissions: ["http://127.0.0.1/*"],
    })
  })
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
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: { query: async () => ({ state: "prompt" }) },
    })
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => ({ getTracks: () => [{ stop: () => undefined }] }),
      },
    })
  })
  await microphonePage.goto(`chrome-extension://${extensionId}/${panelPath}?view=microphone`)

  await expect(microphonePage).toHaveTitle("Microphone access · Pi Chrome")
  await expect(microphonePage.locator("#microphone-access-page")).toBeVisible()
  await expect(microphonePage.locator("#microphone-access-status")).toContainText(
    "Select Allow microphone access",
  )
  await microphonePage.locator("#allow-microphone").click()
  await expect(microphonePage.locator("#microphone-access-status")).toContainText(
    "Microphone access is allowed",
  )

  const pendingSelectionKey = await controller.evaluate(async () => {
    const windowId = (await chrome.windows.getCurrent()).id
    if (windowId === undefined) throw new Error("Current window has no ID")
    const key = `piChromePendingSelection:${windowId}`
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

  const accountDisclosure = controller.locator(".account-disclosure")
  const voiceButton = controller.locator("#voice-input")
  const sessionCount = await controller.locator("#sessions option").count()
  await expect(voiceButton).toBeEnabled()
  await voiceButton.click()
  await expect(voiceButton).toHaveAttribute("aria-pressed", "true")
  await controller.locator("#account-menu-trigger").click()
  await expect(controller.locator("#open-settings")).toBeVisible()
  const settingsTabPromise = context.waitForEvent("page")
  await controller.locator("#open-settings").click()
  const settingsTab = await settingsTabPromise
  const settingsPage = settingsTab.locator("#settings-page")
  const settingsError = settingsTab.locator("#settings-error")

  await expect(settingsTab).toHaveTitle("Settings · Pi Chrome")
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
    const stored = await chrome.storage.local.get("piChromeApprovedHostPermissions")
    const approvals = stored.piChromeApprovedHostPermissions
    return Array.isArray(approvals)
      ? approvals.filter((approval): approval is string => typeof approval === "string")
      : []
  })
  await settingsTab.evaluate(async (credential) => {
    const stored = await chrome.storage.local.get("piChromeApprovedHostPermissions")
    const approvals = Array.isArray(stored.piChromeApprovedHostPermissions)
      ? stored.piChromeApprovedHostPermissions.filter(
          (approval): approval is string => typeof approval === "string",
        )
      : []
    await chrome.storage.local.set({
      piChromeApprovedHostPermissions: [
        ...new Set([...approvals, "https://auth.openai.com/*", "https://chatgpt.com/*"]),
      ],
      piChromeCredentialsV1: { "openai-codex": credential },
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
        const stored = await chrome.storage.local.get("piChromeCredentialsV1")
        return (stored.piChromeCredentialsV1 as Record<string, unknown>)["openai-codex"]
      }),
    )
    .toEqual(existingCodexCredential)
  await controller.evaluate(async (hostApprovals) => {
    await chrome.storage.local.set({ piChromeApprovedHostPermissions: hostApprovals })
    await chrome.storage.local.remove("piChromeCredentialsV1")
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
      if (Object.hasOwn(items, "piChromeSettings")) throw new Error("Test settings save failed")
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
  const initialProvider = await controller.locator("#provider").inputValue()
  const initialModel = await controller.locator("#model").inputValue()
  await controller.evaluate(async () => chrome.storage.local.remove("piChromeCredentialsV1"))
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
      const stored = await chrome.storage.local.get("piChromeCredentialsV1")
      return (
        stored.piChromeCredentialsV1 as Record<string, { type: string; key?: string }> | undefined
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
    await expect(controller.locator("#provider")).toHaveValue(initialProvider)
    await expect(controller.locator("#model")).toHaveValue(initialModel)
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
    await controller.evaluate(async () => chrome.storage.local.remove("piChromeCredentialsV1"))
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
  await expect(controller.locator("#provider")).toHaveValue("anthropic")
  await expect(controller.locator("#model")).toHaveValue(anthropicModelId)

  await sessionSelect.selectOption(initialSessionId)
  await expect(controller.locator("#provider")).toHaveValue("openai-codex")
  const restoredSessionSettingsTab = await openSettingsTab()
  await expect(restoredSessionSettingsTab.locator("#provider")).toHaveValue("openai-codex")
  await expect(restoredSessionSettingsTab.locator("#model")).toHaveValue("gpt-5.6-terra")
  await controller.locator("#new-session").click()
  await expect(controller.locator("#provider")).toHaveValue("anthropic")
  await expect(controller.locator("#model")).toHaveValue(anthropicModelId)

  await restoredSessionSettingsTab.locator("#font-family").selectOption("serif")
  const restoredSessionSettingsTabClosed = restoredSessionSettingsTab.waitForEvent("close")
  await restoredSessionSettingsTab.locator("#save-settings").click()
  await restoredSessionSettingsTabClosed

  await expect(controller.locator("#provider")).toHaveValue("anthropic")
  await expect(controller.locator("#model")).toHaveValue(anthropicModelId)
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
    }
  })

  try {
    await controller.setViewportSize({ width: 480, height: 720 })
    await expect(controller.locator(".brand, .brand-mark")).toHaveCount(0)
    await expect(controller.locator(".app-header")).not.toContainText("Pi Chrome")
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
              },
              { fontSize, running },
            )
            const layout = await controller.evaluate(() => {
              const selectors = [
                "#sessions",
                "#new-session",
                ".session-disclosure > summary",
                "#account-menu-trigger",
                "#prompt",
                "#run-status",
                "#voice-input",
                "#send",
                ...(document.body.dataset.state === "running" ? ["#abort"] : []),
              ]
              const controls = selectors.map((selector) => {
                const element = document.querySelector(selector)
                if (!(element instanceof HTMLElement)) throw new Error(`Missing ${selector}`)
                const rectangle = element.getBoundingClientRect()
                return {
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
              expect(control.width).toBeGreaterThan(0)
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
    }, originalUi)
    await controller.emulateMedia({ colorScheme: null })
    await controller.setViewportSize(originalViewport)
  }
})

test("does not use all-sites Chrome access without exact app approval", async () => {
  await page.bringToFront()
  tabContext = await waitForCurrentTab(`http://127.0.0.1:${fixture.port}/`)
  await controller.evaluate(async () => {
    await chrome.storage.local.remove("piChromeApprovedHostPermissions")
  })
  try {
    await expect(request("page.getVisibleText", {}, { tabContext })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    })
  } finally {
    await controller.evaluate(async () => {
      await chrome.storage.local.set({
        piChromeApprovedHostPermissions: ["http://127.0.0.1/*"],
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
      piChromeApprovedHostPermissions: ["https://auth.openai.com/*", "https://chatgpt.com/*"],
      piChromeCredentialsV1: { "openai-codex": credential },
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
    let getCount = 0
    chrome.storage.local.get = (async (key: string) => {
      getCount += 1
      const result = await callOriginalGet(key)
      if (getCount !== 3) return result
      markEntered()
      await gate
      chrome.storage.local.get = originalGet
      return result
    }) as typeof chrome.storage.local.get
    ;(
      window as typeof window & {
        authStatusGate?: { entered: Promise<void>; release: () => void }
      }
    ).authStatusGate = { entered, release }
  })
  await settingsTab.evaluate(async (credential) => {
    await chrome.storage.local.set({
      piChromeCredentialsV1: {
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

  await settingsTab.evaluate(async () => chrome.storage.local.remove("piChromeCredentialsV1"))
  await expect(configureProvider).toHaveText("Configure authentication")
  await expect(controller.locator("#auth-status")).toHaveText("OpenAI Codex not configured")
  await controller.evaluate(() => {
    const state = window as typeof window & {
      authStatusGate?: { release: () => void }
    }
    state.authStatusGate?.release()
    delete state.authStatusGate
  })
  await controller.waitForTimeout(50)
  await expect(controller.locator("#auth-status")).toHaveText("OpenAI Codex not configured")

  await controller.evaluate(async (credential) => {
    await chrome.storage.local.set({
      piChromeCredentialsV1: { "openai-codex": credential },
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
