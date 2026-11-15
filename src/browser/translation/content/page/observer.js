function isSubtitleRelatedMutation(mutation, options = {}) {
  const { Node, selector } = options

  function containsSubtitleSegment(node, includeDescendants) {
    const element = node?.nodeType === Node?.ELEMENT_NODE ? node : node?.parentElement

    return Boolean(
      element &&
        (element.matches?.(selector) ||
          element.closest?.(selector) ||
          (includeDescendants && element.querySelector?.(selector))),
    )
  }

  return (
    containsSubtitleSegment(mutation?.target, false) ||
    [...(mutation?.addedNodes || []), ...(mutation?.removedNodes || [])].some((node) =>
      containsSubtitleSegment(node, true),
    )
  )
}

export function createPageObserver(options = {}) {
  const {
    document,
    Node,
    MutationObserver,
    window,
    rootAttr,
    sourceAttr,
    noteAttr,
    queuedAttr,
    staleAttr,
    translatedAttr,
    processedAttr,
    activeSiteProfile,
    SubtitleApi,
    isInsideTranslation,
    hasSourceTextChanged,
    setSourceQueued,
    getExistingNoteForSource,
    getSourceText,
    insertSubtitleNote,
    rememberSourceText,
    onScheduleVisibleTranslation,
    contentLifecycle,
    observerDebounceMs = 200,
  } = options
  let observer = null
  let observerFlushTimer = null
  const pendingObserverMutations = []

  function observePageMutations() {
    if (!observer || !document.body) return
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "aria-hidden"],
      childList: true,
      characterData: true,
      subtree: true,
    })
  }

  function withObserverPaused(callback) {
    if (!observer || !document.body) return callback()
    observer.disconnect()
    try {
      return callback()
    } finally {
      observePageMutations()
    }
  }

  function markSourceStale(element) {
    if (!element?.getAttribute) return
    const id = element.getAttribute(sourceAttr)
    if (!id || !hasSourceTextChanged(element)) return
    const existingNote = getExistingNoteForSource(element, id)
    let subtitleReset = false
    withObserverPaused(() => {
      subtitleReset = SubtitleApi.resetChangedSubtitleSource(activeSiteProfile, {
        element,
        getSourceText,
        note: existingNote,
        processedAttribute: processedAttr,
        queuedAttribute: queuedAttr,
        sourceAttribute: sourceAttr,
        staleAttribute: staleAttr,
        translatedAttribute: translatedAttr,
      })
    })
    if (subtitleReset) return
    element.setAttribute(staleAttr, "true")
    element.setAttribute(translatedAttr, "stale")
    element.removeAttribute(processedAttr)
    setSourceQueued(element, false)
    existingNote?.setAttribute("data-stale", "true")
  }

  function markRelatedSourcesStale(node) {
    if (!node) return
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
    if (!element || element.closest(`[${rootAttr}]`) || isInsideTranslation(element)) return
    const directSource = element.closest(`[${sourceAttr}]`)
    if (!directSource) return
    // Reset before scheduling so collection sees the current revision.
    markSourceStale(directSource)
  }

  function reconcileSubtitleNotes() {
    if (
      !SubtitleApi.isSubtitleProfile(activeSiteProfile) ||
      typeof SubtitleApi.reconcileSubtitleNotes !== "function"
    ) {
      return
    }

    const sources = Array.from(document.querySelectorAll?.(`[${sourceAttr}]`) || [])

    withObserverPaused(() => {
      SubtitleApi.reconcileSubtitleNotes(activeSiteProfile, {
        findSource(id) {
          return sources.find((source) => source.getAttribute?.(sourceAttr) === id) || null
        },
        getSourceText,
        noteAttribute: noteAttr,
        notes: document.querySelectorAll?.(`[${rootAttr}="note"]`) || [],
        processedAttribute: processedAttr,
        queuedAttribute: queuedAttr,
        sourceAttribute: sourceAttr,
        staleAttribute: staleAttr,
        translatedAttribute: translatedAttr,
      })
    })
  }

  function getAddedSubtitleSources(mutations) {
    const sources = []
    const selector = SubtitleApi.YOUTUBE_CAPTION_SEGMENT_SELECTOR

    for (const mutation of mutations) {
      for (const node of mutation.addedNodes || []) {
        if (node.nodeType !== Node.ELEMENT_NODE) {
          continue
        }
        if (node.matches?.(selector)) {
          sources.push(node)
        }
        for (const source of node.querySelectorAll?.(selector) || []) {
          sources.push(source)
        }
      }
    }

    return sources
  }

  function getDetachedSubtitleNotes(mutations) {
    const notes = new Map()
    const selector = `[${rootAttr}="note"][${noteAttr}]`

    function rememberNote(note) {
      const id = note?.getAttribute?.(noteAttr)

      if (id && note.getAttribute?.(rootAttr) === "note") {
        notes.set(id, note)
      }
    }

    for (const mutation of mutations) {
      for (const node of mutation.removedNodes || []) {
        if (node.nodeType !== Node.ELEMENT_NODE) {
          continue
        }
        rememberNote(node)
        for (const note of node.querySelectorAll?.(selector) || []) {
          rememberNote(note)
        }
      }
    }

    return notes
  }

  function flushObserverMutations() {
    observerFlushTimer = null
    const mutations = pendingObserverMutations.splice(0)
    const subtitleProfile = SubtitleApi.isSubtitleProfile(activeSiteProfile)
    const replacementSources = subtitleProfile ? getAddedSubtitleSources(mutations) : []
    const detachedNotes = subtitleProfile ? getDetachedSubtitleNotes(mutations) : new Map()
    const findSubtitleNote = (source, id) =>
      getExistingNoteForSource(source, id) || detachedNotes.get(id) || null
    let shouldScheduleTranslation = false

    for (const mutation of mutations) {
      const targetElement =
        mutation.target?.nodeType === Node.ELEMENT_NODE
          ? mutation.target
          : mutation.target?.parentElement
      if (
        targetElement &&
        (targetElement.closest(`[${rootAttr}]`) || isInsideTranslation(targetElement))
      )
        continue
      if (mutation.type === "characterData" || mutation.type === "attributes") {
        markRelatedSourcesStale(mutation.target)
        shouldScheduleTranslation = true
        continue
      }
      if (mutation.type !== "childList") continue
      markRelatedSourcesStale(mutation.target)
      for (const node of mutation.removedNodes) {
        withObserverPaused(() => {
          SubtitleApi.rebindDetachedSubtitleSources?.(activeSiteProfile, node, replacementSources, {
            findNote: findSubtitleNote,
            getSourceText,
            insertNote: insertSubtitleNote,
            processedAttribute: processedAttr,
            queuedAttribute: queuedAttr,
            rememberSourceText,
            sourceAttribute: sourceAttr,
            staleAttribute: staleAttr,
            translatedAttribute: translatedAttr,
          })
          SubtitleApi.removeDetachedSubtitleSources(activeSiteProfile, node, {
            findNote: findSubtitleNote,
            processedAttribute: processedAttr,
            queuedAttribute: queuedAttr,
            sourceAttribute: sourceAttr,
            staleAttribute: staleAttr,
            translatedAttribute: translatedAttr,
          })
        })
      }
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE || !isInsideTranslation(node)) {
          markRelatedSourcesStale(node)
        }
      }
      shouldScheduleTranslation = true
    }

    if (shouldScheduleTranslation) {
      reconcileSubtitleNotes()
      onScheduleVisibleTranslation()
    }
  }

  function ensureObserver() {
    if (observer || !document.body) return
    observer = new MutationObserver((mutations) => {
      const relevantMutations = SubtitleApi.isSubtitleProfile(activeSiteProfile)
        ? mutations.filter((mutation) =>
            isSubtitleRelatedMutation(mutation, {
              Node,
              selector: SubtitleApi.YOUTUBE_CAPTION_SEGMENT_SELECTOR,
            }),
          )
        : mutations

      if (relevantMutations.length === 0) {
        return
      }

      pendingObserverMutations.push(...relevantMutations)
      if (observerDebounceMs <= 0) {
        flushObserverMutations()
        return
      }
      if (!observerFlushTimer) {
        observerFlushTimer = window.setTimeout(flushObserverMutations, observerDebounceMs)
      }
    })
    observePageMutations()
    contentLifecycle.start()
  }

  function resetPendingMutations() {
    observer?.takeRecords?.()
    if (observerFlushTimer) window.clearTimeout(observerFlushTimer)
    observerFlushTimer = null
    pendingObserverMutations.length = 0
  }

  function cleanup() {
    resetPendingMutations()
    observer?.disconnect()
    observer = null
    contentLifecycle.cleanup()
  }

  return { cleanup, ensureObserver, resetPendingMutations, withObserverPaused }
}

export { isSubtitleRelatedMutation }
export default { createPageObserver, isSubtitleRelatedMutation }
