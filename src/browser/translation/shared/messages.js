import {
  isTranslationContentMessage,
  TRANSLATION_CONTENT_LIMITS,
} from "../../runtime/translation.js"

const MESSAGE_TYPES = Object.freeze({
  AUTOMATION_OPEN_PDF: "automation-open-pdf",
  AUTOMATION_TRANSLATE_PAGE: "automation-translate-page",
  AUTOMATION_TRANSLATE_SELECTION: "automation-translate-selection",
  GET_RUNTIME_HEALTH: "get-runtime-health",
  GET_PAGE_TRANSLATION_SESSION: "get-page-translation-session",
  GET_PROVIDER_CATALOG: "get-provider-catalog",
  GET_PROVIDER_AUTH_STATUS: "get-provider-auth-status",
  GET_MODEL_ENDPOINTS: "get-model-endpoints",
  CLEAR_PAGE_PLACEHOLDERS: "clear-page-placeholders",
  CLEAR_PENDING_TRANSLATIONS: "clear-pending-translations",
  CANCEL_YOUTUBE_SUBTITLE_TRANSLATION: "cancel-youtube-subtitle-translation",
  OPEN_OPTIONS: "open-options",
  PING: "ping",
  PREFETCH_YOUTUBE_SUBTITLES: "prefetch-youtube-subtitles",
  QUEUE_PAGE_TRANSLATION_ITEMS: "queue-page-translation-items",
  RENDER_PAGE_PLACEHOLDERS: "render-page-placeholders",
  RENDER_PAGE_TRANSLATION_UPDATES: "render-page-translation-updates",
  RENDER_YOUTUBE_DIAGNOSTIC_EVENT: "render-youtube-diagnostic-event",
  RENDER_SELECTION_ERROR: "render-selection-error",
  RENDER_SELECTION_PLACEHOLDER: "render-selection-placeholder",
  RENDER_SELECTION_TRANSLATION: "render-selection-translation",
  RETRY_SELECTION_TRANSLATION: "retry-selection-translation",
  SHOW_TOAST: "show-toast",
  START_PAGE_TRANSLATION_SESSION: "start-page-translation-session",
  START_YOUTUBE_SUBTITLE_TRANSLATION: "start-youtube-subtitle-translation",
  TEST_CONNECTION: "test-connection",
})

function createMessage(type, payload) {
  const message = { type }

  if (payload !== undefined) {
    message.payload = payload
  }

  return message
}

function automationOpenPdf(payload) {
  return createMessage(MESSAGE_TYPES.AUTOMATION_OPEN_PDF, payload)
}

function automationTranslatePage(payload) {
  return createMessage(MESSAGE_TYPES.AUTOMATION_TRANSLATE_PAGE, payload)
}

function automationTranslateSelection(payload) {
  return createMessage(MESSAGE_TYPES.AUTOMATION_TRANSLATE_SELECTION, payload)
}

function clearPagePlaceholders(payload) {
  return createMessage(MESSAGE_TYPES.CLEAR_PAGE_PLACEHOLDERS, payload)
}

function clearPendingTranslations(payload) {
  return createMessage(MESSAGE_TYPES.CLEAR_PENDING_TRANSLATIONS, payload)
}

function getRuntimeHealth() {
  return createMessage(MESSAGE_TYPES.GET_RUNTIME_HEALTH)
}

function getPageTranslationSession() {
  return createMessage(MESSAGE_TYPES.GET_PAGE_TRANSLATION_SESSION)
}

function getProviderCatalog(payload) {
  return createMessage(MESSAGE_TYPES.GET_PROVIDER_CATALOG, payload)
}

function getProviderAuthStatus(payload) {
  return createMessage(MESSAGE_TYPES.GET_PROVIDER_AUTH_STATUS, payload)
}

function getModelEndpoints(payload) {
  return createMessage(MESSAGE_TYPES.GET_MODEL_ENDPOINTS, payload)
}

function openOptions() {
  return createMessage(MESSAGE_TYPES.OPEN_OPTIONS)
}

function ping() {
  return createMessage(MESSAGE_TYPES.PING)
}

function prefetchYoutubeSubtitles(payload) {
  return createMessage(MESSAGE_TYPES.PREFETCH_YOUTUBE_SUBTITLES, payload)
}

function queuePageTranslationItems(payload) {
  return createMessage(MESSAGE_TYPES.QUEUE_PAGE_TRANSLATION_ITEMS, payload)
}

function renderPagePlaceholders(payload) {
  return createMessage(MESSAGE_TYPES.RENDER_PAGE_PLACEHOLDERS, payload)
}

function renderPageTranslationUpdates(payload) {
  return createMessage(MESSAGE_TYPES.RENDER_PAGE_TRANSLATION_UPDATES, payload)
}

function renderYoutubeDiagnosticEvent(payload) {
  return createMessage(MESSAGE_TYPES.RENDER_YOUTUBE_DIAGNOSTIC_EVENT, payload)
}

function renderSelectionError(payload) {
  return createMessage(MESSAGE_TYPES.RENDER_SELECTION_ERROR, payload)
}

function renderSelectionPlaceholder(payload) {
  return createMessage(MESSAGE_TYPES.RENDER_SELECTION_PLACEHOLDER, payload)
}

function renderSelectionTranslation(payload) {
  return createMessage(MESSAGE_TYPES.RENDER_SELECTION_TRANSLATION, payload)
}

function retrySelectionTranslation(payload) {
  return createMessage(MESSAGE_TYPES.RETRY_SELECTION_TRANSLATION, payload)
}

function showToast(payload) {
  return createMessage(MESSAGE_TYPES.SHOW_TOAST, payload)
}

function batchPageTranslationItems(sessionId, items) {
  const messages = []
  const rejectedItems = []
  const encoder = new TextEncoder()
  const messageFor = (batch) => queuePageTranslationItems({ sessionId, items: batch })
  const emptyBytes = encoder.encode(JSON.stringify(messageFor([]))).length
  let batch = []
  let bytes = emptyBytes
  for (const item of items) {
    const single = messageFor([item])
    if (!isTranslationContentMessage(single)) {
      rejectedItems.push(item)
      continue
    }
    const itemBytes = encoder.encode(JSON.stringify(single)).length - emptyBytes
    const separatorBytes = batch.length ? 1 : 0
    if (
      batch.length >= TRANSLATION_CONTENT_LIMITS.maximumItems ||
      bytes + separatorBytes + itemBytes > TRANSLATION_CONTENT_LIMITS.maximumBytes
    ) {
      messages.push(messageFor(batch))
      batch = []
      bytes = emptyBytes
    }
    bytes += itemBytes + (batch.length ? 1 : 0)
    batch.push(item)
  }
  if (batch.length) messages.push(messageFor(batch))
  return { messages, rejectedItems }
}

function startPageTranslationSession(payload) {
  return createMessage(MESSAGE_TYPES.START_PAGE_TRANSLATION_SESSION, payload)
}

function cancelYoutubeSubtitleTranslation(payload) {
  return createMessage(MESSAGE_TYPES.CANCEL_YOUTUBE_SUBTITLE_TRANSLATION, payload)
}

function startYoutubeSubtitleTranslation(payload) {
  return createMessage(MESSAGE_TYPES.START_YOUTUBE_SUBTITLE_TRANSLATION, payload)
}

export {
  automationOpenPdf,
  automationTranslatePage,
  automationTranslateSelection,
  batchPageTranslationItems,
  cancelYoutubeSubtitleTranslation,
  clearPagePlaceholders,
  clearPendingTranslations,
  createMessage,
  getModelEndpoints,
  getPageTranslationSession,
  getProviderAuthStatus,
  getProviderCatalog,
  getRuntimeHealth,
  MESSAGE_TYPES,
  openOptions,
  ping,
  prefetchYoutubeSubtitles,
  queuePageTranslationItems,
  renderPagePlaceholders,
  renderPageTranslationUpdates,
  renderSelectionError,
  renderSelectionPlaceholder,
  renderSelectionTranslation,
  renderYoutubeDiagnosticEvent,
  retrySelectionTranslation,
  showToast,
  startPageTranslationSession,
  startYoutubeSubtitleTranslation,
}
