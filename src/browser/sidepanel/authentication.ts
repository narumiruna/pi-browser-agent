import type { AuthEvent, AuthPrompt, AuthType } from "@earendil-works/pi-ai"
import type { BrowserAgentRuntime } from "../agent/runtime.js"
import { AUTH_ORIGINS, OPENAI_PROVIDER_ID } from "../auth/codex-oauth.js"
import { CREDENTIALS_KEY } from "../auth/credential-store.js"
import { hasHostPermissions, requestHostPermissions } from "../permissions.js"
import { SearchableSelect } from "./searchable-select.js"
import { element, run } from "./ui.js"

const AUTH_METHOD_LABELS: Record<AuthType, string> = {
  oauth: "Sign in with an account",
  api_key: "Sign in with an API key",
}

const AUTH_METHOD_NAMES: Record<AuthType, string> = {
  oauth: "account login",
  api_key: "API key authentication",
}

type AuthenticationOptions = {
  runtime: BrowserAgentRuntime
  currentProviderId: () => string
  updateError: (error?: unknown) => void
  onProvidersChanged?: () => void
  onStatus?: (text: string) => void
  mode: "conversation" | "settings"
}

type AuthProviderSelection = { providerId: string } | { back: true } | undefined

function waitForDialog(dialog: HTMLDialogElement): Promise<string> {
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue), { once: true })
  })
}

export class AuthenticationController {
  private readonly accountAuthMethodButton = element<HTMLButtonElement>("account-auth-method")
  private readonly apiKeyAuthMethodButton = element<HTMLButtonElement>("api-key-auth-method")
  private readonly authMethodDialog = element<HTMLDialogElement>("auth-method-dialog")
  private readonly authPromptDialog = element<HTMLDialogElement>("auth-prompt-dialog")
  private readonly authPromptInput = element<HTMLInputElement>("auth-prompt-input")
  private readonly authPromptLabel = element<HTMLElement>("auth-prompt-label")
  private readonly authPromptSelect = element<HTMLSelectElement>("auth-prompt-select")
  private readonly authProviderDescription = element<HTMLElement>("auth-provider-description")
  private readonly authProviderDialog = element<HTMLDialogElement>("auth-provider-dialog")
  private readonly authProviderSelect = element<HTMLSelectElement>("auth-provider")
  private readonly configureButton?: HTMLButtonElement
  private readonly loginButton?: HTMLButtonElement
  private readonly logoutButton?: HTMLButtonElement
  private readonly refreshButton?: HTMLButtonElement
  private readonly statusOutput?: HTMLElement
  private readonly providerPicker: SearchableSelect
  private configuring = false
  private controller?: AbortController
  private refreshRequest = 0
  private verificationUri = ""

  constructor(private readonly options: AuthenticationOptions) {
    this.providerPicker = new SearchableSelect({
      container: element<HTMLElement>("auth-provider-picker"),
      input: element<HTMLInputElement>("auth-provider-search"),
      select: this.authProviderSelect,
      listbox: element<HTMLElement>("auth-provider-options"),
      emptyText: "No providers support this authentication method",
      interactionBoundary: this.authProviderDialog,
    })

    if (options.mode === "conversation") {
      this.loginButton = element<HTMLButtonElement>("login")
      this.logoutButton = element<HTMLButtonElement>("logout")
      this.refreshButton = element<HTMLButtonElement>("refresh-token")
      this.statusOutput = element<HTMLElement>("auth-status")
    } else {
      this.configureButton = element<HTMLButtonElement>("configure-provider")
    }

    for (const [buttonId, returnValue] of [
      ["auth-provider-back", "back"],
      ["auth-provider-cancel", "cancel"],
      ["auth-provider-confirm", "confirm"],
    ] as const) {
      element<HTMLButtonElement>(buttonId).addEventListener("click", () => {
        if (returnValue === "confirm" && !this.providerPicker.commitActiveOption()) return
        this.authProviderDialog.close(returnValue)
      })
    }

    element<HTMLButtonElement>("cancel-login").addEventListener("click", () => {
      this.controller?.abort()
      element<HTMLDialogElement>("login-dialog").close()
    })
    element<HTMLButtonElement>("open-verification").addEventListener("click", () => {
      if (this.verificationUri) void chrome.tabs.create({ url: this.verificationUri })
    })

    this.loginButton?.addEventListener("click", () => this.configure())
    this.configureButton?.addEventListener("click", () => this.configure())
    this.refreshButton?.addEventListener("click", () => {
      if (!this.refreshButton) return
      this.refreshButton.disabled = true
      void run(async () => {
        await options.runtime.refreshCredential(options.currentProviderId())
        await this.refresh()
      }, options.updateError).finally(() => {
        if (this.refreshButton) this.refreshButton.disabled = false
      })
    })
    this.logoutButton?.addEventListener("click", () => {
      if (!this.logoutButton) return
      this.logoutButton.disabled = true
      void run(async () => {
        await options.runtime.logout(options.currentProviderId())
        await this.refresh()
      }, options.updateError).finally(() => {
        if (this.logoutButton) this.logoutButton.disabled = false
      })
    })

    chrome.permissions.onRemoved.addListener((permissions) => {
      if (
        !permissions.origins?.some((origin) =>
          AUTH_ORIGINS.includes(origin as (typeof AUTH_ORIGINS)[number]),
        )
      )
        return
      this.controller?.abort()
      void run(async () => {
        await options.runtime.invalidateCredential(OPENAI_PROVIDER_ID)
        await this.refresh()
        throw new Error("OpenAI host access was revoked. Log in again to continue.")
      }, options.updateError)
    })

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local" && CREDENTIALS_KEY in changes) void this.refresh()
    })
  }

  onAuthEvent(event: AuthEvent): void {
    if (event.type === "device_code") {
      this.verificationUri = event.verificationUri
      element<HTMLOutputElement>("device-code").textContent = event.userCode
      const dialog = element<HTMLDialogElement>("login-dialog")
      if (!dialog.open) dialog.showModal()
    } else if (event.type === "progress" || event.type === "info") {
      this.options.onStatus?.(event.message)
    }
  }

  abort(): void {
    this.controller?.abort()
  }

  async refresh(): Promise<void> {
    const request = ++this.refreshRequest
    const providerId = this.options.currentProviderId()
    const provider = this.options.runtime
      .getProviders()
      .find((candidate) => candidate.id === providerId)
    const configurable = this.options.runtime
      .getProviders()
      .some((candidate) => candidate.authMethods.length > 0)

    if (this.loginButton) {
      this.loginButton.hidden = !configurable
      this.loginButton.textContent = "Add credential"
    }
    if (this.configureButton) {
      this.configureButton.textContent = "Configure authentication"
      this.configureButton.disabled = this.configuring || !configurable
    }
    if (!provider) {
      this.options.updateError()
      return
    }

    try {
      let status = await this.options.runtime.authStatus(providerId)
      if (
        providerId === OPENAI_PROVIDER_ID &&
        status.loggedIn &&
        !(await hasHostPermissions(AUTH_ORIGINS))
      ) {
        await this.options.runtime.invalidateCredential(providerId)
        status = { loggedIn: false }
      }
      if (request !== this.refreshRequest || this.options.currentProviderId() !== providerId) return

      this.options.updateError()
      if (this.logoutButton) this.logoutButton.hidden = !status.loggedIn
      if (this.refreshButton) {
        this.refreshButton.hidden = !status.loggedIn || status.type !== "oauth"
      }
      if (this.statusOutput) {
        this.statusOutput.textContent = status.loggedIn
          ? `${provider.name} configured with ${status.type === "oauth" ? "an account" : "an API key"}`
          : `${provider.name} not configured`
        this.statusOutput.dataset.loggedIn = String(status.loggedIn)
      }
      if (this.configureButton) this.configureButton.disabled = this.configuring
    } catch (error) {
      if (request === this.refreshRequest && this.options.currentProviderId() === providerId) {
        this.options.updateError(error)
      }
    }
  }

  private configure(): void {
    if (this.configuring) return
    this.configuring = true
    if (this.loginButton) this.loginButton.disabled = true
    if (this.configureButton) this.configureButton.disabled = true

    void run(async () => {
      const preferredProviderId = this.options.currentProviderId()
      let selected: { authType: AuthType; providerId: string } | undefined
      while (!selected) {
        const authType = await this.selectAuthMethod()
        if (!authType) return
        const selection = await this.selectAuthProvider(authType, preferredProviderId)
        if (!selection) return
        if ("back" in selection) continue
        selected = { authType, providerId: selection.providerId }
      }

      const { authType, providerId } = selected
      const provider = this.options.runtime
        .getProviders(authType)
        .find((candidate) => candidate.id === providerId)
      if (!provider) throw new Error("Select a provider before configuring it")
      await requestProviderSetupPermission(providerId, authType)
      this.controller = new AbortController()
      try {
        await this.options.runtime.login(providerId, authType, this.controller.signal, (prompt) =>
          this.promptForCredential(prompt),
        )
        const loginDialog = element<HTMLDialogElement>("login-dialog")
        if (loginDialog.open) loginDialog.close()
        this.options.onProvidersChanged?.()
        await this.refresh()
        this.options.onStatus?.(
          `${provider.name} configured with ${authType === "oauth" ? "an account" : "an API key"}`,
        )
      } finally {
        this.controller = undefined
      }
    }, this.options.updateError).finally(() => {
      this.configuring = false
      if (this.loginButton) this.loginButton.disabled = false
      if (this.configureButton) {
        this.configureButton.disabled = !this.options.runtime
          .getProviders()
          .some((provider) => provider.authMethods.length > 0)
      }
    })
  }

  private async selectAuthMethod(): Promise<AuthType | undefined> {
    this.accountAuthMethodButton.hidden = this.options.runtime.getProviders("oauth").length === 0
    this.apiKeyAuthMethodButton.hidden = this.options.runtime.getProviders("api_key").length === 0
    this.authMethodDialog.returnValue = ""
    this.authMethodDialog.showModal()
    queueMicrotask(() =>
      (this.accountAuthMethodButton.hidden
        ? this.apiKeyAuthMethodButton
        : this.accountAuthMethodButton
      ).focus(),
    )
    const selection = await waitForDialog(this.authMethodDialog)
    return selection === "oauth" || selection === "api_key" ? selection : undefined
  }

  private async selectAuthProvider(
    authType: AuthType,
    preferredProviderId: string,
  ): Promise<AuthProviderSelection> {
    const providers = this.options.runtime.getProviders(authType)
    if (providers.length === 0) {
      throw new Error(`No providers support ${AUTH_METHOD_NAMES[authType]} in Chrome`)
    }
    this.authProviderDescription.textContent = `Providers available for ${AUTH_METHOD_LABELS[authType].toLowerCase()}.`
    this.providerPicker.setOptions(
      providers.map((provider) => {
        const method = provider.authMethods.find((candidate) => candidate.type === authType)
        return {
          value: provider.id,
          label: method ? `${provider.name} — ${method.label}` : provider.name,
          keywords: [provider.name, provider.id],
        }
      }),
      preferredProviderId,
    )
    this.authProviderDialog.returnValue = ""
    this.authProviderDialog.showModal()
    queueMicrotask(() => element<HTMLInputElement>("auth-provider-search").focus())
    const selection = await waitForDialog(this.authProviderDialog)
    if (selection === "back") return { back: true }
    if (selection !== "confirm") return undefined
    return { providerId: this.authProviderSelect.value }
  }

  private promptForCredential(prompt: AuthPrompt): Promise<string> {
    this.authPromptLabel.textContent = prompt.message
    const isSelect = prompt.type === "select"
    this.authPromptInput.hidden = isSelect
    this.authPromptSelect.hidden = !isSelect
    this.authPromptInput.value = ""
    this.authPromptInput.type = prompt.type === "secret" ? "password" : "text"
    this.authPromptInput.placeholder = "placeholder" in prompt ? (prompt.placeholder ?? "") : ""
    this.authPromptInput.autocomplete = prompt.type === "secret" ? "off" : "on"
    this.authPromptSelect.replaceChildren()
    if (isSelect) {
      for (const choice of prompt.options) {
        const option = document.createElement("option")
        option.value = choice.id
        option.textContent = choice.description
          ? `${choice.label} — ${choice.description}`
          : choice.label
        this.authPromptSelect.append(option)
      }
    }
    this.authPromptDialog.showModal()
    queueMicrotask(() => (isSelect ? this.authPromptSelect : this.authPromptInput).focus())

    return new Promise((resolve, reject) => {
      const signals = [prompt.signal, this.controller?.signal].filter(
        (signal): signal is AbortSignal => signal !== undefined,
      )
      const cleanup = (): void => {
        this.authPromptDialog.removeEventListener("close", finish)
        for (const signal of signals) signal.removeEventListener("abort", abort)
      }
      const finish = (): void => {
        cleanup()
        if (this.authPromptDialog.returnValue !== "confirm") {
          this.authPromptInput.value = ""
          reject(new DOMException("Provider setup cancelled", "AbortError"))
          return
        }
        const response = isSelect ? this.authPromptSelect.value : this.authPromptInput.value
        this.authPromptInput.value = ""
        resolve(response)
      }
      const abort = (): void => {
        if (this.authPromptDialog.open) this.authPromptDialog.close("cancel")
        else {
          cleanup()
          this.authPromptInput.value = ""
          reject(new DOMException("Provider setup cancelled", "AbortError"))
        }
      }
      this.authPromptDialog.addEventListener("close", finish, { once: true })
      for (const signal of signals) signal.addEventListener("abort", abort, { once: true })
      if (signals.some((signal) => signal.aborted)) abort()
    })
  }
}

async function requestProviderSetupPermission(
  providerId: string,
  authType: AuthType,
): Promise<void> {
  if (authType === "oauth") {
    if (providerId !== OPENAI_PROVIDER_ID) {
      throw new Error(`Account login is not configured for ${providerId} in Chrome`)
    }
    const granted = await requestHostPermissions(AUTH_ORIGINS)
    if (!granted) throw new Error("OpenAI host access is required for login")
    return
  }
  if (providerId === "radius") {
    const granted = await requestHostPermissions(["https://radius.pi.dev"])
    if (!granted) throw new Error("Radius host access is required to load its models")
  }
}
