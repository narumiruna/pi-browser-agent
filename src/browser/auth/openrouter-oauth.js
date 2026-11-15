import {
  generatePkce,
  parseAuthorizationInput,
  readJsonResponse,
  throwIfAborted,
} from "./oauth-utils.js"

const OPENROUTER_OAUTH_ORIGINS = Object.freeze(["https://openrouter.ai/*"])
const AUTHORIZE_URL = "https://openrouter.ai/auth"
const TOKEN_URL = "https://openrouter.ai/api/v1/auth/keys"
const REDIRECT_URI = "http://localhost:1457/oauth/callback"

function createBrowserOpenRouterOAuth(options = {}) {
  const cryptoApi = options.crypto || globalThis.crypto
  const fetchImpl = options.fetch || ((input, init) => globalThis.fetch(input, init))

  async function exchange(code, verifier, signal) {
    throwIfAborted(signal)
    const response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code,
        code_challenge_method: "S256",
        code_verifier: verifier,
      }),
      signal,
    })
    const body = await readJsonResponse(response, "OpenRouter OAuth")
    if (!response.ok) {
      throw new Error(`OpenRouter OAuth key exchange failed (${response.status}).`)
    }
    if (typeof body.key !== "string" || !body.key) {
      throw new Error("OpenRouter OAuth response is missing the API key.")
    }
    return {
      type: "oauth",
      access: body.key,
      expires: Number.MAX_SAFE_INTEGER,
      refresh: "",
    }
  }

  return {
    name: "OpenRouter OAuth",
    loginLabel: "Sign in with OpenRouter",
    async login(interaction) {
      throwIfAborted(interaction.signal)
      const { challenge, verifier } = await generatePkce(cryptoApi)
      throwIfAborted(interaction.signal)
      const authorizeUrl = new URL(AUTHORIZE_URL)
      authorizeUrl.search = new URLSearchParams({
        callback_url: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString()
      interaction.notify({
        type: "auth_url",
        url: authorizeUrl.toString(),
        instructions:
          "Complete sign-in, then paste the final redirect URL or authorization code below.",
      })
      const input = await interaction.prompt({
        type: "manual_code",
        message: "Paste the authorization code or final redirect URL:",
        placeholder: REDIRECT_URI,
      })
      throwIfAborted(interaction.signal)
      const { code } = parseAuthorizationInput(input)
      if (!code) {
        throw new Error("OpenRouter authorization code is required.")
      }
      interaction.notify({
        type: "progress",
        message: "Exchanging the OpenRouter authorization code…",
      })
      return exchange(code, verifier, interaction.signal)
    },
    async refresh(credential) {
      return credential
    },
    async toAuth(credential) {
      return { apiKey: credential.access }
    },
  }
}

export { createBrowserOpenRouterOAuth, OPENROUTER_OAUTH_ORIGINS }
