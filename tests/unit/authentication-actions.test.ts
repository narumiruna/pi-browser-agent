import type { AuthType } from "@earendil-works/pi-ai"
import { JSDOM } from "jsdom"
import { afterEach, describe, expect, test, vi } from "vitest"
import { AUTH_ORIGINS, OPENAI_PROVIDER_ID } from "../../src/browser/auth/codex-oauth.js"
import { CREDENTIALS_KEY } from "../../src/browser/auth/credential-store.js"
import type {
  AuthStatus,
  BrowserConfiguration,
  ProviderSummary,
} from "../../src/browser/configuration.js"
import { hasHostPermissions, requestHostPermissions } from "../../src/browser/permissions.js"
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
    <p id="settings-auth-status" role="status" aria-live="polite"></p>
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
  vi.mocked(hasHostPermissions).mockResolvedValue(true)
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
    invalidateCredential: vi
      .fn<BrowserConfiguration["invalidateCredential"]>()
      .mockResolvedValue(undefined),
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
  const onStateChanged = vi.fn()
  const controller = new AuthenticationController({
    configuration: configuration as unknown as BrowserConfiguration,
    currentProviderId,
    updateError,
    onProvidersChanged,
    onStateChanged,
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
    onStateChanged,
    onStatus,
    status: dom.window.document.getElementById("settings-auth-status") as HTMLElement,
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

      await vi.waitFor(() =>
        expect(ui.updateError).toHaveBeenCalledWith(
          buttonId === "configure-provider"
            ? new Error("Authentication is unavailable. Try again.")
            : error,
        ),
      )
      expect(ui.controller.isBusy).toBe(false)
      expect(ui.button(buttonId).disabled).toBe(false)
    },
  )
})

describe("Settings credential status", () => {
  test.each([
    ["anthropic", { loggedIn: false }, "Anthropic credential missing", "Add credential"],
    [
      "anthropic",
      { loggedIn: true, type: "api_key" },
      "Anthropic credential configured — API key",
      "Update credential",
    ],
    [
      OPENAI_PROVIDER_ID,
      { loggedIn: true, type: "oauth" },
      "OpenAI credential configured — Account",
      "Update credential",
    ],
  ] as const)(
    "shows only status and method for %s: %j",
    async (providerId, status, text, label) => {
      const ui = setup("settings")
      ui.currentProviderId.mockReturnValue(providerId)
      ui.configuration.authStatus.mockResolvedValue(status)

      await ui.controller.refresh()

      expect(ui.status.textContent).toBe(text)
      expect(ui.status.dataset.loggedIn).toBe(String(status.loggedIn))
      expect(ui.button("configure-provider").textContent).toBe(label)
      expect(ui.configuration.credentials.read).not.toHaveBeenCalled()
      expect(ui.configuration.login).not.toHaveBeenCalled()
      expect(requestHostPermissions).not.toHaveBeenCalled()
      expect(ui.onStateChanged).toHaveBeenCalledOnce()
      expect(ui.dom.window.document.getElementById("auth-status")?.textContent).toBe("")
    },
  )

  test("clears configured status and reports a fixed error when status lookup fails", async () => {
    const ui = setup("settings")
    ui.configuration.authStatus.mockResolvedValue({ loggedIn: true, type: "api_key" })
    await ui.controller.refresh()
    ui.configuration.authStatus.mockRejectedValue(new Error("secret-provider-response"))

    await ui.controller.refresh()

    expect(ui.status.textContent).toBe("Credential status unavailable. Try again.")
    expect(ui.status.dataset.loggedIn).toBe("false")
    expect(ui.button("configure-provider").textContent).toBe("Add credential")
    expect(ui.updateError).toHaveBeenLastCalledWith(
      new Error("Authentication is unavailable. Try again."),
    )
    expect(ui.dom.window.document.body.textContent).not.toContain("secret-provider-response")
  })

  test("clears status for an unavailable selected provider", async () => {
    const ui = setup("settings")
    ui.configuration.authStatus.mockResolvedValue({ loggedIn: true, type: "api_key" })
    await ui.controller.refresh()
    ui.currentProviderId.mockReturnValue("unavailable")
    await ui.controller.refresh()
    expect(ui.status.textContent).toBe("Credential status unavailable. Try again.")
    expect(ui.status.dataset.loggedIn).toBe("false")
    expect(ui.configuration.authStatus).toHaveBeenCalledOnce()
  })

  test.each(["success", "error"])("ignores stale %s after a provider change", async (result) => {
    const ui = setup("settings")
    let resolveStatus: ((status: AuthStatus) => void) | undefined
    let rejectStatus: ((error: Error) => void) | undefined
    ui.configuration.authStatus.mockImplementationOnce(
      () =>
        new Promise<AuthStatus>((resolve, reject) => {
          resolveStatus = resolve
          rejectStatus = reject
        }),
    )
    const stale = ui.controller.refresh()
    ui.currentProviderId.mockReturnValue(OPENAI_PROVIDER_ID)
    ui.configuration.authStatus.mockResolvedValue({ loggedIn: true, type: "oauth" })
    await ui.controller.refresh()
    ui.updateError.mockClear()
    if (result === "success") resolveStatus?.({ loggedIn: false })
    else rejectStatus?.(new Error("stale-secret"))
    await stale

    expect(ui.status.textContent).toBe("OpenAI credential configured — Account")
    expect(ui.status.dataset.loggedIn).toBe("true")
    expect(ui.button("configure-provider").textContent).toBe("Update credential")
    expect(ui.updateError).not.toHaveBeenCalled()
  })

  test("ignores older refreshes for the same provider", async () => {
    const ui = setup("settings")
    let finish: ((status: AuthStatus) => void) | undefined
    ui.configuration.authStatus.mockImplementationOnce(
      () => new Promise<AuthStatus>((resolve) => (finish = resolve)),
    )
    const stale = ui.controller.refresh()
    ui.configuration.authStatus.mockResolvedValue({ loggedIn: true, type: "api_key" })
    await ui.controller.refresh()
    finish?.({ loggedIn: false })
    await stale
    expect(ui.status.textContent).toBe("Anthropic credential configured — API key")
  })

  test("retains the configured credential status when setup is canceled or fails", async () => {
    const ui = setup("settings")
    ui.configuration.authStatus.mockResolvedValue({ loggedIn: true, type: "api_key" })
    await ui.controller.refresh()
    ui.onStateChanged.mockClear()
    const canceled = ui.controller.configure()
    expect(ui.onStateChanged).toHaveBeenCalledOnce()
    expect(ui.controller.isBusy).toBe(true)
    ui.dialog("auth-method-dialog").close("cancel")
    await expect(canceled).resolves.toBe(false)
    expect(ui.onStateChanged).toHaveBeenCalledTimes(2)
    expect(ui.controller.isBusy).toBe(false)
    expect(ui.status.textContent).toBe("Anthropic credential configured — API key")

    ui.configuration.login.mockRejectedValue(new Error("secret-login-error"))
    ui.button("configure-provider").click()
    await ui.chooseProvider()
    await vi.waitFor(() => expect(ui.controller.isBusy).toBe(false))
    expect(ui.status.textContent).toBe("Anthropic credential configured — API key")
    expect(ui.updateError).toHaveBeenLastCalledWith(
      new Error("Authentication is unavailable. Try again."),
    )
    expect(ui.onProvidersChanged).not.toHaveBeenCalled()
    expect(ui.dom.window.document.body.textContent).not.toContain("secret-login-error")
  })

  test("refreshes after setup without changing the selected provider", async () => {
    const ui = setup("settings")
    ui.currentProviderId.mockReturnValue(OPENAI_PROVIDER_ID)
    const action = ui.controller.configure()
    ui.dialog("auth-method-dialog").close("oauth")
    await vi.waitFor(() => expect(ui.dialog("auth-provider-dialog").open).toBe(true))
    expect(
      (ui.dom.window.document.getElementById("auth-provider") as HTMLSelectElement).value,
    ).toBe(OPENAI_PROVIDER_ID)
    ui.configuration.authStatus.mockResolvedValue({ loggedIn: true, type: "oauth" })
    ui.dialog("auth-provider-dialog").close("confirm")
    await expect(action).resolves.toBe(true)
    expect(ui.currentProviderId()).toBe(OPENAI_PROVIDER_ID)
    expect(ui.status.textContent).toBe("OpenAI credential configured — Account")
    expect(ui.onStateChanged).toHaveBeenCalledTimes(3)
  })

  test("does not forward raw authentication progress or info in Settings", () => {
    const ui = setup("settings")
    ui.controller.onAuthEvent({ type: "progress", message: "secret-progress" })
    ui.controller.onAuthEvent({ type: "info", message: "secret-info" })
    expect(ui.onStatus).not.toHaveBeenCalled()
    expect(ui.status.textContent).toBe("")
  })

  test("updates status after cross-context credential changes only in local storage", async () => {
    const ui = setup("settings")
    const onChanged = vi.mocked(chrome.storage.onChanged.addListener).mock.calls[0]?.[0]
    if (!onChanged) throw new Error("Missing storage listener")
    onChanged({ [CREDENTIALS_KEY]: {} }, "session")
    onChanged({ unrelated: {} }, "local")
    expect(ui.configuration.authStatus).not.toHaveBeenCalled()
    onChanged({ [CREDENTIALS_KEY]: {} }, "local")
    await vi.waitFor(() => expect(ui.status.textContent).toBe("Anthropic credential missing"))
    ui.configuration.authStatus.mockResolvedValue({ loggedIn: true, type: "api_key" })
    onChanged({ [CREDENTIALS_KEY]: {} }, "local")
    await vi.waitFor(() =>
      expect(ui.status.textContent).toBe("Anthropic credential configured — API key"),
    )
    expect(requestHostPermissions).not.toHaveBeenCalled()
  })

  test("invalidates a Codex credential when its permission is absent", async () => {
    const ui = setup("settings")
    ui.currentProviderId.mockReturnValue(OPENAI_PROVIDER_ID)
    ui.configuration.authStatus.mockResolvedValue({ loggedIn: true, type: "oauth" })
    vi.mocked(hasHostPermissions).mockResolvedValue(false)
    await ui.controller.refresh()
    expect(ui.configuration.invalidateCredential).toHaveBeenCalledWith(OPENAI_PROVIDER_ID)
    expect(ui.status.textContent).toBe("OpenAI credential missing")
    expect(ui.button("configure-provider").textContent).toBe("Add credential")
    expect(requestHostPermissions).not.toHaveBeenCalled()
  })

  test("refreshes and reports fixed text after authentication permission revocation", async () => {
    const ui = setup("settings")
    ui.currentProviderId.mockReturnValue(OPENAI_PROVIDER_ID)
    ui.configuration.authStatus.mockResolvedValueOnce({ loggedIn: true, type: "oauth" })
    await ui.controller.refresh()
    const onRemoved = vi.mocked(chrome.permissions.onRemoved.addListener).mock.calls[0]?.[0]
    if (!onRemoved) throw new Error("Missing permission listener")
    onRemoved({ origins: [AUTH_ORIGINS[0]] })
    await vi.waitFor(() => expect(ui.status.textContent).toBe("OpenAI credential missing"))
    expect(ui.configuration.invalidateCredential).toHaveBeenCalledWith(OPENAI_PROVIDER_ID)
    expect(ui.updateError).toHaveBeenLastCalledWith(
      new Error("Authentication is unavailable. Try again."),
    )
    expect(requestHostPermissions).not.toHaveBeenCalled()
  })

  test("clears configured status even if credential invalidation fails after revocation", async () => {
    const ui = setup("settings")
    ui.currentProviderId.mockReturnValue(OPENAI_PROVIDER_ID)
    ui.configuration.authStatus.mockResolvedValue({ loggedIn: true, type: "oauth" })
    await ui.controller.refresh()
    ui.configuration.invalidateCredential.mockRejectedValue(new Error("secret-storage-error"))
    const onRemoved = vi.mocked(chrome.permissions.onRemoved.addListener).mock.calls[0]?.[0]
    if (!onRemoved) throw new Error("Missing permission listener")
    onRemoved({ origins: [AUTH_ORIGINS[0]] })
    expect(ui.status.textContent).toBe("Credential status unavailable. Try again.")
    expect(ui.status.dataset.loggedIn).toBe("false")
    expect(ui.button("configure-provider").textContent).toBe("Add credential")
    await vi.waitFor(() =>
      expect(ui.updateError).toHaveBeenLastCalledWith(
        new Error("Authentication is unavailable. Try again."),
      ),
    )
  })

  test("notifies busy-state observers before and after logout", async () => {
    const ui = setup()
    const observed: boolean[] = []
    ui.onStateChanged.mockImplementation(() => observed.push(ui.controller.isBusy))
    await expect(ui.controller.logout()).resolves.toBe(true)
    expect(observed).toEqual([true, true, false])
  })
})
