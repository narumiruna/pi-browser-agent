import { createRequestAbortScope, waitForAbortable } from "../shared/abort.js"
import { translateItemsProgressively } from "../translation/progressive.js"
import { getSelectionAnchor } from "./selection-anchor.js"
import { createYoutubeCaptionPrefetch } from "./youtube-caption-prefetch.js"
import {
  captureNativeYoutubeCaptionRequestUrl,
  enableYoutubeCaptions,
} from "./youtube-caption-runtime.js"

const PAGE_TRANSLATION_CONCURRENCY = 5
const PAGE_TRANSLATION_BATCH_SIZE = 8
const SUBTITLE_DEADLINE_MS = 30_000

function getPageTranslationQueueBatchSize(item) {
  return item?.kind === "subtitle" ? PAGE_TRANSLATION_BATCH_SIZE : 1
}

function isSubtitleConfigurationError(error) {
  if (error?.retryable === false) return true
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status)
  if ([400, 401, 403, 404, 405, 422].includes(status)) return true
  const identity = [error?.name, error?.code, error?.type].join(" ")
  if (
    /Authentication|Permission|Configuration|Credential|ApiKey|NotFound|invalid_api_key|invalid_request|invalid_grant|model_not_found|authentication_error|permission_denied|unauthenticated|unauthorized|forbidden/iu.test(
      identity,
    )
  )
    return true
  return /(?:api[ -]?key|credential|access token).*(?:missing|invalid|expired|required)|(?:missing|invalid|expired|required).*(?:api[ -]?key|credential|access token)|not configured|no (?:api[ -]?key|credential)|configure (?:this|the|your) provider|selected model is unavailable|provider is unavailable|no browser endpoint|permission.*(?:denied|required)|unauthorized|forbidden|invalid_api_key|invalid_request_error|invalid_grant|model_not_found|authentication_error|permission_denied|unauthenticated|(?:HTTP|status|API error)\s*\(?(?:400|401|403|404|405|422)\b/iu.test(
    String(error?.message || ""),
  )
}

export function createBackgroundController(options = {}) {
  const {
    chrome,
    Api,
    Messages,
    ProviderRuntime,
    Settings,
    SiteProfiles,
    TranslationSession,
    logger,
    openPdfTranslator,
    platform,
  } = options
  const {
    buildDebugPayload,
    buildSelectionPanelPayload,
    buildTranslationAppearancePayload,
    buildYoutubeSubtitlePayload,
    clearPagePlaceholders,
    discoverEmbeddedPageFrames,
    ensureApiPermission,
    ensureContentScript,
    getFrameMessageOptions,
    isDomainDisabled,
    isSupportedPage,
    isTabMessageDisconnectError,
    loadSettingsOrOpenOptions,
    renderPageTranslationUpdates,
    sendToast,
    sendYoutubeDiagnosticEvent,
    setBadge,
    setupContextMenus,
  } = platform
  const youtubeStartups = new Map()
  const pageStartups = new Map()
  let selectionRequestSequence = 0
  function createSelectionRequestId() {
    selectionRequestSequence += 1
    return `selection-${Date.now()}-${selectionRequestSequence}`
  }

  const pageTranslationQueue = TranslationSession.createPageTranslationQueue({
    concurrency: PAGE_TRANSLATION_CONCURRENCY,
    batchSize: PAGE_TRANSLATION_BATCH_SIZE,
    getBatchSize: getPageTranslationQueueBatchSize,
    processBatch: ({ tabId, frameId, sessionId, items }) =>
      processPageTranslationItemBatch(tabId, frameId, sessionId, items),
    onError(error, context) {
      logger?.error("page-batch-failed", {
        error: error?.message || String(error),
        frameId: context?.frameId,
        sessionId: context?.sessionId,
        tabId: context?.tabId,
      })
    },
  })
  const youtubeCaptionPrefetch = createYoutubeCaptionPrefetch({
    enqueue: ({ tabId, frameId, sessionId, items, placement }) =>
      queuePageTranslationItems(tabId, sessionId, items, frameId, {
        placement,
      }),
    fetch: options.fetch,
    onDiagnostic(stage, detail, context) {
      sendYoutubeDiagnosticEvent?.(
        context.tabId,
        context.frameId || 0,
        stage,
        detail,
        context.sessionId,
      )?.catch?.(() => {})
    },
  })

  function getPageTranslationSession(tabId, sessionId, frameId) {
    return pageTranslationQueue.get(tabId, sessionId, frameId)
  }

  async function processPageTranslationItemBatch(tabId, frameId, sessionId, items) {
    const session = getPageTranslationSession(tabId, sessionId, frameId)
    if (!session) return
    if (!items?.some((item) => item.kind === "subtitle")) {
      const scope = createRequestAbortScope(session.signal)
      const control = { signal: scope.signal, subtitle: false }
      try {
        await waitForAbortable(
          runPageTranslationItemBatch(tabId, frameId, sessionId, items, control),
          scope.signal,
        )
      } catch (error) {
        if (session.signal.aborted || !getPageTranslationSession(tabId, sessionId, frameId)) return
        if (isTabMessageDisconnectError(error)) {
          pageTranslationQueue.remove(tabId, frameId)
          const count = pageTranslationQueue.getTranslatedCount(tabId)
          setBadge(tabId, count > 0 ? String(count) : "")
          return
        }
        // Failure UI must not hold the queue when a content endpoint stalls.
        Promise.resolve(
          clearPagePlaceholders(
            tabId,
            items.map(({ id }) => id),
            frameId,
            { items },
            sessionId,
          ),
        ).catch(() => {})
        setBadge(tabId, "!")
        Promise.resolve(
          sendToast(
            tabId,
            scope.signal.reason?.message === "request-timeout"
              ? "Page translation timed out. Try translating again."
              : "Some page text could not be translated. Try again.",
            "error",
          ),
        ).catch(() => {})
      } finally {
        control.finished = true
        scope.dispose()
      }
      return
    }
    const controller = new AbortController()
    const cancel = () => controller.abort(new Error("cancelled"))
    if (session.signal?.aborted) cancel()
    session.signal?.addEventListener("abort", cancel, { once: true })
    const timer = setTimeout(
      () => controller.abort(new Error("request-timeout")),
      SUBTITLE_DEADLINE_MS,
    )
    const control = {
      signal: controller.signal,
      subtitle: true,
      reason: "setup-error",
    }
    try {
      await waitForAbortable(
        runPageTranslationItemBatch(tabId, frameId, sessionId, items, control),
        controller.signal,
      )
    } catch (error) {
      const reason = controller.signal.aborted
        ? controller.signal.reason?.message === "request-timeout"
          ? "request-timeout"
          : "cancelled"
        : control.reason
      // Send settlement without waiting: a closed or stalled content endpoint must not hold a worker.
      if (getPageTranslationSession(tabId, sessionId, frameId)) {
        const ids = items
          .filter((item) => !session.translatedIds.has(item.id))
          .map((item) => item.id)
        Promise.resolve(
          clearPagePlaceholders(
            tabId,
            ids,
            frameId,
            {
              reason,
              retryable:
                control.retryable !== false &&
                (reason === "request-timeout" || reason === "api-error"),
            },
            sessionId,
          ),
        ).catch(() => {})
        Promise.resolve(
          sendYoutubeDiagnosticEvent(
            tabId,
            frameId,
            reason,
            "failure-count=1; Caption translation did not complete",
            sessionId,
          ),
        ).catch(() => {})
      }
      if (!controller.signal.aborted)
        logger?.error("subtitle-batch-failed", {
          error: error?.message,
          sessionId,
        })
    } finally {
      control.finished = true
      clearTimeout(timer)
      session.signal?.removeEventListener("abort", cancel)
    }
  }

  async function runPageTranslationItemBatch(tabId, frameId, sessionId, items, control) {
    const signal = control?.signal
    const isCurrent = () =>
      !control?.finished &&
      !signal?.aborted &&
      Boolean(getPageTranslationSession(tabId, sessionId, frameId))
    signal?.throwIfAborted()
    logger?.debug("page-batch-start", {
      frameId,
      itemCount: items?.length || 0,
      sessionId,
      tabId,
    })
    const session = getPageTranslationSession(tabId, sessionId, frameId)

    const batchItems = (items || []).filter((item) => item && typeof item.id === "string")

    if (!session || batchItems.length === 0) {
      return
    }

    try {
      const subtitleItems = batchItems.filter((item) => item.kind === "subtitle")

      if (subtitleItems.length > 0) {
        await sendYoutubeDiagnosticEvent(
          tabId,
          frameId,
          "api-start",
          `Requesting ${subtitleItems.length} caption translation(s)`,
          sessionId,
        )
        signal?.throwIfAborted()
      }

      const placeholderIds = batchItems
        .filter((item) => item.kind !== "subtitle")
        .map((item) => item.id)

      if (placeholderIds.length > 0) {
        await chrome.tabs.sendMessage(
          tabId,
          Messages.renderPagePlaceholders({
            ids: placeholderIds,
            sessionId,
            targetLanguage: session.settings.targetLanguage,
            ...buildTranslationAppearancePayload(session.settings),
          }),
          getFrameMessageOptions(frameId),
        )
      }

      const progressiveResult = await translateItemsProgressively({
        Api,
        settings: session.settings,
        items: batchItems,
        maximumConcurrency: 1,
        signal,
        isCurrent,
        onTranslations: async (completedTranslations) => {
          const currentSession = getPageTranslationSession(tabId, sessionId, frameId)

          if (!currentSession || !isCurrent()) {
            return
          }

          if (control) control.reason = "api-error"
          if (completedTranslations.some((translation) => translation.kind === "subtitle")) {
            await sendYoutubeDiagnosticEvent(
              tabId,
              frameId,
              "api-success",
              `API returned ${completedTranslations.length} completed translation(s)`,
              sessionId,
            )
            signal?.throwIfAborted()
          }

          const acknowledgement = await renderPageTranslationUpdates(
            tabId,
            currentSession.settings.targetLanguage,
            completedTranslations,
            currentSession.settings,
            frameId,
            sessionId,
          )
          signal?.throwIfAborted()
          if (!isCurrent()) return
          if (control?.subtitle && (!acknowledgement || acknowledgement.ok === false))
            throw new Error("Caption delivery was not acknowledged")
          pageTranslationQueue.markTranslated(
            tabId,
            sessionId,
            control?.subtitle
              ? completedTranslations.map((translation) => translation.id)
              : acknowledgement?.renderedIds || [],
            frameId,
          )
          setBadge(tabId, String(pageTranslationQueue.getTranslatedCount(tabId)))
        },
      })

      signal?.throwIfAborted()
      if (progressiveResult.stale || !isCurrent()) {
        return
      }

      const { incompleteSegmentIds } = progressiveResult
      const configurationFailure =
        control?.subtitle &&
        progressiveResult.failures.some((failure) => isSubtitleConfigurationError(failure.error))
      const failureDetails = {
        reason: configurationFailure ? "setup-error" : "api-error",
        retryable: !configurationFailure,
      }
      if (control) {
        control.reason = failureDetails.reason
        control.retryable = failureDetails.retryable
      }

      if (incompleteSegmentIds.length > 0) {
        await clearPagePlaceholders(
          tabId,
          incompleteSegmentIds,
          frameId,
          control?.subtitle
            ? failureDetails
            : {
                items: batchItems.filter((item) => incompleteSegmentIds.includes(item.id)),
              },
          sessionId,
        )
        signal?.throwIfAborted()
      }

      if (progressiveResult.failures.length > 0) {
        const subtitleFailure = progressiveResult.failures.find((failure) =>
          failure.chunkItems?.some((item) => item.kind === "subtitle"),
        )

        if (subtitleFailure) {
          await sendYoutubeDiagnosticEvent(
            tabId,
            frameId,
            configurationFailure ? "setup-error" : "api-error",
            "failure-count=1; Caption translation request failed",
            sessionId,
          )
          signal?.throwIfAborted()
        }

        const failedCount = incompleteSegmentIds.length || progressiveResult.failures.length

        setBadge(tabId, "!")
        if (control?.subtitle) return
        await sendToast(
          tabId,
          `Failed to translate ${failedCount} page item${failedCount === 1 ? "" : "s"}. Successful translations were kept.`,
          "error",
        )
      }
    } catch (error) {
      if (control) throw error
      if (isTabMessageDisconnectError(error)) {
        pageTranslationQueue.remove(tabId, frameId)
        const translatedCount = pageTranslationQueue.getTranslatedCount(tabId)

        setBadge(tabId, translatedCount > 0 ? String(translatedCount) : "")
        return
      }

      throw error
    }
  }

  async function queuePageTranslationItems(tabId, sessionId, items, frameId, enqueueOptions) {
    return pageTranslationQueue.enqueue(tabId, sessionId, items, frameId, enqueueOptions)
  }

  async function startPageTranslationFrame(tabId, frameId, settings, internal = {}) {
    await ensureContentScript(tabId, frameId)
    internal.signal?.throwIfAborted()
    await internal.validate?.()
    internal.signal?.throwIfAborted()
    const session = pageTranslationQueue.create(tabId, settings, frameId)
    internal.onSession?.(session)
    const extraction = await chrome.tabs.sendMessage(
      tabId,
      Messages.startPageTranslationSession({
        ...(internal.youtubeVideoKey
          ? {
              youtubeVideoKey: internal.youtubeVideoKey,
              youtubeRequestId: internal.youtubeRequestId,
            }
          : {}),
        sessionId: session.sessionId,
        targetLanguage: settings.targetLanguage,
        ...buildTranslationAppearancePayload(settings),
        ...buildYoutubeSubtitlePayload(settings),
        ...buildDebugPayload(settings),
      }),
      getFrameMessageOptions(frameId),
    )

    internal.signal?.throwIfAborted()
    if (!getPageTranslationSession(tabId, session.sessionId, frameId)) throw new Error("cancelled")
    if (!extraction || extraction.ok === false || !Array.isArray(extraction.items)) {
      pageTranslationQueue.remove(tabId, frameId)
      return { items: [], totalSegments: 0 }
    }

    if (extraction.items.length > 0) {
      await queuePageTranslationItems(tabId, session.sessionId, extraction.items, frameId)
    } else if (!TranslationSession.shouldKeepPageTranslationSession(extraction)) {
      pageTranslationQueue.remove(tabId, frameId)
    }

    return { ...extraction, sessionId: session.sessionId }
  }

  function removePageTranslationState(tabId, frameId, preserveStartup = false) {
    if (!preserveStartup && (!Number.isInteger(frameId) || frameId === 0)) {
      pageStartups.get(tabId)?.abort(new Error("cancelled"))
      pageStartups.delete(tabId)
      youtubeStartups.get(tabId)?.abort(new Error("cancelled"))
      youtubeStartups.delete(tabId)
    }
    pageTranslationQueue.remove(tabId, frameId)

    if (!Number.isInteger(frameId) || frameId === 0) {
      youtubeCaptionPrefetch.remove(tabId)
    }
  }

  async function translatePage(tab, internal = {}) {
    if (!tab?.id) return runPageTranslationStartup(tab, internal)
    if (!internal.signal) {
      youtubeStartups.get(tab.id)?.abort(new Error("cancelled"))
      youtubeStartups.delete(tab.id)
    }
    pageStartups.get(tab.id)?.abort(new Error("cancelled"))
    const startup = new AbortController()
    const ownedSessions = new Map()
    pageStartups.set(tab.id, startup)
    const cancel = () => startup.abort(internal.signal.reason)
    if (internal.signal?.aborted) cancel()
    else internal.signal?.addEventListener("abort", cancel, { once: true })
    try {
      return await waitForAbortable(
        runPageTranslationStartup(tab, {
          ...internal,
          signal: startup.signal,
          onSession(session) {
            ownedSessions.set(session.frameId, session)
            internal.onSession?.(session)
          },
        }),
        startup.signal,
      )
    } catch (error) {
      for (const session of ownedSessions.values()) {
        if (getPageTranslationSession(tab.id, session.sessionId, session.frameId)) {
          removePageTranslationState(tab.id, session.frameId, true)
        }
        Promise.resolve(
          chrome.tabs.sendMessage(
            tab.id,
            Messages.clearPendingTranslations({ sessionId: session.sessionId }),
            getFrameMessageOptions(session.frameId),
          ),
        ).catch(() => {})
      }
      if (startup.signal.aborted && !internal.signal?.aborted) return { stale: true }
      throw error
    } finally {
      internal.signal?.removeEventListener("abort", cancel)
      if (pageStartups.get(tab.id) === startup) pageStartups.delete(tab.id)
    }
  }

  async function runPageTranslationStartup(tab, internal) {
    const check = () => internal.signal?.throwIfAborted()
    check()
    logger?.info("page-translation-start", { tabId: tab?.id })
    if (!tab?.id || !isSupportedPage(tab.url)) {
      throw new Error("This page cannot be translated.")
    }

    const settings = await loadSettingsOrOpenOptions({
      interactive: internal.interactive !== false,
    })
    check()

    if (isDomainDisabled(tab.url, settings)) {
      throw new Error("Translation is disabled for this domain.")
    }

    const hasPermission = await ensureApiPermission(settings, {
      interactive: internal.interactive !== false,
    })
    check()

    if (!hasPermission) {
      throw new Error("Permission to access the configured API origin was denied.")
    }

    await internal.validate?.()
    check()
    removePageTranslationState(tab.id, undefined, Boolean(internal.signal))
    const embeddedFrames = await discoverEmbeddedPageFrames(tab.id, tab.url)
    check()
    const frames = [{ frameId: 0, url: tab.url }, ...embeddedFrames]
    let queuedCount = 0
    let totalSegments = 0
    let keepAliveCount = 0
    let mainSessionId = ""

    for (const frame of frames) {
      try {
        const extraction = await startPageTranslationFrame(
          tab.id,
          frame.frameId,
          settings,
          internal,
        )
        check()

        queuedCount += extraction.items.length
        totalSegments += Number(extraction.totalSegments) || 0
        keepAliveCount += extraction.keepAlive ? 1 : 0
        if (frame.frameId === 0) {
          mainSessionId = extraction.sessionId || ""
        }
      } catch (error) {
        check()
        removePageTranslationState(tab.id, frame.frameId, Boolean(internal.signal))

        if (frame.frameId === 0) {
          throw error
        }
      }
    }

    if (queuedCount > 0) {
      return { sessionId: mainSessionId }
    }

    if (totalSegments > 0) {
      await sendToast(
        tab.id,
        "Visible content is already translated. More content will translate as you scroll.",
        "info",
      )
      return { sessionId: mainSessionId }
    }

    if (keepAliveCount > 0) {
      await sendToast(
        tab.id,
        "Subtitle translation is ready. Turn on YouTube captions and play the video.",
        "info",
      )
      return { sessionId: mainSessionId }
    }

    await sendToast(tab.id, "No translatable text was found on this page.", "info")
    setBadge(tab.id, "")
    return { sessionId: mainSessionId }
  }

  async function translateSelection(tabId, selectionText, frameId, options = {}) {
    logger?.info("selection-translation-start", { frameId, tabId })
    if (!tabId) {
      throw new Error("Missing tab id.")
    }

    const text = String(selectionText || "").trim()

    if (!text) {
      throw new Error("No selected text to translate.")
    }

    const settings = await loadSettingsOrOpenOptions()
    const tab = await chrome.tabs.get(tabId)

    if (tab && isDomainDisabled(tab.url, settings)) {
      throw new Error(
        "Translation is disabled for this domain. Remove it from Disabled Domains in Settings to continue.",
      )
    }

    const hasPermission = await ensureApiPermission(settings)

    if (!hasPermission) {
      throw new Error("Permission to access the configured API origin was denied.")
    }

    await ensureContentScript(tabId, frameId)
    const selectionAnchor =
      settings.selectionPanelPositionMode === "near-selection"
        ? options.selectionAnchor ||
          (await getSelectionAnchor({
            chrome,
            tabId,
            frameId,
            selectionText: text,
            isTabMessageDisconnectError,
          }))
        : null
    const frameMessageOptions = getFrameMessageOptions(frameId)
    const requestId = createSelectionRequestId()
    const panelPayload = {
      requestId,
      sourceText: text,
      targetLanguage: settings.targetLanguage,
      ...buildTranslationAppearancePayload(settings),
      ...buildSelectionPanelPayload(settings, selectionAnchor),
    }
    await chrome.tabs.sendMessage(
      tabId,
      Messages.renderSelectionPlaceholder(panelPayload),
      frameMessageOptions,
    )

    try {
      const chunkPlan = Api.createRecursiveChunkPlan([{ id: "selection", kind: "selection", text }])
      const partialTranslations = await Api.requestTranslationsBatched({
        settings,
        chunks: chunkPlan.chunks,
        concurrency: 1,
      })
      const translations = Api.mergeRecursiveTranslations(chunkPlan, partialTranslations)
      const translation = translations[0]?.translation

      if (!translation) {
        throw new Error("The API did not return a translation.")
      }

      const renderResult = await chrome.tabs.sendMessage(
        tabId,
        Messages.renderSelectionTranslation({
          ...panelPayload,
          translation,
          protectedFragments: translations[0]?.protectedFragments || [],
        }),
        frameMessageOptions,
      )
      if (renderResult?.rendered === "floating") {
        setBadge(tabId, "TR")
      }
      logger?.info("selection-render-complete", {
        frameId,
        requestId,
        tabId,
      })
      return { ok: true, requestId }
    } catch (error) {
      const renderResult = await chrome.tabs.sendMessage(
        tabId,
        Messages.renderSelectionError({
          ...panelPayload,
          error:
            String(error?.message || "").trim() ||
            "The translation could not be completed. Try again.",
        }),
        frameMessageOptions,
      )
      if (renderResult?.rendered === "floating") {
        setBadge(tabId, "!")
      }
      logger?.error("selection-translation-failed", {
        error: error.message,
        frameId,
        requestId,
        tabId,
      })
      return { ok: false, error: error.message, requestId }
    }
  }

  function youtubeVideoKey(url) {
    try {
      const parsed = new URL(url)
      if (SiteProfiles.resolveSiteProfile(parsed.hostname).id !== "youtube") return ""
      return parsed.pathname === "/watch"
        ? parsed.searchParams.get("v") || ""
        : /^\/shorts\/([^/]+)/u.exec(parsed.pathname)?.[1] || ""
    } catch {
      return ""
    }
  }

  async function startYoutubeSubtitleTranslation(sender, payload = {}) {
    if (!sender?.tab?.id || (sender.frameId ?? 0) !== 0) {
      throw new Error("YouTube subtitle translation requires the main video page.")
    }
    const tabId = sender.tab.id
    youtubeStartups.get(tabId)?.abort(new Error("cancelled"))
    const controller = new AbortController()
    const { signal } = controller
    controller.youtubeRequestId = payload.requestId
    controller.youtubeVideoKey = payload.videoKey
    youtubeStartups.set(tabId, controller)
    const timer = setTimeout(
      () => controller.abort(new Error("request-timeout")),
      SUBTITLE_DEADLINE_MS,
    )
    let translation
    let createdSessionId
    let captions = { enabled: false, hasTrack: false }
    const unavailable = {
      available: false,
      cueCount: 0,
      queued: 0,
      sessionStatus: "active",
    }
    const prefetchAttempts = []
    let pendingAttemptSource
    const finishPrefetch = (prefetch) => {
      const attempts = prefetchAttempts.map((attempt) => ({ ...attempt }))
      const firstFailure = attempts.find((attempt) => attempt.reason !== "ready")
      sendYoutubeDiagnosticEvent?.(
        tabId,
        0,
        "prefetch-attempts",
        `${attempts.map(({ attemptSource, reason, httpStatus }) => `attempt=${attemptSource}; reason=${reason}${httpStatus === undefined ? "" : `; status=${httpStatus}`}`).join(" | ")}; available=${prefetch.available}`,
        translation.sessionId,
      )?.catch?.(() => {})
      return {
        ...prefetch,
        attempts,
        ...(firstFailure ? { firstFailure } : {}),
      }
    }
    let videoKey = payload.videoKey
    const validate = async () => {
      signal.throwIfAborted()
      const tab = await chrome.tabs.get(tabId)
      signal.throwIfAborted()
      const currentKey = youtubeVideoKey(tab?.url)
      if (!currentKey || (videoKey && currentKey !== videoKey))
        throw new Error("The YouTube video changed. Start translation for the current video.")
      videoKey = currentKey
      controller.youtubeVideoKey = currentKey
      return tab
    }
    const operation = async () => {
      const tab = await validate()
      translation = await translatePage(tab, {
        signal,
        validate,
        interactive: payload.recovery !== true,
        onSession: (session) => {
          if (session.frameId === 0) {
            createdSessionId = session.sessionId
            controller.youtubeSessionId = session.sessionId
          }
        },
        youtubeVideoKey: videoKey,
        youtubeRequestId: payload.requestId,
      })
      signal.throwIfAborted()
      if (!translation?.sessionId || !getPageTranslationSession(tabId, translation.sessionId, 0))
        throw new Error("The subtitle session was not accepted.")
      captions = await enableYoutubeCaptions(chrome, tabId, { signal }).catch(() => {
        signal.throwIfAborted()
        return { enabled: false, hasTrack: false }
      })
      await validate()
      const advertisedTrackUrl = captions.trackBaseUrl
      const nativeTrackUrl = advertisedTrackUrl
        ? await captureNativeYoutubeCaptionRequestUrl(chrome, tabId, advertisedTrackUrl, {
            signal,
          }).catch(() => {
            signal.throwIfAborted()
            return ""
          })
        : ""
      signal.throwIfAborted()
      const initializePrefetch = async (baseUrl, attemptSource) => {
        pendingAttemptSource = attemptSource
        const result = await youtubeCaptionPrefetch.initialize({
          attemptSource,
          baseUrl,
          currentTimeMs: captions.currentTimeMs,
          frameId: 0,
          playbackRate: captions.playbackRate,
          reason: "startup",
          signal,
          sessionId: translation.sessionId,
          tabId,
        })
        signal.throwIfAborted()
        pendingAttemptSource = undefined
        prefetchAttempts.push({
          attemptSource,
          reason: result.available ? "ready" : result.reason,
          ...(result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }),
        })
        return result
      }
      let prefetch = nativeTrackUrl
        ? await initializePrefetch(nativeTrackUrl, "native-request")
        : unavailable
      signal.throwIfAborted()
      if (prefetch.available) captions.trackSource = "native-request"
      else if (!nativeTrackUrl || (advertisedTrackUrl && nativeTrackUrl !== advertisedTrackUrl))
        prefetch = await initializePrefetch(advertisedTrackUrl, "advertised")
      await validate()
      prefetch = finishPrefetch(prefetch)
      const { trackBaseUrl: _trackBaseUrl, ...captionStatus } = captions
      return {
        ok: true,
        sessionId: translation.sessionId,
        captions: captionStatus,
        prefetch,
      }
    }
    try {
      return await waitForAbortable(operation(), signal)
    } catch (error) {
      if (
        signal.aborted &&
        signal.reason?.message === "request-timeout" &&
        translation?.sessionId &&
        getPageTranslationSession(tabId, translation.sessionId, 0)
      ) {
        Promise.resolve(
          sendYoutubeDiagnosticEvent(
            tabId,
            0,
            "prefetch-fallback",
            "Timed caption acquisition timed out; using visible captions",
            translation.sessionId,
          ),
        ).catch(() => {})
        if (pendingAttemptSource)
          prefetchAttempts.push({
            attemptSource: pendingAttemptSource,
            reason: "request-timeout",
          })
        const { trackBaseUrl: _trackBaseUrl, ...captionStatus } = captions
        return {
          ok: true,
          sessionId: translation.sessionId,
          captions: captionStatus,
          prefetch: finishPrefetch(unavailable),
        }
      }
      if (createdSessionId && getPageTranslationSession(tabId, createdSessionId, 0))
        removePageTranslationState(tabId, 0, true)
      const reason = signal.aborted
        ? signal.reason?.message === "request-timeout"
          ? "request-timeout"
          : "cancelled"
        : "setup-error"
      const configurationError =
        /Settings are incomplete|Permission to access|Translation is disabled|video changed|cannot be translated|session was not accepted/u.test(
          String(error.message || ""),
        )
      return {
        ok: false,
        error: error.message,
        reason,
        retryable: reason !== "cancelled" && !configurationError,
        openOptions:
          payload.recovery !== true &&
          String(error.message || "").includes("Settings are incomplete"),
      }
    } finally {
      clearTimeout(timer)
      if (youtubeStartups.get(tabId) === controller) youtubeStartups.delete(tabId)
    }
  }

  async function resolveAutomationTarget(sender, message, missingTabError) {
    if (!sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`)) {
      return {
        error: {
          ok: false,
          error: "Automation commands require an extension page.",
        },
      }
    }

    const tabs = await chrome.tabs.query({})
    const tab = tabs.find((item) => item.url === message.payload?.pageUrl)

    if (!tab?.id) {
      throw new Error(missingTabError)
    }

    return { tab }
  }

  async function handleRuntimeMessage(message, sender) {
    if (!message || typeof message !== "object") {
      return { ok: false }
    }

    if (sender?.id !== chrome.runtime.id) {
      return { ok: false, error: "Untrusted message sender." }
    }

    if (
      [
        Messages.MESSAGE_TYPES.TEST_CONNECTION,
        Messages.MESSAGE_TYPES.GET_PROVIDER_CATALOG,
        Messages.MESSAGE_TYPES.GET_PROVIDER_AUTH_STATUS,
        Messages.MESSAGE_TYPES.GET_MODEL_ENDPOINTS,
      ].includes(message.type)
    ) {
      let trustedPage = false
      if (typeof sender.url === "string") {
        try {
          const url = new URL(sender.url)
          trustedPage =
            url.protocol === "chrome-extension:" &&
            url.host === chrome.runtime.id &&
            !url.username &&
            !url.password
        } catch (_error) {
          // Missing or malformed page URLs cannot authorize administration.
        }
      }
      if (!trustedPage) {
        return {
          ok: false,
          error: "Provider administration requires an extension page.",
        }
      }
    }

    if (message.type === Messages.MESSAGE_TYPES.GET_RUNTIME_HEALTH) {
      return {
        ok: true,
        component: "background",
        version: chrome.runtime.getManifest().version,
      }
    }

    if (message.type === Messages.MESSAGE_TYPES.GET_PROVIDER_CATALOG) {
      return {
        ok: true,
        providers: await ProviderRuntime.getCatalog(message.payload),
      }
    }

    if (message.type === Messages.MESSAGE_TYPES.GET_PROVIDER_AUTH_STATUS) {
      return {
        ok: true,
        status: await ProviderRuntime.getAuthStatus(message.payload?.providerId),
      }
    }

    if (message.type === Messages.MESSAGE_TYPES.GET_MODEL_ENDPOINTS) {
      const validation = Settings.validateSettings(message.payload)
      const endpointFields = new Set(["provider", "model", "customBaseUrl"])
      if (validation.invalidFields.some((field) => endpointFields.has(field))) {
        return { ok: false, error: validation.errors.join(" ") }
      }
      return {
        ok: true,
        origins: await ProviderRuntime.getModelEndpointPatterns(validation.settings),
      }
    }

    if (message.type === Messages.MESSAGE_TYPES.GET_PAGE_TRANSLATION_SESSION) {
      const tabId = sender?.tab?.id
      const frameId = Number.isInteger(sender?.frameId) ? sender.frameId : 0

      if (!tabId) {
        return { ok: true, active: false }
      }

      const session = getPageTranslationSession(tabId, undefined, frameId)

      if (!session) {
        return { ok: true, active: false }
      }

      return {
        ok: true,
        active: true,
        sessionId: session.sessionId,
        targetLanguage: session.settings.targetLanguage,
        ...buildTranslationAppearancePayload(session.settings),
        ...buildYoutubeSubtitlePayload(session.settings),
        ...buildDebugPayload(session.settings),
      }
    }

    if (message.type === Messages.MESSAGE_TYPES.AUTOMATION_OPEN_PDF) {
      const target = await resolveAutomationTarget(
        sender,
        message,
        "Could not resolve the PDF automation tab.",
      )

      if (target.error) {
        return target.error
      }
      if (typeof openPdfTranslator !== "function") {
        throw new Error("PDF translation is unavailable.")
      }
      return { ok: true, ...(await openPdfTranslator(target.tab)) }
    }

    if (message.type === Messages.MESSAGE_TYPES.AUTOMATION_TRANSLATE_PAGE) {
      const target = await resolveAutomationTarget(
        sender,
        message,
        "Could not resolve the automation tab.",
      )

      if (target.error) {
        return target.error
      }
      await translatePage(target.tab)
      return { ok: true, tabId: target.tab.id }
    }

    if (message.type === Messages.MESSAGE_TYPES.AUTOMATION_TRANSLATE_SELECTION) {
      const target = await resolveAutomationTarget(
        sender,
        message,
        "Could not resolve the automation tab.",
      )

      if (target.error) {
        return target.error
      }
      return translateSelection(
        target.tab.id,
        message.payload?.selectionText,
        message.payload?.frameId,
      )
    }

    if (message.type === Messages.MESSAGE_TYPES.OPEN_OPTIONS) {
      await chrome.runtime.openOptionsPage()
      return { ok: true }
    }

    if (message.type === Messages.MESSAGE_TYPES.START_YOUTUBE_SUBTITLE_TRANSLATION) {
      return startYoutubeSubtitleTranslation(sender, message.payload)
    }

    if (message.type === Messages.MESSAGE_TYPES.CANCEL_YOUTUBE_SUBTITLE_TRANSLATION) {
      const tabId = sender.tab?.id
      if (!tabId || (sender.frameId ?? 0) !== 0) return { ok: false }
      const payload = message.payload || {}
      const session = getPageTranslationSession(tabId, undefined, 0)
      const startup = youtubeStartups.get(tabId)
      const matchesSession = payload.sessionId && session?.sessionId === payload.sessionId
      const matchesStartup =
        payload.requestId &&
        startup?.youtubeRequestId === payload.requestId &&
        startup?.youtubeVideoKey === payload.videoKey
      if (matchesStartup || (matchesSession && startup?.youtubeSessionId === payload.sessionId))
        removePageTranslationState(tabId)
      else if (matchesSession) removePageTranslationState(tabId, 0, true)
      return { ok: true, cancelled: Boolean(matchesSession || matchesStartup) }
    }

    if (message.type === Messages.MESSAGE_TYPES.PREFETCH_YOUTUBE_SUBTITLES) {
      if (!sender.tab?.id || (sender.frameId ?? 0) !== 0) {
        return { available: false, queued: 0, sessionStatus: "missing" }
      }

      const session = getPageTranslationSession(sender.tab.id, undefined, 0)
      const requestedSessionId = message.payload?.sessionId
      if (!session || (requestedSessionId && requestedSessionId !== session.sessionId)) {
        return {
          available: false,
          queued: 0,
          sessionStatus: session ? "stale" : "missing",
        }
      }

      const prefetch = await youtubeCaptionPrefetch.update({
        currentTimeMs: message.payload?.currentTimeMs,
        playbackRate: message.payload?.playbackRate,
        reason: message.payload?.reason,
        sessionId: session?.sessionId,
        tabId: sender.tab.id,
      })
      const currentSession = getPageTranslationSession(sender.tab.id, undefined, 0)
      const sessionStatus = !currentSession
        ? "missing"
        : currentSession !== session
          ? "stale"
          : "active"
      return sessionStatus === "active"
        ? { ...prefetch, sessionStatus }
        : { available: false, queued: 0, sessionStatus }
    }

    if (message.type === Messages.MESSAGE_TYPES.RETRY_SELECTION_TRANSLATION) {
      if (!sender.tab?.id) {
        throw new Error("Selection translation retry requires a browser tab.")
      }

      return translateSelection(sender.tab.id, message.payload?.sourceText, sender.frameId, {
        selectionAnchor: message.payload?.selectionAnchor,
      })
    }

    if (message.type === Messages.MESSAGE_TYPES.TEST_CONNECTION) {
      const validation = Settings.validateSettings(message.payload)

      if (!validation.isValid) {
        throw new Error(validation.errors.join(" "))
      }

      if (
        !(await ensureApiPermission(validation.settings, {
          interactive: false,
        }))
      ) {
        throw new Error("Permission to access the configured API origin was denied.")
      }

      const translationStartedAt = Date.now()
      const translations = await Api.requestTranslations({
        settings: validation.settings,
        items: [{ id: "sample", kind: "paragraph", text: "Hello world." }],
        bypassCache: true,
      })
      return {
        ok: true,
        translation: translations[0] ? translations[0].translation : "",
        latencyMs: Date.now() - translationStartedAt,
        provider: validation.settings.provider,
        model: validation.settings.model,
      }
    }

    if (message.type === Messages.MESSAGE_TYPES.QUEUE_PAGE_TRANSLATION_ITEMS) {
      const tabId = sender?.tab?.id
      const frameId = Number.isInteger(sender?.frameId) ? sender.frameId : 0

      if (!tabId) {
        return { ok: false, queued: 0, sessionStatus: "missing" }
      }

      const result = await queuePageTranslationItems(
        tabId,
        message.payload?.sessionId,
        message.payload?.items,
        frameId,
      )

      return {
        ok: true,
        ...result,
      }
    }

    return { ok: false }
  }

  return {
    handleRuntimeMessage,
    pageTranslationQueue,
    removePageTranslationState,
    setupContextMenus,
    translatePage,
    translateSelection,
  }
}
