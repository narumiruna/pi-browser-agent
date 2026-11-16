import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "vitest"

import * as YoutubeDiagnostics from "../../../src/browser/translation/content/youtube/diagnostics.js"

import {
  CONTROL_ATTR,
  CONTROL_SELECTOR,
  createYoutubePlayerControl,
  findYoutubePlayerControlAnchor,
  getVisibleYoutubeCaptionText,
  hasAvailableYoutubeCaptionTrack,
  isYoutubeWatchLocation,
  mountYoutubePlayerControl,
  turnOnNativeYoutubeCaptions,
  unbindYoutubePlayerControl,
} from "../../../src/browser/translation/content/youtube/player-control.js"

test("YouTube diagnostics describe the current player without secrets", () => {
  const control = {
    disabled: false,
    getAttribute(name) {
      return name === "data-state" ? "loading" : null
    },
    getBoundingClientRect() {
      return { height: 40, left: 10, top: 20, width: 40 }
    },
  }
  const captionButton = {
    getAttribute(name) {
      return name === "aria-pressed" ? "true" : "English captions"
    },
  }
  const captionSegment = {
    textContent: "Visible native caption",
    getAttribute(name) {
      return {
        "data-ot-queued": "true",
        "data-ot-source-id": "ot-4",
        "data-ot-translated": null,
      }[name]
    },
  }
  const readyNote = {}
  const video = { currentTime: 12.5, playbackRate: 1.5 }
  const documentLike = {
    elementFromPoint() {
      return control
    },
    querySelector(selector) {
      if (selector === "#movie_player video") {
        return video
      }
      if (selector === "[data-ot-youtube-control]") {
        return control
      }
      if (selector === ".ytp-subtitles-button") {
        return captionButton
      }
      return null
    },
    querySelectorAll(selector) {
      if (selector === "#ytp-caption-window-container .ytp-caption-segment") {
        return [captionSegment]
      }
      if (selector === '#ytp-caption-window-container [data-ot-role="note"][data-phase="ready"]') {
        return [readyNote]
      }
      return []
    },
  }

  assert.deepEqual(
    YoutubeDiagnostics.collectYoutubeDiagnostics({
      captionStatus: {
        hasTrack: true,
        prefetchAvailable: true,
        timedTrackAvailable: true,
        trackCount: 1,
        trackSource: "player-response",
      },
      document: documentLike,
      extensionVersion: "0.1.3",
      location: {
        hostname: "www.youtube.com",
        pathname: "/watch",
        search: "?v=abc123&t=5",
      },
    }),
    {
      captionButton: {
        ariaLabel: "English captions",
        ariaPressed: "true",
        found: true,
      },
      control: {
        disabled: false,
        found: true,
        hitTarget: true,
        state: "loading",
      },
      extensionVersion: "0.1.3",
      page: "www.youtube.com/watch?v=abc123",
      pipeline: {
        queuedSourceCount: 1,
        readyNoteCount: 1,
        sourceCount: 1,
        translatedSourceCount: 0,
      },
      playback: {
        currentTimeMs: 12500,
        playbackRate: 1.5,
      },
      captionTrack: {
        hasTrack: true,
        prefetchAvailable: true,
        timedTrackAvailable: true,
        trackSource: "player-response",
      },
      trackCount: 1,
      visibleCaptionCharacters: 22,
    },
  )
})

test("YouTube diagnostic reports redact secrets", () => {
  const report = YoutubeDiagnostics.createDiagnosticReport(
    { extensionVersion: "0.1.3", page: "www.youtube.com/watch?v=abc123" },
    [
      { stage: "click", detail: "received" },
      {
        stage: "error",
        detail: 'apiKey="sk-example-secret" Authorization: Bearer private-token',
      },
    ],
    [
      {
        stage: "prefetch-fallback",
        detail: "Timed captions unavailable",
      },
    ],
  )

  assert.match(report, /Pi Translator YouTube diagnostics/)
  assert.match(report, /notableEvents/)
  assert.match(report, /prefetch-fallback/)
  assert.match(report, /\[redacted\]/)
  assert.doesNotMatch(report, /sk-example-secret|private-token/)
})

test("YouTube diagnostic store retains root-cause events after activity rolls", () => {
  const store = YoutubeDiagnostics.createDiagnosticStore()

  store.add("prefetch-fallback", "Timed caption request failed with status 403")
  for (let index = 0; index < 35; index += 1) {
    store.add("step", String(index))
  }

  assert.equal(store.getEvents().length, 30)
  assert.equal(store.getEvents()[0].detail, "5")
  assert.deepEqual(store.getNotableEvents(), [
    {
      at: store.getNotableEvents()[0].at,
      detail: "Timed caption request failed with status 403",
      stage: "prefetch-fallback",
    },
  ])
  store.clear()
  assert.deepEqual(store.getEvents(), [])
  assert.deepEqual(store.getNotableEvents(), [])
})

test("YouTube diagnostics retain recovery failures and outcomes without request data", () => {
  const store = YoutubeDiagnostics.createDiagnosticStore()
  for (const stage of [
    "session-lost",
    "recovery-attempt",
    "request-timeout",
    "setup-error",
    "player-rebound",
    "recovery-success",
    "recovery-error",
  ])
    store.add(stage, `Pipeline stage: ${stage}`)
  for (let index = 0; index < 40; index++) store.add("extraction", "caption source count=1")
  assert.equal(store.getEvents().length, 30)
  assert.equal(store.getNotableEvents().length, 7)
  for (const [recovery, code] of [
    [{ inProgress: true }, "session-recovering"],
    [{ exhausted: true }, "session-recovery-exhausted"],
  ]) {
    const diagnosis = YoutubeDiagnostics.diagnoseYoutubePipeline({ recovery })
    assert.equal(diagnosis.status, "degraded")
    assert.equal(diagnosis.issues[0].code, code)
  }
  const report = YoutubeDiagnostics.createDiagnosticReport(
    { recovery: { attempts: 3, exhausted: true } },
    store.getEvents(),
    store.getNotableEvents(),
  )
  assert.match(report, /request-timeout/)
  assert.match(report, /recovery-success/)
  assert.doesNotMatch(report, /apiKey|Authorization|timedtext|sourceText|prompt|responseBody/)
})

test("YouTube diagnostics identify caption-churn starvation", () => {
  assert.deepEqual(
    YoutubeDiagnostics.diagnoseYoutubePipeline({
      captionTrack: {
        prefetchAvailable: false,
        timedTrackAvailable: true,
      },
      captionTrace: {
        renderedResults: 26,
        supersededResults: 16,
        visibleFallbacks: 19,
        recentHealth: {
          discardedFallbacksAtLeast: 3,
          hasSuccessfulRender: false,
          windowMs: 10_000,
        },
      },
      pipeline: { readyNoteCount: 0 },
      visibleCaptionCharacters: 77,
    }),
    {
      issues: [
        {
          code: "timed-prefetch-unavailable",
          detail:
            "A timed caption track exists, but prefetch is unavailable; inspect the retained prefetch-fallback event.",
        },
        {
          code: "caption-churn-starvation",
          detail:
            "At least three fallback results were discarded in the last 10 seconds with no successful render. failureCount counts API error events, not render health.",
        },
      ],
      status: "degraded",
    },
  )
})

function diagnoseTrace(trace, overrides = {}) {
  return YoutubeDiagnostics.diagnoseYoutubePipeline({
    captionTrace: trace.getSummary(),
    failureCount: 0,
    pipeline: { readyNoteCount: 0 },
    visibleCaptionCharacters: 77,
    ...overrides,
  })
}

test("recent caption health detects starvation after earlier success and recovers", () => {
  let now = 0
  const trace = YoutubeDiagnostics.createCaptionTraceStore({ now: () => now })

  trace.addOutcomes({ rendered: 26 })
  for (now = 1000; now <= 3000; now += 1000) {
    trace.addOutcomes({ fallbackDiscarded: 1, superseded: 1 })
  }
  assert.equal(diagnoseTrace(trace).status, "ok")
  now = 10_000
  const diagnosis = diagnoseTrace(trace)
  assert.equal(trace.getSummary().renderedResults, 26)
  assert.equal(diagnosis.issues[0].code, "caption-churn-starvation")
  // A pause does not hide genuine recent discarded outcomes.
  assert.equal(diagnoseTrace(trace, { playback: { paused: true } }).status, "degraded")
  assert.match(
    diagnosis.issues[0].detail,
    /failureCount counts API error events, not render health/,
  )
  assert.equal(diagnoseTrace(trace, { pipeline: { readyNoteCount: 1 } }).status, "ok")
  assert.equal(diagnoseTrace(trace, { visibleCaptionCharacters: 0 }).status, "ok")

  now = 10_001
  trace.addOutcomes({ rendered: 1 })
  assert.equal(diagnoseTrace(trace).status, "ok")
  now = 20_001
  assert.deepEqual(trace.getSummary().recentHealth, {
    discardedFallbacksAtLeast: 0,
    hasSuccessfulRender: false,
    windowMs: 10_000,
  })
  assert.equal(diagnoseTrace(trace).status, "ok")
})

test("recent caption health expires without new outcomes or playback polling", () => {
  let now = 500
  const trace = YoutubeDiagnostics.createCaptionTraceStore({ now: () => now })

  assert.equal(diagnoseTrace(trace, { playback: { paused: true } }).status, "ok")
  trace.addOutcomes({ fallbackDiscarded: 2 })
  assert.equal(diagnoseTrace(trace).status, "ok")
  trace.addOutcomes({ fallbackDiscarded: 1 })
  assert.equal(diagnoseTrace(trace).status, "degraded")
  now = 10_499
  assert.equal(diagnoseTrace(trace).status, "degraded")
  now = 10_500
  assert.equal(diagnoseTrace(trace, { playback: { paused: true } }).status, "ok")
  assert.equal(trace.getSummary().recentHealth.discardedFallbacksAtLeast, 0)
})

test("recent health excludes timed-only cache drops and normal cue transitions", () => {
  let now = 0
  const trace = YoutubeDiagnostics.createCaptionTraceStore({ now: () => now })

  trace.addMutation({ cachePath: "visible-fallback", kind: "source" })
  trace.addOutcomes({ cached: 100, superseded: 10, fallbackDiscarded: 0 })
  assert.equal(trace.getSummary().recentHealth.discardedFallbacksAtLeast, 0)
  assert.equal(diagnoseTrace(trace).status, "ok")
  for (now = 1000; now < 5000; now += 1000) {
    trace.addOutcomes({ rendered: 1, fallbackDiscarded: 1 })
    assert.equal(diagnoseTrace(trace).status, "ok")
  }
  // Lifetime totals alone cannot diagnose current render health.
  assert.equal(
    YoutubeDiagnostics.diagnoseYoutubePipeline({
      captionTrace: {
        renderedResults: 0,
        supersededResults: 100,
        visibleFallbacks: 100,
      },
      pipeline: { readyNoteCount: 0 },
      visibleCaptionCharacters: 77,
    }).status,
    "ok",
  )
})

test("recent health is bounded and resets without changing lifetime totals", () => {
  const trace = YoutubeDiagnostics.createCaptionTraceStore({ now: () => 0 })

  trace.addOutcomes({ rendered: 1 })
  for (let index = 0; index < 1000; index += 1) {
    trace.addOutcomes({ fallbackDiscarded: 100, superseded: 100 })
  }
  assert.deepEqual(trace.getSummary().recentHealth, {
    discardedFallbacksAtLeast: 3,
    hasSuccessfulRender: true,
    windowMs: 10_000,
  })
  assert.equal(trace.getSummary().supersededResults, 100_000)
  assert.equal(diagnoseTrace(trace).status, "ok")
  trace.resetRecentHealth()
  assert.equal(trace.getSummary().renderedResults, 1)
  assert.equal(trace.getSummary().supersededResults, 100_000)
  assert.equal(diagnoseTrace(trace).status, "ok")
  assert.equal(trace.getSummary().recentHealth.discardedFallbacksAtLeast, 0)
  trace.addOutcomes({ superseded: 3 })
  assert.equal(diagnoseTrace(trace).status, "degraded")
  trace.clear()
  assert.equal(trace.getSummary().supersededResults, 0)
  assert.equal(diagnoseTrace(trace).status, "ok")
})

test("YouTube diagnostics retain prefetch attempt summaries after activity rolls", () => {
  const store = YoutubeDiagnostics.createDiagnosticStore()
  store.add("prefetch-attempts", "native-request=http-error; advertised=empty-body")
  for (let index = 0; index < 35; index += 1) store.add("render", "outcome")
  assert.equal(store.getEvents().length, 30)
  assert.equal(store.getNotableEvents()[0].stage, "prefetch-attempts")
})

test("YouTube caption traces keep bounded timing metadata without text or secrets", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("./fixtures/youtube-auto-caption.json", import.meta.url), "utf8"),
  )
  const cue = fixture.events[0]
  const trace = YoutubeDiagnostics.createCaptionTraceStore({ limit: 3 })

  trace.addCue({
    apiKey: "sk-private",
    captionText: cue.segs.map((segment) => segment.utf8).join(""),
    cueStartMs: cue.tStartMs,
    durationMs: cue.dDurationMs,
    wordOffsetsMs: cue.segs.map((segment) => segment.tOffsetMs || 0),
  })
  trace.addMutation({
    cachePath: "exact",
    captionText: "Build reliable",
    characters: 14,
    kind: "source",
    playbackRate: 1,
    progressive: true,
    videoTimeMs: 1400,
  })
  trace.addMutation({
    authorization: "Bearer private-token",
    cachePath: "visible-fallback",
    characters: 18,
    kind: "render",
    playbackRate: 2,
    videoTimeMs: 1600,
  })

  trace.addOutcomes({
    cached: 2,
    provisional: 1,
    rendered: 1,
    superseded: 3,
  })
  assert.deepEqual(trace.getSummary(), {
    cachedResults: 2,
    exactCacheHits: 1,
    progressiveSourceMutations: 1,
    provisionalResults: 1,
    renderedResults: 1,
    recentHealth: {
      discardedFallbacksAtLeast: 3,
      hasSuccessfulRender: true,
      windowMs: 10_000,
    },
    sampleCount: 3,
    supersededResults: 3,
    timedPrefixHits: 0,
    visibleFallbacks: 1,
  })
  const serialized = JSON.stringify(trace.getSamples())

  assert.doesNotMatch(
    serialized,
    /Build reliable|sk-private|private-token|captionText|apiKey|authorization/u,
  )
  assert.deepEqual(trace.getSamples()[0], {
    cueStartMs: 1000,
    durationMs: 3000,
    kind: "cue",
    wordOffsetsMs: [0, 400, 900],
  })
  assert.deepEqual(trace.getSamples()[1], {
    cachePath: "exact",
    characters: 14,
    kind: "source",
    playbackRate: 1,
    progressive: true,
    videoTimeMs: 1400,
  })
  assert.deepEqual(trace.getSamples()[2], {
    cachePath: "visible-fallback",
    characters: 18,
    kind: "render",
    playbackRate: 2,
    progressive: false,
    videoTimeMs: 1600,
  })
})

test("YouTube caption traces normalize malformed timing inputs", () => {
  const trace = YoutubeDiagnostics.createCaptionTraceStore({ limit: 9999 })

  assert.doesNotThrow(() => trace.addCue({ wordOffsetsMs: 42 }))
  const returnedCue = trace.addCue({ wordOffsetsMs: [100] })

  returnedCue.wordOffsetsMs.push(200)
  trace.addMutation({ kind: "source", playbackRate: 0 })

  assert.deepEqual(trace.getSamples()[0].wordOffsetsMs, [])
  assert.deepEqual(trace.getSamples()[1].wordOffsetsMs, [100])
  assert.equal(trace.getSamples()[2].playbackRate, 1)
})

test("YouTube control is limited to watch and Shorts video routes", () => {
  assert.equal(
    isYoutubeWatchLocation({
      hostname: "www.youtube.com",
      pathname: "/watch",
      search: "?v=g7AxxkywiFI",
    }),
    true,
  )
  assert.equal(
    isYoutubeWatchLocation({
      hostname: "www.youtube.com",
      pathname: "/shorts/abc123",
      search: "",
    }),
    true,
  )
  assert.equal(
    isYoutubeWatchLocation({
      hostname: "m.youtube.com",
      pathname: "/watch",
      search: "?v=abc123",
    }),
    true,
  )
  assert.equal(
    isYoutubeWatchLocation({
      hostname: "www.youtube.com",
      pathname: "/",
      search: "",
    }),
    false,
  )
  assert.equal(
    isYoutubeWatchLocation({
      hostname: "music.youtube.com",
      pathname: "/watch",
      search: "?v=abc123",
    }),
    false,
  )
})

test("YouTube control reads all visible native caption segments", () => {
  assert.equal(
    getVisibleYoutubeCaptionText({
      querySelectorAll() {
        return [{ textContent: " First line " }, { textContent: "Second line" }]
      },
    }),
    "First line\nSecond line",
  )
  assert.equal(getVisibleYoutubeCaptionText(null), "")
})

test("YouTube control detects manually supplied and auto-generated caption tracks", () => {
  assert.equal(
    hasAvailableYoutubeCaptionTrack({
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            {
              kind: "asr",
              languageCode: "en",
              name: { simpleText: "English (auto-generated)" },
            },
          ],
        },
      },
    }),
    true,
  )
  assert.equal(hasAvailableYoutubeCaptionTrack({ captions: null }), false)
})

test("YouTube control activates an available auto-generated caption track", () => {
  const selectedTracks = []
  const captionButton = {
    click() {},
    getAttribute(name) {
      if (name === "aria-pressed") {
        return "false"
      }

      return name === "aria-label" ? "Subtitles unavailable" : null
    },
  }
  const player = {
    querySelector() {
      return captionButton
    },
    setOption(namespace, option, value) {
      selectedTracks.push({ namespace, option, value })
    },
  }
  const playerResponse = {
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {
            kind: "asr",
            languageCode: "en",
            name: { simpleText: "English (auto-generated)" },
          },
        ],
      },
    },
  }

  assert.equal(turnOnNativeYoutubeCaptions(player, playerResponse), false)
  assert.deepEqual(selectedTracks, [
    {
      namespace: "captions",
      option: "track",
      value: {
        kind: "asr",
        languageCode: "en",
        name: "English (auto-generated)",
      },
    },
  ])
})

test("creating a replacement control does not reset owner lifecycle state", () => {
  const button = {
    addEventListener() {},
    appendChild() {},
    setAttribute() {},
  }
  const documentLike = {
    createElement() {
      return button
    },
    createElementNS() {
      return {
        appendChild() {},
        setAttribute() {},
      }
    },
  }
  let appliedState = ""

  createYoutubePlayerControl({
    applyState(_button, state) {
      appliedState = state
    },
    document: documentLike,
  })

  assert.equal(appliedState, "")
})

test("the mounted control handles a direct click exactly once", () => {
  const listeners = []
  const attributes = new Map()
  const button = {
    addEventListener(type, listener) {
      listeners.push({ listener, type })
    },
    appendChild() {},
    setAttribute(name, value) {
      attributes.set(name, value)
    },
  }
  const documentLike = {
    createElement() {
      return button
    },
    createElementNS(_namespace, tagName) {
      return {
        appendChild() {},
        setAttribute() {},
        tagName,
      }
    },
  }
  let clickCount = 0

  assert.equal(
    createYoutubePlayerControl({
      document: documentLike,
      onClick() {
        clickCount += 1
      },
    }),
    button,
  )
  assert.equal(listeners.length, 1)
  assert.equal(listeners[0].type, "click")
  listeners[0].listener({})
  assert.equal(clickCount, 1)
})

test("delegated clicks survive YouTube replacing the mounted control", () => {
  const listeners = []
  const controls = {
    insertBefore() {},
  }
  const captionButton = { parentElement: controls }
  const existingButton = {
    nextElementSibling: captionButton,
    parentElement: controls,
  }
  const replacementButton = {}
  const player = {
    contains(element) {
      return element === replacementButton
    },
    querySelector(selector) {
      if (selector === ".ytp-subtitles-button") {
        return captionButton
      }

      return selector === CONTROL_SELECTOR ? existingButton : null
    },
  }
  const documentLike = {
    addEventListener(type, listener, capture) {
      listeners.push({ capture, listener, type })
    },
    querySelector(selector) {
      return selector === "#movie_player" ? player : null
    },
  }
  let clickedControl = null

  mountYoutubePlayerControl({
    document: documentLike,
    location: {
      hostname: "www.youtube.com",
      pathname: "/watch",
      search: "?v=abc123",
    },
    onClick(_event, control) {
      clickedControl = control
    },
  })

  assert.equal(listeners.length, 1)
  assert.equal(listeners[0].type, "click")
  assert.equal(listeners[0].capture, true)
  listeners[0].listener({
    target: {
      closest(selector) {
        return selector === CONTROL_SELECTOR ? replacementButton : null
      },
    },
  })
  assert.equal(clickedControl, replacementButton)
})

test("YouTube delegated control binding can be removed for reinjection", () => {
  const listeners = []
  const removed = []
  const documentLike = {
    addEventListener(type, listener, capture) {
      listeners.push({ capture, listener, type })
    },
    removeEventListener(type, listener, capture) {
      removed.push({ capture, listener, type })
    },
  }

  assert.equal(
    mountYoutubePlayerControl({
      document: documentLike,
      location: { hostname: "example.com", pathname: "/", search: "" },
    }),
    null,
  )
  assert.equal(unbindYoutubePlayerControl(documentLike), true)
  assert.deepEqual(removed, listeners)
  assert.equal(unbindYoutubePlayerControl(documentLike), false)
})

test("repeated mounting does not move an already positioned control", () => {
  let insertCount = 0
  const controls = {
    insertBefore() {
      insertCount += 1
    },
  }
  const captionButton = { parentElement: controls }
  const existingButton = {
    nextElementSibling: captionButton,
    parentElement: controls,
  }
  const player = {
    querySelector(selector) {
      if (selector === ".ytp-subtitles-button") {
        return captionButton
      }

      return selector === CONTROL_SELECTOR ? existingButton : null
    },
  }
  const documentLike = {
    querySelector(selector) {
      return selector === "#movie_player" ? player : null
    },
  }

  assert.equal(
    mountYoutubePlayerControl({
      document: documentLike,
      location: {
        hostname: "www.youtube.com",
        pathname: "/watch",
        search: "?v=abc123",
      },
    }),
    existingButton,
  )
  assert.equal(insertCount, 0)
})

test("YouTube control anchors beside the native captions button", () => {
  const controls = {}
  const captionButton = { parentElement: controls }
  const player = {
    querySelector(selector) {
      if (selector === ".ytp-subtitles-button") {
        return captionButton
      }

      return null
    },
  }

  assert.deepEqual(findYoutubePlayerControlAnchor(player), {
    controls,
    reference: captionButton,
  })
  assert.equal(CONTROL_ATTR, "data-ot-youtube-control")
  assert.equal(CONTROL_SELECTOR, `[${CONTROL_ATTR}]`)
})
