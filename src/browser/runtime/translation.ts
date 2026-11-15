import type { TabContext } from "./types.js"

export const TRANSLATION_MENU_IDS = [
  "pi-translate-page",
  "pi-translate-selection",
  "pi-translate-youtube",
  "pi-translate-pdf",
] as const
export type TranslationMenuId = (typeof TRANSLATION_MENU_IDS)[number]
export type TranslationIntent = {
  id: string
  action: TranslationMenuId
  tab: { id: number; url: string; windowId: number }
  selectionText: string
  frameId: number
  frameUrl: string
  expiresAt: number
}
export type TranslationOperation =
  | "take"
  | "boot"
  | "resume"
  | "claim"
  | "validate"
  | "inject"
  | "message"
  | "anchor"
  | "youtubeProbe"
  | "youtubeCapture"
  | "frames"
  | "badge"
  | "release"
export type TranslationRequest = {
  kind: "translation"
  operation: TranslationOperation
  owner: string
  payload: Record<string, unknown>
}
const operations: readonly string[] = [
  "take",
  "boot",
  "resume",
  "claim",
  "validate",
  "inject",
  "message",
  "anchor",
  "youtubeProbe",
  "youtubeCapture",
  "frames",
  "badge",
  "release",
]
const contentTypes = new Set([
  "get-page-translation-session",
  "queue-page-translation-items",
  "prefetch-youtube-subtitles",
  "start-youtube-subtitle-translation",
  "cancel-youtube-subtitle-translation",
  "retry-selection-translation",
  "dismiss-selection-translation",
  "open-options",
])

export function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}
export const TRANSLATION_CONTENT_LIMITS = Object.freeze({ maximumBytes: 131072, maximumItems: 64 })

export function boundedJson(
  value: unknown,
  maximum: number = TRANSLATION_CONTENT_LIMITS.maximumBytes,
): boolean {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length <= maximum
  } catch {
    return false
  }
}
export function parseTranslationRequest(value: unknown): TranslationRequest {
  if (
    !record(value) ||
    Object.keys(value).sort().join(",") !== "kind,operation,owner,payload" ||
    value.kind !== "translation" ||
    typeof value.operation !== "string" ||
    !operations.includes(value.operation) ||
    typeof value.owner !== "string" ||
    value.owner.length > 64 ||
    !record(value.payload) ||
    !boundedJson(value)
  ) {
    throw new Error("Invalid translation request")
  }
  const fields: Record<string, readonly string[]> = {
    take: ["windowId"],
    boot: [],
    resume: ["context"],
    claim: ["intentId", "context", "frameId", "frameUrl"],
    validate: ["frameId", "documentId"],
    inject: ["frameId"],
    message: ["frameId", "message"],
    anchor: ["frameId", "text"],
    youtubeProbe: [],
    youtubeCapture: ["url"],
    frames: [],
    badge: ["text"],
    release: [],
  }
  const allowed = fields[value.operation]
  if (
    !allowed ||
    Object.keys(value.payload).some((key) => !allowed.includes(key)) ||
    (value.payload.frameId !== undefined &&
      (!Number.isSafeInteger(value.payload.frameId) || Number(value.payload.frameId) < 0))
  ) {
    throw new Error("Invalid translation parameters")
  }
  return value as TranslationRequest
}
export function isTranslationContentMessage(
  value: unknown,
): value is { type: string; payload?: Record<string, unknown> } {
  if (
    !record(value) ||
    typeof value.type !== "string" ||
    !contentTypes.has(value.type) ||
    Object.keys(value).some((key) => key !== "type" && key !== "payload") ||
    (value.payload !== undefined && !record(value.payload)) ||
    !boundedJson(value)
  )
    return false
  const payload = value.payload
  if (value.type === "get-page-translation-session" || value.type === "open-options")
    return payload === undefined
  if (!payload) return false
  if (value.type === "queue-page-translation-items") {
    return (
      Object.keys(payload).every((key) => key === "sessionId" || key === "items") &&
      typeof payload.sessionId === "string" &&
      payload.sessionId.length <= 128 &&
      Array.isArray(payload.items) &&
      payload.items.length <= TRANSLATION_CONTENT_LIMITS.maximumItems &&
      payload.items.every(
        (item) =>
          record(item) &&
          typeof item.id === "string" &&
          item.id.length <= 128 &&
          typeof item.text === "string" &&
          item.text.length <= 20000 &&
          typeof item.kind === "string" &&
          item.kind.length <= 32 &&
          Object.keys(item).every((key) =>
            [
              "id",
              "kind",
              "text",
              "protectedFragments",
              "isUI",
              "isMetadata",
              "containsMath",
            ].includes(key),
          ),
      )
    )
  }
  const keys: Record<string, readonly string[]> = {
    "prefetch-youtube-subtitles": ["sessionId", "currentTimeMs", "playbackRate", "reason"],
    "start-youtube-subtitle-translation": [
      "requestId",
      "videoKey",
      "reason",
      "sessionId",
      "recovery",
    ],
    "cancel-youtube-subtitle-translation": ["requestId", "videoKey", "sessionId"],
    "retry-selection-translation": ["sourceText", "selectionAnchor", "requestId"],
    "dismiss-selection-translation": ["requestId"],
  }
  const type = value.type
  return (
    Object.keys(payload).every((key) => keys[type]?.includes(key)) &&
    Object.entries(payload).every(([key, item]) =>
      key === "recovery"
        ? typeof item === "boolean"
        : key === "selectionAnchor"
          ? item === null || (record(item) && boundedJson(item, 1024))
          : typeof item === "string"
            ? item.length <= (key === "sourceText" ? 50000 : 256)
            : typeof item === "number" && Number.isFinite(item),
    )
  )
}
export function translationContext(value: unknown): TabContext {
  if (
    !record(value) ||
    Object.keys(value).sort().join(",") !== "epoch,tabId,url" ||
    !Number.isSafeInteger(value.tabId) ||
    Number(value.tabId) < 0 ||
    !Number.isSafeInteger(value.epoch) ||
    Number(value.epoch) < 0 ||
    typeof value.url !== "string" ||
    value.url.length > 16384
  ) {
    throw new Error("Invalid translation context")
  }
  const url = new URL(value.url)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Invalid translation page")
  return value as unknown as TabContext
}
