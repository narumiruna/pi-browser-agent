import * as ExtractionApi from "./content/extraction/rules.js"
import { createSourceAnalyzer } from "./content/extraction/source-analyzer.js"
import { createContentHelpers } from "./content/helpers.js"
import { createContentLifecycle } from "./content/lifecycle.js"
import { createPageObserver } from "./content/page/observer.js"
import { createPageProfile } from "./content/page/profile.js"
import * as ViewportApi from "./content/page/viewport.js"
import { createContentRenderer } from "./content/rendering/runtime.js"
import * as SelectionPanelApi from "./content/selection/panel.js"
import { applyContentStyles } from "./content/styles.js"
import * as YoutubeDiagnosticsApi from "./content/youtube/diagnostics.js"
import * as YoutubePlayerControlApi from "./content/youtube/player-control.js"
import { createYoutubeRuntime } from "./content/youtube/runtime.js"
import * as SubtitleApi from "./content/youtube/subtitles.js"
import * as TimedCaptionApi from "./content/youtube/timed-captions.js"
import * as AppearanceApi from "./shared/appearance.js"
import * as Messages from "./shared/messages.js"
import { configureTranslationUi } from "./shared/ui.js"

export function createContentRuntime(options = {}) {
  const SOURCE_ATTR = "data-ot-source-id"
  const NOTE_ATTR = "data-ot-note-id"
  const STALE_ATTR = "data-ot-source-stale"
  const TRANSLATED_ATTR = "data-ot-translated"
  const PROCESSED_ATTR = "data-translated"
  const QUEUED_ATTR = "data-ot-queued"
  const ROOT_ATTR = "data-ot-role"
  const STYLE_ID = "ot-translator-style"
  const PROSE_BLOCK_ATTR = "data-ot-prose-block"
  const PROSE_SPLIT_ATTR = "data-ot-prose-split"
  const PREFETCH_VIEWPORTS = 2
  const VISIBLE_TRANSLATION_FLUSH_DELAY_MS = 200
  const SCROLL_LISTENER_OPTIONS = Object.freeze({
    capture: true,
    passive: true,
  })
  const {
    ACTIVE_CONTENT_RULES,
    ACTIVE_SITE_PROFILE,
    ARTICLE_CONTENT_SELECTOR,
    DIRECT_NOTE_TARGET_SELECTOR,
    EXPLICIT_TEXT_BLOCK_SELECTOR,
    HEADING_SELECTOR,
    INLINE_CODE_SELECTOR,
    MAIN_CONTENT_SELECTOR,
    MATH_SELECTOR,
    READABLE_BLOCK_SELECTOR,
    SEMANTIC_BLOCK_SELECTOR,
    SITE_PROFILE_ID,
    SITE_ROOT_SELECTOR,
    SKIP_ANCESTOR_SELECTOR,
    SPLIT_CONTAINER_SELECTOR,
    TERMINAL_LIKE_SELECTOR,
    TITLE_LIKE_SELECTOR,
    UNSUPPORTED_ANCESTOR_SELECTOR,
    UNSUPPORTED_ELEMENT_SELECTOR,
  } = ExtractionApi
  const PROTECTED_PLACEHOLDER_REGEX = /__OT_(?:TOKEN|MATH)_\d+__/g
  let visibleTranslationFlushTimer = null
  const pageState = {
    pageTranslation: {
      active: false,
      sessionId: "",
      targetLanguage: "",
      youtubeSubtitleDisplayMode: "translation-only",
    },
    youtubeControl: {
      button: null,
      captionCheckTimer: null,
      observer: null,
      mountTimer: null,
      scheduled: false,
      state: "idle",
      prefetchVideo: null,
      lastPrefetchTimeMs: 0,
      videoKey: "",
    },
    youtubeSubtitleTranslations: new Map(),
    youtubeDiagnostics: {
      captionTrace: YoutubeDiagnosticsApi.createCaptionTraceStore(),
      frozenReport: "",
      panel: null,
      paused: false,
      status: "Ready",
      store: YoutubeDiagnosticsApi.createDiagnosticStore(),
    },
    translationAppearance: AppearanceApi.normalizeTranslationAppearance(),
    debug: {
      enabled: false,
    },
  }

  const {
    createExtractionDebugState,
    finalizeExtractionDebug,
    isDebugInfoEnabled,
    recordExtractionDebugSelect,
    recordExtractionDebugSkip,
  } = createContentHelpers({
    pageState,
    siteProfileId: SITE_PROFILE_ID,
  })

  function ensureStyles(appearance) {
    applyContentStyles({
      appearance,
      appearanceApi: AppearanceApi,
      document,
      pageState,
      rootAttr: ROOT_ATTR,
      styleId: STYLE_ID,
    })
  }

  const {
    acceptsYoutubeSessionPayload,
    acceptsYoutubeStartup,
    canQueueYoutubeCaptions,
    failYoutubeCaptionFallbacks,
    handleYoutubeQueueResult,
    applyYoutubeControlState,
    bindYoutubePrefetchTracking,
    cleanupYoutubeRuntime,
    ensureYoutubeControl,
    hasYoutubeCachedTranslation,
    matchYoutubeCaptionItems,
    recordYoutubeDiagnostic,
    resetYoutubeCaptionFallbacks,
    settleYoutubeCaptionFallbacks,
  } = createYoutubeRuntime({
    activeSiteProfile: ACTIVE_SITE_PROFILE,
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
    scheduleVisibleTranslation: scheduleVisiblePageTranslation,
    resetSubtitleObserver: () => pageObserverRuntime.resetPendingMutations(),
  })

  function setSourceQueued(element, queued) {
    if (!element) {
      return
    }

    element.setAttribute(QUEUED_ATTR, queued ? "true" : "false")
  }

  function setSourceTranslated(element, value) {
    if (!element) {
      return
    }

    if (value) {
      element.setAttribute(TRANSLATED_ATTR, "true")
      element.setAttribute(PROCESSED_ATTR, "true")
      return
    }

    element.removeAttribute(TRANSLATED_ATTR)
    element.removeAttribute(PROCESSED_ATTR)
  }

  function debugSkip(reason, element) {
    if (!isDebugInfoEnabled()) {
      return
    }

    const tagName = element?.tagName
      ? element.tagName.toLowerCase()
      : element && element.nodeType === Node.TEXT_NODE
        ? "#text"
        : "unknown"

    console.debug(`[OpenAI Translator] Skipping ${tagName}: ${reason}`)
  }

  function debugSelect(reason, element) {
    if (!isDebugInfoEnabled()) {
      return
    }

    const tagName = element?.tagName ? element.tagName.toLowerCase() : "unknown"

    console.debug(`[OpenAI Translator] Selected ${tagName}: ${reason}`)
  }

  function isInsideTranslation(element) {
    return Boolean(element?.closest?.(`[${ROOT_ATTR}]`))
  }

  const isUnsupportedElement = ExtractionApi.isUnsupportedElement
  const normalizeInlineWhitespace = ExtractionApi.normalizeInlineWhitespace
  const normalizeSegmentText = ExtractionApi.normalizeSegmentText

  const detectContentMode = ExtractionApi.detectContentMode
  const isHeadingLikeElement = ExtractionApi.isHeadingLikeElement
  const isReadableTitleLink = ExtractionApi.isReadableTitleLink
  const scoreCandidateBlock = ExtractionApi.scoreCandidateBlock
  const {
    getTranslationProfile,
    isTranslatorOwned,
    prepareSplitContainers,
    scoreTranslationRoot,
    splitContainer,
  } = createPageProfile({
    Node,
    contentRules: ACTIVE_CONTENT_RULES,
    detectContentMode,
    document,
    isInsideTranslation,
    mainContentSelector: MAIN_CONTENT_SELECTOR,
    normalizeSegmentText,
    proseBlockAttr: PROSE_BLOCK_ATTR,
    proseSplitAttr: PROSE_SPLIT_ATTR,
    rootAttr: ROOT_ATTR,
    scoreTranslationRoot: ExtractionApi.scoreTranslationRoot,
    semanticBlockSelector: SEMANTIC_BLOCK_SELECTOR,
  })

  function activatePageTranslationSession(sessionId) {
    pageState.pageTranslation.active = true
    pageState.pageTranslation.sessionId = sessionId || ""
  }

  function isPageTranslationSessionActive() {
    return pageState.pageTranslation.active && Boolean(pageState.pageTranslation.sessionId)
  }

  const {
    allocateSourceId,
    classifyCandidateElement,
    getCandidateElements,
    getHighestSourceIdCounter,
    getSegmentContent,
    getSegmentKind,
    hasSelectedRelative,
    hasSourceTextChanged,
    rememberSourceText,
    resetSourceIdCounterForTest,
    resetSourceTextSnapshotsForTest,
    shouldTranslateText,
  } = createSourceAnalyzer({
    document,
    window,
    Node,
    activeSiteProfile: ACTIVE_SITE_PROFILE,
    sourceAttr: SOURCE_ATTR,
    queuedAttr: QUEUED_ATTR,
    rootAttr: ROOT_ATTR,
    processedAttr: PROCESSED_ATTR,
    staleAttr: STALE_ATTR,
    translatedAttr: TRANSLATED_ATTR,
    protectedPlaceholderRegex: PROTECTED_PLACEHOLDER_REGEX,
    mathSelector: MATH_SELECTOR,
    skipAncestorSelector: SKIP_ANCESTOR_SELECTOR,
    inlineCodeSelector: INLINE_CODE_SELECTOR,
    contentRules: ACTIVE_CONTENT_RULES,
    terminalLikeSelector: TERMINAL_LIKE_SELECTOR,
    ExtractionApi,
    SubtitleApi,
    isInsideTranslation,
    getExistingNoteForSource,
    debugSkip,
    normalizeInlineWhitespace,
    normalizeSegmentText,
  })

  function insertSubtitleNote(source, note) {
    source?.insertAdjacentElement?.("afterend", note)
  }

  function getExistingNoteForSource(element, id) {
    if (!element) {
      return null
    }

    const next = element.nextElementSibling

    if (next && next.getAttribute(NOTE_ATTR) === id) {
      return next
    }

    for (const note of document.querySelectorAll(`[${ROOT_ATTR}="note"]`)) {
      if (note.getAttribute(NOTE_ATTR) === id) {
        return note
      }
    }

    return null
  }

  const contentLifecycle = createContentLifecycle({
    document,
    onSchedule: scheduleVisiblePageTranslation,
    scrollListenerOptions: SCROLL_LISTENER_OPTIONS,
    window,
  })
  const pageObserverRuntime = createPageObserver({
    MutationObserver: globalThis.MutationObserver,
    Node,
    SubtitleApi,
    activeSiteProfile: ACTIVE_SITE_PROFILE,
    contentLifecycle,
    document,
    getExistingNoteForSource,
    getSourceText: (source) => getSegmentContent(source).text,
    hasSourceTextChanged,
    insertSubtitleNote,
    isInsideTranslation,
    noteAttr: NOTE_ATTR,
    onScheduleVisibleTranslation: scheduleVisiblePageTranslation,
    observerDebounceMs: SubtitleApi.isSubtitleProfile(ACTIVE_SITE_PROFILE) ? 0 : 200,
    processedAttr: PROCESSED_ATTR,
    queuedAttr: QUEUED_ATTR,
    rememberSourceText,
    rootAttr: ROOT_ATTR,
    setSourceQueued,
    sourceAttr: SOURCE_ATTR,
    staleAttr: STALE_ATTR,
    translatedAttr: TRANSLATED_ATTR,
    window,
  })
  const { ensureObserver, withObserverPaused } = pageObserverRuntime

  function buildSegmentItem(element, analysis) {
    const content = analysis?.content || getSegmentContent(element)
    const classification = analysis?.classification || classifySegment(element, content)
    let itemId = element.getAttribute(SOURCE_ATTR)

    if (!itemId) {
      itemId = allocateSourceId()
    }

    element.setAttribute(SOURCE_ATTR, itemId)
    if (!element.hasAttribute(QUEUED_ATTR)) {
      element.setAttribute(QUEUED_ATTR, "false")
    }

    rememberSourceText(element, content.text, content.protectedFragments)

    return {
      id: itemId,
      kind: getSegmentKind(element),
      text: content.text,
      protectedFragments: content.protectedFragments,
      isUI: classification.isUI,
      isMetadata: classification.isMetadata,
      containsMath: classification.containsMath,
    }
  }

  function getViewportWindowOptions() {
    return ViewportApi.normalizeViewportOptions({
      viewportHeight: window.innerHeight || document.documentElement.clientHeight || 0,
      prefetchViewports: PREFETCH_VIEWPORTS,
    })
  }

  function shouldQueueElementForTranslation(element, existingId) {
    const stale = element.getAttribute(STALE_ATTR) === "true"
    const translated = element.getAttribute(TRANSLATED_ATTR) === "true"
    const queued = element.getAttribute(QUEUED_ATTR) === "true"
    const hasNote = existingId ? Boolean(getExistingNoteForSource(element, existingId)) : false

    if (stale) {
      return true
    }

    return !(hasNote || translated || queued)
  }

  function createWindowCandidate(element, item) {
    return {
      element,
      item,
      rect: element.getBoundingClientRect(),
    }
  }

  function classifyPageCandidate(element) {
    const analysis = classifyCandidateElement(element)
    if (analysis.ok && !_isSafeNoteInsertionTarget(element)) {
      return { ok: false, reason: "unsafe note placement" }
    }
    return analysis
  }

  function collectSemanticItems(profile, options, debugState) {
    const items = []
    const windowCandidates = []
    const totalElements = []
    const selectedElements = []
    const root = profile?.root
    const elements = getCandidateElements(root)
    const windowed = Boolean(options?.windowed) && profile?.windowed !== false
    const viewportOptions = windowed ? getViewportWindowOptions() : null

    for (const element of elements) {
      const analysis = classifyPageCandidate(element)

      if (!analysis.ok) {
        recordExtractionDebugSkip(debugState, analysis.reason, element)
        continue
      }

      if (hasSelectedRelative(element, selectedElements)) {
        debugSkip("ancestor block", element)
        recordExtractionDebugSkip(debugState, "ancestor block", element)
        continue
      }

      totalElements.push(element)

      const existingId = element.getAttribute(SOURCE_ATTR)
      const shouldQueue = shouldQueueElementForTranslation(element, existingId)

      if (!shouldQueue) {
        continue
      }

      const item = buildSegmentItem(element, analysis)
      selectedElements.push(element)
      debugSelect("leaf block", element)
      recordExtractionDebugSelect(debugState, item)

      if (windowed) {
        windowCandidates.push(createWindowCandidate(element, item))
      } else {
        items.push(item)
      }
    }

    return {
      items: windowed
        ? ViewportApi.selectWindowCandidates(windowCandidates, viewportOptions).map(
            (candidate) => candidate.item,
          )
        : items,
      totalSegments: totalElements.length,
    }
  }

  function collectFallbackItems(profile, options, debugState) {
    const seen = new Set()
    const selectedElements = []
    const items = []
    const windowCandidates = []
    let totalSegments = 0
    const windowed = Boolean(options?.windowed) && profile?.windowed !== false
    const viewportOptions = windowed ? getViewportWindowOptions() : null
    const root = profile?.root
    const classificationCache = new Map()

    if (!root || !profile?.allowFallback) {
      return {
        items: [],
        totalSegments: 0,
      }
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement

        if (!parent || parent.closest(SKIP_ANCESTOR_SELECTOR) || isInsideTranslation(parent)) {
          return NodeFilter.FILTER_REJECT
        }

        if (isUnsupportedElement(parent)) {
          debugSkip("unsupported element", parent)
          return NodeFilter.FILTER_REJECT
        }

        if (parent.closest(`[${PROCESSED_ATTR}="true"]`)) {
          debugSkip("already translated", parent)
          return NodeFilter.FILTER_REJECT
        }

        if (!shouldTranslateText(node.textContent || "")) {
          return NodeFilter.FILTER_REJECT
        }

        return NodeFilter.FILTER_ACCEPT
      },
    })

    let currentNode = walker.nextNode()

    while (currentNode) {
      const parent = currentNode.parentElement
      const anchor = parent.closest(READABLE_BLOCK_SELECTOR)
      const analysis = anchor
        ? classificationCache.get(anchor) || classifyPageCandidate(anchor)
        : null

      if (anchor && analysis && !classificationCache.has(anchor)) {
        classificationCache.set(anchor, analysis)
      }

      if (anchor && analysis?.ok && !seen.has(anchor)) {
        if (hasSelectedRelative(anchor, selectedElements)) {
          debugSkip("ancestor block", anchor)
          recordExtractionDebugSkip(debugState, "ancestor block", anchor)
          currentNode = walker.nextNode()
          continue
        }

        seen.add(anchor)
        totalSegments += 1

        const existingId = anchor.getAttribute(SOURCE_ATTR)
        const shouldQueue = shouldQueueElementForTranslation(anchor, existingId)

        if (shouldQueue) {
          const item = buildSegmentItem(anchor, analysis)
          selectedElements.push(anchor)
          debugSelect("leaf block", anchor)
          recordExtractionDebugSelect(debugState, item)

          if (windowed) {
            windowCandidates.push(createWindowCandidate(anchor, item))
          } else {
            items.push(item)
          }
        }
      } else if (anchor && analysis && !analysis.ok && !seen.has(anchor)) {
        recordExtractionDebugSkip(debugState, analysis.reason, anchor)
        seen.add(anchor)
      }

      currentNode = walker.nextNode()
    }

    return {
      items: windowed
        ? ViewportApi.selectWindowCandidates(windowCandidates, viewportOptions).map(
            (candidate) => candidate.item,
          )
        : items,
      totalSegments,
    }
  }

  function collectPageItems(options) {
    prepareSplitContainers()
    ensureStyles()
    ensureObserver()

    const profile = getTranslationProfile()
    const debugState = isDebugInfoEnabled() ? createExtractionDebugState() : null

    const semantic = collectSemanticItems(profile, options, debugState)

    if (semantic.totalSegments > 0) {
      return {
        items: semantic.items,
        totalSegments: semantic.totalSegments,
        pendingSegments: semantic.items.length,
        keepAlive: SubtitleApi.shouldKeepSessionAlive(ACTIVE_CONTENT_RULES),
        profileId: SITE_PROFILE_ID,
        debug: finalizeExtractionDebug(debugState),
      }
    }

    const fallback = collectFallbackItems(profile, options, debugState)

    return {
      items: fallback.items,
      totalSegments: fallback.totalSegments,
      pendingSegments: fallback.items.length,
      keepAlive: SubtitleApi.shouldKeepSessionAlive(ACTIVE_CONTENT_RULES),
      profileId: SITE_PROFILE_ID,
      debug: finalizeExtractionDebug(debugState),
    }
  }

  async function requestVisiblePageTranslationBatch() {
    visibleTranslationFlushTimer = null

    if (
      !isPageTranslationSessionActive() ||
      (SubtitleApi.isSubtitleProfile(ACTIVE_SITE_PROFILE) && !canQueueYoutubeCaptions())
    ) {
      return
    }

    const extraction = collectPageItems({ windowed: true })
    renderExtractionDebugPanel(extraction.debug)

    if (
      SubtitleApi.isSubtitleProfile(ACTIVE_SITE_PROFILE) &&
      (extraction.totalSegments > 0 || extraction.items?.length > 0)
    ) {
      recordYoutubeDiagnostic(
        "extraction",
        `Found ${extraction.totalSegments} caption source(s); ${extraction.items?.length || 0} pending item(s)`,
      )
    }

    let pendingItems = extraction.items || []

    if (SubtitleApi.isSubtitleProfile(ACTIVE_SITE_PROFILE)) {
      const matched = matchYoutubeCaptionItems(pendingItems)

      if (matched.cached.length > 0) {
        renderPageTranslationUpdates({
          targetLanguage: pageState.pageTranslation.targetLanguage,
          translations: matched.cached,
          youtubeSubtitleDisplayMode: pageState.pageTranslation.youtubeSubtitleDisplayMode,
        })
      }

      pendingItems = matched.missing
    }

    if (pendingItems.length === 0) {
      return
    }

    const sessionId = pageState.pageTranslation.sessionId
    const { messages, rejectedItems } = Messages.batchPageTranslationItems(sessionId, pendingItems)
    if (rejectedItems.length)
      showToast("Some page text could not be translated. Try again.", "error")
    for (const message of messages) {
      if (!isPageTranslationSessionActive() || sessionId !== pageState.pageTranslation.sessionId)
        return
      let response
      try {
        response = await chrome.runtime.sendMessage(message)
      } catch (_error) {
        response = { ok: false }
      }
      if (!isPageTranslationSessionActive() || sessionId !== pageState.pageTranslation.sessionId)
        return
      const subtitleProfile = SubtitleApi.isSubtitleProfile(ACTIVE_SITE_PROFILE)
      if (subtitleProfile) {
        handleYoutubeQueueResult(message.payload.items, response, sessionId)
        if (!isPageTranslationSessionActive() || sessionId !== pageState.pageTranslation.sessionId)
          return
      }
      if (response?.ok !== true || response.sessionStatus === "missing") {
        if (subtitleProfile)
          recordYoutubeDiagnostic("queue-error", "Could not queue caption items", { show: true })
        else showToast("Some page text could not be translated. Try again.", "error")
        return
      }
      if (subtitleProfile)
        recordYoutubeDiagnostic(
          "queued",
          `Background accepted ${Number(response.queued) || 0} caption item(s)`,
        )
    }
  }

  function scheduleVisiblePageTranslation() {
    if (!isPageTranslationSessionActive()) {
      return
    }

    const shouldRenderCachedSubtitleImmediately =
      SubtitleApi.isSubtitleProfile(ACTIVE_SITE_PROFILE) &&
      hasYoutubeCachedTranslation(
        Array.from(document.querySelectorAll(DIRECT_NOTE_TARGET_SELECTOR) || [])
          .filter((source) =>
            shouldQueueElementForTranslation(source, source.getAttribute(SOURCE_ATTR)),
          )
          .map((source) => getSegmentContent(source).text),
      )

    if (shouldRenderCachedSubtitleImmediately) {
      if (visibleTranslationFlushTimer) {
        window.clearTimeout(visibleTranslationFlushTimer)
        visibleTranslationFlushTimer = null
      }
      requestVisiblePageTranslationBatch().catch(() => {})
      return
    }

    if (visibleTranslationFlushTimer) {
      return
    }

    visibleTranslationFlushTimer = window.setTimeout(() => {
      requestVisiblePageTranslationBatch().catch(() => {})
    }, VISIBLE_TRANSLATION_FLUSH_DELAY_MS)
  }

  async function restorePageTranslationSession() {
    if (clearGeneration > 0) return false
    try {
      const generation = clearGeneration
      const response = await chrome.runtime.sendMessage(Messages.getPageTranslationSession())

      if (
        cleanedUp ||
        generation !== clearGeneration ||
        isPageTranslationSessionActive() ||
        !response?.ok ||
        !response.active ||
        !response.sessionId
      ) {
        return false
      }

      ensureStyles(response.translationAppearance)
      pageState.debug.enabled = Boolean(response.debug?.enabled)
      activatePageTranslationSession(response.sessionId)
      pageState.pageTranslation.targetLanguage = response.targetLanguage || ""
      pageState.pageTranslation.youtubeSubtitleDisplayMode =
        response.youtubeSubtitleDisplayMode || "translation-only"
      ensureObserver()
      if (pageState.youtubeControl.button) {
        applyYoutubeControlState(pageState.youtubeControl.button, "active")
      }
      bindYoutubePrefetchTracking()
      return true
    } catch (_error) {
      // The background may be unavailable while the extension is reloading.
      return false
    }
  }

  const {
    clearPagePlaceholders,
    clearPendingTranslations,
    cleanupRendering,
    getDebugProfileLabel,
    getNoteElementTagName,
    insertNoteForTarget,
    isSafeNoteInsertionTarget: _isSafeNoteInsertionTarget,
    renderExtractionDebugPanel,
    renderPagePlaceholders,
    renderPageTranslationUpdates,
    renderSelectionError,
    renderSelectionPlaceholder,
    renderSelectionTranslation,
    showToast,
    startPageTranslationSession,
    shouldAppendNoteInsideTarget,
  } = createContentRenderer({
    document,
    window,
    chrome,
    pageState,
    activeSiteProfile: ACTIVE_SITE_PROFILE,
    siteProfileId: SITE_PROFILE_ID,
    allowAncestorTransforms: ACTIVE_CONTENT_RULES.allowAncestorTransforms,
    sourceAttr: SOURCE_ATTR,
    noteAttr: NOTE_ATTR,
    staleAttr: STALE_ATTR,
    translatedAttr: TRANSLATED_ATTR,
    processedAttr: PROCESSED_ATTR,
    queuedAttr: QUEUED_ATTR,
    rootAttr: ROOT_ATTR,
    siteRootSelector: SITE_ROOT_SELECTOR,
    directNoteTargetSelector: DIRECT_NOTE_TARGET_SELECTOR,
    readableBlockSelector: READABLE_BLOCK_SELECTOR,
    terminalLikeSelector: TERMINAL_LIKE_SELECTOR,
    SelectionPanelApi,
    SubtitleApi,
    Messages,
    isHeadingLikeElement,
    isReadableTitleLink,
    withObserverPaused,
    ensureStyles,
    ensureObserver,
    getExistingNoteForSource,
    getSegmentContent,
    rememberSourceText,
    setSourceTranslated,
    setSourceQueued,
    collectPageItems,
    activatePageTranslationSession,
    applyYoutubeControlState,
    recordYoutubeDiagnostic,
    resetYoutubeCaptionFallbacks,
    settleYoutubeCaptionFallbacks,
    failYoutubeCaptionFallbacks,
    matchYoutubeCaptionItems,
    isDebugInfoEnabled,
  })

  const MessageTypes = Messages.MESSAGE_TYPES
  let cleanedUp = false
  let clearGeneration = 0
  let restoreSessionTimer = null
  const onRuntimeMessage = (message, sender, sendResponse) => {
    if (sender?.id !== chrome.runtime.id || sender?.tab) return
    if (
      ["start-page-translation-session", "render-selection-placeholder", "show-toast"].includes(
        message?.type,
      )
    )
      configureTranslationUi(message.payload?.uiStrings)
    if (!message || typeof message !== "object") {
      sendResponse({ ok: false })
      return
    }

    if (message.type === MessageTypes.PING || message.type === MessageTypes.GET_RUNTIME_HEALTH) {
      sendResponse({
        ok: true,
        component: "content",
        version: chrome.runtime.getManifest().version,
      })
      return
    }

    if (message.type === MessageTypes.START_PAGE_TRANSLATION_SESSION) {
      if (
        SubtitleApi.isSubtitleProfile(ACTIVE_SITE_PROFILE) &&
        !acceptsYoutubeStartup(message.payload || {})
      ) {
        sendResponse({ ok: false, stale: true })
        return
      }
      sendResponse({
        ok: true,
        ...startPageTranslationSession(message.payload || {}),
      })
      return
    }

    if (
      message.payload?.sessionId &&
      message.payload.sessionId !== pageState.pageTranslation.sessionId &&
      [
        MessageTypes.RENDER_PAGE_TRANSLATION_UPDATES,
        MessageTypes.RENDER_PAGE_PLACEHOLDERS,
        MessageTypes.CLEAR_PAGE_PLACEHOLDERS,
        MessageTypes.CLEAR_PENDING_TRANSLATIONS,
      ].includes(message.type)
    ) {
      sendResponse({ ok: false, stale: true })
      return
    }

    if (
      SubtitleApi.isSubtitleProfile(ACTIVE_SITE_PROFILE) &&
      [
        MessageTypes.RENDER_PAGE_TRANSLATION_UPDATES,
        MessageTypes.CLEAR_PAGE_PLACEHOLDERS,
        MessageTypes.RENDER_YOUTUBE_DIAGNOSTIC_EVENT,
      ].includes(message.type) &&
      !acceptsYoutubeSessionPayload(message.payload)
    ) {
      sendResponse({ ok: false, stale: true })
      return
    }

    if (message.type === MessageTypes.RENDER_PAGE_TRANSLATION_UPDATES) {
      sendResponse({
        ok: true,
        ...renderPageTranslationUpdates(message.payload || {}),
      })
      return
    }

    if (message.type === MessageTypes.RENDER_YOUTUBE_DIAGNOSTIC_EVENT) {
      const payload = message.payload || {}
      recordYoutubeDiagnostic(
        String(payload.stage || "background"),
        String(payload.detail || "Background event"),
        { show: String(payload.stage || "").endsWith("error") },
      )
      sendResponse({ ok: true })
      return
    }

    if (message.type === MessageTypes.RENDER_PAGE_PLACEHOLDERS) {
      sendResponse({
        ok: true,
        ...renderPagePlaceholders(message.payload || {}),
      })
      return
    }

    if (message.type === MessageTypes.RENDER_SELECTION_ERROR) {
      sendResponse({
        ok: true,
        ...renderSelectionError(message.payload || {}),
      })
      return
    }

    if (message.type === MessageTypes.RENDER_SELECTION_TRANSLATION) {
      sendResponse({
        ok: true,
        ...renderSelectionTranslation(message.payload || {}),
      })
      return
    }

    if (message.type === MessageTypes.RENDER_SELECTION_PLACEHOLDER) {
      sendResponse({
        ok: true,
        ...renderSelectionPlaceholder(message.payload || {}),
      })
      return
    }

    if (message.type === MessageTypes.CLEAR_PENDING_TRANSLATIONS) {
      clearGeneration += 1
      sendResponse({
        ok: true,
        ...clearPendingTranslations(),
      })
      return
    }

    if (message.type === MessageTypes.CLEAR_PAGE_PLACEHOLDERS) {
      sendResponse({
        ok: true,
        ...clearPagePlaceholders(message.payload || {}),
      })
      return
    }

    if (message.type === MessageTypes.SHOW_TOAST) {
      const payload = message.payload || {}
      showToast(payload.message || "", payload.level || "info")
      sendResponse({ ok: true })
      return
    }

    sendResponse({ ok: false })
  }

  if (options.mount !== false) {
    ensureYoutubeControl()
    chrome.runtime.onMessage.addListener(onRuntimeMessage)
    restoreSessionTimer = window.setTimeout(() => {
      restoreSessionTimer = null
      restorePageTranslationSession()
    }, 0)
  }

  function cleanup() {
    cleanedUp = true
    cleanupYoutubeRuntime()
    pageObserverRuntime.cleanup()
    if (visibleTranslationFlushTimer) {
      window.clearTimeout(visibleTranslationFlushTimer)
    }
    if (restoreSessionTimer) {
      window.clearTimeout(restoreSessionTimer)
    }
    visibleTranslationFlushTimer = null
    restoreSessionTimer = null
    cleanupRendering()
    chrome.runtime.onMessage.removeListener?.(onRuntimeMessage)
  }

  return {
    cleanup,
    __TEST__: {
      detectContentMode,
      ARTICLE_CONTENT_SELECTOR,
      DIRECT_NOTE_TARGET_SELECTOR,
      EXPLICIT_TEXT_BLOCK_SELECTOR,
      HEADING_SELECTOR,
      READABLE_BLOCK_SELECTOR,
      SPLIT_CONTAINER_SELECTOR,
      TITLE_LIKE_SELECTOR,
      UNSUPPORTED_ANCESTOR_SELECTOR,
      UNSUPPORTED_ELEMENT_SELECTOR,
      _createExtractionDebugState: createExtractionDebugState,
      _finalizeExtractionDebug: finalizeExtractionDebug,
      _isSafeNoteInsertionTarget,
      _getDebugProfileLabel: getDebugProfileLabel,
      _getHighestSourceIdCounter: getHighestSourceIdCounter,
      _getNoteElementTagName: getNoteElementTagName,
      _insertNoteForTarget: insertNoteForTarget,
      _allocateSourceId: allocateSourceId,
      _hasSourceTextChanged: hasSourceTextChanged,
      _rememberSourceText: rememberSourceText,
      _resetSourceIdCounterForTest: resetSourceIdCounterForTest,
      _resetSourceTextSnapshotsForTest: resetSourceTextSnapshotsForTest,
      _SCROLL_LISTENER_OPTIONS: SCROLL_LISTENER_OPTIONS,
      _shouldAppendNoteInsideTarget: shouldAppendNoteInsideTarget,
      _splitContainer: splitContainer,
      getSegmentContent,
      isHeadingLikeElement,
      isInsideTranslation,
      isTranslatorOwned,
      isUnsupportedElement,
      scoreCandidateBlock,
      scoreTranslationRoot,
    },
  }
}

export default function mountContent() {
  return createContentRuntime().cleanup
}
