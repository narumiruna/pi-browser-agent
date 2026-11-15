import {
  type Api,
  type AuthPrompt,
  type Credential,
  type CredentialStore,
  createModels,
  isModelType,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai"
import { builtinProviders } from "@earendil-works/pi-ai/providers/all"
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex"
import {
  getRadiusCredentialConfig,
  getRadiusModels,
  getRadiusModelsFromConfig,
} from "@earendil-works/pi-ai/providers/radius-config"
import { DEFAULT_MODEL_SELECTION } from "../defaults.js"
import { hasApprovedHostPermission } from "../permissions.js"
import { boundedResponse } from "../runtime/bounded-response.js"
import { browserOAuth } from "./browser-oauth.js"
import { createBrowserCodexOAuth } from "./codex-oauth.js"
import { createCustomProvider } from "./custom-provider.js"
import { getGitHubCopilotBaseUrl } from "./github-copilot-oauth.js"
export const RADIUS_CONFIG_URL = "https://radius.pi.dev/v1/config"

/** The pi-ai Bedrock adapter intentionally loads a Node-only AWS SDK module. */
export const BROWSER_EXCLUDED_PROVIDERS = ["amazon-bedrock"] as const

function requiredPromptValue(value: string, prompt: AuthPrompt): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${prompt.message} is required`)
  return normalized
}

function browserAzureProvider(provider: Provider): Provider {
  const apiKey = provider.auth.apiKey
  if (!apiKey) return provider
  return {
    ...provider,
    auth: {
      apiKey: {
        ...apiKey,
        async login(interaction) {
          const keyPrompt = { type: "secret" as const, message: "Enter Azure OpenAI API key" }
          const urlPrompt = {
            type: "text" as const,
            message: "Enter Azure OpenAI base URL",
            placeholder: "https://RESOURCE.openai.azure.com",
          }
          const key = requiredPromptValue(await interaction.prompt(keyPrompt), keyPrompt)
          const baseUrl = requiredPromptValue(await interaction.prompt(urlPrompt), urlPrompt)
          const apiVersion = (
            await interaction.prompt({
              type: "text",
              message: "Enter Azure API version (leave blank for v1)",
              placeholder: "v1",
            })
          ).trim()
          const deploymentMap = (
            await interaction.prompt({
              type: "text",
              message: "Optional model-to-deployment map (model=deployment, comma-separated)",
            })
          ).trim()
          return {
            type: "api_key",
            key,
            env: {
              AZURE_OPENAI_BASE_URL: baseUrl,
              ...(apiVersion ? { AZURE_OPENAI_API_VERSION: apiVersion } : {}),
              ...(deploymentMap ? { AZURE_OPENAI_DEPLOYMENT_NAME_MAP: deploymentMap } : {}),
            },
          }
        },
      },
    },
  }
}

function browserVertexProvider(provider: Provider): Provider {
  const apiKey = provider.auth.apiKey
  if (!apiKey) return provider
  return {
    ...provider,
    auth: {
      apiKey: {
        ...apiKey,
        async login(interaction) {
          const prompt = { type: "secret" as const, message: "Enter Google Cloud API key" }
          return {
            type: "api_key",
            key: requiredPromptValue(await interaction.prompt(prompt), prompt),
          }
        },
      },
    },
  }
}

function browserRadiusProvider(provider: Provider): Provider {
  let models = provider.getModels()
  return {
    ...provider,
    getModels: () => models,
    async refreshModels(context) {
      const stored =
        context.stored?.models ??
        (context.credential?.type === "oauth"
          ? getRadiusModels(provider.id, context.credential)
          : [])
      if (context.stored || stored.length) {
        const published = await context.publish({
          update: () => {
            models = stored
              .filter((model) => isModelType(model, "chat"))
              .filter((model) => model.provider === provider.id)
          },
        })
        if (!published) return
      }
      if (
        !context.allowNetwork ||
        context.signal.aborted ||
        !(await hasApprovedHostPermission(RADIUS_CONFIG_URL))
      )
        return
      const credential = context.credential
      const key = credential?.type === "oauth" ? credential.access : credential?.key
      if (!key) return
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(30000)])
      const response = await boundedResponse(
        await fetch(RADIUS_CONFIG_URL, {
          credentials: "omit",
          redirect: "error",
          signal,
          headers: key ? { Authorization: `Bearer ${key}` } : {},
        }),
        524288,
      )
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error("Radius model catalog request failed")
      }
      let config: Parameters<typeof getRadiusModelsFromConfig>[1]
      try {
        config = await response.json()
      } catch {
        throw new Error("Radius model catalog is invalid")
      }
      const privateValues =
        credential?.type === "oauth" ? [credential.access, credential.refresh] : [String(key)]
      if (privateValues.some((value) => value && JSON.stringify(config).includes(value)))
        throw new Error("Radius model catalog contains authentication data")
      // This SDK helper only sanitizes gateway metadata; it does not use tokens.
      const validated = getRadiusCredentialConfig({
        type: "oauth",
        access: "",
        refresh: "",
        expires: 0,
        gatewayConfig: config,
      })
      if (
        !validated ||
        validated.models.length !== config.models.length ||
        validated.models.some(
          (model) =>
            !model.id.trim() ||
            !model.name.trim() ||
            !model.input.length ||
            model.input.some((kind) => !["text", "image"].includes(kind)) ||
            ![model.contextWindow, model.maxTokens].every(
              (value) => Number.isFinite(value) && value > 0,
            ) ||
            ![
              model.cost.input,
              model.cost.output,
              model.cost.cacheRead,
              model.cost.cacheWrite,
            ].every((value) => Number.isFinite(value) && value >= 0),
        )
      )
        throw new Error("Radius model catalog is invalid")
      const endpoint = new URL(validated.baseUrl)
      if (
        !["http:", "https:"].includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password
      )
        throw new Error("Radius model catalog is invalid")
      const refreshed = getRadiusModelsFromConfig(provider.id, validated)
      if (!signal.aborted && (await hasApprovedHostPermission(RADIUS_CONFIG_URL)))
        await context.publish({
          persist: { models: refreshed, checkedAt: Date.now() },
          update: () => {
            models = refreshed
          },
        })
    },
  }
}

function browserProvider(provider: Provider): Provider {
  if (provider.id === DEFAULT_MODEL_SELECTION.provider) return createBrowserCodexProvider()
  const oauth = browserOAuth(provider.id)
  const withoutNodeOAuth: Provider = {
    ...provider,
    auth: {
      ...(provider.auth.apiKey ? { apiKey: provider.auth.apiKey } : {}),
      ...(oauth ? { oauth } : {}),
    },
  }
  if (provider.id === "radius") return browserRadiusProvider(withoutNodeOAuth)
  if (provider.id === "azure") return browserAzureProvider(withoutNodeOAuth)
  if (provider.id === "google-vertex") return browserVertexProvider(withoutNodeOAuth)
  return withoutNodeOAuth
}

export function createBrowserCodexProvider(): Provider<"openai-codex-responses"> {
  const provider = openaiCodexProvider()
  return {
    ...provider,
    auth: { oauth: createBrowserCodexOAuth() },
  }
}

export function createBrowserProviders(): Provider[] {
  const excluded = new Set<string>(BROWSER_EXCLUDED_PROVIDERS)
  return builtinProviders()
    .filter((provider) => !excluded.has(provider.id))
    .map(browserProvider)
    .concat({ ...createCustomProvider(), getModels: () => [] })
}

export interface BrowserModelRuntime {
  models: ReturnType<typeof createModels>
  defaultModel: Model<Api>
}

export function createBrowserModels(credentials: CredentialStore): BrowserModelRuntime {
  const models = createModels({
    credentials,
    authContext: {
      async env() {
        return undefined
      },
      async fileExists() {
        return false
      },
    },
  })
  for (const provider of createBrowserProviders()) models.setProvider(provider)
  const defaultModel = models.getModel(DEFAULT_MODEL_SELECTION.provider, DEFAULT_MODEL_SELECTION.id)
  if (!defaultModel) {
    throw new Error(
      `Bundled default model is unavailable: ${DEFAULT_MODEL_SELECTION.provider}/${DEFAULT_MODEL_SELECTION.id}`,
    )
  }
  return { models, defaultModel }
}

export function modelEndpointUrls(
  provider: Provider,
  model: Model<Api>,
  credential?: Credential,
): string[] {
  if (provider.id === "github-copilot" && credential?.type === "oauth") {
    return [getGitHubCopilotBaseUrl(credential.access)]
  }
  if (provider.id === "azure") {
    const configured =
      credential?.type === "api_key" ? credential.env?.AZURE_OPENAI_BASE_URL : undefined
    return configured ? [configured] : []
  }
  if (provider.id === "google-vertex") return ["https://aiplatform.googleapis.com"]
  if (provider.id === "radius") {
    return [RADIUS_CONFIG_URL, ...(model.baseUrl ? [model.baseUrl] : [])]
  }
  const endpoint = model.baseUrl ?? provider.baseUrl
  return endpoint ? [endpoint] : []
}
