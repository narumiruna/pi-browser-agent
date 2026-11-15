import { CLIENT_MESSAGE_TYPES } from "../translation/shared/pdf.js"

function announcePdfDocument(state) {
  if (!state?.port || !state.sessionId || !state.translationDocumentId) {
    return false
  }
  try {
    state.port.postMessage({
      type: CLIENT_MESSAGE_TYPES.DOCUMENT,
      sessionId: state.sessionId,
      documentId: state.translationDocumentId,
    })
    return true
  } catch (_error) {
    return false
  }
}

export { announcePdfDocument }
