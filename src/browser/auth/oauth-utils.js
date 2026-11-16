const DEFAULT_POLL_INTERVAL_SECONDS = 5
const MINIMUM_POLL_INTERVAL_MS = 1000
const SLOW_DOWN_INCREMENT_MS = 5000

function asRecord(value, message = "OAuth returned an invalid response.") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message)
  }
  return value
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new DOMException("Authentication cancelled.", "AbortError")
  }
}

function abortableSleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal)
    const abort = () => {
      clearTimeout(timer)
      reject(new DOMException("Authentication cancelled.", "AbortError"))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort)
      resolve()
    }, milliseconds)
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) {
      abort()
    }
  })
}

async function pollDeviceAuthorization(options) {
  const now = options.now || (() => Date.now())
  const sleep = options.sleep || abortableSleep
  const expiry = Number(options.expiresInSeconds || 900)
  if (!Number.isFinite(expiry) || expiry <= 0) throw new Error("Invalid device login deadline.")
  const deadline = now() + Math.min(expiry, 7200) * 1000
  const interval = Number(options.intervalSeconds)
  let intervalMs = Math.max(
    MINIMUM_POLL_INTERVAL_MS,
    (Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_POLL_INTERVAL_SECONDS) * 1000,
  )

  if (options.waitBeforeFirstPoll !== false) {
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())), options.signal)
  }

  while (now() < deadline) {
    throwIfAborted(options.signal)
    const result = await options.poll()
    if (result.status === "complete") {
      return result.value
    }
    if (result.status === "failed") {
      throw new Error(result.message)
    }
    if (result.status === "slow_down") {
      intervalMs =
        Number.isFinite(result.intervalSeconds) && result.intervalSeconds > 0
          ? Math.max(MINIMUM_POLL_INTERVAL_MS, result.intervalSeconds * 1000)
          : intervalMs + SLOW_DOWN_INCREMENT_MS
    }
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())), options.signal)
  }

  throw new Error("Device login expired.")
}

async function readJsonResponse(response, providerName) {
  try {
    return asRecord(await response.json(), `${providerName} returned an invalid response.`)
  } catch {
    // JSON parser errors can quote untrusted response bodies, including secrets.
    throw new Error(`${providerName} returned an invalid response.`)
  }
}

function requiredString(record, field, providerName) {
  const value = record[field]
  if (typeof value !== "string" || !value) {
    throw new Error(`${providerName} response is missing ${field}.`)
  }
  return value
}

function positiveNumber(record, field, providerName, fallback) {
  const value = record[field]
  if (value === undefined && fallback !== undefined) {
    return fallback
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${providerName} response has an invalid ${field}.`)
  }
  return value
}

function trustedHttpUrl(value, providerName, allowHttp = false) {
  try {
    const url = new URL(String(value || ""))
    if (
      url.username ||
      url.password ||
      url.href.length > 16384 ||
      (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:"))
    ) {
      throw new Error()
    }
    return url.href
  } catch (_error) {
    throw new Error(`${providerName} returned an untrusted sign-in URL.`)
  }
}

function base64Url(bytes) {
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "")
}

async function generatePkce(cryptoApi = globalThis.crypto) {
  const verifierBytes = new Uint8Array(32)
  cryptoApi.getRandomValues(verifierBytes)
  const verifier = base64Url(verifierBytes)
  const challenge = base64Url(
    new Uint8Array(await cryptoApi.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  )
  return { challenge, verifier }
}

function parseAuthorizationInput(input) {
  const value = String(input || "").trim()
  if (!value) {
    return {}
  }
  try {
    const url = new URL(value)
    return {
      code: url.searchParams.get("code") || undefined,
      state: url.searchParams.get("state") || undefined,
    }
  } catch (_error) {
    // A bare code is valid input.
  }
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2)
    return { code, state }
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value)
    return {
      code: params.get("code") || undefined,
      state: params.get("state") || undefined,
    }
  }
  return { code: value }
}

function oauthErrorCode(body) {
  return typeof body?.error === "string" ? body.error : ""
}

export {
  asRecord,
  generatePkce,
  oauthErrorCode,
  parseAuthorizationInput,
  pollDeviceAuthorization,
  positiveNumber,
  readJsonResponse,
  requiredString,
  throwIfAborted,
  trustedHttpUrl,
}
