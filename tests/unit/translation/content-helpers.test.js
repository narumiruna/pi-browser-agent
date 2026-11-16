import assert from "node:assert/strict"
import { test } from "vitest"
import { createContentHelpers } from "../../../src/browser/translation/content/helpers.js"
import { estimateTokenCount } from "../../../src/browser/translation/translation/responses.js"

test("extraction debug uses the translation token estimate with default profile metadata", () => {
  const helpers = createContentHelpers({
    pageState: { debug: { enabled: true } },
  })
  const state = helpers.createExtractionDebugState()
  const items = [undefined, "", " \n ", "  hello  ", "字幕の翻訳", "😀😀😀"].map((text, index) => ({
    id: `item-${index}`,
    kind: "paragraph",
    text,
    containsMath: index === 4,
  }))
  for (const item of items) helpers.recordExtractionDebugSelect(state, item)
  assert.equal(helpers.isDebugInfoEnabled(), true)
  assert.deepEqual(helpers.finalizeExtractionDebug(state), {
    profileId: "default",
    selectedItems: items.map((item) => ({
      id: item.id,
      kind: item.kind,
      tokenCount: estimateTokenCount(item.text),
      containsMath: item.containsMath,
    })),
    skippedByReason: [],
    skippedSamples: [],
  })
})
