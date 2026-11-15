const PDF_PORT_NAME = "vibe-pdf-translation-v1"
const PDF_READER_PATH = "pages/pdf.html"
const PDF_LAUNCH_PREFIX = "piBrowserAgentPdfLaunchV1:"
const PDF_CACHE_VERSION = 1
const PDF_LIMITS = Object.freeze({
  maximumBatchCharacters: 100_000,
  maximumDocumentCharacters: 2_000_000,
  maximumItemsPerBatch: 64,
  maximumItemCharacters: 20_000,
  maximumPages: 1_000,
  maximumSourceBytes: 50 * 1024 * 1024,
})
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u
const CLIENT_MESSAGE_TYPES = Object.freeze({
  CANCEL: "cancel",
  DOCUMENT: "document",
  QUEUE: "queue",
  RETRY: "retry",
  START: "start",
})
const SERVER_MESSAGE_TYPES = Object.freeze({
  BATCH_COMPLETE: "batch-complete",
  BATCH_STARTED: "batch-started",
  CANCELLED: "cancelled",
  ERROR: "error",
  SESSION_STARTED: "session-started",
  TRANSLATION_UPDATE: "translation-update",
})

function parseHttpUrl(value) {
  try {
    const url = new URL(String(value || ""))

    return (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      url.href.length <= 16384
      ? url
      : null
  } catch (_error) {
    return null
  }
}

function isPdfCandidateUrl(value) {
  try {
    const url = new URL(String(value || ""))
    return ["file:", "http:", "https:"].includes(url.protocol) && /\.pdf$/iu.test(url.pathname)
  } catch (_error) {
    return false
  }
}

function getPdfSourcePermissionPattern(value) {
  const url = parseHttpUrl(value)

  if (!url) {
    throw new Error("PDF sources must use HTTP or HTTPS.")
  }

  return `${url.origin}/*`
}

function sanitizePdfTitle(value, fallback = "PDF document") {
  const normalized = Array.from(String(value || ""))
    .filter((character) => {
      const code = character.codePointAt(0)
      return code > 31 && code !== 127
    })
    .join("")
    .replace(/[<>]/gu, "")
    .trim()
    .slice(0, 160)

  return normalized || fallback
}

function getPdfTitleFromUrl(value) {
  const url = parseHttpUrl(value)

  if (!url) {
    return "PDF document"
  }

  const pathName = url.pathname.split("/").filter(Boolean).at(-1) || ""
  let decoded = pathName

  try {
    decoded = decodeURIComponent(pathName)
  } catch (_error) {
    // Keep the encoded path segment when it is malformed.
  }

  return sanitizePdfTitle(decoded.replace(/\.pdf$/iu, ""))
}

function hasPdfSignature(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    return false
  }

  const header = new TextDecoder("latin1").decode(bytes.subarray(0, 1024))
  const match = /%PDF-\d\.\d/u.exec(header)
  if (!match) {
    return false
  }
  const preamble = header.slice(0, match.index)
  return preamble.split(/\r?\n/u).every((line) => !line.trim() || line.trimStart().startsWith("%"))
}

function isSafePdfId(value) {
  return SAFE_ID_PATTERN.test(String(value || ""))
}

function assertAllowedKeys(value, allowedKeys, label) {
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.includes(key))
  if (unknownKeys.length > 0) {
    throw new Error(`${label} contains unsupported fields.`)
  }
}

function validatePdfItems(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("A PDF translation batch must contain items.")
  }

  if (value.length > PDF_LIMITS.maximumItemsPerBatch) {
    throw new Error("The PDF translation batch contains too many items.")
  }

  const ids = new Set()
  let totalCharacters = 0
  const items = value.map((item) => {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !isSafePdfId(item.id)) {
      throw new Error("A PDF translation item has an invalid id.")
    }
    assertAllowedKeys(item, ["id", "kind", "text"], "PDF translation item")
    if (ids.has(item.id)) {
      throw new Error("A PDF translation batch contains duplicate ids.")
    }
    ids.add(item.id)

    if (typeof item.text !== "string") {
      throw new Error("A PDF translation item must contain string text.")
    }
    const text = item.text.trim()
    if (!text || text.length > PDF_LIMITS.maximumItemCharacters) {
      throw new Error("A PDF translation item has an invalid text length.")
    }
    totalCharacters += text.length
    if (totalCharacters > PDF_LIMITS.maximumBatchCharacters) {
      throw new Error("The PDF translation batch is too large.")
    }

    const allowedKinds = new Set(["caption", "heading", "list-item", "paragraph", "table-cell"])
    const kind = allowedKinds.has(item.kind) ? item.kind : "paragraph"

    return {
      id: item.id,
      kind,
      text,
    }
  })

  return items
}

function validatePdfClientMessage(message) {
  if (!message || typeof message !== "object") {
    throw new Error("Invalid PDF reader message.")
  }

  if (message.type === CLIENT_MESSAGE_TYPES.START) {
    assertAllowedKeys(message, ["type", "launchToken"], "PDF start message")
    if (!isSafePdfId(message.launchToken)) {
      throw new Error("Invalid PDF launch token.")
    }
    return { type: message.type, launchToken: message.launchToken }
  }

  if (message.type === CLIENT_MESSAGE_TYPES.DOCUMENT) {
    assertAllowedKeys(message, ["type", "sessionId", "documentId"], "PDF document message")
    if (!isSafePdfId(message.sessionId) || !isSafePdfId(message.documentId)) {
      throw new Error("Invalid PDF document identity.")
    }
    return {
      type: message.type,
      sessionId: message.sessionId,
      documentId: message.documentId,
    }
  }

  if (message.type === CLIENT_MESSAGE_TYPES.CANCEL) {
    assertAllowedKeys(message, ["type", "sessionId"], "PDF cancel message")
    if (!isSafePdfId(message.sessionId)) {
      throw new Error("Invalid PDF session id.")
    }
    return { type: message.type, sessionId: message.sessionId }
  }

  if (message.type === CLIENT_MESSAGE_TYPES.QUEUE || message.type === CLIENT_MESSAGE_TYPES.RETRY) {
    assertAllowedKeys(
      message,
      ["type", "sessionId", "documentId", "requestId", "placement", "items"],
      "PDF batch message",
    )
    if (
      !isSafePdfId(message.sessionId) ||
      !isSafePdfId(message.documentId) ||
      !isSafePdfId(message.requestId)
    ) {
      throw new Error("Invalid PDF batch identity.")
    }
    return {
      type: message.type,
      sessionId: message.sessionId,
      documentId: message.documentId,
      requestId: message.requestId,
      placement: message.placement === "back" ? "back" : "front",
      items: validatePdfItems(message.items),
    }
  }

  throw new Error("Unknown PDF reader message type.")
}

function createPdfServerMessage(type, payload = {}) {
  return { type, ...payload }
}

function pdfSessionStarted(payload) {
  return createPdfServerMessage(SERVER_MESSAGE_TYPES.SESSION_STARTED, payload)
}

function pdfBatchStarted(payload) {
  return createPdfServerMessage(SERVER_MESSAGE_TYPES.BATCH_STARTED, payload)
}

function pdfTranslationUpdate(payload) {
  return createPdfServerMessage(SERVER_MESSAGE_TYPES.TRANSLATION_UPDATE, payload)
}

function pdfBatchComplete(payload) {
  return createPdfServerMessage(SERVER_MESSAGE_TYPES.BATCH_COMPLETE, payload)
}

function pdfSessionError(payload) {
  return createPdfServerMessage(SERVER_MESSAGE_TYPES.ERROR, payload)
}

function pdfSessionCancelled(payload) {
  return createPdfServerMessage(SERVER_MESSAGE_TYPES.CANCELLED, payload)
}

export {
  CLIENT_MESSAGE_TYPES,
  getPdfSourcePermissionPattern,
  getPdfTitleFromUrl,
  hasPdfSignature,
  isPdfCandidateUrl,
  isSafePdfId,
  PDF_CACHE_VERSION,
  PDF_LAUNCH_PREFIX,
  PDF_LIMITS,
  PDF_PORT_NAME,
  PDF_READER_PATH,
  parseHttpUrl,
  pdfBatchComplete,
  pdfBatchStarted,
  pdfSessionCancelled,
  pdfSessionError,
  pdfSessionStarted,
  pdfTranslationUpdate,
  SERVER_MESSAGE_TYPES,
  sanitizePdfTitle,
  validatePdfClientMessage,
  validatePdfItems,
}
