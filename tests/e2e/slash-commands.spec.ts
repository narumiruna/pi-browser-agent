import { expect, type Page, test } from "@playwright/test"
import {
  configureMockCodex,
  type ExtensionHarness,
  launchExtensionHarness,
  waitForConversationReady,
} from "./support/extension-harness.js"
import { startMcpFixture } from "./support/mcp-fixture.js"
import { CODEX_RESPONSES_URL, finalTextResponse } from "./support/mock-codex.js"

test.setTimeout(90_000)

const COMMANDS = [
  "/new",
  "/resume",
  "/tree",
  "/name blocked-title",
  "/settings",
  "/login",
  "/logout",
]

type SavedSession = { id: string; title: string; messages: unknown[] }
type ProbeWindow = Window & {
  commandPermissions: chrome.permissions.Permissions[]
  commandMethods: string[]
  commandGate?: { entered: boolean; release: () => void }
  finishGate?: { entered: boolean; release: () => void }
}

async function send(page: Page, draft: string): Promise<void> {
  await page.locator("#prompt").fill(draft)
  // Enter first accepts a completion. Send always dispatches the submitted draft.
  await page.locator("#send").click()
}

async function pastePng(page: Page): Promise<void> {
  await page.locator("#prompt").evaluate((target) => {
    const bytes = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nL8AAAAASUVORK5CYII=",
      ),
      (character) => character.charCodeAt(0),
    )
    const clipboard = new DataTransfer()
    clipboard.items.add(new File([bytes], "clipboard.png", { type: "image/png" }))
    target.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }),
    )
  })
}

async function activeSession(page: Page): Promise<string> {
  return page.locator("#sessions").inputValue()
}

async function savedSessions(page: Page): Promise<SavedSession[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("pi-browser-agent-sessions", 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<SavedSession[]>((resolve, reject) => {
        const request = database
          .transaction("sessions", "readonly")
          .objectStore("sessions")
          .getAll()
        request.onsuccess = () => resolve(request.result as SavedSession[])
        request.onerror = () => reject(request.error)
      })
    } finally {
      database.close()
    }
  })
}

async function probeLocalDispatch(harness: ExtensionHarness): Promise<string[]> {
  const network: string[] = []
  harness.context.on("request", (request) => {
    if (/^https?:/.test(request.url())) network.push(`${request.method()} ${request.url()}`)
  })
  await harness.controller.evaluate(() => {
    const state = window as unknown as ProbeWindow
    state.commandPermissions = []
    state.commandMethods = []
    const requestPermission = chrome.permissions.request.bind(chrome.permissions)
    chrome.permissions.request = (async (permissions) => {
      state.commandPermissions.push(permissions)
      return requestPermission(permissions)
    }) as typeof chrome.permissions.request
    const original = chrome.runtime.sendMessage.bind(chrome.runtime)
    chrome.runtime.sendMessage = ((message: { method?: string }) => {
      if (message.method) state.commandMethods.push(message.method)
      return original(message)
    }) as typeof chrome.runtime.sendMessage
  })
  return network
}

async function expectLocalOnly(harness: ExtensionHarness, network: string[]): Promise<void> {
  expect(network).toEqual([])
  expect(
    await harness.controller.evaluate(() => {
      const state = window as unknown as ProbeWindow
      return {
        permissions: state.commandPermissions,
        toolMethods: state.commandMethods.filter((method) =>
          /^(webmcp\.|page\.|browser\.)/.test(method),
        ),
      }
    }),
  ).toEqual({ permissions: [], toolMethods: [] })
  expect((await savedSessions(harness.controller)).flatMap((session) => session.messages)).toEqual(
    [],
  )
  await expect(harness.controller.locator("#transcript .message")).toHaveCount(0)
  expect(harness.pageErrors).toEqual([])
}

async function protectedPage(harness: ExtensionHarness): Promise<void> {
  await harness.fixturePage.goto("chrome://settings/", { waitUntil: "domcontentloaded" })
  await harness.fixturePage.bringToFront()
  await expect(harness.controller.locator("#page-status")).toContainText("cannot read or operate")
}

async function cancelLogin(page: Page, providerDialog = false): Promise<void> {
  await expect(page.locator("#auth-method-dialog")).toBeVisible()
  if (providerDialog) {
    await page.locator("#api-key-auth-method").click()
    await expect(page.locator("#auth-provider-dialog")).toBeVisible()
    await page.locator("#auth-provider-cancel").click()
  } else {
    await page.locator("#auth-method-dialog").press("Escape")
  }
  await expect(page.locator("#auth-method-dialog")).not.toBeVisible()
  await expect(page.locator("#send")).toBeEnabled()
}

test("runs local session commands without credentials on a protected page and persists titles", async () => {
  const harness = await launchExtensionHarness()
  try {
    await protectedPage(harness)
    const network = await probeLocalDispatch(harness)
    const first = await activeSession(harness.controller)
    await send(harness.controller, "  /name   First local session   ")
    await expect(harness.controller.locator("#session-trigger-label")).toHaveText(
      "First local session",
    )
    await expect(harness.controller.locator("#prompt")).toHaveValue("")
    await send(harness.controller, "/new")
    await expect.poll(() => activeSession(harness.controller)).not.toBe(first)
    const second = await activeSession(harness.controller)
    await send(harness.controller, `/name ${"x".repeat(121)}`)
    await expect(harness.controller.locator("#session-trigger-label")).toHaveText("x".repeat(120))
    await send(harness.controller, "/resume")
    await expect(harness.controller.locator("#session-menu")).toBeVisible()
    await expect(harness.controller.locator("#prompt")).toHaveValue("")
    await harness.controller.locator("#session-options [role=option]").first().press("Escape")
    expect(await activeSession(harness.controller)).toBe(second)
    await send(harness.controller, "/resume")
    await harness.controller.locator(`#session-options [data-value="${first}"]`).click()
    await expect.poll(() => activeSession(harness.controller)).toBe(first)
    await expect(harness.controller.locator("#session-trigger-label")).toHaveText(
      "First local session",
    )
    await expectLocalOnly(harness, network)
    await harness.controller.reload({ waitUntil: "domcontentloaded" })
    await waitForConversationReady(harness.controller)
    expect(await activeSession(harness.controller)).toBe(first)
    await expect(harness.controller.locator("#session-trigger-label")).toHaveText(
      "First local session",
    )
    expect(
      (await savedSessions(harness.controller)).find((session) => session.id === second)?.title,
    ).toBe("x".repeat(120))
  } finally {
    await harness.close()
  }
})

test("retains canceled and empty rename drafts and uses the existing name dialog", async () => {
  const harness = await launchExtensionHarness()
  try {
    const network = await probeLocalDispatch(harness)
    const original = await harness.controller.locator("#session-trigger-label").textContent()
    harness.controller.once("dialog", (dialog) => dialog.dismiss())
    await send(harness.controller, "/name")
    await expect(harness.controller.locator("#send")).toBeEnabled()
    await expect(harness.controller.locator("#prompt")).toHaveValue("/name")
    await expect(harness.controller.locator("#session-trigger-label")).toHaveText(original ?? "")
    harness.controller.once("dialog", (dialog) => dialog.accept("   "))
    await send(harness.controller, "/name")
    await expect(harness.controller.locator("#error")).not.toBeEmpty()
    await expect(harness.controller.locator("#prompt")).toHaveValue("/name")
    harness.controller.once("dialog", (dialog) => dialog.accept("Dialog title"))
    await send(harness.controller, "/name")
    await expect(harness.controller.locator("#session-trigger-label")).toHaveText("Dialog title")
    await expect(harness.controller.locator("#prompt")).toHaveValue("")
    await expectLocalOnly(harness, network)
  } finally {
    await harness.close()
  }
})

test("opens Settings with session context and cancels login locally on a denied site", async () => {
  const harness = await launchExtensionHarness()
  try {
    // The harness grants Chrome host access, but not the app's separate site approval.
    await expect(harness.controller.locator("#auth-status")).toHaveAttribute(
      "data-logged-in",
      "false",
    )
    await expect(harness.controller.locator("#page-status")).toContainText(
      "available with site access",
    )
    const session = await activeSession(harness.controller)
    const network = await probeLocalDispatch(harness)
    const settingsOpened = harness.context.waitForEvent("page")
    await send(harness.controller, "/settings")
    const settings = await settingsOpened
    await expect(settings).toHaveTitle("Settings · Pi Browser Agent")
    const url = new URL(settings.url())
    expect(url.searchParams.get("source")).toBeTruthy()
    expect(url.searchParams.get("modelProvider")).toBe("openai-codex")
    expect(url.searchParams.get("modelId")).toBeTruthy()
    expect(url.searchParams.get("thinkingLevel")).toBeTruthy()
    await expect(harness.controller.locator("#prompt")).toHaveValue("")
    await settings.getByRole("tab", { name: "Appearance", exact: true }).click()
    await settings.locator("#font-size").fill("24")
    const closed = settings.waitForEvent("close")
    await settings.locator("#save-settings").click()
    await closed
    await expect(harness.controller.locator("html")).toHaveAttribute("data-font-size", "24")
    expect(await activeSession(harness.controller)).toBe(session)
    for (const providerDialog of [false, true]) {
      await send(harness.controller, "/login")
      await cancelLogin(harness.controller, providerDialog)
      await expect(harness.controller.locator("#prompt")).toHaveValue("/login")
    }
    await send(harness.controller, "/logout")
    await expect(harness.controller.locator("#prompt")).toHaveValue("")
    await expect(harness.controller.locator("#auth-status")).toHaveAttribute(
      "data-logged-in",
      "false",
    )
    await expectLocalOnly(harness, network)
  } finally {
    await harness.close()
  }
})

test("logout removes only the selected provider credential without a provider request", async () => {
  const harness = await launchExtensionHarness()
  try {
    await configureMockCodex(harness)
    await harness.controller.evaluate(async () => {
      const key = "piBrowserAgentCredentialsV1"
      const stored = await chrome.storage.local.get(key)
      await chrome.storage.local.set({
        [key]: {
          ...(stored[key] as Record<string, unknown>),
          anthropic: { type: "api_key", key: "unselected-provider-secret" },
        },
      })
    })
    await expect(harness.controller.locator("#auth-status")).toHaveAttribute(
      "data-logged-in",
      "true",
    )
    const network = await probeLocalDispatch(harness)
    await send(harness.controller, "/logout")
    await expect(harness.controller.locator("#auth-status")).toHaveAttribute(
      "data-logged-in",
      "false",
    )
    await expect(harness.controller.locator("#prompt")).toHaveValue("")
    const credentials = await harness.controller.evaluate(
      async () =>
        (await chrome.storage.local.get("piBrowserAgentCredentialsV1"))
          .piBrowserAgentCredentialsV1 as Record<string, unknown>,
    )
    expect(credentials["openai-codex"]).toBeUndefined()
    expect(credentials.anthropic).toEqual({ type: "api_key", key: "unselected-provider-secret" })
    await send(harness.controller, "/logout")
    await expect(harness.controller.locator("#prompt")).toHaveValue("")
    await expectLocalOnly(harness, network)
  } finally {
    await harness.close()
  }
})

test("rejects unknown, argument-bearing and multiline commands before any prompt preflight", async () => {
  const harness = await launchExtensionHarness()
  try {
    await configureMockCodex(harness)
    const network = await probeLocalDispatch(harness)
    const session = await activeSession(harness.controller)
    for (const draft of [
      "/not-a-command private-argument",
      ...["new", "resume", "tree", "settings", "login", "logout"].map(
        (name) => `/${name} private-argument`,
      ),
      "/name private-argument\nsecond-line",
    ]) {
      await send(harness.controller, draft)
      await expect(harness.controller.locator("#error")).not.toBeEmpty()
      await expect(harness.controller.locator("#error")).not.toContainText("private-argument")
      await expect(harness.controller.locator("#prompt")).toHaveValue(draft)
      expect(await activeSession(harness.controller)).toBe(session)
      await expect(harness.controller.locator("dialog[open]")).toHaveCount(0)
    }
    await expectLocalOnly(harness, network)
  } finally {
    await harness.close()
  }
})

test("sends literal slash escapes, paths and ordinary text through normal provider submission", async () => {
  const harness = await launchExtensionHarness()
  try {
    await configureMockCodex(harness)
    await protectedPage(harness)
    const requests: unknown[] = []
    await harness.context.route(CODEX_RESPONSES_URL, async (route) => {
      requests.push(route.request().postDataJSON())
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: finalTextResponse(requests.length, `Answer ${requests.length}`),
      })
    })
    const drafts = [
      "//settings",
      "//name literal\nsecond line",
      "/tmp/file",
      "Explain /new without executing it",
      "Ordinary question",
    ]
    const sent = ["/settings", "/name literal\nsecond line", ...drafts.slice(2)]
    for (const [index, draft] of drafts.entries()) {
      await send(harness.controller, draft)
      await expect(harness.controller.locator("#transcript")).toContainText(`Answer ${index + 1}`)
      await expect(harness.controller.locator("#abort")).not.toBeVisible()
      await expect(harness.controller.locator("#prompt")).toHaveValue("")
      expect(JSON.stringify(requests[index])).toContain(JSON.stringify(sent[index]).slice(1, -1))
    }
    expect(requests).toHaveLength(drafts.length)
    expect(JSON.stringify(requests[0])).not.toContain("//settings")
    const messages = (await savedSessions(harness.controller)).flatMap(
      (session) => session.messages,
    )
    expect(JSON.stringify(messages)).toContain("/tmp/file")
    expect(JSON.stringify(messages)).not.toContain("//settings")
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("completion only fills drafts with keyboard and pointer input and fits 320px at font size 24", async () => {
  const harness = await launchExtensionHarness()
  try {
    const network = await probeLocalDispatch(harness)
    const page = harness.controller
    const session = await activeSession(page)
    const prompt = page.locator("#prompt")
    const menu = page.getByRole("listbox", { name: "Commands", exact: true })
    await page.setViewportSize({ width: 320, height: 720 })
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--app-font-size", "24px")
    })
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" })
      await prompt.fill("/")
      await expect(menu).toBeVisible()
      await expect(menu.getByRole("option")).toHaveCount(7)
      await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeFocused()
      await expect(prompt).not.toHaveAttribute("role")
      await expect(page.locator("#slash-command-menu-status")).toHaveAttribute("role", "status")
      await expect(page.locator("#slash-command-menu-status")).toHaveAttribute(
        "aria-atomic",
        "true",
      )
      await expect(prompt).toHaveAttribute("aria-describedby", /slash-command-menu-status/)
      await expect(page.locator("#slash-command-menu-status")).toContainText("Command list open")
      await expect(prompt).toHaveAttribute("aria-controls", "slash-command-menu")
      await expect(prompt).toHaveAttribute("aria-autocomplete", "list")
      await expect(menu.getByRole("option", { selected: true })).toHaveCount(1)
      const layout = await menu.evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        return {
          left: bounds.left,
          right: bounds.right,
          viewport: document.documentElement.clientWidth,
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          menuOverflow: element.scrollWidth > element.clientWidth,
        }
      })
      expect(layout.left).toBeGreaterThanOrEqual(0)
      expect(layout.right).toBeLessThanOrEqual(layout.viewport)
      expect(layout.overflow).toBe(false)
      expect(layout.menuOverflow).toBe(false)
      await prompt.press("ArrowUp")
      const optionBounds = await menu.getByRole("option", { selected: true }).boundingBox()
      const menuBounds = await menu.boundingBox()
      expect(optionBounds).not.toBeNull()
      expect(menuBounds).not.toBeNull()
      if (optionBounds && menuBounds) {
        expect(optionBounds.y).toBeGreaterThanOrEqual(menuBounds.y)
        expect(optionBounds.y + optionBounds.height).toBeLessThanOrEqual(
          menuBounds.y + menuBounds.height,
        )
      }
      await prompt.press("ArrowDown")
      await prompt.press("ArrowDown")
      const active = await prompt.getAttribute("aria-activedescendant")
      expect(active).toBeTruthy()
      await expect(page.locator(`[id="${active}"]`)).toHaveAttribute("aria-selected", "true")
      await prompt.press("Enter")
      await expect(prompt).toHaveValue("/resume ")
      await expect(prompt).toBeFocused()
      await expect(page.locator("#session-menu")).not.toBeVisible()
      expect(await activeSession(page)).toBe(session)
      await prompt.fill("/sett")
      await prompt.press("Tab")
      await expect(prompt).toHaveValue("/settings ")
      await expect(prompt).toBeFocused()
      expect(harness.context.pages()).toHaveLength(3)
      await prompt.fill("/log")
      await menu.getByRole("option").filter({ hasText: "/login" }).click()
      await expect(prompt).toHaveValue("/login ")
      await expect(prompt).toBeFocused()
      await expect(page.locator("dialog[open]")).toHaveCount(0)
      await prompt.fill("/new")
      await prompt.press("Escape")
      await expect(menu).not.toBeVisible()
      await expect(page.locator("#slash-command-menu-status")).toContainText("Command list closed")
      await expect(prompt).toHaveValue("/new")
      expect(await activeSession(page)).toBe(session)
    }
    await expectLocalOnly(harness, network)
  } finally {
    await harness.close()
  }
})

test("rejects every command during streaming without steering, follow-ups or menu Escape abort", async () => {
  const harness = await launchExtensionHarness()
  let release = () => {}
  try {
    await configureMockCodex(harness)
    await protectedPage(harness)
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const requests: unknown[] = []
    await harness.context.route(CODEX_RESPONSES_URL, async (route) => {
      requests.push(route.request().postDataJSON())
      await gate
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: finalTextResponse(1, "Only the original turn finished."),
      })
    })
    const session = await activeSession(harness.controller)
    await send(harness.controller, "Keep this original turn running")
    await expect.poll(() => requests.length).toBe(1)
    await expect(harness.controller.locator("#abort")).toBeVisible()
    const pages = harness.context.pages().length
    for (const draft of COMMANDS) {
      await send(harness.controller, draft)
      await expect(harness.controller.locator("#error")).toContainText("Wait")
      await expect(harness.controller.locator("#prompt")).toHaveValue(draft)
      await expect(harness.controller.locator("#abort")).toBeVisible()
      await harness.controller.locator("#queue-instruction").click()
      await expect(harness.controller.locator("#error")).toContainText("cannot be queued")
      expect(await activeSession(harness.controller)).toBe(session)
      await expect(harness.controller.locator("dialog[open]")).toHaveCount(0)
    }
    await harness.controller.locator("#prompt").fill("/new")
    await expect(harness.controller.locator("#slash-command-menu")).toBeVisible()
    await harness.controller.locator("#prompt").press("Escape")
    await expect(harness.controller.locator("#slash-command-menu")).not.toBeVisible()
    await expect(harness.controller.locator("#abort")).toBeVisible()
    expect(harness.context.pages()).toHaveLength(pages)
    release()
    await expect(harness.controller.locator("#transcript")).toContainText(
      "Only the original turn finished.",
    )
    await expect(harness.controller.locator("#abort")).not.toBeVisible()
    expect(requests).toHaveLength(1)
    expect(
      JSON.stringify(
        (await savedSessions(harness.controller)).flatMap((record) => record.messages),
      ),
    ).not.toContain("blocked-title")
    await expect(harness.controller.locator("#transcript")).not.toContainText("/new")
    await expect(harness.controller.locator("#prompt")).toHaveValue("/new")
    expect(harness.pageErrors).toEqual([])
  } finally {
    release()
    await harness.close()
  }
})

test("retains images and selected-element chips when a command is rejected", async () => {
  const harness = await launchExtensionHarness()
  try {
    await configureMockCodex(harness)
    const network = await probeLocalDispatch(harness)
    await pastePng(harness.controller)
    await expect(harness.controller.locator("#pasted-images img")).toHaveCount(1)
    for (const draft of COMMANDS) {
      await send(harness.controller, draft)
      await expect(harness.controller.locator("#error")).toContainText(
        "Remove images and selected elements",
      )
      await expect(harness.controller.locator("#prompt")).toHaveValue(draft)
      await expect(harness.controller.locator("#pasted-images img")).toHaveCount(1)
    }
    expect(
      await harness.controller.evaluate(
        () => (window as unknown as ProbeWindow).commandPermissions,
      ),
    ).toEqual([])
    await harness.controller.locator("#pasted-images button").click()
    await harness.controller.locator("#element-picker").click()
    await expect(harness.fixturePage.locator("[data-pi-browser-agent-element-picker]")).toHaveCount(
      1,
    )
    const bounds = await harness.fixturePage.locator("#complete").boundingBox()
    if (!bounds) throw new Error("Missing fixture element bounds")
    await harness.fixturePage.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await expect(harness.controller.locator(".selected-element-chip")).toHaveCount(1)
    await harness.controller.locator("#prompt").press("Escape")
    await harness.controller.evaluate(() => {
      ;(window as unknown as ProbeWindow).commandPermissions = []
    })
    for (const draft of COMMANDS) {
      await send(harness.controller, draft)
      await expect(harness.controller.locator("#error")).toContainText(
        "Remove images and selected elements",
      )
      await expect(harness.controller.locator("#prompt")).toHaveValue(draft)
      await expect(harness.controller.locator(".selected-element-chip")).toHaveCount(1)
    }
    expect(network).toEqual([])
    expect(
      await harness.controller.evaluate(
        () => (window as unknown as ProbeWindow).commandPermissions,
      ),
    ).toEqual([])
    expect((await savedSessions(harness.controller)).flatMap((record) => record.messages)).toEqual(
      [],
    )
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("blocks pending image processing and rechecks attachments before async command acceptance", async () => {
  const harness = await launchExtensionHarness()
  try {
    await configureMockCodex(harness)
    const network = await probeLocalDispatch(harness)
    const session = await activeSession(harness.controller)
    await harness.controller.evaluate(() => {
      const original = Blob.prototype.arrayBuffer
      const state = window as unknown as ProbeWindow
      let release = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      state.commandGate = { entered: false, release }
      Blob.prototype.arrayBuffer = async function () {
        Blob.prototype.arrayBuffer = original
        if (state.commandGate) state.commandGate.entered = true
        await gate
        return original.call(this)
      }
    })
    await pastePng(harness.controller)
    await expect
      .poll(() =>
        harness.controller.evaluate(() => (window as unknown as ProbeWindow).commandGate?.entered),
      )
      .toBe(true)
    await expect(harness.controller.locator("#send")).toBeDisabled()
    await harness.controller.locator("#prompt").fill("/new")
    await harness.controller.locator("#prompt").press("Escape")
    await harness.controller.locator("#prompt").press("Enter")
    await expect(harness.controller.locator("#error")).toContainText("Wait")
    expect(await activeSession(harness.controller)).toBe(session)
    await releaseCommandGate(harness.controller)
    await expect(harness.controller.locator("#pasted-images img")).toHaveCount(1)
    await expect(harness.controller.locator("#prompt")).toHaveValue("/new")
    await harness.controller.locator("#pasted-images button").click()

    const pages = harness.context.pages().length
    await gateSettingsQuery(harness.controller)
    await send(harness.controller, "/settings")
    await expect
      .poll(() =>
        harness.controller.evaluate(() => (window as unknown as ProbeWindow).commandGate?.entered),
      )
      .toBe(true)
    await pastePng(harness.controller)
    await expect(harness.controller.locator("#pasted-images img")).toHaveCount(1)
    await releaseCommandGate(harness.controller)
    await expect(harness.controller.locator("#error")).toContainText(
      "Remove images and selected elements",
    )
    await expect(harness.controller.locator("#prompt")).toHaveValue("/settings")
    await expect(harness.controller.locator("#pasted-images img")).toHaveCount(1)
    expect(harness.context.pages()).toHaveLength(pages)
    expect(await activeSession(harness.controller)).toBe(session)
    await expectLocalOnly(harness, network)
  } finally {
    await releaseCommandGate(harness.controller).catch(() => undefined)
    await harness.close()
  }
})

async function gateSettingsQuery(page: Page): Promise<void> {
  await page.evaluate(() => {
    const original = chrome.tabs.query.bind(chrome.tabs)
    const state = window as unknown as ProbeWindow
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    state.commandGate = { entered: false, release }
    chrome.tabs.query = (async (query) => {
      chrome.tabs.query = original
      if (state.commandGate) state.commandGate.entered = true
      await gate
      return original(query)
    }) as typeof chrome.tabs.query
  })
}

async function releaseCommandGate(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as ProbeWindow).commandGate?.release())
}

test("serializes duplicate commands and preserves edits while Settings awaits tab lookup", async () => {
  const harness = await launchExtensionHarness()
  try {
    const network = await probeLocalDispatch(harness)
    const pages = harness.context.pages().length
    await gateSettingsQuery(harness.controller)
    await send(harness.controller, "/settings")
    await expect
      .poll(() =>
        harness.controller.evaluate(() => (window as unknown as ProbeWindow).commandGate?.entered),
      )
      .toBe(true)
    await expect(harness.controller.locator("#new-session")).toBeDisabled()
    await expect(harness.controller.locator("#session-trigger")).toBeDisabled()
    // The normal Send control is disabled. A second keyboard submission must also be guarded.
    await harness.controller.locator("#prompt").press("Escape")
    await harness.controller.locator("#prompt").press("Enter")
    await expect(harness.controller.locator("#error")).toContainText("Wait")
    await harness.controller.locator("#prompt").fill("New draft typed while the command waits")
    const opened = harness.context.waitForEvent("page")
    await releaseCommandGate(harness.controller)
    const settings = await opened
    await expect(settings).toHaveTitle("Settings · Pi Browser Agent")
    await expect(harness.controller.locator("#send")).toBeEnabled()
    await expect(harness.controller.locator("#prompt")).toHaveValue(
      "New draft typed while the command waits",
    )
    expect(harness.context.pages()).toHaveLength(pages + 1)
    await settings.close()
    await expectLocalOnly(harness, network)
  } finally {
    await releaseCommandGate(harness.controller).catch(() => undefined)
    await harness.close()
  }
})

test("rejects commands while an ordinary prompt waits for permission preflight", async () => {
  const harness = await launchExtensionHarness()
  try {
    await configureMockCodex(harness)
    await harness.controller.evaluate(async () => {
      await chrome.storage.local.set({ piBrowserAgentApprovedHostPermissions: [] })
      const state = window as unknown as ProbeWindow
      let release = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      state.commandGate = { entered: false, release }
      chrome.permissions.request = (async () => {
        if (state.commandGate) state.commandGate.entered = true
        await gate
        return false
      }) as typeof chrome.permissions.request
    })
    const network: string[] = []
    harness.context.on("request", (request) => {
      if (request.url() === CODEX_RESPONSES_URL) network.push(request.url())
    })
    const session = await activeSession(harness.controller)
    await send(harness.controller, "Original pending prompt")
    await expect
      .poll(() =>
        harness.controller.evaluate(() => (window as unknown as ProbeWindow).commandGate?.entered),
      )
      .toBe(true)
    await harness.controller.locator("#prompt").fill("/new")
    await harness.controller.locator("#prompt").press("Escape")
    await harness.controller.locator("#prompt").press("Enter")
    await expect(harness.controller.locator("#error")).toContainText("Wait")
    expect(await activeSession(harness.controller)).toBe(session)
    await releaseCommandGate(harness.controller)
    await expect(harness.controller.locator("#send")).toBeEnabled()
    await expect(harness.controller.locator("#prompt")).toHaveValue("/new")
    expect(network).toEqual([])
    expect((await savedSessions(harness.controller)).flatMap((record) => record.messages)).toEqual(
      [],
    )
  } finally {
    await releaseCommandGate(harness.controller).catch(() => undefined)
    await harness.close()
  }
})

test("rejects commands during remote MCP preparation and finalization without replay", async () => {
  const fixture = await startMcpFixture()
  const harness = await launchExtensionHarness({ browserArgs: fixture.browserArgs })
  try {
    await configureMockCodex(harness)
    const settings = await harness.context.newPage()
    await settings.goto(`${harness.controller.url()}?view=settings`)
    await settings.getByRole("tab", { name: "MCP", exact: true }).click()
    await settings.locator("#mcp-name").fill("Slash command fixture")
    await settings.locator("#mcp-endpoint").fill(fixture.endpoint)
    await settings.locator("#mcp-save").click()
    await expect(settings.locator("#mcp-status")).toContainText("Saved disconnected")
    const permissions = await harness.context.newPage()
    await permissions.goto("chrome://extensions/")
    await permissions.evaluate(async (id) => {
      const api = chrome as unknown as {
        developerPrivate: { addHostPermission(id: string, host: string): Promise<void> }
      }
      await api.developerPrivate.addHostPermission(id, "https://mcp.e2e.example.com/*")
    }, harness.extensionId)
    await permissions.close()
    await settings.locator("#mcp-connect").click()
    await expect(settings.locator("#mcp-status")).toContainText(
      "Enabled for new runs. Tool metadata and results can go to the selected model.",
    )
    await settings.close()
    await protectedPage(harness)
    await harness.controller.evaluate((endpoint) => {
      const state = window as unknown as ProbeWindow
      const original = window.fetch.bind(window)
      let releasePreparation = () => {}
      let releaseFinish = () => {}
      const preparation = new Promise<void>((resolve) => {
        releasePreparation = resolve
      })
      const finish = new Promise<void>((resolve) => {
        releaseFinish = resolve
      })
      state.commandGate = { entered: false, release: releasePreparation }
      state.finishGate = { entered: false, release: releaseFinish }
      window.fetch = async (input, init) => {
        if (String(input) === endpoint) {
          if (init?.method === "POST" && String(init.body).includes('"method":"initialize"')) {
            if (state.commandGate) state.commandGate.entered = true
            await preparation
          }
          if (init?.method === "DELETE") {
            if (state.finishGate) state.finishGate.entered = true
            await finish
          }
        }
        return original(input, init)
      }
    }, fixture.endpoint)
    const requests: unknown[] = []
    await harness.context.route(CODEX_RESPONSES_URL, async (route) => {
      requests.push(route.request().postDataJSON())
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: finalTextResponse(1, "MCP lifecycle turn complete"),
      })
    })
    const session = await activeSession(harness.controller)
    await send(harness.controller, "Original lifecycle prompt")
    await expect
      .poll(() =>
        harness.controller.evaluate(() => (window as unknown as ProbeWindow).commandGate?.entered),
      )
      .toBe(true)
    await harness.controller.locator("#prompt").fill("/new")
    await harness.controller.locator("#prompt").press("Escape")
    await harness.controller.locator("#prompt").press("Enter")
    await expect(harness.controller.locator("#error")).toContainText("Wait")
    expect(requests).toHaveLength(0)
    expect(await activeSession(harness.controller)).toBe(session)
    await releaseCommandGate(harness.controller)
    await expect
      .poll(() =>
        harness.controller.evaluate(() => (window as unknown as ProbeWindow).finishGate?.entered),
      )
      .toBe(true)
    // Cleanup has a bounded two-second timeout. Test one mutation inside that window;
    // every command is tested during streaming above.
    await send(harness.controller, "/new")
    await expect(harness.controller.locator("#error")).toContainText("Wait")
    await expect(harness.controller.locator("#prompt")).toHaveValue("/new")
    expect(await activeSession(harness.controller)).toBe(session)
    await harness.controller.evaluate(() =>
      (window as unknown as ProbeWindow).finishGate?.release(),
    )
    await expect(harness.controller.locator("#abort")).not.toBeVisible()
    expect(requests).toHaveLength(1)
    expect(
      fixture.requests.filter((request) => request.message?.method === "tools/call"),
    ).toHaveLength(0)
    expect(JSON.stringify(fixture.requests)).not.toContain("blocked-title")
    expect(
      JSON.stringify(
        (await savedSessions(harness.controller)).flatMap((record) => record.messages),
      ),
    ).not.toContain("blocked-title")
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.controller
      .evaluate(() => {
        const state = window as unknown as ProbeWindow
        state.commandGate?.release()
        state.finishGate?.release()
      })
      .catch(() => undefined)
    await harness.close()
    await fixture.close()
  }
})
