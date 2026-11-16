import assert from "node:assert/strict"
import { test } from "vitest"

import * as Api from "../../../src/browser/translation/translation/api.js"
import {
  buildProgressiveRequestChunks,
  buildProgressiveRequestConcurrency,
  translateItemsProgressively,
} from "../../../src/browser/translation/translation/progressive.js"

function createProgressiveApi(resolveChunk) {
  return {
    ...Api,
    async requestTranslationsBatchedProgressive(options) {
      const successes = []
      const failures = []
      for (let index = 0; index < options.chunks.length; index += 1) {
        try {
          const translations = await resolveChunk(options.chunks[index], index)
          successes.push(...translations)
          await options.onChunkResolved({ translations })
        } catch (error) {
          failures.push({ chunkIndex: index, error })
        }
      }
      return { failures, successes }
    },
  }
}

test("progressive translation keeps page chunks separate and subtitle chunks grouped", () => {
  const pageItems = [
    { id: "one", kind: "paragraph", text: "One" },
    { id: "two", kind: "paragraph", text: "Two" },
  ]
  const pagePlan = Api.createRecursiveChunkPlan(pageItems)
  assert.equal(buildProgressiveRequestChunks(Api, pageItems, pagePlan), pagePlan.chunks)
  assert.equal(buildProgressiveRequestConcurrency(pageItems, pagePlan.chunks, 5), 2)

  const subtitles = pageItems.map((item) => ({ ...item, kind: "subtitle" }))
  const subtitlePlan = Api.createRecursiveChunkPlan(subtitles)
  const subtitleChunks = buildProgressiveRequestChunks(Api, subtitles, subtitlePlan)
  assert.equal(subtitleChunks.length, 1)
  assert.equal(buildProgressiveRequestConcurrency(subtitles, subtitleChunks, 5), 1)
})

test("progressive translation emits complete split items and reports partial failures", async () => {
  const text = `${"long text ".repeat(700)}end`
  const items = [
    { id: "long", kind: "paragraph", text },
    { id: "failed", kind: "paragraph", text: "Fail this" },
  ]
  const emitted = []
  const progressiveApi = createProgressiveApi(async (chunk) => {
    if (chunk.some((item) => item.sourceId === "failed" || item.id === "failed")) {
      throw new Error("expected failure")
    }
    return chunk.map((item) => ({
      id: item.id,
      translation: item.text,
    }))
  })
  const result = await translateItemsProgressively({
    Api: progressiveApi,
    settings: { targetLanguage: "test" },
    items,
    onTranslations(translations) {
      emitted.push(...translations)
    },
  })

  assert.deepEqual(
    emitted.map((item) => item.id),
    ["long"],
  )
  assert.deepEqual(result.incompleteSegmentIds, ["failed"])
  assert.equal(result.failures.length, 1)
})

test("progressive translation propagates renderer failures outside API failure accounting", async () => {
  const progressiveApi = createProgressiveApi(async (chunk) =>
    chunk.map((item) => ({ id: item.id, translation: "done" })),
  )
  await assert.rejects(
    translateItemsProgressively({
      Api: progressiveApi,
      settings: { targetLanguage: "test" },
      items: [{ id: "one", kind: "paragraph", text: "One" }],
      onTranslations() {
        throw new Error("render transport disconnected")
      },
    }),
    /render transport disconnected/,
  )
})

test("progressive translation suppresses updates after its session becomes stale", async () => {
  let current = true
  const emitted = []
  const progressiveApi = createProgressiveApi(async (chunk) => {
    current = false
    return chunk.map((item) => ({ id: item.id, translation: "done" }))
  })
  const result = await translateItemsProgressively({
    Api: progressiveApi,
    settings: { targetLanguage: "test" },
    items: [{ id: "one", kind: "paragraph", text: "One" }],
    isCurrent: () => current,
    onTranslations(translations) {
      emitted.push(...translations)
    },
  })

  assert.deepEqual(emitted, [])
  assert.equal(result.stale, true)
})
