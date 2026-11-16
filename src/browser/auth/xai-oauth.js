import {
  oauthErrorCode,
  pollDeviceAuthorization,
  positiveNumber,
  readJsonResponse,
  requiredString,
  throwIfAborted,
  trustedHttpUrl,
} from "./oauth-utils.js"

const XAI_OAUTH_ORIGINS = Object.freeze(["https://auth.x.ai/*"])
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
const SCOPE = "openid profile email offline_access grok-cli:access api:access"
const DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code"
const TOKEN_URL = "https://auth.x.ai/oauth2/token"
const EXPIRY_SKEW_MS = 5 * 60 * 1000

async function postForm(fetchImpl, url, fields, signal) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields),
    signal,
  })
  return {
    body: await readJsonResponse(response, "xAI OAuth"),
    ok: response.ok,
    status: response.status,
  }
}

function credentialFromResponse(body, previousRefresh, now) {
  return {
    type: "oauth",
    access: requiredString(body, "access_token", "xAI OAuth"),
    expires: now() + positiveNumber(body, "expires_in", "xAI OAuth", 3600) * 1000 - EXPIRY_SKEW_MS,
    refresh:
      typeof body.refresh_token === "string" && body.refresh_token
        ? body.refresh_token
        : previousRefresh || requiredString(body, "refresh_token", "xAI OAuth"),
  }
}

function createBrowserXaiOAuth(options = {}) {
  const fetchImpl = options.fetch || ((input, init) => globalThis.fetch(input, init))
  const now = options.now || (() => Date.now())
  const pollOptions = {
    ...(options.now ? { now: options.now } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  }

  return {
    name: "xAI (Grok/X subscription)",
    isSubscription: true,
    loginLabel: "Sign in with SuperGrok or X Premium",
    async login(interaction) {
      throwIfAborted(interaction.signal)
      const response = await postForm(
        fetchImpl,
        DEVICE_CODE_URL,
        { client_id: CLIENT_ID, referrer: "pi", scope: SCOPE },
        interaction.signal,
      )
      if (!response.ok) {
        throw new Error(`xAI device authorization failed (${response.status}).`)
      }
      const device = {
        deviceCode: requiredString(response.body, "device_code", "xAI OAuth"),
        expiresInSeconds: positiveNumber(response.body, "expires_in", "xAI OAuth"),
        intervalSeconds:
          typeof response.body.interval === "number" ? response.body.interval : undefined,
        userCode: requiredString(response.body, "user_code", "xAI OAuth"),
        verificationUri: trustedHttpUrl(
          response.body.verification_uri_complete || response.body.verification_uri,
          "xAI OAuth",
        ),
      }
      throwIfAborted(interaction.signal)
      interaction.notify({
        type: "device_code",
        expiresInSeconds: device.expiresInSeconds,
        intervalSeconds: device.intervalSeconds,
        userCode: device.userCode,
        verificationUri: device.verificationUri,
      })
      return pollDeviceAuthorization({
        ...pollOptions,
        expiresInSeconds: device.expiresInSeconds,
        intervalSeconds: device.intervalSeconds,
        signal: interaction.signal,
        async poll() {
          const token = await postForm(
            fetchImpl,
            TOKEN_URL,
            {
              client_id: CLIENT_ID,
              device_code: device.deviceCode,
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            },
            interaction.signal,
          )
          if (token.ok) {
            return {
              status: "complete",
              value: credentialFromResponse(token.body, undefined, now),
            }
          }
          const code = oauthErrorCode(token.body)
          if (code === "authorization_pending") {
            return { status: "pending" }
          }
          if (code === "slow_down") {
            return { status: "slow_down" }
          }
          if (["access_denied", "authorization_denied"].includes(code)) {
            return { status: "failed", message: "xAI login was denied." }
          }
          if (code === "expired_token") {
            return { status: "failed", message: "xAI login expired." }
          }
          return {
            status: "failed",
            message: `xAI device login failed (${token.status}).`,
          }
        },
      })
    },
    async refresh(credential, signal) {
      const response = await postForm(
        fetchImpl,
        TOKEN_URL,
        {
          client_id: CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: credential.refresh,
        },
        signal,
      )
      if (!response.ok) {
        throw new Error(`xAI token refresh failed (${response.status}).`)
      }
      return credentialFromResponse(response.body, credential.refresh, now)
    },
    async toAuth(credential) {
      return { apiKey: credential.access }
    },
  }
}

export { createBrowserXaiOAuth, XAI_OAUTH_ORIGINS }
