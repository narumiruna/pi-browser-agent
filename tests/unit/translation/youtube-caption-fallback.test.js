import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "vitest"

import { createCaptionFallbackStore } from "../../../src/browser/translation/content/youtube/caption-fallback.js"

test("caption fallback keeps one active request and the latest pending snapshot per slot", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("./fixtures/youtube-progressive-caption.json", import.meta.url), "utf8"),
  )
  const [first, second, third] = fixture.mutations
  const store = createCaptionFallbackStore()

  assert.deepEqual(store.offer(first.slot, { id: "a", text: first.text }), {
    accepted: true,
    coalesced: false,
  })
  assert.deepEqual(store.offer(first.slot, { id: "a", text: first.text }), {
    accepted: false,
    coalesced: false,
  })
  assert.deepEqual(store.offer(second.slot, { id: "b", text: second.text }), {
    accepted: false,
    coalesced: true,
  })
  assert.deepEqual(store.offer(third.slot, { id: "c", text: third.text }), {
    accepted: false,
    coalesced: true,
  })
  assert.deepEqual(store.getSummary(), {
    activeSlotCount: 1,
    coalescedFallbackCount: 2,
    latestPendingCount: 1,
    supersededResultCount: 0,
  })
  assert.deepEqual(store.settle("a"), {
    shouldRetry: true,
    superseded: true,
    tracked: true,
  })
  assert.deepEqual(store.offer(third.slot, { id: "c", text: third.text }), {
    accepted: true,
    coalesced: false,
  })
  assert.deepEqual(store.settle("c"), {
    shouldRetry: false,
    superseded: false,
    tracked: true,
  })
})

test("caption fallback coalesces changed text that keeps its source identity", () => {
  const store = createCaptionFallbackStore()

  assert.deepEqual(store.offer("caption-0", { id: "ot-4", text: "Build" }), {
    accepted: true,
    coalesced: false,
  })
  assert.deepEqual(
    store.offer("caption-0", {
      id: "ot-4",
      text: "Build reliable tools",
    }),
    {
      accepted: false,
      coalesced: true,
    },
  )
  assert.deepEqual(store.getLatest("ot-4"), {
    id: "ot-4",
    text: "Build reliable tools",
  })
  assert.deepEqual(
    store.offer("caption-0", {
      id: "ot-4",
      text: "Build reliable tools",
    }),
    {
      accepted: false,
      coalesced: false,
    },
  )
  assert.deepEqual(store.settle("ot-4"), {
    shouldRetry: true,
    superseded: true,
    tracked: true,
  })
  assert.equal(store.getLatest("ot-4"), null)
  assert.equal(
    store.offer("caption-0", {
      id: "ot-4",
      text: "Build reliable tools",
    }).accepted,
    true,
  )
})

test("caption fallback bounds slots and rejects duplicate active identities", () => {
  const store = createCaptionFallbackStore({ slotLimit: 2 })

  assert.equal(store.offer("slot-0", { id: "same", text: "First" }).accepted, true)
  assert.deepEqual(store.offer("slot-1", { id: "same", text: "Duplicate" }), {
    accepted: false,
    coalesced: false,
  })
  assert.equal(store.offer("slot-1", { id: "second", text: "Second" }).accepted, true)
  assert.deepEqual(store.offer("slot-2", { id: "third", text: "Third" }), {
    accepted: false,
    coalesced: false,
  })
  assert.equal(store.getSummary().activeSlotCount, 2)
})

test("failed fallback retries only once and a changed latest snapshot remains eligible", () => {
  const store = createCaptionFallbackStore()
  const item = { id: "one", text: "Caption" }
  store.offer("caption-0", item)
  assert.equal(store.fail("one", { retryable: true }).shouldRetry, true)
  assert.equal(store.offer("caption-0", item).accepted, true)
  assert.equal(store.fail("one", { retryable: true }).retryExhausted, true)
  assert.equal(store.offer("caption-0", item).accepted, false)
  store.offer("caption-0", { id: "two", text: "New caption" })
  store.offer("caption-0", { id: "three", text: "Latest caption" })
  assert.equal(store.fail("two", { retryable: true }).shouldRetry, true)
  assert.equal(store.offer("caption-0", { id: "three", text: "Latest caption" }).accepted, true)
  assert.equal(store.fail("three", { retryable: false }).shouldRetry, false)
  assert.equal(store.getSummary().activeSlotCount, 0)
})

test("seek invalidation keeps bounded tombstones without blocking fresh identities", () => {
  const store = createCaptionFallbackStore({ supersededLimit: 2 })
  for (let index = 0; index < 3; index += 1) {
    store.offer("slot", { id: `old-${index}`, text: "Caption" })
    store.invalidate()
  }
  assert.equal(store.settle("old-0").tracked, false)
  assert.deepEqual(store.settle("old-1"), {
    shouldRetry: false,
    superseded: true,
    tracked: true,
    invalidated: true,
  })
  assert.equal(store.offer("slot", { id: "new", text: "Caption" }).accepted, true)
  assert.equal(store.settle("old-2").invalidated, true)
  assert.equal(store.getSummary().activeSlotCount, 1)
  assert.equal(store.settle("new").superseded, false)
})

test("seek invalidation also retires results whose caption slots already disappeared", () => {
  const store = createCaptionFallbackStore()
  for (let index = 0; index < 3; index++) {
    store.offer(`slot-${index}`, {
      id: `old-${index}`,
      text: "Pre-seek caption",
    })
  }
  store.retain(new Set())
  store.invalidate()
  for (let index = 0; index < 3; index++) {
    assert.equal(store.settle(`old-${index}`).invalidated, true)
  }
  assert.equal(store.getSummary().activeSlotCount, 0)
})

test("caption fallback classifies removed slots and clears retained state", () => {
  const store = createCaptionFallbackStore()

  store.offer("slot-0", { id: "old", text: "Old cue" })
  store.retain(new Set(["slot-1"]))

  assert.deepEqual(store.settle("old"), {
    shouldRetry: false,
    superseded: true,
    tracked: true,
  })
  store.offer("slot-1", { id: "new", text: "New cue" })
  store.clear()
  assert.deepEqual(store.getSummary(), {
    activeSlotCount: 0,
    coalescedFallbackCount: 0,
    latestPendingCount: 0,
    supersededResultCount: 0,
  })
  assert.deepEqual(store.settle("new"), {
    shouldRetry: false,
    superseded: false,
    tracked: false,
  })
})
