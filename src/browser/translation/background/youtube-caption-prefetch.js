import * as TimedCaptions from "../content/youtube/timed-captions.js"
import { waitForAbortable } from "../shared/abort.js"

function isTrustedYoutubeCaptionUrl(value) {
  try {
    const url = new URL(String(value || ""))
    const hostname = url.hostname.toLowerCase()

    return (
      url.protocol === "https:" && (hostname === "youtube.com" || hostname.endsWith(".youtube.com"))
    )
  } catch (_error) {
    return false
  }
}

function createYoutubeCaptionPrefetch(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch
  const enqueue = options.enqueue || (async () => ({ queued: 0 }))
  const onDiagnostic = options.onDiagnostic || (() => {})
  const sessions = new Map()
  const initializers = new Map()

  function getSession(context) {
    const session = sessions.get(context.tabId)

    return session && (!context.sessionId || context.sessionId === session.sessionId)
      ? session
      : null
  }

  async function update(context = {}) {
    context.signal?.throwIfAborted()
    const session = getSession(context)

    if (!session) {
      return {
        available: false,
        queued: 0,
        sessionStatus: sessions.has(context.tabId) ? "stale" : "missing",
      }
    }
    if (!session.cues) return { available: false, queued: 0, sessionStatus: "active" }

    const playbackRate = TimedCaptions.normalizePlaybackRate(context.playbackRate)
    const windowMs = TimedCaptions.getCaptionWindowMs(playbackRate)
    const windowCues = TimedCaptions.selectCaptionWindow(session.cues, {
      currentTimeMs: context.currentTimeMs,
      windowMs,
    })
    const items = TimedCaptions.buildTimedCaptionItems(windowCues)

    if (items.length === 0) {
      return { available: true, queued: 0, sessionStatus: "active" }
    }

    const placement = context.reason === "startup" || context.reason === "seek" ? "front" : "back"
    const result = await enqueue({
      frameId: session.frameId,
      items,
      placement,
      playbackRate,
      sessionId: session.sessionId,
      tabId: session.tabId,
      windowMs,
    })
    const queued = Math.max(0, Number(result?.queued) || 0)

    if (getSession(context) !== session || context.signal?.aborted)
      return { available: false, queued: 0, sessionStatus: "stale" }
    onDiagnostic(
      "prefetch-window",
      `rate=${playbackRate}; window=${windowMs}ms; placement=${placement}; cues=${items.length}; queued=${queued}`,
      context,
    )
    return {
      available: true,
      queued,
      sessionStatus: result?.sessionStatus || "active",
    }
  }

  async function initialize(context = {}) {
    const attemptSource =
      context.attemptSource === "native-request" ? "native-request" : "advertised"
    let httpStatus
    const unavailable = {
      attemptSource,
      available: false,
      cueCount: 0,
      queued: 0,
      sessionStatus: context.sessionId ? "active" : "missing",
    }
    const token = {}
    initializers.set(context.tabId, token)
    const isCurrent = () => initializers.get(context.tabId) === token && !context.signal?.aborted
    if (!isCurrent()) return unavailable
    if (context.tabId && context.sessionId)
      sessions.set(context.tabId, {
        cues: null,
        frameId: context.frameId || 0,
        sessionId: context.sessionId,
        tabId: context.tabId,
      })

    function fail(reason) {
      const status = httpStatus === undefined ? {} : { httpStatus }
      onDiagnostic(
        "prefetch-fallback",
        `attempt=${attemptSource}; reason=${reason}${httpStatus === undefined ? "" : `; status=${httpStatus}`}; using visible captions`,
        context,
      )
      return { ...unavailable, ...status, reason }
    }

    if (!context.tabId) return fail("missing-tab")
    if (!context.sessionId) return fail("missing-session")
    if (!context.baseUrl) return fail("missing-url")
    if (!isTrustedYoutubeCaptionUrl(context.baseUrl)) return fail("untrusted-url")
    if (typeof fetchImpl !== "function") return fail("fetch-unavailable")

    let failureReason = "network-error"
    try {
      context.signal?.throwIfAborted()
      const response = await waitForAbortable(
        fetchImpl(TimedCaptions.buildJson3TrackUrl(context.baseUrl), {
          credentials: "include",
          ...(context.signal ? { signal: context.signal } : {}),
        }),
        context.signal,
      )
      if (!isCurrent()) return { ...unavailable, sessionStatus: "stale" }

      if (Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599)
        httpStatus = response.status
      if (!response?.ok) return fail("http-error")

      const text = await waitForAbortable(response.text(), context.signal)
      if (!isCurrent()) return { ...unavailable, sessionStatus: "stale" }
      if (!text.trim()) return fail("empty-body")
      failureReason = "invalid-json"
      const body = JSON.parse(text)
      failureReason = "no-cues"
      const cues = TimedCaptions.parseJson3Captions(body).map((cue, cueIndex) => ({
        ...cue,
        cueIndex,
      }))

      if (cues.length === 0) return fail("no-cues")

      sessions.set(context.tabId, {
        cues,
        frameId: context.frameId || 0,
        sessionId: context.sessionId,
        tabId: context.tabId,
      })
      failureReason = "enqueue-error"
      const result = await waitForAbortable(
        update({ ...context, reason: "startup" }),
        context.signal,
      )
      if (!isCurrent()) return { ...unavailable, sessionStatus: "stale" }

      onDiagnostic(
        "prefetch-ready",
        `attempt=${attemptSource}; Loaded ${cues.length} timed caption cue(s); queued ${result.queued} for the initial playback window`,
        context,
      )

      return {
        attemptSource,
        ...(httpStatus === undefined ? {} : { httpStatus }),
        available: true,
        cueCount: cues.length,
        queued: result.queued,
        sessionStatus: result.sessionStatus,
      }
    } catch (_error) {
      if (!isCurrent()) return { ...unavailable, sessionStatus: "stale" }
      const session = getSession(context)
      if (session) session.cues = null
      return fail(failureReason)
    }
  }

  function remove(tabId) {
    initializers.delete(tabId)
    return sessions.delete(tabId)
  }

  return { initialize, remove, update }
}

export { createYoutubeCaptionPrefetch, isTrustedYoutubeCaptionUrl }
