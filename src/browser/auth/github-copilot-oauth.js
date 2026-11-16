import {
  oauthErrorCode,
  pollDeviceAuthorization,
  positiveNumber,
  readJsonResponse,
  requiredString,
  throwIfAborted,
  trustedHttpUrl,
} from "./oauth-utils.js"

const GITHUB_COPILOT_OAUTH_ORIGINS = Object.freeze([
  "https://github.com/*",
  "https://api.github.com/*",
])
const CLIENT_ID = atob("SXYxLmI1MDdhMDhjODdlY2ZlOTg=")
const DEVICE_CODE_URL = "https://github.com/login/device/code"
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token"
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token"
const DEFAULT_API_URL = "https://api.individual.githubcopilot.com"
const COPILOT_HEADERS = Object.freeze({
  "Copilot-Integration-Id": "vscode-chat",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "User-Agent": "GitHubCopilotChat/0.35.0",
})

function getGitHubCopilotBaseUrl(token) {
  const proxyHost = String(token || "").match(/(?:^|;)proxy-ep=([^;]+)/u)?.[1]
  if (
    !proxyHost ||
    ![
      "proxy.individual.githubcopilot.com",
      "proxy.business.githubcopilot.com",
      "proxy.enterprise.githubcopilot.com",
    ].includes(proxyHost)
  ) {
    return DEFAULT_API_URL
  }
  return `https://${proxyHost.replace(/^proxy\./u, "api.")}`
}

async function requestJson(fetchImpl, url, init, providerName) {
  const response = await fetchImpl(url, init)
  const body = await readJsonResponse(response, providerName)
  if (!response.ok) {
    throw new Error(`${providerName} request failed (${response.status}).`)
  }
  return body
}

async function requestDevice(fetchImpl, signal) {
  const body = await requestJson(
    fetchImpl,
    DEVICE_CODE_URL,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ client_id: CLIENT_ID, scope: "read:user" }),
      signal,
    },
    "GitHub",
  )
  return {
    deviceCode: requiredString(body, "device_code", "GitHub"),
    expiresInSeconds: positiveNumber(body, "expires_in", "GitHub"),
    intervalSeconds: typeof body.interval === "number" ? body.interval : undefined,
    userCode: requiredString(body, "user_code", "GitHub"),
    verificationUri: trustedHttpUrl(
      requiredString(body, "verification_uri", "GitHub"),
      "GitHub",
      true,
    ),
  }
}

async function requestGitHubAccessToken(fetchImpl, device, signal, pollOptions) {
  return pollDeviceAuthorization({
    ...pollOptions,
    expiresInSeconds: device.expiresInSeconds,
    intervalSeconds: device.intervalSeconds,
    signal,
    async poll() {
      const response = await fetchImpl(ACCESS_TOKEN_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          device_code: device.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
        signal,
      })
      const body = await readJsonResponse(response, "GitHub")
      if (response.ok && typeof body.access_token === "string") {
        return { status: "complete", value: body.access_token }
      }
      const code = oauthErrorCode(body)
      if (code === "authorization_pending") {
        return { status: "pending" }
      }
      if (code === "slow_down") {
        return {
          status: "slow_down",
          intervalSeconds: typeof body.interval === "number" ? body.interval : undefined,
        }
      }
      if (code === "access_denied") {
        return { status: "failed", message: "GitHub login was denied." }
      }
      if (code === "expired_token") {
        return { status: "failed", message: "GitHub login expired." }
      }
      return {
        status: "failed",
        message: `GitHub device login failed (${response.status}).`,
      }
    },
  })
}

async function requestCopilotCredential(fetchImpl, githubToken, signal) {
  const body = await requestJson(
    fetchImpl,
    COPILOT_TOKEN_URL,
    {
      headers: {
        ...COPILOT_HEADERS,
        Accept: "application/json",
        Authorization: `Bearer ${githubToken}`,
      },
      signal,
    },
    "GitHub Copilot",
  )
  return {
    type: "oauth",
    access: requiredString(body, "token", "GitHub Copilot"),
    expires: positiveNumber(body, "expires_at", "GitHub Copilot") * 1000 - 5 * 60 * 1000,
    refresh: githubToken,
  }
}

function createBrowserGitHubCopilotOAuth(options = {}) {
  const fetchImpl = options.fetch || ((input, init) => globalThis.fetch(input, init))
  const pollOptions = {
    ...(options.now ? { now: options.now } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  }

  async function refresh(refreshToken, signal) {
    const credential = await requestCopilotCredential(fetchImpl, refreshToken, signal)
    // Endpoint discovery is not authorization. The selected model endpoint
    // receives its own exact-origin approval before any model request.
    return credential
  }

  return {
    name: "GitHub Copilot",
    isSubscription: true,
    async login(interaction) {
      throwIfAborted(interaction.signal)
      const device = await requestDevice(fetchImpl, interaction.signal)
      throwIfAborted(interaction.signal)
      interaction.notify({
        type: "device_code",
        expiresInSeconds: device.expiresInSeconds,
        intervalSeconds: device.intervalSeconds,
        userCode: device.userCode,
        verificationUri: device.verificationUri,
      })
      const githubToken = await requestGitHubAccessToken(
        fetchImpl,
        device,
        interaction.signal,
        pollOptions,
      )
      interaction.notify({
        type: "progress",
        message: "Configuring GitHub Copilot access…",
      })
      return refresh(githubToken, interaction.signal)
    },
    refresh(credential, signal) {
      return refresh(credential.refresh, signal)
    },
    async toAuth(credential) {
      return {
        apiKey: credential.access,
        baseUrl: getGitHubCopilotBaseUrl(credential.access),
      }
    },
  }
}

export { createBrowserGitHubCopilotOAuth, GITHUB_COPILOT_OAUTH_ORIGINS, getGitHubCopilotBaseUrl }
