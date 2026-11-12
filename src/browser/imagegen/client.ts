import { extractAccountId } from "../auth/codex-oauth.js"
import { MAX_GENERATED_IMAGE_BYTES } from "./image.js"

export const IMAGE_ENDPOINT = "https://chatgpt.com/backend-api/codex/images/generations"
export const MAX_IMAGE_PROMPT_CHARS = 32_000
export const MAX_IMAGE_RESPONSE_BYTES = Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4 + 65_536
export const IMAGE_REQUEST_TIMEOUT_MS = 300_000
export const IMAGE_AUTH_TIMEOUT_MS = 30_000

export class ImagegenError extends Error {}

export interface ImageRequest {
  prompt: string
  transparentBackground: boolean
  size: string
}

export async function imagegenWait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let aborted = () => {}
  const cancellation = new Promise<never>((_resolve, reject) => {
    aborted = () => reject(signal.reason)
    signal.addEventListener("abort", aborted, { once: true })
    if (signal.aborted) aborted()
  })
  try {
    return await Promise.race([cancellation, promise])
  } finally {
    signal.removeEventListener("abort", aborted)
  }
}

function accountId(token: string): string {
  try {
    if (token.length > 32_768) throw new Error()
    const parts = token.split(".")
    if (
      parts.length !== 3 ||
      parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part) || part.length % 4 === 1)
    )
      throw new Error()
    const headerPart = parts[0]
    if (!headerPart) throw new Error()
    const header = JSON.parse(atob(headerPart.replace(/-/g, "+").replace(/_/g, "/")))
    if (
      typeof header?.alg !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(header.alg) ||
      header.alg.toLowerCase() === "none"
    )
      throw new Error()
    const id = extractAccountId(token)
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(id)) throw new Error()
    return id
  } catch {
    throw new ImagegenError("Image generation requires a valid OpenAI Codex account login")
  }
}

function statusError(status: number): ImagegenError {
  if (status === 401)
    return new ImagegenError(
      "Image authentication was rejected (401). Sign in to OpenAI Codex again.",
    )
  if (status === 403)
    return new ImagegenError("Image access was denied (403). Check account entitlement and policy.")
  if (status === 429)
    return new ImagegenError("Image quota or rate limit reached (429). Check your account limits.")
  return new ImagegenError("The image endpoint rejected the request. No automatic retry was made.")
}

function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined)
}

/** One fixed-endpoint JSON request. The caller owns authentication and the total deadline. */
export async function generateImageRequest(
  token: string,
  request: ImageRequest,
  signal: AbortSignal,
): Promise<{ base64: string; requestId?: string }> {
  const id = accountId(token)
  signal.throwIfAborted()
  let response: Response | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const pending = fetch(IMAGE_ENDPOINT, {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "ChatGPT-Account-ID": id,
        originator: "pi-browser-agent",
      },
      body: JSON.stringify({
        prompt: request.prompt,
        background: request.transparentBackground ? "transparent" : "opaque",
        model: "gpt-image-2",
        quality: "auto",
        size: request.size,
      }),
    })
    void pending.then(
      (late) => {
        if (signal.aborted) cancelBody(late)
      },
      () => undefined,
    )
    response = await imagegenWait(pending, signal)
    signal.throwIfAborted()
    if (response.redirected) throw new ImagegenError("Image endpoint redirects are not allowed")
    if (!response.ok) throw statusError(response.status)
    const invalid = () => new ImagegenError("The image endpoint returned invalid image JSON")
    if (
      response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
      "application/json"
    )
      throw invalid()
    const length = response.headers.get("content-length")
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_IMAGE_RESPONSE_BYTES))
      throw new ImagegenError("The image response exceeds the size limit")
    if (!response.body) throw invalid()
    reader = response.body.getReader()
    let buffer = new Uint8Array(65_536)
    let bytes = 0
    for (;;) {
      const chunk = await imagegenWait(reader.read(), signal)
      signal.throwIfAborted()
      if (chunk.done) break
      const nextSize = bytes + chunk.value.byteLength
      if (nextSize > MAX_IMAGE_RESPONSE_BYTES)
        throw new ImagegenError("The image response exceeds the size limit")
      if (nextSize > buffer.byteLength) {
        const next = new Uint8Array(
          Math.min(MAX_IMAGE_RESPONSE_BYTES, Math.max(nextSize, buffer.byteLength * 2)),
        )
        next.set(buffer.subarray(0, bytes))
        buffer = next
      }
      buffer.set(chunk.value, bytes)
      bytes = nextSize
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes)),
      )
    } catch {
      throw invalid()
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("data" in parsed) ||
      !Array.isArray(parsed.data) ||
      parsed.data.length !== 1
    )
      throw invalid()
    const image: unknown = parsed.data[0]
    if (
      typeof image !== "object" ||
      image === null ||
      !("b64_json" in image) ||
      typeof image.b64_json !== "string"
    )
      throw invalid()
    const requestId = response.headers.get("x-codex-imagegen-request-id")
    return {
      base64: image.b64_json,
      ...(requestId && /^[A-Za-z0-9_-]{1,128}$/.test(requestId) ? { requestId } : {}),
    }
  } finally {
    if (reader) {
      void reader.cancel().catch(() => undefined)
      reader.releaseLock()
    } else if (response) cancelBody(response)
  }
}
