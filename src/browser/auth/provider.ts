import {
  type CredentialStore,
  createModels,
  type Model,
  type Models,
  type Provider,
} from "@earendil-works/pi-ai"
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex"
import { createBrowserCodexOAuth } from "./codex-oauth.js"

export const DEFAULT_CODEX_MODEL = "gpt-5.4"

export function createBrowserCodexProvider(): Provider<"openai-codex-responses"> {
  const provider = openaiCodexProvider()
  return {
    ...provider,
    auth: { oauth: createBrowserCodexOAuth() },
  }
}

export function createBrowserModels(credentials: CredentialStore): {
  models: Models
  model: Model<"openai-codex-responses">
} {
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
  models.setProvider(createBrowserCodexProvider())
  const model = models.getModel("openai-codex", DEFAULT_CODEX_MODEL)
  if (model?.api !== "openai-codex-responses") {
    throw new Error(`Bundled Codex model is unavailable: ${DEFAULT_CODEX_MODEL}`)
  }
  return { models, model: model as Model<"openai-codex-responses"> }
}
