import {
  type Api,
  type AuthPrompt,
  type Credential,
  type CredentialStore,
  createModels,
  type Model,
  type Models,
  type Provider,
} from "@earendil-works/pi-ai"
import { builtinProviders } from "@earendil-works/pi-ai/providers/all"
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex"
import { DEFAULT_MODEL_SELECTION } from "../defaults.js"
import { createBrowserCodexOAuth } from "./codex-oauth.js"
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

function browserProvider(provider: Provider): Provider {
  if (provider.id === DEFAULT_MODEL_SELECTION.provider) return createBrowserCodexProvider()
  const withoutNodeOAuth: Provider = {
    ...provider,
    auth: provider.auth.apiKey ? { apiKey: provider.auth.apiKey } : {},
  }
  if (provider.id === "azure-openai-responses") return browserAzureProvider(withoutNodeOAuth)
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
}

export interface BrowserModelRuntime {
  models: Models
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
  if (provider.id === "azure-openai-responses") {
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
