const CONTROL_SELECTOR = "[data-ot-youtube-control]"
const CAPTION_BUTTON_SELECTOR = ".ytp-subtitles-button"
const CAPTION_SEGMENT_SELECTOR = "#ytp-caption-window-container .ytp-caption-segment"
const MAX_EVENTS = 30
const MAX_TRACE_SAMPLES = 120
const RECENT_HEALTH_WINDOW_MS = 10_000
const RECENT_DISCARD_THRESHOLD = 3
const NOTABLE_EVENT_STAGES = new Set([
  "api-error",
  "background-error",
  "caption-timeout",
  "message-error",
  "prefetch-fallback",
  "prefetch-attempts",
  "queue-error",
  "session-lost",
  "recovery-attempt",
  "recovery-success",
  "recovery-error",
  "request-timeout",
  "setup-error",
  "player-rebound",
])
const MAX_TRACE_WORD_OFFSETS = 32
const TRACE_CACHE_PATHS = new Set(["exact", "timed-prefix", "visible-fallback"])

function normalizeNonNegativeNumber(value, fallback = 0) {
  const number = Number(value)

  return Number.isFinite(number) && number >= 0 ? number : fallback
}

function normalizeTraceLimit(value) {
  const number = Math.floor(Number(value))

  return Number.isFinite(number) && number > 0
    ? Math.min(number, MAX_TRACE_SAMPLES)
    : MAX_TRACE_SAMPLES
}

function getVideoPageLabel(locationLike) {
  const hostname = String(locationLike?.hostname || "")
  const pathname = String(locationLike?.pathname || "")
  const videoId = new URLSearchParams(String(locationLike?.search || "")).get("v")

  return `${hostname}${pathname}${videoId ? `?v=${videoId}` : ""}`
}

function getControlHitTarget(documentLike, control) {
  if (!control?.getBoundingClientRect || !documentLike?.elementFromPoint) {
    return false
  }

  const rect = control.getBoundingClientRect()
  const target = documentLike.elementFromPoint(
    rect.left + rect.width / 2,
    rect.top + rect.height / 2,
  )

  return target === control || target?.closest?.(CONTROL_SELECTOR) === control
}

function collectYoutubeDiagnostics(options = {}) {
  const documentLike = options.document || globalThis.document
  const control = documentLike?.querySelector?.(CONTROL_SELECTOR)
  const captionButton = documentLike?.querySelector?.(CAPTION_BUTTON_SELECTOR)
  const video = documentLike?.querySelector?.("#movie_player video")
  const playbackRate = Number(video?.playbackRate)
  const captionSegments = Array.from(
    documentLike?.querySelectorAll?.(CAPTION_SEGMENT_SELECTOR) || [],
  )
  const visibleCaptionText = captionSegments
    .map((segment) => String(segment.textContent || "").trim())
    .filter(Boolean)
    .join("\n")
  const captionStatus = options.captionStatus || {}
  const readyNotes = Array.from(
    documentLike?.querySelectorAll?.(
      '#ytp-caption-window-container [data-ot-role="note"][data-phase="ready"]',
    ) || [],
  )

  return {
    captionButton: {
      ariaLabel: captionButton?.getAttribute?.("aria-label") || "",
      ariaPressed: captionButton?.getAttribute?.("aria-pressed") || "",
      found: Boolean(captionButton),
    },
    control: {
      disabled: Boolean(control?.disabled),
      found: Boolean(control),
      hitTarget: getControlHitTarget(documentLike, control),
      state: control?.getAttribute?.("data-state") || "",
    },
    extensionVersion: String(options.extensionVersion || "unknown"),
    page: getVideoPageLabel(options.location || globalThis.location),
    pipeline: {
      queuedSourceCount: captionSegments.filter(
        (segment) => segment.getAttribute?.("data-ot-queued") === "true",
      ).length,
      readyNoteCount: readyNotes.length,
      sourceCount: captionSegments.filter((segment) =>
        Boolean(segment.getAttribute?.("data-ot-source-id")),
      ).length,
      translatedSourceCount: captionSegments.filter(
        (segment) => segment.getAttribute?.("data-ot-translated") === "true",
      ).length,
    },
    playback: {
      currentTimeMs: Math.max(0, Number(video?.currentTime) || 0) * 1000,
      playbackRate: Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1,
    },
    captionTrack: {
      hasTrack: Boolean(captionStatus.hasTrack),
      prefetchAvailable: Boolean(captionStatus.prefetchAvailable),
      timedTrackAvailable: Boolean(captionStatus.timedTrackAvailable),
      trackSource: String(captionStatus.trackSource || "none"),
    },
    trackCount: Math.max(0, Number(captionStatus.trackCount) || 0),
    visibleCaptionCharacters: visibleCaptionText.length,
  }
}

function diagnoseYoutubePipeline(snapshot = {}) {
  const issues = []
  const captionTrack = snapshot.captionTrack || {}
  const recentHealth = snapshot.captionTrace?.recentHealth || {}
  const pipeline = snapshot.pipeline || {}

  if (snapshot.recovery?.exhausted) {
    issues.push({
      code: "session-recovery-exhausted",
      detail: "Automatic recovery stopped; click the player control to retry.",
    })
  } else if (snapshot.recovery?.inProgress) {
    issues.push({
      code: "session-recovering",
      detail: "The background subtitle session is being restored.",
    })
  }

  if (captionTrack.timedTrackAvailable && !captionTrack.prefetchAvailable) {
    issues.push({
      code: "timed-prefetch-unavailable",
      detail:
        "A timed caption track exists, but prefetch is unavailable; inspect the retained prefetch-fallback event.",
    })
  }

  if (
    Number(snapshot.visibleCaptionCharacters) > 0 &&
    Number(pipeline.readyNoteCount) === 0 &&
    !recentHealth.hasSuccessfulRender &&
    Number(recentHealth.discardedFallbacksAtLeast) >= RECENT_DISCARD_THRESHOLD
  ) {
    issues.push({
      code: "caption-churn-starvation",
      detail:
        "At least three fallback results were discarded in the last 10 seconds with no successful render. failureCount counts API error events, not render health.",
    })
  }

  return {
    issues,
    status: issues.length > 0 ? "degraded" : "ok",
  }
}

function redactDiagnosticText(value) {
  return String(value || "")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s"']+/giu, "$1[redacted]")
    .replace(/(api[_-]?key\s*[=:]\s*["']?)[^\s"']+/giu, "$1[redacted]")
}

function normalizeDiagnosticEvent(event) {
  return {
    at: String(event?.at || new Date().toISOString()),
    detail: redactDiagnosticText(event?.detail),
    stage: String(event?.stage || "unknown"),
  }
}

function createDiagnosticStore() {
  const events = []
  const notableEvents = new Map()

  return {
    add(stage, detail = "") {
      const event = normalizeDiagnosticEvent({ detail, stage })

      events.push(event)
      if (NOTABLE_EVENT_STAGES.has(event.stage) && !notableEvents.has(event.stage)) {
        notableEvents.set(event.stage, event)
      }
      if (events.length > MAX_EVENTS) {
        events.splice(0, events.length - MAX_EVENTS)
      }
      return { ...event }
    },
    clear() {
      events.length = 0
      notableEvents.clear()
    },
    getEvents() {
      return events.map((event) => ({ ...event }))
    },
    getNotableEvents() {
      return Array.from(notableEvents.values(), (event) => ({ ...event }))
    },
  }
}

function createCaptionTraceStore(options = {}) {
  const limit = normalizeTraceLimit(options.limit)
  const samples = []
  const now = options.now || (() => performance.now())
  // Only the latest three discards are needed to test the starvation threshold.
  const recentDiscards = []
  let lastSuccessfulRender = null
  const counters = {
    cachedResults: 0,
    exactCacheHits: 0,
    progressiveSourceMutations: 0,
    provisionalResults: 0,
    renderedResults: 0,
    supersededResults: 0,
    timedPrefixHits: 0,
    visibleFallbacks: 0,
  }

  function cloneSample(sample) {
    return {
      ...sample,
      ...(sample.wordOffsetsMs ? { wordOffsetsMs: [...sample.wordOffsetsMs] } : {}),
    }
  }

  function append(sample) {
    samples.push(sample)
    if (samples.length > limit) {
      samples.splice(0, samples.length - limit)
    }
    return cloneSample(sample)
  }

  function resetRecentHealth() {
    recentDiscards.length = 0
    lastSuccessfulRender = null
  }

  function getRecentHealth(at = now()) {
    const cutoff = at - RECENT_HEALTH_WINDOW_MS

    while (recentDiscards.length > 0 && recentDiscards[0] <= cutoff) {
      recentDiscards.shift()
    }
    if (lastSuccessfulRender !== null && lastSuccessfulRender <= cutoff) {
      lastSuccessfulRender = null
    }
    return {
      discardedFallbacksAtLeast: recentDiscards.length,
      hasSuccessfulRender: lastSuccessfulRender !== null,
      windowMs: RECENT_HEALTH_WINDOW_MS,
    }
  }

  function countSample(sample) {
    if (sample.cachePath === "exact") {
      counters.exactCacheHits += 1
    } else if (sample.cachePath === "timed-prefix") {
      counters.timedPrefixHits += 1
    } else if (sample.cachePath === "visible-fallback") {
      counters.visibleFallbacks += 1
    }

    if (sample.kind === "source" && sample.progressive) {
      counters.progressiveSourceMutations += 1
    }
  }

  return {
    addCue(cue = {}) {
      return append({
        cueStartMs: normalizeNonNegativeNumber(cue.cueStartMs),
        durationMs: normalizeNonNegativeNumber(cue.durationMs),
        kind: "cue",
        wordOffsetsMs: (Array.isArray(cue.wordOffsetsMs) ? cue.wordOffsetsMs : [])
          .slice(0, MAX_TRACE_WORD_OFFSETS)
          .map((value) => normalizeNonNegativeNumber(value)),
      })
    },
    addMutation(mutation = {}) {
      const cachePath = TRACE_CACHE_PATHS.has(mutation.cachePath) ? mutation.cachePath : ""
      const sample = {
        cachePath,
        characters: Math.floor(normalizeNonNegativeNumber(mutation.characters)),
        kind: mutation.kind === "source" ? "source" : "render",
        playbackRate:
          Number.isFinite(Number(mutation.playbackRate)) && Number(mutation.playbackRate) > 0
            ? Number(mutation.playbackRate)
            : 1,
        progressive: Boolean(mutation.progressive),
        videoTimeMs: normalizeNonNegativeNumber(mutation.videoTimeMs),
      }

      countSample(sample)
      return append(sample)
    },
    addOutcomes(outcomes = {}) {
      const at = now()
      const discarded = Math.min(
        RECENT_DISCARD_THRESHOLD,
        Math.floor(normalizeNonNegativeNumber(outcomes.fallbackDiscarded ?? outcomes.superseded)),
      )

      getRecentHealth(at)
      if (normalizeNonNegativeNumber(outcomes.rendered) > 0) {
        lastSuccessfulRender = at
      }
      for (let index = 0; index < discarded; index += 1) {
        recentDiscards.push(at)
      }
      if (recentDiscards.length > RECENT_DISCARD_THRESHOLD) {
        recentDiscards.splice(0, recentDiscards.length - RECENT_DISCARD_THRESHOLD)
      }
      for (const [counter, value] of [
        ["cachedResults", outcomes.cached],
        ["provisionalResults", outcomes.provisional],
        ["renderedResults", outcomes.rendered],
        ["supersededResults", outcomes.superseded],
        ["timedPrefixHits", outcomes.timedPrefix],
      ]) {
        counters[counter] += Math.floor(normalizeNonNegativeNumber(value))
      }
      return {
        ...counters,
        recentHealth: getRecentHealth(at),
        sampleCount: samples.length,
      }
    },
    clear() {
      samples.length = 0
      resetRecentHealth()
      for (const key of Object.keys(counters)) {
        counters[key] = 0
      }
    },
    getSamples() {
      return samples.map(cloneSample)
    },
    getSummary() {
      return {
        ...counters,
        recentHealth: getRecentHealth(),
        sampleCount: samples.length,
      }
    },
    resetRecentHealth,
  }
}

function createDiagnosticReport(snapshot, events, notableEvents) {
  return [
    "Pi Translator YouTube diagnostics",
    JSON.stringify(
      {
        events: (events || []).map(normalizeDiagnosticEvent),
        notableEvents: (notableEvents || []).map(normalizeDiagnosticEvent),
        snapshot: snapshot || {},
      },
      null,
      2,
    ),
  ].join("\n")
}

export {
  CAPTION_BUTTON_SELECTOR,
  CAPTION_SEGMENT_SELECTOR,
  CONTROL_SELECTOR,
  collectYoutubeDiagnostics,
  createCaptionTraceStore,
  createDiagnosticReport,
  createDiagnosticStore,
  diagnoseYoutubePipeline,
}
