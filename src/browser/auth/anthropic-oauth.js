import {
  generatePkce,
  parseAuthorizationInput,
  positiveNumber,
  readJsonResponse,
  requiredString,
  throwIfAborted,
} from "./oauth-utils.js"

const ANTHROPIC_OAUTH_ORIGINS = Object.freeze([
  "https://claude.ai/*",
  "https://platform.claude.com/*",
])
const CLIENT_ID = atob("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl")
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize"
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
const REDIRECT_URI = "http://localhost:53692/callback"
const SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"
const EXPIRY_SKEW_MS = 5 * 60 * 1000

function credentialFromResponse(body, now) {
  return {
    type: "oauth",
    access: requiredString(body, "access_token", "Anthropic OAuth"),
    refresh: requiredString(body, "refresh_token", "Anthropic OAuth"),
    expires: now() + positiveNumber(body, "expires_in", "Anthropic OAuth") * 1000 - EXPIRY_SKEW_MS,
  }
}

async function requestCredential(fields, signal, dependencies) {
  throwIfAborted(signal)
  const response = await dependencies.fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(fields),
    signal,
  })
  const body = await readJsonResponse(response, "Anthropic OAuth")
  if (!response.ok) {
    throw new Error(`Anthropic OAuth token request failed (${response.status}).`)
  }
  return credentialFromResponse(body, dependencies.now)
}

function createBrowserAnthropicOAuth(options = {}) {
  const dependencies = {
    crypto: options.crypto || globalThis.crypto,
    fetch: options.fetch || ((input, init) => globalThis.fetch(input, init)),
    now: options.now || (() => Date.now()),
  }

  return {
    name: "Anthropic (Claude Pro/Max)",
    isSubscription: true,
    async login(interaction) {
      throwIfAborted(interaction.signal)
      const { challenge, verifier } = await generatePkce(dependencies.crypto)
      const stateBytes = new Uint8Array(32)
      dependencies.crypto.getRandomValues(stateBytes)
      const expectedState = Array.from(stateBytes, (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("")
      throwIfAborted(interaction.signal)
      const authorizeUrl = new URL(AUTHORIZE_URL)
      authorizeUrl.search = new URLSearchParams({
        client_id: CLIENT_ID,
        code: "true",
        code_challenge: challenge,
        code_challenge_method: "S256",
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope: SCOPES,
        state: expectedState,
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
      const value = String(input || "").trim()
      const { code, state } = parseAuthorizationInput(value)
      if (!code) {
        throw new Error("Anthropic OAuth authorization code is required.")
      }
      // The SDK permits a manually copied bare code with local state.
      // A structured callback must contain the exact returned state (RFC 6749).
      let isCallback = value.includes("#") || value.includes("code=")
      try {
        new URL(value)
        isCallback = true
      } catch {
        /* Bare codes are not URLs. */
      }
      if ((isCallback || state !== undefined) && state !== expectedState) {
        throw new Error("Anthropic OAuth state mismatch.")
      }
      interaction.notify({
        type: "progress",
        message: "Exchanging the Anthropic authorization code…",
      })
      return requestCredential(
        {
          client_id: CLIENT_ID,
          code,
          code_verifier: verifier,
          grant_type: "authorization_code",
          redirect_uri: REDIRECT_URI,
          state: expectedState,
        },
        interaction.signal,
        dependencies,
      )
    },
    refresh(credential, signal) {
      return requestCredential(
        {
          client_id: CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: credential.refresh,
        },
        signal,
        dependencies,
      )
    },
    async toAuth(credential) {
      return { apiKey: credential.access }
    },
  }
}

export { ANTHROPIC_OAUTH_ORIGINS, createBrowserAnthropicOAuth }
