const DEFAULT_CAPTION_WINDOW_MS = 60000
const MAX_CAPTION_WINDOW_MS = 180000
const DEFAULT_PROGRESS_REPORT_INTERVAL_MS = 10000

function normalizeNonNegativeNumber(value, fallback = 0) {
  const number = Number(value)

  return Number.isFinite(number) && number >= 0 ? number : fallback
}

function normalizePlaybackRate(value) {
  const rate = Number(value)

  return Number.isFinite(rate) && rate > 0 ? rate : 1
}

function getCaptionWindowMs(playbackRate) {
  return Math.min(
    MAX_CAPTION_WINDOW_MS,
    DEFAULT_CAPTION_WINDOW_MS * Math.max(1, normalizePlaybackRate(playbackRate)),
  )
}

function normalizeCaptionText(value) {
  return String(value || "")
    .replace(/\s+/gu, " ")
    .trim()
}

function parseJson3Captions(payload) {
  const cues = []

  for (const event of payload?.events || []) {
    const text = normalizeCaptionText(
      (event?.segs || []).map((segment) => segment?.utf8 || "").join(""),
    )

    if (!text || !Number.isFinite(Number(event?.tStartMs))) {
      continue
    }

    cues.push({
      startMs: normalizeNonNegativeNumber(event.tStartMs),
      durationMs: normalizeNonNegativeNumber(event.dDurationMs),
      text,
    })
  }

  return cues
}

function selectCaptionWindow(cues, options = {}) {
  const currentTimeMs = normalizeNonNegativeNumber(options.currentTimeMs)
  const windowMs = normalizeNonNegativeNumber(options.windowMs, DEFAULT_CAPTION_WINDOW_MS)
  const windowEndMs = currentTimeMs + windowMs

  return (cues || []).filter((cue) => {
    const cueStartMs = normalizeNonNegativeNumber(cue?.startMs)
    const cueEndMs = cueStartMs + normalizeNonNegativeNumber(cue?.durationMs)

    return cueStartMs < windowEndMs && (cueStartMs >= currentTimeMs || cueEndMs > currentTimeMs)
  })
}

function buildTimedCaptionItems(cues) {
  return (cues || []).map((cue, index) => {
    const id = `youtube-cue-${Math.floor(cue.startMs)}-${cue.cueIndex ?? index}`

    return {
      id,
      cueId: id,
      cueStartMs: normalizeNonNegativeNumber(cue.startMs),
      durationMs: normalizeNonNegativeNumber(cue.durationMs),
      kind: "subtitle",
      text: cue.text,
      dedupeCompleted: true,
    }
  })
}

function buildJson3TrackUrl(baseUrl) {
  const url = new URL(String(baseUrl || ""))

  url.searchParams.set("fmt", "json3")
  return url.toString()
}

function shouldReportCaptionProgress(previousTimeMs, currentTimeMs, options = {}) {
  if (options.force) {
    return true
  }

  const previous = normalizeNonNegativeNumber(previousTimeMs)
  const current = normalizeNonNegativeNumber(currentTimeMs)
  const interval = normalizeNonNegativeNumber(
    options.intervalMs,
    DEFAULT_PROGRESS_REPORT_INTERVAL_MS,
  )

  return Math.abs(current - previous) >= interval
}

export {
  buildJson3TrackUrl,
  buildTimedCaptionItems,
  DEFAULT_CAPTION_WINDOW_MS,
  getCaptionWindowMs,
  MAX_CAPTION_WINDOW_MS,
  normalizePlaybackRate,
  parseJson3Captions,
  selectCaptionWindow,
  shouldReportCaptionProgress,
}
