import type { AuthType } from "@earendil-works/pi-ai"
import { JSDOM } from "jsdom"
import { afterEach, describe, expect, test, vi } from "vitest"
import { AUTH_ORIGINS, OPENAI_PROVIDER_ID } from "../../src/browser/auth/codex-oauth.js"
import type { BrowserConfiguration, ProviderSummary } from "../../src/browser/configuration.js"
import { requestHostPermissions } from "../../src/browser/permissions.js"
import { AuthenticationController } from "../../src/browser/sidepanel/authentication.js"

vi.mock("../../src/browser/permissions.js", () => ({
  hasHostPermissions: vi.fn(async () => true),
  requestHostPermissions: vi.fn(async () => true),
}))

const providers: ProviderSummary[] = [
  {
    id: OPENAI_PROVIDER_ID,
    name: "OpenAI",
    modelCount: 1,
    authMethods: [{ type: "oauth", label: "Account" }],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    modelCount: 1,
    authMethods: [{ type: "api_key", label: "API key" }],
  },
]

const windows: JSDOM[] = []

afterEach(() => {
  for (const dom of windows.splice(0)) dom.window.close()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function setup(mode: "conversation" | "settings" = "conversation") {
  const dom = new JSDOM(`
    <button id="login"></button><button id="logout"></button>
    <button id="refresh-token"></button><button id="configure-provider"></button>
    <output id="auth-status"></output>
    <dialog id="auth-method-dialog">
      <button id="account-auth-method"></button><button id="api-key-auth-method"></button>
    </dialog>
    <dialog id="auth-provider-dialog">
      <p id="auth-provider-description"></p>
      <div id="auth-provider-picker">
        <input id="auth-provider-search"><select id="auth-provider"></select>
        <div id="auth-provider-options" hidden></div>
      </div>
      <button id="auth-provider-back"></button><button id="auth-provider-cancel"></button>
      <button id="auth-provider-confirm"></button>
    </dialog>
    <dialog id="auth-prompt-dialog">
      <label id="auth-prompt-label"></label><input id="auth-prompt-input">
      <select id="auth-prompt-select"></select>
    </dialog>
    <dialog id="login-dialog">
      <output id="device-code"></output>
      <button id="cancel-login"></button><button id="open-verification"></button>
    </dialog>
  `)
  windows.push(dom)
  vi.stubGlobal("document", dom.window.document)
  vi.stubGlobal("chrome", {
    permissions: { onRemoved: { addListener: vi.fn() } },
    storage: { onChanged: { addListener: vi.fn() } },
    tabs: { create: vi.fn() },
  })
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  dom.window.HTMLDialogElement.prototype.close = function (value?: string) {
    if (value !== undefined) this.returnValue = value
    this.open = false
    this.dispatchEvent(new dom.window.Event("close"))
  }
  vi.mocked(requestHostPermissions).mockResolvedValue(true)
  const configuration = {
    isChangingAuth: false,
    getProviders: vi.fn((authType?: AuthType) =>
      providers.filter((provider) =>
        authType ? provider.authMethods.some((method) => method.type === authType) : true,
      ),
    ),
    authStatus: vi.fn<BrowserConfiguration["authStatus"]>().mockResolvedValue({ loggedIn: false }),
    login: vi.fn<BrowserConfiguration["login"]>().mockResolvedValue(undefined),
    logout: vi.fn<BrowserConfiguration["logout"]>().mockResolvedValue(undefined),
    credentials: {
      read: vi
        .fn<BrowserConfiguration["credentials"]["read"]>()
        .mockResolvedValue({ type: "api_key", key: "test-key" }),
    },
  }
  const currentProviderId = vi.fn(() => "anthropic")
  const updateError = vi.fn()
  const onProvidersChanged = vi.fn()
  const onStatus = vi.fn()
  const controller = new AuthenticationController({
    configuration: configuration as unknown as BrowserConfiguration,
    currentProviderId,
    updateError,
    onProvidersChanged,
    onStatus,
    mode,
  })
  const dialog = (id: string) => {
    const value = dom.window.document.getElementById(id)
    if (!(value instanceof dom.window.HTMLDialogElement)) throw new Error(`Missing dialog: ${id}`)
    return value
  }
  const button = (id: string) => {
    const value = dom.window.document.getElementById(id)
    if (!(value instanceof dom.window.HTMLButtonElement)) throw new Error(`Missing button: ${id}`)
    return value
  }
  const chooseProvider = async (authType: AuthType = "api_key") => {
    dialog("auth-method-dialog").close(authType)
    await vi.waitFor(() => expect(dialog("auth-provider-dialog").open).toBe(true))
    dialog("auth-provider-dialog").close("confirm")
  }
  return {
    dom,
    controller,
    configuration,
    currentProviderId,
    updateError,
    onProvidersChanged,
    onStatus,
    dialog,
    button,
    chooseProvider,
  }
}

describe("awaitable authentication actions", () => {
  test("waits for successful login and refresh before reporting completion", async () => {
    const ui = setup()
    let finishLogin: (() => void) | undefined
    ui.configuration.login.mockImplementation(
      () => new Promise<void>((resolve) => (finishLogin = resolve)),
    )
    const action = ui.controller.configure()
    expect(ui.controller.isBusy).toBe(true)
    expect(ui.button("login").disabled).toBe(true)
    await ui.chooseProvider()
    await vi.waitFor(() => expect(ui.configuration.login).toHaveBeenCalledOnce())
    expect(ui.configuration.login).toHaveBeenCalledWith(
      "anthropic",
      "api_key",
      expect.any(AbortSignal),
      expect.any(Function),
    )
    expect(ui.onStatus).not.toHaveBeenCalled()
    finishLogin?.()

    await expect(action).resolves.toBe(true)
    expect(ui.configuration.authStatus).toHaveBeenCalledWith("anthropic")
    expect(ui.onProvidersChanged).toHaveBeenCalledOnce()
    expect(ui.onStatus).toHaveBeenCalledWith("Anthropic configured with an API key")
    expect(ui.controller.isBusy).toBe(false)
    expect(ui.button("login").disabled).toBe(false)
  })

  test.each(["method", "provider"])(
    "returns false when the %s dialog is canceled",
    async (step) => {
      const ui = setup()
      const action = ui.controller.configure()
      if (step === "method") ui.dialog("auth-method-dialog").close("cancel")
      else {
        ui.dialog("auth-method-dialog").close("api_key")
        await vi.waitFor(() => expect(ui.dialog("auth-provider-dialog").open).toBe(true))
        ui.dialog("auth-provider-dialog").close("cancel")
      }

      await expect(action).resolves.toBe(false)
      expect(ui.configuration.login).not.toHaveBeenCalled()
      expect(ui.onProvidersChanged).not.toHaveBeenCalled()
      expect(ui.controller.isBusy).toBe(false)
      expect(ui.button("login").disabled).toBe(false)
    },
  )

  test("allows Back to return to authentication method selection", async () => {
    const ui = setup()
    const action = ui.controller.configure()
    ui.dialog("auth-method-dialog").close("api_key")
    await vi.waitFor(() => expect(ui.dialog("auth-provider-dialog").open).toBe(true))
    ui.dialog("auth-provider-dialog").close("back")
    await vi.waitFor(() => expect(ui.dialog("auth-method-dialog").open).toBe(true))
    await ui.chooseProvider()
    await expect(action).resolves.toBe(true)
    expect(ui.configuration.login).toHaveBeenCalledOnce()
  })

  test("returns false on credential prompt cancellation and clears the input", async () => {
    const ui = setup()
    ui.configuration.login.mockImplementation(async (_provider, _type, signal, prompt) => {
      await prompt({ type: "secret", message: "API key", signal })
    })
    const action = ui.controller.configure()
    await ui.chooseProvider()
    await vi.waitFor(() => expect(ui.dialog("auth-prompt-dialog").open).toBe(true))
    const input = ui.dom.window.document.getElementById("auth-prompt-input") as HTMLInputElement
    input.value = "unsaved-key"
    ui.dialog("auth-prompt-dialog").close("cancel")

    await expect(action).resolves.toBe(false)
    expect(input.value).toBe("")
    expect(ui.onStatus).not.toHaveBeenCalled()
    expect(ui.controller.isBusy).toBe(false)
    expect(ui.button("login").disabled).toBe(false)
  })

  test("returns false when active login is aborted", async () => {
    const ui = setup()
    ui.configuration.login.mockImplementation(
      (_provider, _type, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("Login cancelled")), {
            once: true,
          })
        }),
    )
    const action = ui.controller.configure()
    await ui.chooseProvider()
    await vi.waitFor(() => expect(ui.configuration.login).toHaveBeenCalledOnce())
    ui.controller.abort()

    await expect(action).resolves.toBe(false)
    expect(ui.controller.isBusy).toBe(false)
  })

  test("propagates login errors and restores the settings button", async () => {
    const ui = setup("settings")
    const error = new Error("Login failed")
    ui.configuration.login.mockRejectedValue(error)
    const action = ui.controller.configure()
    const rejected = expect(action).rejects.toBe(error)
    expect(ui.button("configure-provider").disabled).toBe(true)
    await ui.chooseProvider()

    await rejected
    expect(ui.controller.isBusy).toBe(false)
    expect(ui.button("configure-provider").disabled).toBe(false)
    expect(ui.updateError).not.toHaveBeenCalledWith(error)
  })

  test("rejects denied setup permission without starting login", async () => {
    const ui = setup()
    vi.mocked(requestHostPermissions).mockResolvedValue(false)
    const action = ui.controller.configure()
    const rejected = expect(action).rejects.toThrow("OpenAI host access is required for login")
    await ui.chooseProvider("oauth")

    await rejected
    expect(requestHostPermissions).toHaveBeenCalledWith(AUTH_ORIGINS)
    expect(ui.configuration.login).not.toHaveBeenCalled()
    expect(ui.controller.isBusy).toBe(false)
    expect(ui.button("login").disabled).toBe(false)
  })

  test("rechecks the command guard after setup permission resolves", async () => {
    const ui = setup()
    let grantPermission: ((value: boolean) => void) | undefined
    vi.mocked(requestHostPermissions).mockImplementation(
      () => new Promise<boolean>((resolve) => (grantPermission = resolve)),
    )
    const guard = vi.fn()
    const action = ui.controller.configure(guard)
    const error = new Error("Conversation became busy")
    const rejected = expect(action).rejects.toBe(error)
    await ui.chooseProvider("oauth")
    await vi.waitFor(() => expect(requestHostPermissions).toHaveBeenCalledOnce())
    expect(guard).toHaveBeenCalledOnce()
    guard.mockImplementation(() => {
      throw error
    })
    grantPermission?.(true)

    await rejected
    expect(guard).toHaveBeenCalledTimes(2)
    expect(ui.configuration.login).not.toHaveBeenCalled()
    expect(ui.controller.isBusy).toBe(false)
  })

  test("rejects a command guard before requesting setup permission", async () => {
    const ui = setup()
    const error = new Error("Conversation became busy")
    const action = ui.controller.configure(() => {
      throw error
    })
    const rejected = expect(action).rejects.toBe(error)
    await ui.chooseProvider("oauth")

    await rejected
    expect(requestHostPermissions).not.toHaveBeenCalled()
    expect(ui.configuration.login).not.toHaveBeenCalled()
  })

  test("does not start duplicate or concurrent actions while configuring", async () => {
    const ui = setup()
    const action = ui.controller.configure()

    await expect(ui.controller.configure()).resolves.toBe(false)
    await expect(ui.controller.logout()).resolves.toBe(false)
    expect(ui.configuration.credentials.read).not.toHaveBeenCalled()
    ui.dialog("auth-method-dialog").close("cancel")
    await expect(action).resolves.toBe(false)
  })

  test("awaits removal of only the selected provider credential", async () => {
    const ui = setup()
    ui.currentProviderId.mockReturnValue(OPENAI_PROVIDER_ID)
    let finishLogout: (() => void) | undefined
    ui.configuration.logout.mockImplementation(
      () => new Promise<void>((resolve) => (finishLogout = resolve)),
    )
    const guard = vi.fn()
    const action = ui.controller.logout(guard)
    expect(ui.controller.isBusy).toBe(true)
    expect(ui.button("logout").disabled).toBe(true)
    await vi.waitFor(() => expect(ui.configuration.logout).toHaveBeenCalledOnce())
    expect(ui.configuration.credentials.read).toHaveBeenCalledWith(OPENAI_PROVIDER_ID)
    expect(ui.configuration.logout).toHaveBeenCalledWith(OPENAI_PROVIDER_ID)
    expect(guard).toHaveBeenCalledOnce()
    await expect(ui.controller.logout()).resolves.toBe(false)
    await expect(ui.controller.configure()).resolves.toBe(false)
    finishLogout?.()

    await expect(action).resolves.toBe(true)
    expect(ui.configuration.authStatus).toHaveBeenCalledWith(OPENAI_PROVIDER_ID)
    expect(ui.controller.isBusy).toBe(false)
    expect(ui.button("logout").disabled).toBe(false)
  })

  test("accepts logout when no credential exists without provider requests", async () => {
    const ui = setup()
    ui.configuration.credentials.read.mockResolvedValue(undefined)

    await expect(ui.controller.logout()).resolves.toBe(true)
    expect(ui.configuration.logout).not.toHaveBeenCalled()
    expect(ui.configuration.authStatus).not.toHaveBeenCalled()
    expect(requestHostPermissions).not.toHaveBeenCalled()
    expect(ui.onStatus).toHaveBeenCalledWith("Anthropic not configured")
    expect(ui.controller.isBusy).toBe(false)
    expect(ui.button("logout").disabled).toBe(false)
  })

  test("propagates logout errors and restores its button", async () => {
    const ui = setup()
    const error = new Error("Credential removal failed")
    ui.configuration.logout.mockRejectedValue(error)

    await expect(ui.controller.logout()).rejects.toBe(error)
    expect(ui.controller.isBusy).toBe(false)
    expect(ui.button("logout").disabled).toBe(false)
    expect(ui.updateError).not.toHaveBeenCalledWith(error)
  })

  test("rechecks the command guard after credential lookup and before logout", async () => {
    const ui = setup()
    const error = new Error("Conversation became busy")
    const guard = vi.fn(() => {
      expect(ui.configuration.credentials.read).toHaveBeenCalledOnce()
      throw error
    })

    await expect(ui.controller.logout(guard)).rejects.toBe(error)
    expect(ui.configuration.logout).not.toHaveBeenCalled()
    expect(ui.controller.isBusy).toBe(false)
    expect(ui.button("logout").disabled).toBe(false)
  })

  test("does not remove a credential if the selected provider changes during lookup", async () => {
    const ui = setup()
    ui.configuration.credentials.read.mockImplementation(async () => {
      ui.currentProviderId.mockReturnValue(OPENAI_PROVIDER_ID)
      return { type: "api_key", key: "test-key" }
    })

    await expect(ui.controller.logout()).rejects.toThrow("The selected provider changed")
    expect(ui.configuration.logout).not.toHaveBeenCalled()
    expect(ui.controller.isBusy).toBe(false)
  })

  test("uses configuration's existing lifecycle state for other auth changes", async () => {
    const ui = setup()
    ui.configuration.isChangingAuth = true
    expect(ui.controller.isBusy).toBe(true)
    await expect(ui.controller.configure()).resolves.toBe(false)
    await expect(ui.controller.logout()).resolves.toBe(false)
    ui.configuration.isChangingAuth = false
    expect(ui.controller.isBusy).toBe(false)
  })

  test.each(["login", "configure-provider", "logout"])(
    "keeps the %s button error reporting through run",
    async (buttonId) => {
      const ui = setup(buttonId === "configure-provider" ? "settings" : "conversation")
      const error = new Error("Authentication failed")
      ui.configuration.login.mockRejectedValue(error)
      ui.configuration.logout.mockRejectedValue(error)
      ui.button(buttonId).click()
      expect(ui.updateError).toHaveBeenCalledWith()
      if (buttonId !== "logout") await ui.chooseProvider()

      await vi.waitFor(() => expect(ui.updateError).toHaveBeenCalledWith(error))
      expect(ui.controller.isBusy).toBe(false)
      expect(ui.button(buttonId).disabled).toBe(false)
    },
  )
})
