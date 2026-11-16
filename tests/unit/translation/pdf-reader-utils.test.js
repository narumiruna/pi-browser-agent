import assert from "node:assert/strict"
import { test } from "vitest"

import {
  buildPdfTranslationCopy,
  createBoundedPdfBatches,
  decodeLaunchToken,
  hashText,
  sanitizeDocumentId,
  splitPdfBlocks,
} from "../../../src/browser/pdf/reader-utils.js"

test("PDF reader launch tokens fail closed on malformed encoding", () => {
  assert.equal(decodeLaunchToken("#launch-token"), "launch-token")
  assert.equal(decodeLaunchToken("#%E0%A4%A"), "")
  assert.equal(decodeLaunchToken(""), "")
})

test("PDF reader splits oversized blocks and batches by count and characters", () => {
  const split = splitPdfBlocks(
    [{ id: "block", text: `${"word ".repeat(5)}end`, role: "paragraph" }],
    10,
  )
  assert.equal(split.length > 1, true)
  assert.equal(
    split.every((block) => block.text.length <= 10),
    true,
  )
  assert.equal(new Set(split.map((block) => block.id)).size, split.length)

  const items = Array.from({ length: 7 }, (_, index) => ({
    id: `item-${index}`,
    text: "x".repeat(20),
  }))
  const batches = createBoundedPdfBatches(items, {
    maximumCharacters: 100,
    maximumItems: 64,
  })
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [5, 2],
  )
  assert.deepEqual(
    batches.flat().map((item) => item.id),
    items.map((item) => item.id),
  )
  assert.deepEqual(
    createBoundedPdfBatches(
      Array.from({ length: 65 }, (_, index) => ({
        id: `small-${index}`,
        text: "x",
      })),
      { maximumCharacters: 100, maximumItems: 64 },
    ).map((batch) => batch.length),
    [64, 1],
  )
})

test("PDF reader labels partial copied translations", () => {
  const blocks = [
    { id: "one", originalOnly: false },
    { id: "two", originalOnly: false },
  ]
  assert.equal(
    buildPdfTranslationCopy(blocks, new Map([["one", "Translated"]])),
    "[Partial translation: 1 of 2 blocks completed]\n\nTranslated",
  )
})

test("PDF reader document ids and source hashes are stable and bounded", () => {
  assert.equal(hashText("source"), hashText("source"))
  assert.notEqual(hashText("source"), hashText("changed"))
  assert.equal(sanitizeDocumentId("abc:def"), "dabcdef")
  assert.equal(
    sanitizeDocumentId("", () => "12345678-1234-1234-1234-123456789abc"),
    "d12345678123412341234",
  )
})
