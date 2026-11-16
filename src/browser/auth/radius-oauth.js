import {
  oauthErrorCode,
  pollDeviceAuthorization,
  positiveNumber,
  readJsonResponse,
  requiredString,
  throwIfAborted,
  trustedHttpUrl,
} from "./oauth-utils.js"

const RADIUS_OAUTH_ORIGINS = Object.freeze(["https://radius.pi.dev/*"])
const GATEWAY_URL = "https://radius.pi.dev"
const CLIENT_ID = "pi-gateway"
const SCOPE = "gateway offline_access"
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
const EXPIRY_SKEW_MS = 60 * 1000

async function postForm(fetchImpl, path, fields, signal) {
  const response = await fetchImpl(new URL(path, GATEWAY_URL), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields),
    signal,
  })
  return {
    body: await readJsonResponse(response, "Radius OAuth"),
    ok: response.ok,
    status: response.status,
  }
}

function credentialFromResponse(body, now) {
  return {
    type: "oauth",
    access: requiredString(body, "access_token", "Radius OAuth"),
    expires: now() + positiveNumber(body, "expires_in", "Radius OAuth") * 1000 - EXPIRY_SKEW_MS,
    refresh: requiredString(body, "refresh_token", "Radius OAuth"),
    ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
  }
}

function createBrowserRadiusOAuth(options = {}) {
  const fetchImpl = options.fetch || ((input, init) => globalThis.fetch(input, init))
  const now = options.now || (() => Date.now())
  const pollOptions = {
    ...(options.now ? { now: options.now } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  }

  return {
    name: "Radius",
    async login(interaction) {
      throwIfAborted(interaction.signal)
      const response = await postForm(
        fetchImpl,
        "/v1/oauth/device",
        { client_id: CLIENT_ID, scope: SCOPE },
        interaction.signal,
      )
      if (!response.ok) {
        throw new Error(`Radius device authorization failed (${response.status}).`)
      }
      const device = {
        deviceCode: requiredString(response.body, "device_code", "Radius OAuth"),
        expiresInSeconds: positiveNumber(response.body, "expires_in", "Radius OAuth"),
        intervalSeconds:
          typeof response.body.interval === "number" ? response.body.interval : undefined,
        userCode: requiredString(response.body, "user_code", "Radius OAuth"),
        verificationUri: trustedHttpUrl(
          requiredString(response.body, "verification_uri", "Radius OAuth"),
          "Radius OAuth",
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
            "/v1/oauth/token",
            {
              client_id: CLIENT_ID,
              device_code: device.deviceCode,
              grant_type: DEVICE_GRANT,
            },
            interaction.signal,
          )
          if (token.ok) {
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
            return { status: "failed", message: "Radius login was denied." }
          }
          if (code === "expired_token") {
            return { status: "failed", message: "Radius login expired." }
          }
          return {
            status: "failed",
            message: `Radius device login failed (${token.status}).`,
          }
        },
      })
    },
    async refresh(credential, signal) {
      const response = await postForm(
        fetchImpl,
        "/v1/oauth/token",
        {
          client_id: CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: credential.refresh,
        },
        signal,
      )
      if (!response.ok) {
        throw new Error(`Radius token refresh failed (${response.status}).`)
      }
      return credentialFromResponse(response.body, now)
    },
    async toAuth(credential) {
      return { apiKey: credential.access }
    },
  }
}

export { createBrowserRadiusOAuth, RADIUS_OAUTH_ORIGINS }
