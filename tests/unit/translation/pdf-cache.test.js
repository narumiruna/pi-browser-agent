import assert from "node:assert/strict"
import { test } from "vitest"

import {
  cacheTranslations,
  clearPdfCache,
  createCacheKey,
  getCachedTranslations,
} from "../../../src/browser/pdf/cache.js"

test("PDF cache keys include document context and source hash", () => {
  assert.notEqual(
    createCacheKey("document:language:model-a", {
      id: "block",
      sourceHash: "a",
    }),
    createCacheKey("document:language:model-b", {
      id: "block",
      sourceHash: "a",
    }),
  )
  assert.notEqual(
    createCacheKey("document:language:model-a", {
      id: "block",
      sourceHash: "a",
    }),
    createCacheKey("document:language:model-a", {
      id: "block",
      sourceHash: "b",
    }),
  )
  assert.notEqual(
    createCacheKey("context:a", { id: "b", sourceHash: "c" }),
    createCacheKey("context", { id: "a:b", sourceHash: "c" }),
  )
})

test("PDF cache clearing surfaces persistent storage failures", async () => {
  const request = { error: new Error("IndexedDB unavailable") }
  const indexedDB = {
    open() {
      queueMicrotask(() => request.onerror())
      return request
    },
  }
  await assert.rejects(clearPdfCache({ indexedDB }), /IndexedDB unavailable/)
})

test("PDF cache returns matching translations and clears only its namespace", async () => {
  await clearPdfCache({ indexedDB: null })
  const block = { id: "block-1", sourceHash: "source-a" }
  const blocksById = new Map([[block.id, block]])
  await cacheTranslations(
    "document:settings",
    blocksById,
    [{ id: block.id, translation: "譯文" }],
    { indexedDB: null },
  )
  assert.deepEqual(
    await getCachedTranslations("document:settings", [block], {
      indexedDB: null,
    }),
    [{ id: block.id, translation: "譯文" }],
  )
  assert.deepEqual(
    await getCachedTranslations("document:other-settings", [block], {
      indexedDB: null,
    }),
    [],
  )
  await clearPdfCache({ indexedDB: null })
  assert.deepEqual(
    await getCachedTranslations("document:settings", [block], {
      indexedDB: null,
    }),
    [],
  )
})
