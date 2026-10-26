import { readFileSync } from "node:fs"
import type { AuthType } from "@earendil-works/pi-ai"
import { JSDOM } from "jsdom"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { BrowserAgentRuntime, RuntimeCallbacks } from "../../src/browser/agent/runtime.js"
import type { BrowserConfiguration } from "../../src/browser/configuration.js"
import { requestHostPermissions } from "../../src/browser/permissions.js"
import type { RuntimeRequest } from "../../src/browser/runtime/messages.js"
import { initializeConversationPage } from "../../src/browser/sidepanel/conversation-page.js"

const { createRuntime } = vi.hoisted(() => ({ createRuntime: vi.fn() }))

vi.mock("../../src/browser/agent/runtime.js", () => ({
  BrowserAgentRuntime: vi.fn(function MockBrowserAgentRuntime(callbacks: RuntimeCallbacks) {
    return createRuntime(callbacks)
  }),
}))
vi.mock("../../src/browser/permissions.js", () => ({
  BOOKMARKS_PERMISSION: "bookmarks",
  SCREENSHOT_HOST_PERMISSION: "<all_urls>",
  hasApprovedHostPermission: vi.fn(async () => true),
  hasHostPermissions: vi.fn(async () => true),
  requestBookmarkPermission: vi.fn(async () => true),
  requestHostPermission: vi.fn(async () => true),
  requestHostPermissions: vi.fn(async () => true),
  requestScreenshotPermission: vi.fn(async () => true),
}))
vi.mock("../../src/browser/sidepanel/voice-input.js", () => ({
  createVoiceInput: () => undefined,
  getMicrophonePermissionState: vi.fn(),
}))
vi.mock("../../src/browser/sidepanel/message-rendering.js", () => ({
  TranscriptRenderer: class {
    render() {}
  },
}))
vi.mock("../../src/browser/sidepanel/screenshot-annotation.js", () => ({
  ScreenshotAnnotationController: class {
    close() {}
  },
}))
vi.mock("../../src/browser/sidepanel/element-picker-shortcut.js", () => ({
  assignedPickerShortcut: async () => "",
  connectElementPickerShortcut: async () => () => {},
  pickerButtonTitle: () => "Select page element",
}))

const html = readFileSync(
  new URL("../../src/browser/sidepanel/index.html", import.meta.url),
  "utf8",
)
const windows: JSDOM[] = []
const pageUrl = "https://example.com/article"
const endpoint = "https://api.anthropic.com/v1/messages"

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Deferred promise is not initialized")
  }
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

afterEach(() => {
  for (const dom of windows.splice(0)) {
    dom.window.dispatchEvent(new dom.window.Event("pagehide"))
    dom.window.close()
  }
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

async function setup() {
  const dom = new JSDOM(html, { url: "https://extension.test/sidepanel/index.html" })
  windows.push(dom)
  vi.stubGlobal("window", dom.window)
  vi.stubGlobal("document", dom.window.document)
  vi.stubGlobal("Node", dom.window.Node)
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  dom.window.HTMLDialogElement.prototype.close = function (value = "") {
    this.returnValue = value
    this.open = false
    this.dispatchEvent(new dom.window.Event("close"))
  }
  const tabs = {
    query: vi.fn(async () => [{ id: 7 }]),
    create: vi.fn(async (_properties: chrome.tabs.CreateProperties) => ({})),
  }
  const sendMessage = vi.fn(async (request: RuntimeRequest) => ({
    ok: true,
    result:
      request.method === "app.getState"
        ? {
            tabContext: { tabId: 7, url: pageUrl, epoch: 1 },
            page: { kind: "web", title: "Example" },
          }
        : null,
  }))
  vi.stubGlobal("chrome", {
    tabs,
    windows: { getCurrent: vi.fn(async () => ({ id: 1 })) },
    runtime: { sendMessage, onMessage: { addListener: vi.fn() } },
    permissions: { onRemoved: { addListener: vi.fn() } },
    storage: {
      local: { get: vi.fn(async () => ({})) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  })
  const configuration = {
    appSettings: { fontFamily: "system", fontSize: 14, confirmationMode: "always" },
    isChangingAuth: false,
    getProviders: vi.fn((type?: AuthType) =>
      type === "oauth"
        ? []
        : [
            {
              id: "anthropic",
              name: "Anthropic",
              authMethods: [{ type: "api_key", label: "API key" }],
            },
          ],
    ),
    authStatus: vi
      .fn<BrowserConfiguration["authStatus"]>()
      .mockResolvedValue({ loggedIn: true, type: "api_key" }),
    requiredModelEndpointUrls: vi.fn(async () => [endpoint]),
    login: vi.fn<BrowserConfiguration["login"]>().mockResolvedValue(undefined),
    logout: vi.fn<BrowserConfiguration["logout"]>().mockResolvedValue(undefined),
    credentials: {
      read: vi
        .fn<BrowserConfiguration["credentials"]["read"]>()
        .mockResolvedValue({ type: "api_key", key: "test-key" }),
    },
  }
  let callbacks: RuntimeCallbacks
  const runtime = {
    configuration,
    activeSession: { id: "current", title: "Current session" },
    model: { provider: "anthropic", id: "test-model", input: ["text", "image"] },
    agent: { state: { messages: [], isStreaming: false, thinkingLevel: "off" } },
    isPreparing: false,
    busy: false,
    get isBusy() {
      return this.busy || this.isPreparing || this.agent.state.isStreaming
    },
    usesPageContext: true,
    initialize: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    listSessions: vi.fn(async () => [
      { id: "current", title: "Current session" },
      { id: "saved", title: "Saved session" },
    ]),
    newSession: vi.fn(async () => {}),
    resumeSession: vi.fn(async (_id: string) => {}),
    renameSession: vi.fn(async (_title: string) => {}),
    getSessionTree: vi.fn(() => ({
      version: 1 as const,
      nodes: [
        {
          id: "request",
          parentId: null,
          message: { role: "user" as const, content: "Restored request", timestamp: 1 },
        },
      ],
      activeLeafId: "request",
    })),
    previewTreeSelection: vi.fn((_id: string | null) => ({ text: "Restored request", images: [] })),
    navigateTree: vi
      .fn<BrowserAgentRuntime["navigateTree"]>()
      .mockImplementation(async (_id, accept) => {
        accept?.()
        return { text: "Restored request", images: [] }
      }),
    submit: vi.fn<BrowserAgentRuntime["submit"]>().mockImplementation(async () => {
      callbacks.onAgentEvent({ type: "agent_start" })
      return "prompt"
    }),
  }
  createRuntime.mockImplementation((value: RuntimeCallbacks) => {
    callbacks = value
    return runtime
  })
  vi.mocked(requestHostPermissions).mockResolvedValue(true)
  await initializeConversationPage(new URLSearchParams("source=routing-test"))
  expect(document.body.dataset.conversationReady).toBe("true")
  configuration.authStatus.mockClear()
  sendMessage.mockClear()

  function element<T extends HTMLElement>(id: string): T {
    const value = document.getElementById(id)
    if (!value) throw new Error(`Missing test element: ${id}`)
    return value as T
  }
  const input = element<HTMLTextAreaElement>("prompt")
  const error = element<HTMLElement>("error")
  function send(text: string) {
    input.value = text
    element<HTMLButtonElement>("send").click()
  }
  function enter(altKey = false) {
    input.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Enter", altKey, bubbles: true }),
    )
  }
  function expectNoRun() {
    expect(runtime.submit).not.toHaveBeenCalled()
    expect(configuration.requiredModelEndpointUrls).not.toHaveBeenCalled()
    expect(requestHostPermissions).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
  }
  async function idle() {
    await vi.waitFor(() => expect(element<HTMLButtonElement>("send").disabled).toBe(false))
  }
  return {
    dom,
    runtime,
    configuration,
    tabs,
    input,
    error,
    element,
    send,
    enter,
    idle,
    expectNoRun,
  }
}

describe("initializeConversationPage slash-command routing", () => {
  test("opens Settings from current model and thinking state after tab lookup", async () => {
    const ui = await setup()
    const gate = deferred<{ id: number }[]>()
    ui.tabs.query.mockReturnValueOnce(gate.promise)
    ui.send("/settings")
    ui.runtime.model.id = "updated-model"
    ui.runtime.agent.state.thinkingLevel = "high"
    gate.resolve([{ id: 7 }])
    await ui.idle()
    const created = ui.tabs.create.mock.calls[0]?.[0] as { url: string } | undefined
    expect(created).toBeDefined()
    const url = new URL(created?.url ?? "")
    expect(url.searchParams.get("modelId")).toBe("updated-model")
    expect(url.searchParams.get("thinkingLevel")).toBe("high")
    ui.expectNoRun()
  })

  test.each(["/new", "ordinary prompt"])("IME commit never executes or sends %s", async (text) => {
    const ui = await setup()
    ui.input.value = text
    ui.input.dispatchEvent(new ui.dom.window.CompositionEvent("compositionstart"))
    ui.enter()
    ui.input.dispatchEvent(
      new ui.dom.window.KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true }),
    )
    await Promise.resolve()
    expect(ui.runtime.newSession).not.toHaveBeenCalled()
    ui.expectNoRun()
    expect(ui.input.value).toBe(text)
  })

  test.each(["new", "name", "settings", "resume", "tree", "login", "logout"])(
    "/%s executes its local action without prompt preflight or runtime submission",
    async (command) => {
      const ui = await setup()
      ui.send(command === "name" ? "/name Routing title" : `/${command}`)
      switch (command) {
        case "new":
          await vi.waitFor(() => expect(ui.runtime.newSession).toHaveBeenCalledOnce())
          break
        case "name":
          await vi.waitFor(() =>
            expect(ui.runtime.renameSession).toHaveBeenCalledWith("Routing title"),
          )
          break
        case "settings":
          await vi.waitFor(() => expect(ui.tabs.create).toHaveBeenCalledOnce())
          expect(ui.tabs.create).toHaveBeenCalledWith({
            url: expect.stringContaining("view=settings"),
            openerTabId: 7,
          })
          break
        case "resume":
          expect(ui.element<HTMLElement>("session-menu").hidden).toBe(false)
          ui.element<HTMLButtonElement>("session-options-option-1").click()
          await vi.waitFor(() => expect(ui.runtime.resumeSession).toHaveBeenCalledWith("saved"))
          break
        case "tree":
          expect(ui.element<HTMLDialogElement>("session-tree-dialog").open).toBe(true)
          expect(ui.runtime.navigateTree).not.toHaveBeenCalled()
          ui.element<HTMLButtonElement>("session-tree-cancel").click()
          break
        case "login":
          expect(ui.element<HTMLDialogElement>("auth-method-dialog").open).toBe(true)
          ui.element<HTMLDialogElement>("auth-method-dialog").close("api_key")
          await vi.waitFor(() =>
            expect(ui.element<HTMLDialogElement>("auth-provider-dialog").open).toBe(true),
          )
          ui.element<HTMLDialogElement>("auth-provider-dialog").close("confirm")
          await vi.waitFor(() =>
            expect(ui.configuration.login).toHaveBeenCalledWith(
              "anthropic",
              "api_key",
              expect.any(AbortSignal),
              expect.any(Function),
            ),
          )
          break
        case "logout":
          await vi.waitFor(() => expect(ui.configuration.logout).toHaveBeenCalledWith("anthropic"))
          break
      }
      await vi.waitFor(() => expect(ui.input.value).toBe(""))
      ui.expectNoRun()
      // Session creation/resume and authentication refresh the credential UI, not run access.
      if (command === "settings" || command === "name" || command === "tree") {
        expect(ui.configuration.authStatus).not.toHaveBeenCalled()
      } else {
        expect(ui.configuration.authStatus).toHaveBeenCalledOnce()
      }
    },
  )

  test("tree selection restores an editable user draft without a model submission", async () => {
    const ui = await setup()
    ui.send("/tree")
    await ui.idle()
    ui.element<HTMLElement>("session-tree-list")
      .querySelector<HTMLButtonElement>('[data-node-id="request"]')
      ?.click()
    await vi.waitFor(() =>
      expect(ui.runtime.navigateTree).toHaveBeenCalledWith("request", expect.any(Function)),
    )
    await vi.waitFor(() => expect(ui.input.value).toBe("Restored request"))
    await vi.waitFor(() =>
      expect(ui.element<HTMLDialogElement>("session-tree-dialog").open).toBe(false),
    )
    ui.expectNoRun()
  })

  test("restored slash-prefixed user text is resent to the model, not dispatched locally", async () => {
    const ui = await setup()
    ui.runtime.navigateTree.mockResolvedValueOnce({ text: "/logout", images: [] })
    ui.send("/tree")
    await ui.idle()
    ui.element<HTMLElement>("session-tree-list")
      .querySelector<HTMLButtonElement>('[data-node-id="request"]')
      ?.click()
    await vi.waitFor(() =>
      expect(ui.element<HTMLDialogElement>("session-tree-dialog").open).toBe(false),
    )
    expect(ui.input.value).toBe("//logout")
    ui.expectNoRun()
    ui.send(ui.input.value)
    await vi.waitFor(() =>
      expect(ui.runtime.submit).toHaveBeenCalledWith("/logout", "steer", [], [], true),
    )
    expect(ui.configuration.logout).not.toHaveBeenCalled()
  })

  test("a stale or edited tree dialog cannot replace an unsent draft", async () => {
    const ui = await setup()
    ui.send("/tree")
    await ui.idle()
    ui.input.value = "A newer draft"
    ui.element<HTMLElement>("session-tree-list")
      .querySelector<HTMLButtonElement>('[data-node-id="request"]')
      ?.click()
    await vi.waitFor(() =>
      expect(ui.element<HTMLElement>("session-tree-error").textContent).toContain("unsent draft"),
    )
    expect(ui.runtime.navigateTree).not.toHaveBeenCalled()
    expect(ui.input.value).toBe("A newer draft")
    ui.element<HTMLButtonElement>("session-tree-cancel").click()
    ui.input.value = ""
    ui.send("/tree")
    await ui.idle()
    ui.runtime.activeSession.id = "another-session"
    ui.element<HTMLElement>("session-tree-list")
      .querySelector<HTMLButtonElement>('[data-node-id="request"]')
      ?.click()
    await vi.waitFor(() =>
      expect(ui.element<HTMLElement>("session-tree-error").textContent).toContain(
        "conversation changed",
      ),
    )
    expect(ui.runtime.navigateTree).not.toHaveBeenCalled()
    ui.expectNoRun()
  })

  test("tree write failures keep the modal and original composer", async () => {
    const ui = await setup()
    ui.runtime.navigateTree.mockRejectedValueOnce(new Error("Unable to save branch"))
    ui.send("/tree")
    await ui.idle()
    ui.element<HTMLElement>("session-tree-list")
      .querySelector<HTMLButtonElement>('[data-node-id="request"]')
      ?.click()
    await vi.waitFor(() =>
      expect(ui.element<HTMLElement>("session-tree-error").textContent).toContain(
        "Unable to save branch",
      ),
    )
    expect(ui.element<HTMLDialogElement>("session-tree-dialog").open).toBe(true)
    expect(ui.input.value).toBe("")
    ui.expectNoRun()
  })

  test.each([
    ["/unknown private-argument", "Unknown slash command."],
    ["/settings private-argument", "This slash command does not accept arguments."],
    ["/name title\nprivate-argument", "Slash commands must use a single line."],
  ])("rejects %j without echoing arguments or reading credentials", async (draft, message) => {
    const ui = await setup()
    ui.send(draft)
    expect(ui.error.textContent).toBe(message)
    expect(ui.error.textContent).not.toContain("private-argument")
    expect(ui.input.value).toBe(draft)
    expect(ui.configuration.authStatus).not.toHaveBeenCalled()
    ui.expectNoRun()
  })

  test("rejects queued commands through the queue button and Alt+Enter", async () => {
    const ui = await setup()
    ui.input.value = "/new"
    for (const submit of [
      () => ui.element<HTMLButtonElement>("queue-instruction").click(),
      () => ui.enter(true),
    ]) {
      submit()
      expect(ui.error.textContent).toBe(
        "Commands cannot be queued. Use Send when the conversation is idle.",
      )
      expect(ui.input.value).toBe("/new")
    }
    expect(ui.runtime.newSession).not.toHaveBeenCalled()
    expect(ui.configuration.authStatus).not.toHaveBeenCalled()
    ui.expectNoRun()
  })

  test.each([
    ["  //settings  ", "/settings"],
    ["//unknown private-argument", "/unknown private-argument"],
    ["/tmp/file.txt", "/tmp/file.txt"],
    ["/settings/path", "/settings/path"],
  ])("routes literal/path %j through normal auth and access preflight", async (draft, text) => {
    const ui = await setup()
    ui.send(draft)
    await vi.waitFor(() =>
      expect(ui.runtime.submit).toHaveBeenCalledWith(text, "steer", [], [], true),
    )
    expect(ui.runtime.submit).toHaveBeenCalledOnce()
    expect(ui.configuration.authStatus).toHaveBeenCalledExactlyOnceWith("anthropic")
    expect(ui.configuration.requiredModelEndpointUrls).toHaveBeenCalledOnce()
    expect(requestHostPermissions).toHaveBeenCalledExactlyOnceWith([pageUrl, endpoint])
    expect(ui.configuration.authStatus.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(requestHostPermissions).mock.invocationCallOrder[0] ?? 0,
    )
    expect(vi.mocked(requestHostPermissions).mock.invocationCallOrder[0]).toBeLessThan(
      ui.runtime.submit.mock.invocationCallOrder[0] ?? 0,
    )
    expect(ui.tabs.create).not.toHaveBeenCalled()
    expect(ui.input.value).toBe("")
  })

  test.each(["streaming", "preparing", "busy", "auth-changing"])(
    "retains a command rejected while %s",
    async (state) => {
      const ui = await setup()
      ui.runtime.agent.state.isStreaming = state === "streaming"
      ui.runtime.isPreparing = state === "preparing"
      ui.runtime.busy = state === "busy"
      ui.configuration.isChangingAuth = state === "auth-changing"
      ui.send("/new")
      await vi.waitFor(() =>
        expect(ui.error.textContent).toBe(
          "Wait for the current operation to finish before using a command",
        ),
      )
      expect(ui.input.value).toBe("/new")
      expect(ui.runtime.newSession).not.toHaveBeenCalled()
      expect(ui.configuration.authStatus).not.toHaveBeenCalled()
      ui.expectNoRun()
    },
  )

  test("retains a pasted PNG and command when attachments block local commands", async () => {
    const ui = await setup()
    const png = new File(
      [
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
          "base64",
        ),
      ],
      "pixel.png",
      { type: "image/png" },
    )
    const paste = new ui.dom.window.Event("paste", { cancelable: true })
    Object.defineProperty(paste, "clipboardData", {
      value: { items: [{ kind: "file", type: png.type, getAsFile: () => png }] },
    })
    ui.input.dispatchEvent(paste)
    await ui.idle()
    const images = ui.element<HTMLElement>("pasted-images")
    expect(images.querySelectorAll("img")).toHaveLength(1)
    ui.send("/settings")
    await vi.waitFor(() =>
      expect(ui.error.textContent).toBe(
        "Remove images and selected elements before using a command",
      ),
    )
    expect(ui.input.value).toBe("/settings")
    expect(images.querySelectorAll("img")).toHaveLength(1)
    expect(ui.tabs.query).not.toHaveBeenCalled()
    expect(ui.configuration.authStatus).not.toHaveBeenCalled()
    ui.expectNoRun()
  })

  test("blocks duplicate in-flight commands and retains a changed draft after acceptance", async () => {
    const ui = await setup()
    const gate = deferred<Array<{ id: number }>>()
    ui.tabs.query.mockReturnValueOnce(gate.promise)
    ui.send("/settings")
    expect(ui.tabs.query).toHaveBeenCalledOnce()
    ui.enter()
    await vi.waitFor(() =>
      expect(ui.error.textContent).toBe(
        "Wait for the current operation to finish before using a command",
      ),
    )
    expect(ui.tabs.query).toHaveBeenCalledOnce()
    expect(ui.input.value).toBe("/settings")
    ui.input.value = "Changed draft"
    ui.input.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }))
    gate.resolve([{ id: 7 }])
    await vi.waitFor(() => expect(ui.tabs.create).toHaveBeenCalledOnce())
    await ui.idle()
    expect(ui.input.value).toBe("Changed draft")
    expect(ui.configuration.authStatus).not.toHaveBeenCalled()
    ui.expectNoRun()
  })

  test("retains the command if settings tab creation fails", async () => {
    const ui = await setup()
    ui.tabs.create.mockRejectedValueOnce(new Error("Cannot open settings"))
    ui.send("/settings")
    await vi.waitFor(() => expect(ui.error.textContent).toBe("Cannot open settings"))
    await ui.idle()
    expect(ui.input.value).toBe("/settings")
    ui.expectNoRun()
  })

  test("retains /name when the rename prompt is canceled", async () => {
    const ui = await setup()
    const prompt = vi.fn(() => null)
    vi.stubGlobal("prompt", prompt)
    ui.send("/name")
    await ui.idle()
    expect(prompt).toHaveBeenCalledWith("Conversation name", "Current session")
    expect(ui.input.value).toBe("/name")
    expect(ui.runtime.renameSession).not.toHaveBeenCalled()
    ui.expectNoRun()
  })

  test("retains /login when authentication is canceled", async () => {
    const ui = await setup()
    ui.send("/login")
    expect(ui.element<HTMLDialogElement>("auth-method-dialog").open).toBe(true)
    ui.element<HTMLDialogElement>("auth-method-dialog").close("cancel")
    await ui.idle()
    expect(ui.input.value).toBe("/login")
    expect(ui.configuration.login).not.toHaveBeenCalled()
    expect(ui.configuration.authStatus).not.toHaveBeenCalled()
    ui.expectNoRun()
  })

  test.each(["credential", "permission", "submission"])(
    "retains an escaped prompt after a %s failure",
    async (failure) => {
      const ui = await setup()
      if (failure === "credential") {
        ui.configuration.authStatus.mockResolvedValueOnce({ loggedIn: false })
      } else if (failure === "permission") {
        vi.mocked(requestHostPermissions).mockResolvedValueOnce(false)
      } else {
        ui.runtime.submit.mockRejectedValueOnce(new Error("Submission failed"))
      }
      ui.send("//settings")
      await vi.waitFor(() => expect(ui.error.textContent).not.toBe(""))
      await ui.idle()
      expect(ui.input.value).toBe("//settings")
      expect(ui.tabs.query).not.toHaveBeenCalled()
      if (failure !== "submission") expect(ui.runtime.submit).not.toHaveBeenCalled()
      if (failure === "credential") expect(requestHostPermissions).not.toHaveBeenCalled()
    },
  )
})
