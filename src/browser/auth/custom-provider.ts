import { createProvider, envApiKeyAuth, type Provider } from "@earendil-works/pi-ai"
import * as responsesApi from "@earendil-works/pi-ai/api/openai-responses"

export const CUSTOM_PROVIDER_ID = "openai-compatible"

export function createCustomProvider(
  baseUrl = "https://api.openai.com/v1",
  modelId = "custom-model",
): Provider<"openai-responses"> {
  const url = new URL(baseUrl)
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !url.pathname.split("/").includes("v1")
  ) {
    throw new Error("Custom endpoints require an HTTP(S) /v1 URL without credentials or a fragment")
  }
  const endpoint = url.toString().replace(/\/+$/u, "")
  return createProvider({
    id: CUSTOM_PROVIDER_ID,
    name: "Custom OpenAI-compatible",
    baseUrl: endpoint,
    api: responsesApi,
    auth: { apiKey: envApiKeyAuth("API key", []) },
    models: [
      {
        id: modelId,
        name: modelId,
        api: "openai-responses",
        provider: CUSTOM_PROVIDER_ID,
        baseUrl: endpoint,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      },
    ],
  })
}
