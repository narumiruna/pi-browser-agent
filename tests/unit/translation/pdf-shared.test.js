import assert from "node:assert/strict"
import { test } from "vitest"

import * as Pdf from "../../../src/browser/translation/shared/pdf.js"

test("PDF URL helpers accept HTTP documents without exposing query data", () => {
  assert.equal(Pdf.isPdfCandidateUrl("https://example.com/paper.PDF?token=secret"), true)
  assert.equal(Pdf.isPdfCandidateUrl("https://example.com/paper"), false)
  assert.equal(Pdf.isPdfCandidateUrl("file:///tmp/paper.pdf"), true)
  assert.equal(Pdf.isPdfCandidateUrl("chrome://settings/paper.pdf"), false)
  assert.equal(
    Pdf.getPdfSourcePermissionPattern("https://example.com/paper.pdf?token=x"),
    "https://example.com/*",
  )
  assert.equal(Pdf.getPdfTitleFromUrl("https://example.com/a%20paper.pdf?x=1"), "a paper")
})

test("PDF signature validation allows a bounded preamble", () => {
  assert.equal(Pdf.hasPdfSignature(new TextEncoder().encode("%PDF-1.7\n")), true)
  assert.equal(
    Pdf.hasPdfSignature(new TextEncoder().encode("% generated comment\n%PDF-1.4\n")),
    true,
  )
  assert.equal(Pdf.hasPdfSignature(new TextEncoder().encode("<html>%PDF-1.4\n")), false)
  assert.equal(Pdf.hasPdfSignature(new TextEncoder().encode("<html>")), false)
})

test("PDF titles remove control and markup characters", () => {
  assert.equal(Pdf.sanitizePdfTitle(" <paper>\u0000\n "), "paper")
  assert.equal(Pdf.sanitizePdfTitle(""), "PDF document")
})

test("PDF reader messages enforce bounded identities and source text", () => {
  assert.deepEqual(
    Pdf.validatePdfClientMessage({
      type: "queue",
      sessionId: "pdf-session",
      documentId: "document-1",
      requestId: "request-1",
      placement: "back",
      items: [{ id: "doc:p1:b1", kind: "heading", text: " Heading " }],
    }),
    {
      type: "queue",
      sessionId: "pdf-session",
      documentId: "document-1",
      requestId: "request-1",
      placement: "back",
      items: [{ id: "doc:p1:b1", kind: "heading", text: "Heading" }],
    },
  )
  assert.throws(
    () =>
      Pdf.validatePdfClientMessage({
        type: "queue",
        sessionId: "pdf-session",
        documentId: "document-1",
        requestId: "request-1",
        items: [
          { id: "duplicate", text: "one" },
          { id: "duplicate", text: "two" },
        ],
      }),
    /duplicate ids/,
  )
  assert.throws(
    () =>
      Pdf.validatePdfClientMessage({
        type: "queue",
        sessionId: "pdf-session",
        documentId: "document-1",
        requestId: "request-1",
        items: [{ id: "unsafe id", text: "text" }],
      }),
    /invalid id/,
  )
  assert.throws(
    () =>
      Pdf.validatePdfClientMessage({
        type: "start",
        launchToken: "launch-token",
        apiKey: "must-not-cross-the-port",
      }),
    /unsupported fields/,
  )
  assert.throws(
    () =>
      Pdf.validatePdfClientMessage({
        type: "queue",
        sessionId: "pdf-session",
        requestId: "request-1",
        items: [{ id: "block-1", text: "text" }],
      }),
    /identity/,
  )
  assert.throws(() => Pdf.validatePdfClientMessage({ type: "unknown" }), /Unknown/)
})

test("PDF document messages require scoped identities and no extra data", () => {
  assert.deepEqual(
    Pdf.validatePdfClientMessage({
      type: "document",
      sessionId: "pdf-session",
      documentId: "document-1",
    }),
    {
      type: "document",
      sessionId: "pdf-session",
      documentId: "document-1",
    },
  )
  assert.throws(
    () =>
      Pdf.validatePdfClientMessage({
        type: "document",
        sessionId: "pdf-session",
        documentId: "document-1",
        sourceUrl: "https://example.com/private.pdf",
      }),
    /unsupported fields/,
  )
})

test("PDF batch validation enforces item and total character limits", () => {
  const createMessage = (items) => ({
    type: "queue",
    sessionId: "pdf-session",
    documentId: "document-1",
    requestId: "request-1",
    items,
  })
  const exactLimitItems = Array.from({ length: 5 }, (_, index) => ({
    id: `item-${index}`,
    text: "x".repeat(Pdf.PDF_LIMITS.maximumItemCharacters),
  }))
  assert.equal(Pdf.validatePdfClientMessage(createMessage(exactLimitItems)).items.length, 5)
  assert.throws(
    () =>
      Pdf.validatePdfClientMessage(
        createMessage([
          ...exactLimitItems,
          {
            id: "item-6",
            text: "x".repeat(Pdf.PDF_LIMITS.maximumItemCharacters),
          },
        ]),
      ),
    /too large/,
  )
  assert.throws(
    () =>
      Pdf.validatePdfClientMessage(
        createMessage(
          Array.from({ length: Pdf.PDF_LIMITS.maximumItemsPerBatch + 1 }, (_, index) => ({
            id: `small-${index}`,
            text: "x",
          })),
        ),
      ),
    /too many items/,
  )
})

test("PDF server message builders do not add credentials or source text", () => {
  assert.deepEqual(
    Pdf.pdfTranslationUpdate({
      sessionId: "pdf-session",
      requestId: "request-1",
      translations: [{ id: "block-1", translation: "譯文" }],
    }),
    {
      type: Pdf.SERVER_MESSAGE_TYPES.TRANSLATION_UPDATE,
      sessionId: "pdf-session",
      requestId: "request-1",
      translations: [{ id: "block-1", translation: "譯文" }],
    },
  )
})
