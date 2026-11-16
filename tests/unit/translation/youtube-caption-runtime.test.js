import assert from "node:assert/strict"
import { test } from "vitest"

import {
  enableYoutubeCaptions,
  TRACKER_KEY,
} from "../../../src/browser/translation/background/youtube-caption-runtime.js"

test("YouTube caption probe uses the main world and normalizes its result", async () => {
  let scriptDetails
  const chrome = {
    scripting: {
      async executeScript(details) {
        scriptDetails = details
        return [
          {
            result: {
              currentTimeMs: 12500,
              enabled: true,
              playbackRate: 1.5,
              trackCandidates: {
                currentVideoId: "video-1",
                initialResponse: { tracks: [], videoId: "" },
                playerOption: { tracks: [] },
                playerResponse: {
                  tracks: [
                    {
                      baseUrl: "https://www.youtube.com/api/timedtext?v=video-1&lang=en",
                      kind: "asr",
                      languageCode: "en",
                    },
                  ],
                  videoId: "video-1",
                },
                selectedTrack: { kind: "asr", languageCode: "en" },
              },
            },
          },
        ]
      },
    },
  }

  const result = await enableYoutubeCaptions(chrome, 17)

  assert.deepEqual(
    {
      args: scriptDetails.args,
      func: scriptDetails.func,
      target: scriptDetails.target,
      world: scriptDetails.world,
    },
    {
      args: [TRACKER_KEY],
      func: scriptDetails.func,
      target: { tabId: 17 },
      world: "MAIN",
    },
  )
  assert.equal(scriptDetails.func.name, "probeYoutubeCaptionState")
  assert.deepEqual(result, {
    currentTimeMs: 12500,
    enabled: true,
    hasTrack: true,
    playbackRate: 1.5,
    trackBaseUrl: "https://www.youtube.com/api/timedtext?v=video-1&lang=en",
    trackCount: 1,
    trackSource: "player-response",
    timedTrackAvailable: true,
  })
})

test("YouTube caption probe returns a stable unavailable shape", async () => {
  const result = await enableYoutubeCaptions(
    {
      scripting: {
        async executeScript() {
          return []
        },
      },
    },
    17,
  )

  assert.deepEqual(result, {
    enabled: false,
    hasTrack: false,
    trackBaseUrl: "",
    trackCount: 0,
    trackSource: "none",
    timedTrackAvailable: false,
  })
})
