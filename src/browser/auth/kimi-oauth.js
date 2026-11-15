import {
  oauthErrorCode,
  pollDeviceAuthorization,
  positiveNumber,
  readJsonResponse,
  requiredString,
  throwIfAborted,
  trustedHttpUrl,
} from "./oauth-utils.js"

const KIMI_OAUTH_ORIGINS = Object.freeze(["https://auth.kimi.com/*"])
const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098"
const OAUTH_BASE_URL = "https://auth.kimi.com/api/oauth"

function credentialFromResponse(body, now) {
  return {
    type: "oauth",
    access: requiredString(body, "access_token", "Kimi Code OAuth"),
    expires: now() + positiveNumber(body, "expires_in", "Kimi Code OAuth") * 1000,
    refresh: requiredString(body, "refresh_token", "Kimi Code OAuth"),
  }
}

async function postForm(fetchImpl, path, fields, signal) {
  const response = await fetchImpl(`${OAUTH_BASE_URL}/${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields),
    signal,
  })
  return {
    body: await readJsonResponse(response, "Kimi Code OAuth"),
    ok: response.ok,
    status: response.status,
  }
}

function createBrowserKimiOAuth(options = {}) {
  const fetchImpl = options.fetch || ((input, init) => globalThis.fetch(input, init))
  const now = options.now || (() => Date.now())
  const pollOptions = {
    ...(options.now ? { now: options.now } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  }

  return {
    name: "Kimi Code (subscription)",
    isSubscription: true,
    loginLabel: "Sign in with Kimi Code",
    async login(interaction) {
      throwIfAborted(interaction.signal)
      const response = await postForm(
        fetchImpl,
        "device_authorization",
        { client_id: CLIENT_ID },
        interaction.signal,
      )
      if (!response.ok) {
        throw new Error(`Kimi Code device authorization failed (${response.status}).`)
      }
      const device = {
        deviceCode: requiredString(response.body, "device_code", "Kimi Code OAuth"),
        expiresInSeconds: positiveNumber(response.body, "expires_in", "Kimi Code OAuth", 900),
        intervalSeconds: typeof response.body.interval === "number" ? response.body.interval : 5,
        userCode: requiredString(response.body, "user_code", "Kimi Code OAuth"),
        verificationUri: trustedHttpUrl(
          response.body.verification_uri_complete || response.body.verification_uri,
          "Kimi Code OAuth",
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
            "token",
            {
              client_id: CLIENT_ID,
              device_code: device.deviceCode,
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            },
            interaction.signal,
          )
          if (token.ok && typeof token.body.access_token === "string") {
            return {
              status: "complete",
              value: credentialFromResponse(token.body, now),
            }
          }
          const code = oauthErrorCode(token.body)
          if (code === "authorization_pending") {
            return { status: "pending" }
          }
          if (code === "slow_down") {
            return { status: "slow_down" }
          }
          if (code === "access_denied") {
            return { status: "failed", message: "Kimi Code login was denied." }
          }
          if (code === "expired_token") {
            return { status: "failed", message: "Kimi Code login expired." }
          }
          return {
            status: "failed",
            message: `Kimi Code device login failed (${token.status}).`,
          }
        },
      })
    },
    async refresh(credential, signal) {
      const response = await postForm(
        fetchImpl,
        "token",
        {
          client_id: CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: credential.refresh,
        },
        signal,
      )
      if (!response.ok) {
        throw new Error(`Kimi Code token refresh failed (${response.status}).`)
      }
      return credentialFromResponse(response.body, now)
    },
    async toAuth(credential) {
      return { headers: { Authorization: `Bearer ${credential.access}` } }
    },
  }
}

export { createBrowserKimiOAuth, KIMI_OAUTH_ORIGINS }
