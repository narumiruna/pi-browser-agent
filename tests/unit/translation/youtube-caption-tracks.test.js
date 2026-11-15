import assert from "node:assert/strict"
import { test } from "vitest"

import {
  resolveNativeYoutubeCaptionRequestUrl,
  resolveYoutubeCaptionTracks,
} from "../../../src/browser/translation/background/youtube-caption-tracks.js"

function track(languageCode, options = {}) {
  return {
    baseUrl: options.baseUrl || "",
    kind: options.kind || "",
    languageCode,
  }
}

test("caption track resolver prefers the selected current player-response track", () => {
  assert.deepEqual(
    resolveYoutubeCaptionTracks({
      currentVideoId: "current",
      initialResponse: {
        tracks: [track("fr", { baseUrl: "https://www.youtube.com/initial" })],
        videoId: "current",
      },
      playerOption: {
        tracks: [track("de", { baseUrl: "https://www.youtube.com/option" })],
      },
      playerResponse: {
        tracks: [
          track("es", { baseUrl: "https://www.youtube.com/es" }),
          track("en", {
            baseUrl: "https://www.youtube.com/en",
            kind: "asr",
          }),
        ],
        videoId: "current",
      },
      selectedTrack: track("en", { kind: "asr" }),
    }),
    {
      hasTrack: true,
      trackBaseUrl: "https://www.youtube.com/en",
      trackCount: 2,
      trackSource: "player-response",
      timedTrackAvailable: true,
    },
  )
})

test("caption track resolver ignores stale and malformed response sources", () => {
  assert.deepEqual(
    resolveYoutubeCaptionTracks({
      currentVideoId: "current",
      initialResponse: {
        tracks: [track("en", { baseUrl: "https://www.youtube.com/stale" })],
        videoId: "old",
      },
      playerOption: { tracks: null },
      playerResponse: { tracks: [{ languageCode: "en" }], videoId: "current" },
      selectedTrack: track("en"),
    }),
    {
      hasTrack: true,
      trackBaseUrl: "",
      trackCount: 1,
      trackSource: "player-response",
      timedTrackAvailable: false,
    },
  )
})

test("native caption request resolver prefers the current proof-bearing track", () => {
  const advertisedUrl = "https://www.youtube.com/api/timedtext?v=current&lang=en&kind=asr"
  const nativeUrl =
    "https://www.youtube.com/api/timedtext?v=current&lang=en&kind=asr&fmt=json3&pot=fixture-proof"

  assert.equal(
    resolveNativeYoutubeCaptionRequestUrl(
      [
        "https://attacker.example/api/timedtext?v=current&lang=en&pot=bad",
        "https://www.youtube.com/api/timedtext?v=old&lang=en&kind=asr&pot=stale",
        "https://www.youtube.com/api/timedtext?v=current&lang=fr&kind=asr&pot=wrong-language",
        "https://www.youtube.com/watch?v=current&lang=en&pot=wrong-path",
        "https://www.youtube.com/api/timedtext?v=current&lang=en&kind=asr&fmt=json3",
        nativeUrl,
      ],
      advertisedUrl,
    ),
    nativeUrl,
  )
})

test("native caption request resolver rejects unrelated requests safely", () => {
  const advertisedUrl = "https://www.youtube.com/api/timedtext?v=current&lang=en&kind=asr"

  assert.equal(
    resolveNativeYoutubeCaptionRequestUrl(
      [
        "not a URL",
        "http://www.youtube.com/api/timedtext?v=current&lang=en",
        "https://m.youtube.com/api/timedtext?v=other&lang=en",
      ],
      advertisedUrl,
    ),
    "",
  )
  assert.equal(resolveNativeYoutubeCaptionRequestUrl([], advertisedUrl), "")
  assert.equal(
    resolveNativeYoutubeCaptionRequestUrl(
      ["https://www.youtube.com/api/timedtext?v=current&lang=en"],
      "https://attacker.example/api/timedtext?v=current&lang=en",
    ),
    "",
  )
})

test("caption track resolver falls back across direct and option sources", () => {
  assert.deepEqual(
    resolveYoutubeCaptionTracks({
      currentVideoId: "current",
      initialResponse: {
        tracks: [track("ja", { baseUrl: "https://www.youtube.com/initial" })],
        videoId: "current",
      },
      playerOption: {
        tracks: [track("en", { baseUrl: "https://www.youtube.com/option" })],
      },
      playerResponse: { tracks: [], videoId: "current" },
      selectedTrack: track("en"),
    }),
    {
      hasTrack: true,
      trackBaseUrl: "https://www.youtube.com/option",
      trackCount: 1,
      trackSource: "player-option",
      timedTrackAvailable: true,
    },
  )
  assert.deepEqual(resolveYoutubeCaptionTracks(), {
    hasTrack: false,
    trackBaseUrl: "",
    trackCount: 0,
    trackSource: "none",
    timedTrackAvailable: false,
  })
})
