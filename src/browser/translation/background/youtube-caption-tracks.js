const TRACK_SOURCES = Object.freeze([
  ["initial-response", "initialResponse"],
  ["player-response", "playerResponse"],
  ["player-option", "playerOption"],
])

function normalizeTracks(value) {
  return Array.isArray(value) ? value.filter((track) => track && typeof track === "object") : []
}

function isCurrentSource(source, currentVideoId) {
  const sourceVideoId = String(source?.videoId || "")
  const currentId = String(currentVideoId || "")

  return !sourceVideoId || !currentId || sourceVideoId === currentId
}

function parseTrustedTimedTextUrl(value) {
  try {
    const url = new URL(String(value || ""))
    const hostname = url.hostname.toLowerCase()

    if (
      url.protocol !== "https:" ||
      (hostname !== "youtube.com" && !hostname.endsWith(".youtube.com")) ||
      url.pathname !== "/api/timedtext"
    ) {
      return null
    }

    return url
  } catch (_error) {
    return null
  }
}

function resolveNativeYoutubeCaptionRequestUrl(requestUrls, advertisedUrl) {
  const advertised = parseTrustedTimedTextUrl(advertisedUrl)

  if (!advertised) {
    return ""
  }

  const matchParameters = ["v", "lang", "kind", "variant"]
  let best = null
  let bestScore = -1

  for (const value of requestUrls || []) {
    const candidate = parseTrustedTimedTextUrl(value)

    if (
      !candidate ||
      matchParameters.some((name) => {
        const expected = advertised.searchParams.get(name)

        return expected && candidate.searchParams.get(name) !== expected
      })
    ) {
      continue
    }

    const score =
      (candidate.searchParams.has("pot") ? 100 : 0) +
      (candidate.searchParams.has("potc") ? 20 : 0) +
      ["xorb", "xobt", "xovt", "c", "cver"].filter((name) => candidate.searchParams.has(name))
        .length

    if (score >= bestScore) {
      best = candidate
      bestScore = score
    }
  }

  return best?.toString() || ""
}

function matchesSelectedTrack(track, selectedTrack) {
  const selectedLanguage = String(selectedTrack?.languageCode || "")
  const selectedKind = String(selectedTrack?.kind || "")

  if (!selectedLanguage || String(track?.languageCode || "") !== selectedLanguage) {
    return false
  }

  return !selectedKind || String(track?.kind || "") === selectedKind
}

function resolveYoutubeCaptionTracks(input = {}) {
  const sources = TRACK_SOURCES.map(([label, key]) => ({
    label,
    tracks: isCurrentSource(input[key], input.currentVideoId)
      ? normalizeTracks(input[key]?.tracks)
      : [],
  }))
  const selectedTrack = input.selectedTrack
  let resolvedSource = null
  let timedTrack = null

  if (selectedTrack) {
    for (const source of sources) {
      const selected = source.tracks.find(
        (track) => track.baseUrl && matchesSelectedTrack(track, selectedTrack),
      )

      if (selected) {
        resolvedSource = source
        timedTrack = selected
        break
      }
    }
  }

  if (!timedTrack) {
    for (const source of sources) {
      const candidate = source.tracks.find((track) => track.baseUrl)

      if (candidate) {
        resolvedSource = source
        timedTrack = candidate
        break
      }
    }
  }

  resolvedSource ||= sources.find((source) => source.tracks.length > 0) || null

  return {
    hasTrack: Boolean(resolvedSource),
    trackBaseUrl: String(timedTrack?.baseUrl || ""),
    trackCount: resolvedSource?.tracks.length || 0,
    trackSource: resolvedSource?.label || "none",
    timedTrackAvailable: Boolean(timedTrack),
  }
}

export { resolveNativeYoutubeCaptionRequestUrl, resolveYoutubeCaptionTracks }
