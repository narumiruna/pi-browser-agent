import assert from "node:assert/strict"
import { test } from "vitest"

import {
  DEFAULT_PREFETCH_VIEWPORTS,
  getTranslationWindowPriority,
  isRectWithinTranslationWindow,
  normalizeViewportOptions,
  selectWindowCandidates,
} from "../../../src/browser/translation/content/page/viewport.js"

test("normalizeViewportOptions fills defaults", () => {
  assert.deepEqual(normalizeViewportOptions({ viewportHeight: 720 }), {
    viewportHeight: 720,
    prefetchViewports: DEFAULT_PREFETCH_VIEWPORTS,
    topPrefetchViewports: DEFAULT_PREFETCH_VIEWPORTS,
    topMargin: 96,
  })
})

test("normalizeViewportOptions preserves explicit zero values", () => {
  assert.deepEqual(
    normalizeViewportOptions({
      viewportHeight: 720,
      prefetchViewports: 0,
      topPrefetchViewports: 0,
      topMargin: 0,
    }),
    {
      viewportHeight: 720,
      prefetchViewports: 0,
      topPrefetchViewports: 0,
      topMargin: 0,
    },
  )
})

test("isRectWithinTranslationWindow includes visible and prefetched blocks", () => {
  const options = { viewportHeight: 800, prefetchViewports: 1, topMargin: 96 }

  assert.equal(isRectWithinTranslationWindow({ top: 20, bottom: 120 }, options), true)
  assert.equal(isRectWithinTranslationWindow({ top: 1200, bottom: 1300 }, options), true)
  assert.equal(isRectWithinTranslationWindow({ top: -700, bottom: -620 }, options), true)
  assert.equal(isRectWithinTranslationWindow({ top: 1700, bottom: 1800 }, options), false)
  assert.equal(isRectWithinTranslationWindow({ top: -1100, bottom: -1020 }, options), false)
})

test("selectWindowCandidates keeps viewport order", () => {
  const items = [
    { id: "later", rect: { top: 400, bottom: 440 } },
    { id: "early", rect: { top: 40, bottom: 80 } },
    { id: "prefetch", rect: { top: 1000, bottom: 1050 } },
  ]

  assert.deepEqual(
    selectWindowCandidates(items, {
      viewportHeight: 700,
      prefetchViewports: 1,
    }).map((item) => item.id),
    ["early", "later", "prefetch"],
  )
})

test("a long downward jump prioritizes the new viewport over both prefetch sides", () => {
  const candidates = [
    { id: "old-above", rect: { top: -900, bottom: -820 } },
    { id: "new-visible", rect: { top: 80, bottom: 160 } },
    { id: "new-below", rect: { top: 840, bottom: 920 } },
  ]
  const selected = selectWindowCandidates(candidates, {
    viewportHeight: 700,
    prefetchViewports: 2,
  })

  assert.equal(selected[0].id, "new-visible")
  assert.deepEqual(
    new Set(selected.slice(1).map((item) => item.id)),
    new Set(["old-above", "new-below"]),
  )
})

test("a return upward reprioritizes the restored viewport", () => {
  const candidates = [
    { id: "restored-visible", rect: { top: 32, bottom: 112 } },
    { id: "prefetch-above", rect: { top: -620, bottom: -540 } },
    { id: "previous-position", rect: { top: 1180, bottom: 1260 } },
  ]
  const selected = selectWindowCandidates(candidates, {
    viewportHeight: 700,
    prefetchViewports: 2,
  })

  assert.equal(selected[0].id, "restored-visible")
  assert.deepEqual(
    new Set(selected.slice(1).map((item) => item.id)),
    new Set(["prefetch-above", "previous-position"]),
  )
})

test("getTranslationWindowPriority prefers visible blocks over nearby offscreen blocks", () => {
  const options = { viewportHeight: 700, prefetchViewports: 2, topMargin: 96 }

  assert.ok(
    getTranslationWindowPriority({ top: 40, bottom: 90 }, options) <
      getTranslationWindowPriority({ top: 760, bottom: 820 }, options),
  )
  assert.ok(
    getTranslationWindowPriority({ top: 40, bottom: 90 }, options) <
      getTranslationWindowPriority({ top: -80, bottom: -20 }, options),
  )
})
