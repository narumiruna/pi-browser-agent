import assert from "node:assert/strict"
import { test } from "vitest"

import { announcePdfDocument } from "../../../src/browser/pdf/session.js"

test("PDF reader announces each loaded document without source data", () => {
  const posted = []
  assert.equal(
    announcePdfDocument({
      port: { postMessage: (message) => posted.push(message) },
      sessionId: "pdf-session",
      translationDocumentId: "document-1",
    }),
    true,
  )
  assert.deepEqual(posted, [
    {
      type: "document",
      sessionId: "pdf-session",
      documentId: "document-1",
    },
  ])
  assert.equal(announcePdfDocument(null), false)
  assert.equal(
    announcePdfDocument({
      port: {
        postMessage() {
          throw new Error("disconnected")
        },
      },
      sessionId: "pdf-session",
      translationDocumentId: "document-1",
    }),
    false,
  )
})
