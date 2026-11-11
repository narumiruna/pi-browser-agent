import type { AgentTool } from "@earendil-works/pi-agent-core"
import { Type } from "typebox"
import type { ConfirmationHandler } from "../agent/browser-tools.js"
import { AUTH_ORIGINS, OPENAI_PROVIDER_ID } from "../auth/codex-oauth.js"
import { CREDENTIALS_KEY } from "../auth/credential-store.js"
import type { BrowserConfiguration } from "../configuration.js"
import { t } from "../i18n/index.js"
import { hasApprovedHostPermission } from "../permissions.js"
import { formatUntrusted } from "../runtime/types.js"
import {
  generateImageRequest,
  IMAGE_AUTH_TIMEOUT_MS,
  IMAGE_ENDPOINT,
  IMAGE_REQUEST_TIMEOUT_MS,
  ImagegenError,
  type ImageRequest,
  imagegenWait,
  MAX_IMAGE_PROMPT_CHARS,
} from "./client.js"
import { decodeGeneratedImage, GeneratedImageError } from "./image.js"

const CONFIRMATION =
  "Generate an image with OpenAI Codex? The prompt goes to OpenAI; the image goes to the selected model and saved session. This uses account quota. Cancellation may not stop generation. Every call requires confirmation."
const UNCERTAIN = "No automatic retry was made. The server may still consume account quota."
const AUTH_REQUIRED = "Sign in to OpenAI Codex with an account before generating an image"

type Configuration = Pick<BrowserConfiguration, "credentials" | "models">

const SIZE_PATTERN = "^(auto|[1-9][0-9]{2,3}x[1-9][0-9]{2,3})$"
const SIZE_DESCRIPTION =
  "Output size: auto or WIDTHxHEIGHT, such as 512x512 or 1536x1024. Each side must be 256–3840 pixels in steps of 16, with at most 8294400 pixels and a 1:3 to 3:1 aspect ratio. Smaller sizes can reduce output bytes but do not guarantee a result below 3 MB."

function parseSize(value: unknown): string {
  if (value === undefined || value === "auto") return "auto"
  if (
    typeof value === "string" &&
    value.length <= 9 &&
    value.trim() === value &&
    new RegExp(SIZE_PATTERN).test(value)
  ) {
    const [width = 0, height = 0] = value.split("x").map(Number)
    if (
      width >= 256 &&
      height >= 256 &&
      width <= 3840 &&
      height <= 3840 &&
      width % 16 === 0 &&
      height % 16 === 0 &&
      width * height <= 8_294_400 &&
      width <= height * 3 &&
      height <= width * 3
    )
      return value
  }
  throw new ImagegenError(`Invalid image size. ${SIZE_DESCRIPTION}`)
}

function parseRequest(value: unknown): ImageRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("prompt" in value) ||
    Object.keys(value).some(
      (key) => key !== "prompt" && key !== "transparentBackground" && key !== "size",
    ) ||
    typeof value.prompt !== "string" ||
    !value.prompt.trim() ||
    value.prompt.length > MAX_IMAGE_PROMPT_CHARS ||
    ("transparentBackground" in value &&
      value.transparentBackground !== undefined &&
      typeof value.transparentBackground !== "boolean")
  )
    throw new ImagegenError(
      "Use a nonblank image prompt of at most 32000 characters and an optional boolean transparentBackground",
    )
  return {
    prompt: value.prompt,
    transparentBackground: "transparentBackground" in value && value.transparentBackground === true,
    size: parseSize("size" in value ? value.size : undefined),
  }
}

async function approved(): Promise<void> {
  if (
    !(await Promise.all(AUTH_ORIGINS.map((origin) => hasApprovedHostPermission(origin)))).every(
      Boolean,
    )
  )
    throw new ImagegenError(
      "OpenAI Codex origin access is missing. Sign in again or approve the image endpoint.",
    )
}

/** Separate from page tools: generation needs Codex OAuth, not a readable tab or Codex chat model. */
export async function createImagegenTools(
  configuration: Configuration,
  confirm: ConfirmationHandler,
): Promise<AgentTool[]> {
  if ((await configuration.credentials.read(OPENAI_PROVIDER_ID))?.type !== "oauth") return []
  return [
    {
      name: "codex_imagegen",
      label: "Generate image",
      description:
        "Generate one image from a text prompt using the configured OpenAI Codex account (gpt-image-2). Optional size controls output dimensions; use a smaller size such as 512x512 to reduce output bytes. Optional transparentBackground requests transparency. Requires fresh confirmation and consumes account quota. The result is displayed and saved in this conversation; no filesystem path or image editing is supported. Never automatically repeat a failed or cancelled generation.",
      parameters: Type.Object(
        {
          prompt: Type.String({ minLength: 1, maxLength: MAX_IMAGE_PROMPT_CHARS }),
          transparentBackground: Type.Optional(Type.Boolean()),
          size: Type.Optional(
            Type.String({ pattern: SIZE_PATTERN, maxLength: 9, description: SIZE_DESCRIPTION }),
          ),
        },
        { additionalProperties: false },
      ),
      replay: "never",
      executionMode: "sequential",
      async execute(_id, params, executionSignal) {
        const request = parseRequest(params)
        const caller = executionSignal ?? new AbortController().signal
        caller.throwIfAborted()
        const credential = await imagegenWait(
          configuration.credentials.read(OPENAI_PROVIDER_ID, { signal: caller }),
          caller,
        )
        if (credential?.type !== "oauth") throw new ImagegenError(AUTH_REQUIRED)
        caller.throwIfAborted()
        if (
          !(await confirm(
            CONFIRMATION,
            {
              targetUrl: IMAGE_ENDPOINT,
              prompt: request.prompt,
              transparentBackground: request.transparentBackground,
              size: request.size,
            },
            executionSignal,
            undefined,
            { message: t(CONFIRMATION) },
          ))
        )
          throw new ImagegenError("Image generation was declined")
        executionSignal?.throwIfAborted()
        const controller = new AbortController()
        const signal = AbortSignal.any([
          controller.signal,
          ...(executionSignal ? [executionSignal] : []),
        ])
        const timer = setTimeout(
          () => controller.abort(new ImagegenError("Image generation timed out")),
          IMAGE_REQUEST_TIMEOUT_MS,
        )
        let expectedAccess: string | undefined
        const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
          if (area !== "local" || !(CREDENTIALS_KEY in changes) || expectedAccess === undefined)
            return
          const values: unknown = changes[CREDENTIALS_KEY]?.newValue
          const next =
            typeof values === "object" && values !== null && OPENAI_PROVIDER_ID in values
              ? values[OPENAI_PROVIDER_ID]
              : undefined
          if (
            typeof next !== "object" ||
            next === null ||
            !("type" in next) ||
            next.type !== "oauth" ||
            !("access" in next) ||
            next.access !== expectedAccess
          )
            controller.abort(
              new ImagegenError("OpenAI Codex credential changed during image generation"),
            )
        }
        const revoked = () => {
          void approved().catch(() =>
            controller.abort(new ImagegenError("OpenAI Codex access was revoked")),
          )
        }
        chrome.storage.onChanged.addListener(changed)
        chrome.permissions.onRemoved.addListener(revoked)
        const assertCurrent = async () => {
          signal.throwIfAborted()
          await imagegenWait(approved(), signal)
          const credential = await imagegenWait(
            configuration.credentials.read(OPENAI_PROVIDER_ID, { signal }),
            signal,
          )
          if (
            credential?.type !== "oauth" ||
            (expectedAccess !== undefined && credential.access !== expectedAccess)
          )
            throw new ImagegenError(AUTH_REQUIRED)
          signal.throwIfAborted()
        }
        try {
          await assertCurrent()
          const authController = new AbortController()
          const authTimer = setTimeout(
            () => authController.abort(new ImagegenError("OpenAI Codex authentication timed out")),
            IMAGE_AUTH_TIMEOUT_MS,
          )
          const authSignal = AbortSignal.any([signal, authController.signal])
          const resolved = await imagegenWait(
            configuration.models.getAuth(OPENAI_PROVIDER_ID, {
              signal: authSignal,
              minOAuthValidityMs: IMAGE_AUTH_TIMEOUT_MS,
            }),
            authSignal,
          ).finally(() => clearTimeout(authTimer))
          const auth = resolved?.auth
          if (
            !auth?.apiKey ||
            (auth.baseUrl !== undefined &&
              ![
                "https://chatgpt.com/backend-api",
                "https://chatgpt.com/backend-api/",
                "https://chatgpt.com/backend-api/codex",
                "https://chatgpt.com/backend-api/codex/",
              ].includes(auth.baseUrl))
          )
            throw new ImagegenError(AUTH_REQUIRED)
          expectedAccess = auth.apiKey
          await assertCurrent()
          const result = await generateImageRequest(expectedAccess, request, signal)
          const image = await imagegenWait(decodeGeneratedImage(result.base64), signal)
          await assertCurrent()
          const details = {
            mimeType: image.content.mimeType,
            width: image.width,
            height: image.height,
            ...(result.requestId ? { requestId: result.requestId } : {}),
          }
          return {
            content: [
              { type: "text", text: formatUntrusted("generated image metadata", details) },
              image.content,
            ],
            details,
          }
        } catch (error) {
          const known = error instanceof ImagegenError || error instanceof GeneratedImageError
          const message = signal.aborted
            ? "Image generation was cancelled or timed out"
            : known
              ? error.message
              : "Image generation failed. Check OpenAI Codex authentication and network access."
          throw new ImagegenError(`${message.replace(/\.$/, "")}. ${UNCERTAIN}`)
        } finally {
          clearTimeout(timer)
          chrome.storage.onChanged.removeListener(changed)
          chrome.permissions.onRemoved.removeListener(revoked)
        }
      },
    },
  ]
}
