import { ui } from "../../shared/ui.js"
import { createCaptionFallbackStore } from "./caption-fallback.js"
import { createSubtitleRecovery } from "./recovery.js"

export function createYoutubeRuntime(options = {}) {
  const {
    activeSiteProfile,
    document,
    window,
    chrome,
    pageState,
    rootAttr: ROOT_ATTR,
    styleId: STYLE_ID,
    ensureStyles,
    SubtitleApi,
    YoutubeDiagnosticsApi,
    YoutubePlayerControlApi,
    TimedCaptionApi,
    Messages,
    scheduleVisibleTranslation,
  } = options
  const captionFallbackStore = createCaptionFallbackStore()
  let disposed = false
  let fallbackRetryTimer = null
  const recovery = createSubtitleRecovery({
    window,
    getVideoKey: getYoutubeVideoKey,
    isActive: () => !disposed && Boolean(pageState.pageTranslation.active),
    sendStart: (payload) =>
      chrome.runtime.sendMessage(Messages.startYoutubeSubtitleTranslation(payload)),
    onAttempt(attempt) {
      recordYoutubeDiagnostic("recovery-attempt", `Restarting subtitle session; attempt=${attempt}`)
    },
    onStarted(response) {
      if (!pageState.pageTranslation.active) return
      applyStartedSession(response)
      recordYoutubeDiagnostic("recovery-success", "Subtitle session restored")
      scheduleVisibleTranslation?.()
    },
    onFailure(_response, exhausted) {
      if (!exhausted) return
      cancelYoutubeSession()
      pageState.pageTranslation.active = false
      pageState.pageTranslation.sessionId = ""
      clearYoutubePrefetchTracking()
      resetYoutubeCaptionFallbacks()
      resetCaptionPresentation()
      showSubtitleFailure("Subtitle recovery failed. Click to try again")
      recordYoutubeDiagnostic(
        "recovery-error",
        "Subtitle recovery stopped; click the player control to retry",
        { show: true },
      )
    },
  })

  pageState.youtubeDiagnostics.captionStatus ||= {
    hasTrack: false,
    prefetchAvailable: false,
    timedTrackAvailable: false,
    trackCount: 0,
    trackSource: "none",
  }

  function getYoutubeDiagnosticSnapshot() {
    const events = pageState.youtubeDiagnostics.store.getEvents()
    const snapshot = {
      ...YoutubeDiagnosticsApi.collectYoutubeDiagnostics({
        captionStatus: pageState.youtubeDiagnostics.captionStatus,
        document,
        extensionVersion: chrome.runtime.getManifest?.().version || "unknown",
        location: window.location,
      }),
      recovery: recovery.getSummary(),
      captionFallback: captionFallbackStore.getSummary(),
      captionTrace: pageState.youtubeDiagnostics.captionTrace?.getSummary?.(),
      failureCount: events.filter((event) => event.stage === "api-error").length,
    }

    return {
      ...snapshot,
      diagnosis: YoutubeDiagnosticsApi.diagnoseYoutubePipeline?.(snapshot) || {
        issues: [],
        status: "unknown",
      },
    }
  }

  function getYoutubeDiagnosticReport() {
    return YoutubeDiagnosticsApi.createDiagnosticReport(
      getYoutubeDiagnosticSnapshot(),
      pageState.youtubeDiagnostics.store.getEvents(),
      pageState.youtubeDiagnostics.store.getNotableEvents?.() || [],
    )
  }

  function closeYoutubeDiagnostics() {
    pageState.youtubeDiagnostics.panel?.remove()
    pageState.youtubeDiagnostics.panel = null
    pageState.youtubeDiagnostics.paused = false
    pageState.youtubeDiagnostics.frozenReport = ""
  }

  async function copyYoutubeDiagnostics(button) {
    const report = pageState.youtubeDiagnostics.frozenReport || getYoutubeDiagnosticReport()

    try {
      await navigator.clipboard.writeText(report)
      button.textContent = ui("Copied")
    } catch (_error) {
      button.textContent = ui("Copy failed")
    }
  }

  function renderYoutubeDiagnostics(options = {}) {
    ensureStyles()
    const player = document.querySelector("#movie_player")

    if (!player) {
      return null
    }

    let panel = pageState.youtubeDiagnostics.panel

    if (panel?.isConnected && pageState.youtubeDiagnostics.paused && !options.force) {
      return panel
    }

    if (!panel?.isConnected) {
      panel = document.createElement("aside")
      panel.setAttribute(ROOT_ATTR, "youtube-diagnostics")
      panel.setAttribute("aria-live", "polite")
      panel.setAttribute("aria-label", ui("Pi Browser Agent diagnostics"))
      pageState.youtubeDiagnostics.panel = panel
      player.appendChild(panel)
    }

    const title = document.createElement("strong")
    const status = document.createElement("span")
    const output = document.createElement("pre")
    const copyButton = document.createElement("button")
    const pauseButton = document.createElement("button")
    const closeButton = document.createElement("button")

    title.textContent = ui("Pi Browser Agent diagnostics")
    status.setAttribute("data-ot-diagnostic-status", "")
    status.textContent = pageState.youtubeDiagnostics.status
    output.textContent = pageState.youtubeDiagnostics.frozenReport || getYoutubeDiagnosticReport()
    copyButton.type = "button"
    copyButton.textContent = ui("Copy diagnostics")
    copyButton.addEventListener("click", () => {
      copyYoutubeDiagnostics(copyButton)
    })
    pauseButton.type = "button"
    pauseButton.textContent = ui(
      pageState.youtubeDiagnostics.paused ? "Resume diagnostics" : "Pause diagnostics",
    )
    pauseButton.addEventListener("click", () => {
      if (pageState.youtubeDiagnostics.paused) {
        pageState.youtubeDiagnostics.paused = false
        pageState.youtubeDiagnostics.frozenReport = ""
      } else {
        pageState.youtubeDiagnostics.paused = true
        pageState.youtubeDiagnostics.frozenReport = getYoutubeDiagnosticReport()
      }
      renderYoutubeDiagnostics({ force: true })
    })
    closeButton.type = "button"
    closeButton.textContent = ui("Close")
    closeButton.addEventListener("click", closeYoutubeDiagnostics)
    panel.replaceChildren(title, status, output, copyButton, pauseButton, closeButton)

    return panel
  }

  function recordYoutubeDiagnostic(stage, detail, options = {}) {
    pageState.youtubeDiagnostics.store.add(stage, detail)
    pageState.youtubeDiagnostics.status = detail || stage
    pageState.youtubeDiagnostics.captionTrace?.addOutcomes?.(options.outcomes)

    if (pageState.pageTranslation.active && Number(options.outcomes?.delivered) > 0) {
      recovery.delivered()
      if (pageState.youtubeControl.errorReason === "translation-failure") {
        applyYoutubeControlState(pageState.youtubeControl.button, "active")
      }
    }
    if (Number(options.outcomes?.rendered) > 0) {
      recoverYoutubeCaptionTimeout()
    }
    if (options.show || pageState.youtubeDiagnostics.panel?.isConnected) {
      renderYoutubeDiagnostics()
    }
  }

  function getYoutubeCurrentTimeMs() {
    const video = document.querySelector("#movie_player video")

    return Math.max(0, Number(video?.currentTime) || 0) * 1000
  }

  function recoverYoutubeCaptionTimeout() {
    const button = pageState.youtubeControl.button

    if (
      pageState.youtubeControl.errorReason !== "caption-timeout" ||
      !button ||
      !YoutubePlayerControlApi?.getVisibleYoutubeCaptionText(document)
    ) {
      return false
    }

    applyYoutubeControlState(button, "active")
    recordYoutubeDiagnostic(
      "caption-recovered",
      "YouTube captions became visible; translation remains active",
    )
    return true
  }

  function recordYoutubeCachePaths(matched = {}) {
    const cached = matched.cached || []
    const missing = matched.missing || []
    const video = document.querySelector("#movie_player video")
    const playback = {
      playbackRate: video?.playbackRate,
      videoTimeMs: Math.max(0, Number(video?.currentTime) || 0) * 1000,
    }

    for (const item of cached) {
      pageState.youtubeDiagnostics.captionTrace?.addMutation?.({
        ...playback,
        cachePath: item.cachePath || "exact",
        characters: item.sourceText?.length,
        kind: "render",
      })
    }
    if (cached.length > 0 || missing.length > 0) {
      const exact = cached.filter((item) => item.cachePath !== "timed-prefix").length
      const timedPrefix = cached.length - exact

      recordYoutubeDiagnostic(
        "cache-path",
        `exact=${exact}; timed-prefix=${timedPrefix}; visible-fallback=${missing.length}`,
      )
      recoverYoutubeCaptionTimeout()
    }
  }

  function getCaptionSlots() {
    const sources = Array.from(
      document.querySelectorAll?.(YoutubeDiagnosticsApi.CAPTION_SEGMENT_SELECTOR) || [],
    )
    const slotBySourceId = new Map()
    const activeSlotIds = new Set()

    for (let index = 0; index < sources.length; index += 1) {
      const slotId = `caption-${index}`
      const sourceId = sources[index].getAttribute?.("data-ot-source-id")

      activeSlotIds.add(slotId)
      if (sourceId) {
        slotBySourceId.set(sourceId, slotId)
      }
    }

    return { activeSlotIds, slotBySourceId }
  }

  function prepareYoutubeCaptionFallbacks(matched = {}) {
    const before = captionFallbackStore.getSummary()
    const { activeSlotIds, slotBySourceId } = getCaptionSlots()
    const accepted = []

    captionFallbackStore.retain(activeSlotIds)
    for (const item of matched.missing || []) {
      const slotId = slotBySourceId.get(item.id)
      const result = captionFallbackStore.offer(slotId, item)
      const video = document.querySelector("#movie_player video")
      const trace = {
        characters: item.text?.length,
        kind: "source",
        playbackRate: video?.playbackRate,
        videoTimeMs: getYoutubeCurrentTimeMs(),
      }

      if (result.accepted) {
        accepted.push(item)
        pageState.youtubeDiagnostics.captionTrace?.addMutation?.({
          ...trace,
          cachePath: "visible-fallback",
        })
      } else if (result.coalesced) {
        pageState.youtubeDiagnostics.captionTrace?.addMutation?.({
          ...trace,
          progressive: true,
        })
      }
    }

    const after = captionFallbackStore.getSummary()
    const coalesced = after.coalescedFallbackCount - before.coalescedFallbackCount

    if (coalesced > 0) {
      recordYoutubeDiagnostic(
        "fallback-coalesced",
        `coalesced=${coalesced}; active-slots=${after.activeSlotCount}; latest-pending=${after.latestPendingCount}`,
      )
    }
    return accepted
  }

  function matchYoutubeCaptionItems(items) {
    const matched = SubtitleApi.consumeCachedSubtitleTranslations(
      pageState.youtubeSubtitleTranslations,
      items,
      { currentTimeMs: getYoutubeCurrentTimeMs() },
    )

    recordYoutubeCachePaths(matched)
    return {
      cached: matched.cached,
      missing: prepareYoutubeCaptionFallbacks(matched),
    }
  }

  function hasYoutubeCachedTranslation(sourceTexts) {
    return SubtitleApi.hasCachedSubtitleTranslation(
      pageState.youtubeSubtitleTranslations,
      sourceTexts,
      { currentTimeMs: getYoutubeCurrentTimeMs() },
    )
  }

  function settleYoutubeCaptionFallbacks(items) {
    const settledIds = new Set()
    const supersededIds = new Set()
    const supersededItems = new Map()
    const invalidatedIds = new Set()
    let shouldRetry = false

    for (const item of items || []) {
      const id = typeof item === "string" ? item : item?.id
      const retryItem = captionFallbackStore.getLatest(id)
      const result = captionFallbackStore.settle(id)

      if (!result.tracked) {
        continue
      }
      settledIds.add(id)
      if (result.invalidated) invalidatedIds.add(id)
      if (result.superseded) {
        supersededIds.add(id)
        if (retryItem) {
          supersededItems.set(id, retryItem)
        }
      }
      shouldRetry ||= result.shouldRetry
    }

    if (shouldRetry) {
      scheduleVisibleTranslation?.()
    }
    return { settledIds, supersededIds, supersededItems, invalidatedIds }
  }

  function resetYoutubeCaptionFallbacks() {
    pageState.youtubeDiagnostics.captionTrace?.resetRecentHealth?.()
    captionFallbackStore.clear()
    if (fallbackRetryTimer !== null) window.clearTimeout(fallbackRetryTimer)
    fallbackRetryTimer = null
  }

  function resetCaptionPresentation(ids) {
    for (const source of document.querySelectorAll?.(".ytp-caption-segment[data-ot-source-id]") ||
      []) {
      if (ids && !ids.has(source.getAttribute("data-ot-source-id"))) continue
      for (const attr of [
        "data-ot-subtitle-replaced",
        "data-ot-translated",
        "data-translated",
        "data-ot-queued",
        "data-ot-source-stale",
      ])
        source.removeAttribute(attr)
    }
    for (const note of document.querySelectorAll?.(
      '[data-ot-role="note"][data-ot-presentation="subtitle"]',
    ) || []) {
      if (!ids || ids.has(note.getAttribute("data-ot-note-id"))) note.remove()
    }
  }

  function showSubtitleFailure(error) {
    applyYoutubeControlPresentation(
      pageState.youtubeControl.button,
      SubtitleApi.resolvePlayerControlError({ error }),
      { errorReason: "translation-failure" },
    )
  }

  function failYoutubeCaptionFallbacks(payload) {
    const ids = new Set(payload.ids || [])
    let retry = false
    let exhausted = false
    for (const id of ids) {
      const result = captionFallbackStore.fail(id, {
        retryable: payload.retryable === true,
      })
      retry ||= result.shouldRetry
      exhausted ||= result.retryExhausted
    }
    resetCaptionPresentation(ids)
    if (payload.retryable === false && payload.reason !== "cancelled") {
      cancelYoutubeSession()
      recovery.cancel()
      pageState.pageTranslation.active = false
      pageState.pageTranslation.sessionId = ""
      resetYoutubeCaptionFallbacks()
      resetCaptionPresentation()
      clearYoutubePrefetchTracking()
    }
    if (["request-timeout", "setup-error", "api-error", "cancelled"].includes(payload.reason)) {
      recordYoutubeDiagnostic(payload.reason, "Caption translation did not complete")
    }
    if (exhausted || payload.retryable === false)
      showSubtitleFailure("Subtitle translation failed. Click to try again")
    if (retry && fallbackRetryTimer === null) {
      fallbackRetryTimer = window.setTimeout(() => {
        fallbackRetryTimer = null
        scheduleVisibleTranslation?.()
      }, 1000)
    }
  }

  function handleYoutubeQueueResult(items, response, sessionId) {
    if (!isCurrentYoutubeVideo() || sessionId !== pageState.pageTranslation.sessionId) return
    if (["missing", "stale"].includes(response?.sessionStatus)) {
      handleYoutubeSessionLoss()
      return
    }
    if (!response?.ok) {
      failYoutubeCaptionFallbacks({
        ids: items.map((item) => item.id),
        retryable: true,
        reason: "api-error",
      })
    }
  }

  function handleYoutubeSessionLoss() {
    if (disposed || !isCurrentYoutubeVideo() || !pageState.pageTranslation.active) return
    pageState.youtubeDiagnostics.captionStatus.prefetchAvailable = false
    if (!recovery.isRecovering()) {
      pageState.pageTranslation.sessionId = ""
      resetYoutubeCaptionFallbacks()
      resetCaptionPresentation()
      recordYoutubeDiagnostic("session-lost", "Background subtitle session is unavailable")
    }
    recovery.recover()
  }

  function acceptsYoutubeSessionPayload(payload) {
    return (
      !disposed &&
      getYoutubeVideoKey() === pageState.youtubeControl.videoKey &&
      Boolean(payload?.sessionId) &&
      payload.sessionId === pageState.pageTranslation.sessionId
    )
  }

  function applyStartedSession(response) {
    pageState.youtubeDiagnostics.captionTrace?.resetRecentHealth?.()
    if (response.sessionId) pageState.pageTranslation.sessionId = response.sessionId
    setYoutubeCaptionStatus(response.captions, response.prefetch)
    applyYoutubeControlState(pageState.youtubeControl.button, "active")
    bindYoutubePrefetchTracking()
    reportYoutubePrefetchProgress("seek", true)
  }

  function setYoutubeCaptionStatus(captions = {}, prefetch = {}) {
    pageState.youtubeDiagnostics.captionStatus = {
      hasTrack: Boolean(captions.hasTrack),
      prefetchAvailable: Boolean(prefetch.available),
      timedTrackAvailable: Boolean(captions.timedTrackAvailable),
      trackCount: Math.max(0, Number(captions.trackCount) || 0),
      trackSource: String(captions.trackSource || "none"),
    }
  }

  function applyYoutubeControlPresentation(button, presentation, options = {}) {
    if (!button || !presentation) {
      return
    }

    button.setAttribute("aria-label", presentation.title)
    button.setAttribute("aria-pressed", presentation.pressed || "false")
    button.setAttribute("data-state", presentation.state)
    button.setAttribute("data-tooltip-title", presentation.title)
    button.title = presentation.title
    button.disabled = presentation.state === "loading"
    pageState.youtubeControl.button = button
    pageState.youtubeControl.state = presentation.state
    pageState.youtubeControl.errorReason =
      presentation.state === "error" ? options.errorReason || "fatal" : ""
  }

  function applyYoutubeControlState(button, state) {
    if (!button || !SubtitleApi?.resolvePlayerControlState) {
      return
    }

    const resolved = SubtitleApi.resolvePlayerControlState(state)

    applyYoutubeControlPresentation(button, resolved, {
      errorReason: state === "error" ? pageState.youtubeControl.errorReason || "fatal" : "",
    })
  }

  function cancelYoutubeSession() {
    if (!SubtitleApi?.isSubtitleProfile(activeSiteProfile)) return
    const identity = recovery.getIdentity()
    const videoKey = pageState.youtubeControl.videoKey || identity?.videoKey
    const sessionId = pageState.pageTranslation.sessionId
    if (!videoKey || (!sessionId && !identity?.requestId)) return
    try {
      chrome.runtime
        .sendMessage?.(
          Messages.cancelYoutubeSubtitleTranslation({
            sessionId,
            requestId: identity?.requestId,
            videoKey,
          }),
        )
        ?.catch?.(() => {})
    } catch {
      // Extension updates can invalidate the context before teardown.
    }
  }

  function isCurrentYoutubeVideo() {
    return getYoutubeVideoKey() === String(pageState.youtubeControl.videoKey || "")
  }

  function getYoutubeVideoKey() {
    const location = window.location || {}

    if (location.pathname === "/watch") {
      return new URLSearchParams(location.search).get("v") || ""
    }

    return /^\/shorts\/([^/]+)/u.exec(location.pathname)?.[1] || ""
  }

  function clearYoutubeCaptionCheck() {
    if (pageState.youtubeControl.captionCheckTimer) {
      window.clearTimeout(pageState.youtubeControl.captionCheckTimer)
      pageState.youtubeControl.captionCheckTimer = null
    }
  }

  function reportYoutubePrefetchProgress(reason, force = false) {
    const video = pageState.youtubeControl.prefetchVideo
    const currentTimeMs = Math.max(0, Number(video?.currentTime) || 0) * 1000

    if (
      !video ||
      !pageState.pageTranslation.sessionId ||
      !isCurrentYoutubeVideo() ||
      !TimedCaptionApi?.shouldReportCaptionProgress(
        pageState.youtubeControl.lastPrefetchTimeMs,
        currentTimeMs,
        { force },
      )
    ) {
      return false
    }

    pageState.youtubeControl.lastPrefetchTimeMs = currentTimeMs
    const sessionId = pageState.pageTranslation.sessionId
    chrome.runtime
      .sendMessage(
        Messages.prefetchYoutubeSubtitles({
          sessionId,
          currentTimeMs,
          playbackRate: TimedCaptionApi.normalizePlaybackRate(video.playbackRate),
          reason,
        }),
      )
      .then((response) => {
        if (
          !isCurrentYoutubeVideo() ||
          sessionId !== pageState.pageTranslation.sessionId ||
          disposed
        )
          return
        if (["missing", "stale"].includes(response?.sessionStatus)) handleYoutubeSessionLoss()
        else if (response?.sessionStatus === "active")
          pageState.youtubeDiagnostics.captionStatus.prefetchAvailable = Boolean(response.available)
      })
      .catch(() => {
        if (sessionId === pageState.pageTranslation.sessionId) handleYoutubeSessionLoss()
      })
    return true
  }

  function handleYoutubePlaybackProgress() {
    reportYoutubePrefetchProgress("progress", false)
  }

  function handleYoutubePlaybackSeek() {
    if (disposed || !pageState.pageTranslation.sessionId || !isCurrentYoutubeVideo()) return
    pageState.youtubeDiagnostics.captionTrace?.resetRecentHealth?.()
    options.resetSubtitleObserver?.()
    // Retire in-flight fallback identities, but retain their tombstones so a
    // late pre-seek result cannot bind to a similar caption at the new time.
    captionFallbackStore.invalidate()
    resetCaptionPresentation()
    for (const source of document.querySelectorAll?.(".ytp-caption-segment[data-ot-source-id]") ||
      []) {
      source.removeAttribute?.("data-ot-source-id")
    }
    scheduleVisibleTranslation?.()
    reportYoutubePrefetchProgress("seek", true)
  }

  function handleYoutubePlaybackRateChange() {
    reportYoutubePrefetchProgress("ratechange", true)
  }

  function handleYoutubePlaybackResume() {
    reportYoutubePrefetchProgress("resume", true)
  }

  function clearYoutubePrefetchTracking() {
    const video = pageState.youtubeControl.prefetchVideo

    video?.removeEventListener?.("timeupdate", handleYoutubePlaybackProgress)
    video?.removeEventListener?.("seeking", handleYoutubePlaybackSeek)
    video?.removeEventListener?.("ratechange", handleYoutubePlaybackRateChange)
    video?.removeEventListener?.("playing", handleYoutubePlaybackResume)
    pageState.youtubeControl.prefetchVideo = null
    pageState.youtubeControl.lastPrefetchTimeMs = 0
  }

  function bindYoutubePrefetchTracking() {
    const video =
      document.querySelector?.("#movie_player video") || document.querySelector?.("video")

    if (video && video === pageState.youtubeControl.prefetchVideo) return true
    const replaced = Boolean(pageState.youtubeControl.prefetchVideo)
    clearYoutubePrefetchTracking()

    if (!video) {
      return false
    }

    pageState.youtubeControl.prefetchVideo = video
    pageState.youtubeControl.lastPrefetchTimeMs = Math.max(0, Number(video.currentTime) || 0) * 1000
    video.addEventListener?.("timeupdate", handleYoutubePlaybackProgress)
    video.addEventListener?.("seeking", handleYoutubePlaybackSeek)
    video.addEventListener?.("ratechange", handleYoutubePlaybackRateChange)
    video.addEventListener?.("playing", handleYoutubePlaybackResume)
    if (replaced) {
      recordYoutubeDiagnostic("player-rebound", "Playback tracking moved to the current video node")
      reportYoutubePrefetchProgress("seek", true)
    }
    return true
  }

  function showYoutubeCaptionUnavailable(button) {
    if (
      !button ||
      pageState.youtubeControl.button !== button ||
      pageState.youtubeControl.state !== "active" ||
      YoutubePlayerControlApi?.getVisibleYoutubeCaptionText(document)
    ) {
      return
    }

    const presentation = SubtitleApi.resolvePlayerControlError({
      error: "YouTube captions are not visible. Turn on CC and play the video",
    })
    applyYoutubeControlPresentation(button, presentation, {
      errorReason: "caption-timeout",
    })
    recordYoutubeDiagnostic("caption-timeout", presentation.title, {
      show: true,
    })
  }

  function scheduleYoutubeCaptionCheck(button) {
    clearYoutubeCaptionCheck()
    pageState.youtubeControl.captionCheckTimer = window.setTimeout(() => {
      pageState.youtubeControl.captionCheckTimer = null
      showYoutubeCaptionUnavailable(button)
    }, 4500)
  }

  async function handleYoutubeControlClick(_event, clickedButton) {
    const button = clickedButton || pageState.youtubeControl.button

    if (!button) {
      return
    }

    if (pageState.youtubeControl.state === "loading") {
      recordYoutubeDiagnostic("duplicate-click", "Translation startup is already in progress", {
        show: true,
      })
      return
    }

    recovery.reset()
    pageState.pageTranslation.sessionId = ""
    resetYoutubeCaptionFallbacks()
    resetCaptionPresentation()
    const request = recovery.beginRequest()
    recordYoutubeDiagnostic("click", "Player button click received", {
      show: true,
    })
    applyYoutubeControlState(button, "loading")
    recordYoutubeDiagnostic("loading", "Contacting extension background")
    YoutubePlayerControlApi?.turnOnNativeYoutubeCaptions(
      document.querySelector("#movie_player"),
      window.ytInitialPlayerResponse,
    )

    try {
      const response = await chrome.runtime.sendMessage(
        Messages.startYoutubeSubtitleTranslation(request),
      )
      if (!recovery.isCurrent(request) || disposed) return

      if (!response?.ok) {
        const presentation = SubtitleApi.resolvePlayerControlError(response)
        applyYoutubeControlPresentation(button, presentation)
        recordYoutubeDiagnostic("background-error", presentation.title, {
          show: true,
        })

        if (presentation.openOptions) {
          await chrome.runtime.sendMessage(Messages.openOptions())
        }

        return
      }

      applyStartedSession(response)
      recordYoutubeDiagnostic(
        "active",
        `Translation session active; caption enabled=${Boolean(response.captions?.enabled)}; track found=${Boolean(response.captions?.hasTrack)}`,
      )
      scheduleYoutubeCaptionCheck(button)
    } catch (error) {
      if (!recovery.isCurrent(request) || disposed) return
      const rawError = String(error?.message || "")
      const presentation = SubtitleApi.resolvePlayerControlError({
        error: rawError,
        openOptions:
          rawError.includes("message port closed") ||
          rawError.includes("Extension context invalidated"),
      })
      applyYoutubeControlPresentation(button, presentation)
      recordYoutubeDiagnostic("message-error", presentation.title, {
        show: true,
      })
    }
  }

  function mountYoutubeControl() {
    pageState.youtubeControl.scheduled = false
    const controlApi = YoutubePlayerControlApi

    if (!document.getElementById(STYLE_ID)) {
      ensureStyles()
    }

    if (!controlApi) {
      return
    }

    const videoKey = getYoutubeVideoKey()

    if (videoKey !== pageState.youtubeControl.videoKey) {
      cancelYoutubeSession()
      recovery.reset()
      resetYoutubeCaptionFallbacks()
      resetCaptionPresentation()
      clearYoutubePrefetchTracking()
      pageState.youtubeControl.videoKey = videoKey
      pageState.youtubeControl.state = "idle"
      pageState.youtubeControl.errorReason = ""
      pageState.youtubeDiagnostics.store.clear()
      pageState.youtubeDiagnostics.captionTrace?.clear?.()
      captionFallbackStore.clear()
      setYoutubeCaptionStatus()
      pageState.youtubeDiagnostics.status = "Ready"
      closeYoutubeDiagnostics()
      pageState.pageTranslation.active = false
      pageState.pageTranslation.sessionId = ""
      pageState.pageTranslation.targetLanguage = ""
      pageState.youtubeSubtitleTranslations?.clear?.()
    }

    const button = controlApi.mountYoutubePlayerControl({
      applyState: applyYoutubeControlState,
      document,
      location: window.location,
      onClick: handleYoutubeControlClick,
    })

    if (button) {
      applyYoutubeControlState(button, pageState.youtubeControl.state)
    }
    if (pageState.pageTranslation.active) bindYoutubePrefetchTracking()
  }

  function scheduleYoutubeControlMount() {
    if (pageState.youtubeControl.scheduled) {
      return
    }

    pageState.youtubeControl.scheduled = true
    pageState.youtubeControl.mountTimer = window.setTimeout(() => {
      pageState.youtubeControl.mountTimer = null
      mountYoutubeControl()
    }, 0)
  }

  function cleanupYoutubeRuntime() {
    cancelYoutubeSession()
    disposed = true
    recovery.cancel()
    resetYoutubeCaptionFallbacks()
    clearYoutubeCaptionCheck()
    captionFallbackStore.clear()
    clearYoutubePrefetchTracking()
    if (pageState.youtubeControl.mountTimer) {
      window.clearTimeout(pageState.youtubeControl.mountTimer)
      pageState.youtubeControl.mountTimer = null
    }
    pageState.youtubeControl.scheduled = false
    pageState.youtubeControl.observer?.disconnect()
    pageState.youtubeControl.observer = null
    window.removeEventListener?.("yt-navigate-finish", scheduleYoutubeControlMount)
    YoutubePlayerControlApi?.unbindYoutubePlayerControl?.(document)
    document
      .querySelector?.(YoutubePlayerControlApi?.CONTROL_SELECTOR || "[data-ot-youtube-control]")
      ?.remove?.()
    pageState.youtubeControl.button = null
    closeYoutubeDiagnostics()
  }

  function ensureYoutubeControl() {
    if (
      !YoutubePlayerControlApi ||
      pageState.youtubeControl.observer ||
      !document.documentElement
    ) {
      return
    }

    pageState.youtubeControl.observer = new MutationObserver(scheduleYoutubeControlMount)
    pageState.youtubeControl.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    })
    window.addEventListener("yt-navigate-finish", scheduleYoutubeControlMount)
    scheduleYoutubeControlMount()
  }

  return {
    acceptsYoutubeSessionPayload,
    acceptsYoutubeStartup: (payload) => !disposed && recovery.acceptsStartup(payload),
    canQueueYoutubeCaptions: () => !recovery.isRecovering(),
    failYoutubeCaptionFallbacks,
    handleYoutubeQueueResult,
    handleYoutubeSessionLoss,
    applyYoutubeControlState,
    bindYoutubePrefetchTracking,
    cleanupYoutubeRuntime,
    clearYoutubeCaptionCheck,
    closeYoutubeDiagnostics,
    ensureYoutubeControl,
    hasYoutubeCachedTranslation,
    matchYoutubeCaptionItems,
    recordYoutubeCachePaths,
    recordYoutubeDiagnostic,
    recoverYoutubeCaptionTimeout,
    resetYoutubeCaptionFallbacks,
    settleYoutubeCaptionFallbacks,
    scheduleYoutubeControlMount,
  }
}
