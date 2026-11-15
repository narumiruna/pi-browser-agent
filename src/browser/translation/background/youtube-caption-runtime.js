import { waitForAbortable } from "../shared/abort.js"
import {
  resolveNativeYoutubeCaptionRequestUrl,
  resolveYoutubeCaptionTracks,
} from "./youtube-caption-tracks.js"

const TRACKER_KEY = "__otCaptionRequestTracker"

function probeYoutubeCaptionState(trackerKey) {
  const rememberRequest = (entryName) => {
    try {
      const url = new URL(String(entryName || ""))
      const hostname = url.hostname.toLowerCase()

      if (
        url.protocol !== "https:" ||
        (hostname !== "youtube.com" && !hostname.endsWith(".youtube.com")) ||
        url.pathname !== "/api/timedtext"
      ) {
        return
      }

      const tracker = globalThis[trackerKey]
      const serialized = url.toString()

      tracker.urls = tracker.urls.filter((value) => value !== serialized)
      tracker.urls.push(serialized)
      tracker.urls.splice(0, Math.max(0, tracker.urls.length - 8))
    } catch (_error) {
      // Ignore unrelated resource URLs.
    }
  }

  if (!globalThis[trackerKey]) {
    globalThis[trackerKey] = { urls: [] }
    for (const entry of performance.getEntriesByType("resource")) {
      rememberRequest(entry.name)
    }
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          rememberRequest(entry.name)
        }
      })

      observer.observe({ type: "resource" })
      globalThis[trackerKey].observer = observer
    } catch (_error) {
      // Polling resource timing remains available as a fallback.
    }
  }

  const player = document.querySelector("#movie_player")
  const captionButton = player?.querySelector(".ytp-subtitles-button")

  if (!player || !captionButton) {
    return { enabled: false, hasTrack: false }
  }

  if (captionButton.getAttribute("aria-pressed") !== "true") {
    captionButton.click()
  }

  const initialResponse = globalThis.ytInitialPlayerResponse
  let playerResponse = null

  try {
    playerResponse = player.getPlayerResponse?.() || null
  } catch (_error) {
    playerResponse = null
  }

  const responseTracks = initialResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks
  const currentResponseTracks =
    playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks
  const playerTracks = player.getOption?.("captions", "tracklist")
  const tracks = Array.isArray(currentResponseTracks)
    ? currentResponseTracks
    : Array.isArray(responseTracks)
      ? responseTracks
      : Array.isArray(playerTracks)
        ? playerTracks
        : []

  if (captionButton.getAttribute("aria-pressed") !== "true" && tracks.length > 0) {
    const track = tracks[0]
    player.setOption?.("captions", "track", {
      languageCode: track.languageCode,
      kind: track.kind || "",
      name: track.name?.simpleText || track.name || "",
    })
  }
  const selectedTrack = player.getOption?.("captions", "track")
  const video = player.querySelector?.("video") || document.querySelector("video")
  const playbackRate = Number(video?.playbackRate)
  const currentVideoId = String(
    player.getVideoData?.()?.video_id ||
      new URLSearchParams(globalThis.location?.search || "").get("v") ||
      "",
  )
  const copyTracks = (value) =>
    (Array.isArray(value) ? value.slice(0, 32) : []).map((track) => ({
      baseUrl: String(track?.baseUrl || ""),
      kind: String(track?.kind || ""),
      languageCode: String(track?.languageCode || ""),
    }))

  return {
    currentTimeMs: Math.max(0, Number(video?.currentTime) || 0) * 1000,
    enabled: captionButton.getAttribute("aria-pressed") === "true",
    playbackRate: Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1,
    hasTrack: tracks.length > 0,
    trackCandidates: {
      currentVideoId,
      initialResponse: {
        tracks: copyTracks(responseTracks),
        videoId: String(initialResponse?.videoDetails?.videoId || ""),
      },
      playerOption: { tracks: copyTracks(playerTracks) },
      playerResponse: {
        tracks: copyTracks(currentResponseTracks),
        videoId: String(playerResponse?.videoDetails?.videoId || ""),
      },
      selectedTrack: selectedTrack
        ? {
            kind: String(selectedTrack.kind || ""),
            languageCode: String(selectedTrack.languageCode || ""),
          }
        : null,
    },
  }
}

async function enableYoutubeCaptions(chrome, tabId, { signal } = {}) {
  signal?.throwIfAborted()
  if (chrome.translation) return chrome.translation.youtubeProbe({ tabId })
  const [result] = await waitForAbortable(
    chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [TRACKER_KEY],
      func: probeYoutubeCaptionState,
    }),
    signal,
  )
  const captionState = result?.result

  if (!captionState) {
    return {
      enabled: false,
      hasTrack: false,
      trackBaseUrl: "",
      trackCount: 0,
      trackSource: "none",
      timedTrackAvailable: false,
    }
  }

  const resolvedTracks = resolveYoutubeCaptionTracks(captionState.trackCandidates)

  return {
    currentTimeMs: captionState.currentTimeMs,
    enabled: captionState.enabled,
    playbackRate: captionState.playbackRate,
    ...resolvedTracks,
  }
}

async function captureNativeYoutubeCaptionRequestUrl(
  chrome,
  tabId,
  advertisedUrl,
  { signal } = {},
) {
  signal?.throwIfAborted()
  if (chrome.translation) return chrome.translation.youtubeCapture({ tabId, url: advertisedUrl })
  let advertised = null

  try {
    advertised = new URL(String(advertisedUrl || ""))
  } catch (_error) {
    return ""
  }

  const expected = Object.fromEntries(
    ["v", "lang", "kind", "variant"].map((name) => [name, advertised.searchParams.get(name) || ""]),
  )
  const [result] = await waitForAbortable(
    chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [expected, TRACKER_KEY],
      func: async (match, trackerKey) => {
        const collect = () => {
          const trackedUrls = Array.isArray(globalThis[trackerKey]?.urls)
            ? globalThis[trackerKey].urls
            : []

          return [
            ...trackedUrls,
            ...performance.getEntriesByType("resource").map((entry) => entry.name),
          ]
            .flatMap((entryName) => {
              try {
                const url = new URL(entryName)
                const hostname = url.hostname.toLowerCase()

                if (
                  url.protocol !== "https:" ||
                  (hostname !== "youtube.com" && !hostname.endsWith(".youtube.com")) ||
                  url.pathname !== "/api/timedtext" ||
                  Object.entries(match).some(
                    ([name, value]) => value && url.searchParams.get(name) !== value,
                  )
                ) {
                  return []
                }

                return [url.toString()]
              } catch (_error) {
                return []
              }
            })
            .slice(-8)
        }
        const deadline = Date.now() + 1200
        let urls = collect()

        while (urls.length === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50))
          urls = collect()
        }

        return urls
      },
    }),
    signal,
  )

  return resolveNativeYoutubeCaptionRequestUrl(result?.result, advertised.toString())
}

export { captureNativeYoutubeCaptionRequestUrl, enableYoutubeCaptions, TRACKER_KEY }
