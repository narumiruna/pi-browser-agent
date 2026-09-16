import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai"

export const OPENAI_PROVIDER_ID = "openai-codex"
export const AUTH_ORIGINS = ["https://auth.openai.com/*", "https://chatgpt.com/*"] as const

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const AUTH_BASE_URL = "https://auth.openai.com"
const USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`
const VERIFICATION_URI = `${AUTH_BASE_URL}/codex/device`
const REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`
const DEVICE_TIMEOUT_SECONDS = 15 * 60
const ACCOUNT_CLAIM = "https://api.openai.com/auth"

export interface DeviceAuthorization {
  deviceAuthId: string
  userCode: string
  verificationUri: string
  intervalSeconds: number
  expiresInSeconds: number
}

export interface CodexOAuthDependencies {
  fetch: typeof fetch
  now: () => number
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Login cancelled", "AbortError"))
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(new DOMException("Login cancelled", "AbortError"))
      },
      { once: true },
    )
  })
}

const defaults: CodexOAuthDependencies = {
  fetch: (input, init) => globalThis.fetch(input, init),
  now: () => Date.now(),
  sleep: defaultSleep,
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("OpenAI returned an invalid response")
  }
  return value as Record<string, unknown>
}

async function errorCode(response: Response): Promise<string> {
  const text = await response.text().catch(() => "")
  try {
    const parsed = asRecord(JSON.parse(text))
    const error = parsed.error
    if (typeof error === "string") return error
    if (typeof error === "object" && error !== null && "code" in error) {
      return typeof error.code === "string" ? error.code : ""
    }
  } catch {
    // The status is sufficient; never echo a response that may contain credentials.
  }
  return ""
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Login cancelled")
}

export function extractAccountId(accessToken: string): string {
  try {
    const parts = accessToken.split(".")
    if (parts.length !== 3 || !parts[1]) throw new Error()
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/")
    const payload = JSON.parse(
      atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")),
    ) as Record<string, unknown>
    const auth = payload[ACCOUNT_CLAIM]
    const accountId =
      typeof auth === "object" && auth !== null && "chatgpt_account_id" in auth
        ? auth.chatgpt_account_id
        : undefined
    if (typeof accountId !== "string" || accountId.length === 0 || accountId.length > 512)
      throw new Error()
    return accountId
  } catch {
    throw new Error("OpenAI access token does not contain a valid ChatGPT account ID")
  }
}

async function readCredential(response: Response, now: () => number): Promise<OAuthCredential> {
  if (!response.ok) throw new Error(`OpenAI token request failed (${response.status})`)
  const json = asRecord(await response.json())
  if (
    typeof json.access_token !== "string" ||
    typeof json.refresh_token !== "string" ||
    typeof json.expires_in !== "number" ||
    !Number.isFinite(json.expires_in) ||
    json.expires_in <= 0
  ) {
    throw new Error("OpenAI token response is missing required fields")
  }
  return {
    type: "oauth",
    access: json.access_token,
    refresh: json.refresh_token,
    expires: now() + json.expires_in * 1000,
    accountId: extractAccountId(json.access_token),
  }
}

export async function requestDeviceAuthorization(
  signal: AbortSignal,
  dependencies: Partial<CodexOAuthDependencies> = {},
): Promise<DeviceAuthorization> {
  const deps = { ...defaults, ...dependencies }
  throwIfAborted(signal)
  let response: Response
  try {
    response = await deps.fetch(USER_CODE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID }),
      signal,
    })
  } catch (error) {
    if (signal.aborted) throw new Error("Login cancelled")
    throw error
  }
  if (!response.ok) throw new Error(`OpenAI device authorization failed (${response.status})`)
  const json = asRecord(await response.json())
  const interval = typeof json.interval === "string" ? Number(json.interval) : json.interval
  if (
    typeof json.device_auth_id !== "string" ||
    typeof json.user_code !== "string" ||
    typeof interval !== "number" ||
    !Number.isFinite(interval) ||
    interval < 0
  ) {
    throw new Error("OpenAI returned an invalid device authorization")
  }
  return {
    deviceAuthId: json.device_auth_id,
    userCode: json.user_code,
    verificationUri: VERIFICATION_URI,
    intervalSeconds: interval,
    expiresInSeconds: DEVICE_TIMEOUT_SECONDS,
  }
}

export async function pollDeviceAuthorization(
  device: DeviceAuthorization,
  signal: AbortSignal,
  dependencies: Partial<CodexOAuthDependencies> = {},
): Promise<{ authorizationCode: string; codeVerifier: string }> {
  const deps = { ...defaults, ...dependencies }
  const deadline = deps.now() + device.expiresInSeconds * 1000
  let intervalMs = Math.max(1000, device.intervalSeconds * 1000)
  while (deps.now() < deadline) {
    throwIfAborted(signal)
    await deps.sleep(intervalMs, signal)
    if (deps.now() >= deadline) throw new Error("OpenAI device login expired")
    let response: Response
    try {
      response = await deps.fetch(DEVICE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }),
        signal,
      })
    } catch (error) {
      if (signal.aborted) throw new Error("Login cancelled")
      throw error
    }
    if (response.ok) {
      const json = asRecord(await response.json())
      if (typeof json.authorization_code !== "string" || typeof json.code_verifier !== "string") {
        throw new Error("OpenAI returned an invalid device token response")
      }
      return { authorizationCode: json.authorization_code, codeVerifier: json.code_verifier }
    }
    const code = await errorCode(response)
    if ([403, 404].includes(response.status) || code === "deviceauth_authorization_pending")
      continue
    if (code === "slow_down") {
      intervalMs += 5000
      continue
    }
    if (["access_denied", "authorization_declined"].includes(code)) {
      throw new Error("OpenAI device login was denied")
    }
    if (["expired_token", "device_code_expired"].includes(code)) {
      throw new Error("OpenAI device login expired")
    }
    throw new Error(`OpenAI device login failed (${response.status})`)
  }
  throw new Error("OpenAI device login expired")
}

export async function exchangeDeviceCode(
  code: { authorizationCode: string; codeVerifier: string },
  signal: AbortSignal,
  dependencies: Partial<CodexOAuthDependencies> = {},
): Promise<OAuthCredential> {
  const deps = { ...defaults, ...dependencies }
  const response = await deps.fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: code.authorizationCode,
      code_verifier: code.codeVerifier,
      redirect_uri: REDIRECT_URI,
    }),
    signal,
  })
  return readCredential(response, deps.now)
}

export async function refreshCodexCredential(
  credential: OAuthCredential,
  signal: AbortSignal,
  dependencies: Partial<CodexOAuthDependencies> = {},
): Promise<OAuthCredential> {
  const deps = { ...defaults, ...dependencies }
  const response = await deps.fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credential.refresh,
      client_id: CLIENT_ID,
    }),
    signal,
  })
  return readCredential(response, deps.now)
}

export function createBrowserCodexOAuth(
  dependencies: Partial<CodexOAuthDependencies> = {},
): OAuthAuth {
  return {
    name: "OpenAI (ChatGPT Plus/Pro)",
    isSubscription: true,
    async login(interaction: ProviderAuthInteraction) {
      const device = await requestDeviceAuthorization(interaction.signal, dependencies)
      interaction.notify({
        type: "device_code",
        userCode: device.userCode,
        verificationUri: device.verificationUri,
        intervalSeconds: device.intervalSeconds,
        expiresInSeconds: device.expiresInSeconds,
      })
      const code = await pollDeviceAuthorization(device, interaction.signal, dependencies)
      return exchangeDeviceCode(code, interaction.signal, dependencies)
    },
    refresh: (credential, signal) => refreshCodexCredential(credential, signal, dependencies),
    async toAuth(credential) {
      return { apiKey: credential.access }
    },
  }
}
