import type { Api, AuthEvent, AuthPrompt, AuthType, Model } from "@earendil-works/pi-ai"
import { OPENAI_PROVIDER_ID } from "./auth/codex-oauth.js"
import { ChromeCredentialStore } from "./auth/credential-store.js"
import { createBrowserModels, modelEndpointUrls } from "./auth/provider.js"
import {
  type AppSettings,
  getSettings,
  restrictLocalStorageToTrustedContexts,
  saveSettings,
} from "./storage.js"

export interface AuthStatus {
  loggedIn: boolean
  type?: AuthType
}

export interface ProviderSummary {
  id: string
  name: string
  modelCount: number
  authMethods: { type: AuthType; label: string }[]
}

export interface ModelSummary {
  provider: string
  id: string
  name: string
  reasoning: boolean
  imageInput: boolean
}

/** Provider setup and saved configuration, independent of conversation execution. */
export class BrowserConfiguration {
  readonly credentials = new ChromeCredentialStore()
  readonly models
  readonly defaultModel: Model<Api>
  private settings!: AppSettings
  private authChanging = false

  constructor(
    private readonly onAuthEvent: (event: AuthEvent) => void,
    // Conversations must finish their run and persistence before credentials disappear.
    private readonly beforeCredentialRemoval?: () => Promise<void>,
  ) {
    const modelRuntime = createBrowserModels(this.credentials)
    this.models = modelRuntime.models
    this.defaultModel = modelRuntime.defaultModel
  }

  async initialize(modelSelection?: { provider: string; id: string }): Promise<Model<Api>> {
    await restrictLocalStorageToTrustedContexts()
    this.settings = await getSettings()
    await this.models.refresh({ providers: ["radius"] })
    const configured =
      this.models.getModel(this.settings.modelProvider, this.settings.modelId) ?? this.defaultModel
    return modelSelection
      ? (this.models.getModel(modelSelection.provider, modelSelection.id) ?? configured)
      : configured
  }

  get appSettings(): AppSettings {
    return { ...this.settings }
  }

  get isChangingAuth(): boolean {
    return this.authChanging
  }

  async updateSettings(settings: AppSettings): Promise<void> {
    this.settings = { ...settings }
    await saveSettings(this.settings)
  }

  async syncSettings(): Promise<void> {
    this.settings = await getSettings()
    if (this.settings.modelProvider === "radius") {
      await this.models.refresh({ providers: ["radius"] })
    }
  }

  getProviders(authType?: AuthType): ProviderSummary[] {
    const providers = this.models.getProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
      modelCount: provider.getModels().length,
      authMethods: [
        ...(provider.auth.oauth
          ? [
              {
                type: "oauth" as const,
                label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name,
              },
            ]
          : []),
        ...(provider.auth.apiKey?.login
          ? [{ type: "api_key" as const, label: provider.auth.apiKey.name }]
          : []),
      ],
    }))
    return authType
      ? providers.filter((provider) =>
          provider.authMethods.some((method) => method.type === authType),
        )
      : providers
  }

  getModels(providerId: string): ModelSummary[] {
    return this.models.getModels(providerId).map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      imageInput: model.input.includes("image"),
    }))
  }

  async authStatus(providerId: string): Promise<AuthStatus> {
    const credential = await this.credentials.read(providerId)
    if (!credential) return { loggedIn: false }
    const configured = await this.models.checkAuth(providerId)
    if (!configured) return { loggedIn: false }
    return { loggedIn: true, type: credential.type }
  }

  async login(
    providerId: string,
    type: AuthType,
    signal: AbortSignal,
    prompt: (prompt: AuthPrompt) => Promise<string>,
  ): Promise<void> {
    return this.runAuthChange(async () => {
      await this.models.login(providerId, type, { signal, notify: this.onAuthEvent, prompt })
      if (providerId === "radius") {
        const result = await this.models.refresh({ providers: [providerId], force: true, signal })
        const error = result.errors.get(providerId)
        if (error) throw error
      }
    })
  }

  async refreshCredential(providerId: string): Promise<void> {
    return this.runAuthChange(async () => {
      const auth = await this.models.getAuth(providerId, {
        minOAuthValidityMs: Number.MAX_SAFE_INTEGER,
      })
      if (!auth) throw new Error("Configure this provider before refreshing its credential")
    })
  }

  async logout(providerId: string): Promise<void> {
    return this.runAuthChange(async () => {
      await this.beforeCredentialRemoval?.()
      await this.models.logout(providerId)
    })
  }

  async invalidateCredential(providerId = OPENAI_PROVIDER_ID): Promise<void> {
    await this.beforeCredentialRemoval?.()
    await this.credentials.delete(providerId)
  }

  async requiredModelEndpointUrls(currentModel: () => Model<Api>): Promise<string[]> {
    const providerId = currentModel().provider
    const provider = this.models.getProvider(providerId)
    if (!provider) throw new Error(`Provider is unavailable: ${providerId}`)
    const credential = await this.credentials.read(provider.id)
    // Preserve the live selection read after credential lookup; the conversation owns this state.
    const urls = modelEndpointUrls(provider, currentModel(), credential)
    if (urls.length === 0) {
      throw new Error(`No browser endpoint is configured for ${provider.name}`)
    }
    return urls
  }

  private async runAuthChange(operation: () => Promise<void>): Promise<void> {
    if (this.authChanging) throw new Error("Another authentication change is already running")
    this.authChanging = true
    try {
      await operation()
    } finally {
      this.authChanging = false
    }
  }
}
