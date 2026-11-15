import { getSupportedThinkingLevels, type ThinkingLevel } from "@earendil-works/pi-ai"
import { browserOAuthOrigins } from "../auth/browser-oauth.js"
import { CUSTOM_PROVIDER_ID, createCustomProvider } from "../auth/custom-provider.js"
import { modelEndpointUrls } from "../auth/provider.js"
import type { BrowserConfiguration } from "../configuration.js"
import { hasApprovedHostPermission } from "../permissions.js"
import { boundedResponse } from "../runtime/bounded-response.js"
import { withTranslationSlot } from "./concurrency.js"
import type * as Settings from "./shared/settings.js"

function configurationError(message: string): Error {
  const error = new Error(message)
  error.name = "ConfigurationError"
  return error
}

export type TranslationSettings = Awaited<ReturnType<typeof Settings.getSettings>>

/** Text-only translation uses the shared trusted configuration, not an Agent or worker. */
export class TranslationProvider {
  private endpointSnapshot?: readonly string[]
  constructor(readonly configuration: BrowserConfiguration) {}

  async scoped(settings: TranslationSettings): Promise<TranslationProvider> {
    const provider = new TranslationProvider(this.configuration)
    provider.endpointSnapshot = await this.resolveEndpoints(settings)
    return provider
  }

  async getModel(settings: TranslationSettings) {
    if (settings.provider === CUSTOM_PROVIDER_ID) {
      const model = createCustomProvider(settings.customBaseUrl, settings.model).getModels()[0]
      if (!model) throw configurationError("Custom translation model is unavailable")
      return model
    }
    const model = this.configuration.models.getModel(settings.provider, settings.model)
    if (!model) throw configurationError("The selected translation model is unavailable")
    return model
  }

  async assertConfigured(settings: TranslationSettings) {
    const model = await this.getModel(settings)
    const credential = await this.configuration.credentials.read(model.provider)
    if (
      credential?.type === "oauth" &&
      !(
        await Promise.all(browserOAuthOrigins(model.provider).map(hasApprovedHostPermission))
      ).every(Boolean)
    )
      throw configurationError(
        "Account authentication permission is required. Configure the provider again.",
      )
    if (!(await this.configuration.models.checkAuth(model.provider))) {
      throw configurationError(
        "Configure a credential for the selected translation provider in Settings",
      )
    }
    return model
  }

  private async resolveEndpoints(
    settings: TranslationSettings,
    selectedModel?: Awaited<ReturnType<TranslationProvider["getModel"]>>,
  ): Promise<string[]> {
    const model = selectedModel ?? (await this.getModel(settings))
    const provider = this.configuration.models.getProvider(model.provider)
    if (!provider) throw configurationError("Translation provider is unavailable")
    const credential = await this.configuration.credentials.read(provider.id)
    return modelEndpointUrls(provider, model, credential).map((value) => {
      const url = new URL(value)
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw configurationError("Translation endpoint is invalid")
      }
      return url.href
    })
  }

  async getModelEndpointPatterns(settings: TranslationSettings): Promise<string[]> {
    return (this.endpointSnapshot ?? (await this.resolveEndpoints(settings))).map(
      (value) => new URL(value).origin,
    )
  }

  async getModelCacheIdentity(settings: TranslationSettings): Promise<string> {
    const identity = JSON.stringify(
      this.endpointSnapshot ?? (await this.resolveEndpoints(settings)),
    )
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity))
    return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, "0")).join("")
  }

  async complete(
    settings: TranslationSettings,
    input: { systemPrompt: string; userPrompt: string },
    options: { signal?: AbortSignal; validate?: () => Promise<unknown> } = {},
  ): Promise<{ text: string }> {
    options = {
      ...options,
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)])
        : AbortSignal.timeout(120_000),
    }
    options.signal?.throwIfAborted()
    await options.validate?.()
    const model = await this.assertConfigured(settings)
    const endpointUrls = await this.resolveEndpoints(settings, model)
    if (
      this.endpointSnapshot &&
      JSON.stringify(endpointUrls) !== JSON.stringify(this.endpointSnapshot)
    )
      throw configurationError("The selected translation endpoint changed. Start again explicitly.")
    const bases = endpointUrls.map((value) => new URL(value))
    const endpoints = bases.map((value) => value.origin)
    if (
      endpoints.length === 0 ||
      !(await Promise.all(endpoints.map(hasApprovedHostPermission))).every(Boolean)
    ) {
      throw configurationError("Translation endpoint permission is required")
    }
    options.signal?.throwIfAborted()
    const secrets = new Set<string>()
    const collect = (value: unknown): void => {
      if (!value || typeof value !== "object") return
      for (const [key, item] of Object.entries(value)) {
        if (
          typeof item === "string" &&
          item &&
          ["access", "refresh", "key", "apiKey", "value"].includes(key)
        )
          secrets.add(item)
        else if (key === "value" && item && typeof item === "object") collect(item)
      }
    }
    const credentialAtStart = await this.configuration.credentials.read(model.provider)
    collect(credentialAtStart)
    const thinking = settings.thinkingLevel
    const supported = getSupportedThinkingLevels(model)
    const selected = supported.find((level) => level === thinking)
    // The locked SDK runtime handles max; SimpleStreamOptions still omits that level.
    const reasoning = selected && selected !== "off" ? (selected as ThinkingLevel) : undefined
    let dispatchDenied = false
    const response = await withTranslationSlot(async () => {
      await options.validate?.()
      options.signal?.throwIfAborted()
      return this.configuration.models.completeSimple(
        model,
        {
          systemPrompt: input.systemPrompt,
          messages: [{ role: "user", content: input.userPrompt, timestamp: Date.now() }],
        },
        {
          signal: options.signal,
          transport: "sse",
          maxRetries: 0,
          disableContinuation: true,
          ...(reasoning ? { reasoning } : {}),
          fetch: async (input, init) => {
            options.signal?.throwIfAborted()
            const url = new URL(input instanceof Request ? input.url : input)
            if (
              !bases.some(
                (base) =>
                  base.origin === url.origin &&
                  (url.pathname === base.pathname.replace(/\/+$/u, "") ||
                    url.pathname.startsWith(`${base.pathname.replace(/\/+$/u, "")}/`)),
              ) ||
              url.hash ||
              url.username ||
              url.password ||
              !(await hasApprovedHostPermission(url))
            ) {
              dispatchDenied = true
              throw configurationError("Translation endpoint changed or access was revoked")
            }
            options.signal?.throwIfAborted()
            await options.validate?.()
            options.signal?.throwIfAborted()
            const headers = new Headers(
              init?.headers ?? (input instanceof Request ? input.headers : undefined),
            )
            for (const name of ["authorization", "x-api-key", "api-key", "x-goog-api-key"]) {
              const value = headers.get(name)
              if (value) secrets.add(value.replace(/^Bearer\s+/iu, ""))
            }
            return boundedResponse(
              await fetch(input, {
                ...init,
                signal: AbortSignal.any([
                  ...(options.signal ? [options.signal] : []),
                  ...(init?.signal
                    ? [init.signal]
                    : input instanceof Request
                      ? [input.signal]
                      : []),
                ]),
                credentials: "omit",
                redirect: "error",
              }),
              2_097_152,
            )
          },
        },
      )
    }, options.signal)
    options.signal?.throwIfAborted()
    if (dispatchDenied)
      throw configurationError("Translation endpoint changed or access was revoked")
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error("The translation provider request failed")
    }
    const text = response.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n")
    const credentialAtEnd = await this.configuration.credentials.read(model.provider)
    collect(credentialAtEnd)
    if (
      !credentialAtEnd ||
      credentialAtStart?.type !== credentialAtEnd.type ||
      (credentialAtEnd.type === "api_key" &&
        JSON.stringify(credentialAtStart) !== JSON.stringify(credentialAtEnd)) ||
      (credentialAtStart?.type === "oauth" &&
        credentialAtEnd.type === "oauth" &&
        credentialAtStart.accountId !== credentialAtEnd.accountId)
    )
      throw configurationError("The translation credential changed")
    await this.assertConfigured(settings)
    if (!(await Promise.all(endpoints.map(hasApprovedHostPermission))).every(Boolean))
      throw configurationError("Translation endpoint permission was revoked")
    options.signal?.throwIfAborted()
    let candidate = text
    try {
      candidate += JSON.stringify(JSON.parse(text))
    } catch {
      /* The translation parser reports malformed JSON. */
    }
    if ([...secrets].some((value) => candidate.includes(value)))
      throw configurationError("The provider returned sensitive authentication data")
    if (!text || text.length > 131_072)
      throw new Error("The translation response is empty or too large")
    return { text }
  }
}
