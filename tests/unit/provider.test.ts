import type { Api, AuthPrompt, Credential, Model, Provider } from "@earendil-works/pi-ai"
import { builtinProviders } from "@earendil-works/pi-ai/providers/all"
import { describe, expect, test } from "vitest"
import {
  BROWSER_EXCLUDED_PROVIDERS,
  createBrowserProviders,
  modelEndpointUrls,
  RADIUS_CONFIG_URL,
} from "../../src/browser/auth/provider.js"

function provider(id: string): Provider {
  const result = createBrowserProviders().find((candidate) => candidate.id === id)
  if (!result) throw new Error(`Missing provider: ${id}`)
  return result
}

function model(id: string): Model<Api> {
  const result = provider(id).getModels()[0]
  if (!result) throw new Error(`Missing model for provider: ${id}`)
  return result
}

describe("browser pi-ai providers", () => {
  test("registers every built-in provider except the Node-only Bedrock adapter", () => {
    const providers = createBrowserProviders()
    const ids = providers.map((candidate) => candidate.id)

    expect(ids).toEqual(
      builtinProviders()
        .map((provider) => provider.id)
        .filter((id) => !BROWSER_EXCLUDED_PROVIDERS.some((excluded) => excluded === id)),
    )
    expect(ids).toContain("anthropic")
    expect(ids).toContain("google")
    expect(ids).toContain("openrouter")
    expect(ids).toContain("radius")
    expect(ids).not.toContain(BROWSER_EXCLUDED_PROVIDERS[0])
    const codex = providers.find((candidate) => candidate.id === "openai-codex")
    const openai = providers.find((candidate) => candidate.id === "openai")
    expect(codex?.auth.oauth).toBeDefined()
    expect(codex?.auth.apiKey).toBeUndefined()
    expect(openai?.auth.apiKey?.login).toBeDefined()
    expect(openai?.auth.oauth).toBeUndefined()
    for (const provider of providers.filter((candidate) => candidate.id !== "openai-codex")) {
      expect(provider.auth.oauth, provider.id).toBeUndefined()
    }
  })

  test("collects Azure browser configuration in its stored credential", async () => {
    const azure = provider("azure-openai-responses")
    const answers = [
      "azure-key",
      "https://demo.openai.azure.com",
      "2025-04-01-preview",
      "gpt-5=prod",
    ]
    const credential = await azure.auth.apiKey?.login?.({
      signal: new AbortController().signal,
      notify() {},
      async prompt(_prompt: AuthPrompt) {
        return answers.shift() ?? ""
      },
    })

    expect(credential).toEqual({
      type: "api_key",
      key: "azure-key",
      env: {
        AZURE_OPENAI_BASE_URL: "https://demo.openai.azure.com",
        AZURE_OPENAI_API_VERSION: "2025-04-01-preview",
        AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "gpt-5=prod",
      },
    })
  })

  test("limits Vertex setup to its browser-usable API-key path", async () => {
    const vertex = provider("google-vertex")
    const prompts: AuthPrompt[] = []
    const credential = await vertex.auth.apiKey?.login?.({
      signal: new AbortController().signal,
      notify() {},
      async prompt(value) {
        prompts.push(value)
        return "vertex-key"
      },
    })

    expect(prompts).toEqual([{ type: "secret", message: "Enter Google Cloud API key" }])
    expect(credential).toEqual({ type: "api_key", key: "vertex-key" })
  })

  test("resolves permission endpoints without exposing credential secrets", () => {
    const azureCredential: Credential = {
      type: "api_key",
      key: "secret",
      env: { AZURE_OPENAI_BASE_URL: "https://demo.openai.azure.com/openai/v1" },
    }

    expect(
      modelEndpointUrls(
        provider("azure-openai-responses"),
        model("azure-openai-responses"),
        azureCredential,
      ),
    ).toEqual(["https://demo.openai.azure.com/openai/v1"])
    expect(modelEndpointUrls(provider("google-vertex"), model("google-vertex"))).toEqual([
      "https://aiplatform.googleapis.com",
    ])
    expect(modelEndpointUrls(provider("radius"), {} as Model<Api>)).toEqual([RADIUS_CONFIG_URL])
  })
})
