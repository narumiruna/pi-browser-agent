import assert from "node:assert/strict"
import { test } from "vitest"

import {
  buildTimedCaptionItems,
  getCaptionWindowMs,
  normalizePlaybackRate,
  parseJson3Captions,
  selectCaptionWindow,
  shouldReportCaptionProgress,
} from "../../../src/browser/translation/content/youtube/timed-captions.js"

const JSON3_FIXTURE = {
  events: [
    { tStartMs: 9000, dDurationMs: 1000, segs: [{ utf8: "Earlier" }] },
    {
      tStartMs: 10000,
      dDurationMs: 2200,
      segs: [{ utf8: "Hello" }, { utf8: " world" }],
    },
    { tStartMs: 69999, dDurationMs: 1000, segs: [{ utf8: "Inside" }] },
    { tStartMs: 70000, dDurationMs: 1000, segs: [{ utf8: "Boundary" }] },
    { tStartMs: 71000, dDurationMs: 1000 },
  ],
}

test("JSON3 timed captions preserve cue timing and joined segment text", () => {
  assert.deepEqual(parseJson3Captions(JSON3_FIXTURE), [
    { startMs: 9000, durationMs: 1000, text: "Earlier" },
    { startMs: 10000, durationMs: 2200, text: "Hello world" },
    { startMs: 69999, durationMs: 1000, text: "Inside" },
    { startMs: 70000, durationMs: 1000, text: "Boundary" },
  ])
})

test("caption window includes the active cue and starts in the next 60 seconds", () => {
  const cues = parseJson3Captions(JSON3_FIXTURE)

  assert.deepEqual(
    selectCaptionWindow(cues, { currentTimeMs: 10500, windowMs: 60000 }),
    cues.slice(1, 4),
  )
})

test("cumulative auto-caption events preserve every exact visible text boundary", () => {
  const cues = parseJson3Captions({
    events: [
      {
        tStartMs: 1000,
        dDurationMs: 3000,
        segs: [{ utf8: "We" }],
      },
      {
        tStartMs: 1400,
        dDurationMs: 2600,
        segs: [{ utf8: "We build" }],
      },
      {
        tStartMs: 1800,
        dDurationMs: 2200,
        segs: [{ utf8: "We build tools" }],
      },
    ],
  })

  assert.deepEqual(
    selectCaptionWindow(cues, { currentTimeMs: 2000, windowMs: 1000 }).map((cue) => cue.text),
    ["We", "We build", "We build tools"],
  )
  assert.deepEqual(
    buildTimedCaptionItems(cues).map((item) => item.text),
    ["We", "We build", "We build tools"],
  )
})

test("timed captions become stable subtitle queue items", () => {
  assert.deepEqual(
    buildTimedCaptionItems([
      { startMs: 1250, durationMs: 900, text: "One" },
      { startMs: 3000, durationMs: 800, text: "Two" },
    ]),
    [
      {
        id: "youtube-cue-1250-0",
        cueId: "youtube-cue-1250-0",
        cueStartMs: 1250,
        durationMs: 900,
        kind: "subtitle",
        text: "One",
        dedupeCompleted: true,
      },
      {
        id: "youtube-cue-3000-1",
        cueId: "youtube-cue-3000-1",
        cueStartMs: 3000,
        durationMs: 800,
        kind: "subtitle",
        text: "Two",
        dedupeCompleted: true,
      },
    ],
  )
})

test("playback progress reports every ten seconds and immediately after a seek", () => {
  assert.equal(shouldReportCaptionProgress(10000, 19000), false)
  assert.equal(shouldReportCaptionProgress(10000, 20000), true)
  assert.equal(shouldReportCaptionProgress(50000, 12000), true)
  assert.equal(shouldReportCaptionProgress(0, 1000, { force: true }), true)
})

test("caption windows preserve one minute of lead across playback rates", () => {
  assert.equal(normalizePlaybackRate(1), 1)
  assert.equal(normalizePlaybackRate(1.5), 1.5)
  assert.equal(normalizePlaybackRate(2), 2)
  assert.equal(normalizePlaybackRate(0), 1)
  assert.equal(normalizePlaybackRate(-1), 1)
  assert.equal(normalizePlaybackRate(Number.NaN), 1)
  assert.equal(normalizePlaybackRate("fast"), 1)
  assert.equal(getCaptionWindowMs(0.5), 60000)
  assert.equal(getCaptionWindowMs(1), 60000)
  assert.equal(getCaptionWindowMs(1.5), 90000)
  assert.equal(getCaptionWindowMs(2), 120000)
  assert.equal(getCaptionWindowMs(10), 180000)
})
