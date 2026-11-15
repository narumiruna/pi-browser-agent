const DEFAULT_CONCURRENCY = 5
const DEFAULT_BATCH_SIZE = 8

function createSessionId() {
  return `page-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function normalizePositiveInteger(value, fallback) {
  const number = Math.floor(Number(value))

  return Number.isFinite(number) && number > 0 ? number : fallback
}

function shouldKeepPageTranslationSession(extraction) {
  return Boolean(
    extraction?.keepAlive ||
      Number(extraction?.totalSegments) > 0 ||
      (Array.isArray(extraction?.items) && extraction.items.length > 0),
  )
}

function createPageTranslationQueue(options = {}) {
  const concurrency = normalizePositiveInteger(options.concurrency, DEFAULT_CONCURRENCY)
  const batchSize = normalizePositiveInteger(options.batchSize, DEFAULT_BATCH_SIZE)
  const getBatchSize =
    typeof options.getBatchSize === "function" ? options.getBatchSize : () => batchSize
  const processBatch =
    typeof options.processBatch === "function" ? options.processBatch : async () => {}
  const onError = typeof options.onError === "function" ? options.onError : () => {}
  const sessions = new Map()

  function getSessionKey(tabId, frameId = 0) {
    return `${tabId}:${frameId}`
  }

  function create(tabId, settings, frameId = 0) {
    remove(tabId, frameId)
    const abortController = new AbortController()
    const session = {
      abortController,
      signal: abortController.signal,
      tabId,
      frameId,
      sessionId: createSessionId(),
      settings,
      pendingItems: [],
      pendingIds: new Set(),
      activeItems: new Map(),
      latestPendingItems: new Map(),
      translatedIds: new Set(),
      inFlightCount: 0,
    }

    sessions.set(getSessionKey(tabId, frameId), session)

    return session
  }

  function get(tabId, sessionId, frameId) {
    if (Number.isInteger(frameId) && frameId >= 0) {
      const session = sessions.get(getSessionKey(tabId, frameId))

      return !session || (sessionId && session.sessionId !== sessionId) ? null : session
    }

    if (!sessionId) {
      return sessions.get(getSessionKey(tabId, 0)) || null
    }

    for (const session of sessions.values()) {
      if (session.tabId === tabId && session.sessionId === sessionId) {
        return session
      }
    }

    return null
  }

  function remove(tabId, frameId) {
    if (Number.isInteger(frameId) && frameId >= 0) {
      sessions.get(getSessionKey(tabId, frameId))?.abortController.abort()
      sessions.delete(getSessionKey(tabId, frameId))
      return
    }

    for (const [key, session] of sessions) {
      if (session.tabId === tabId) {
        session.abortController.abort()
        sessions.delete(key)
      }
    }
  }

  function getTranslatedCount(tabId) {
    let count = 0

    for (const session of sessions.values()) {
      if (session.tabId === tabId) {
        count += session.translatedIds.size
      }
    }

    return count
  }

  function markTranslated(tabId, sessionId, ids, frameId) {
    const session = get(tabId, sessionId, frameId)

    if (!session) {
      return 0
    }

    let count = 0

    for (const id of ids || []) {
      if (typeof id !== "string") {
        continue
      }

      if (!session.translatedIds.has(id)) {
        count += 1
      }

      session.translatedIds.add(id)
    }

    return count
  }

  function resolveClaimBatchSize(item, session) {
    return Math.min(batchSize, normalizePositiveInteger(getBatchSize(item, session), batchSize))
  }

  function continueProcessing(tabId, sessionId, frameId) {
    const session = get(tabId, sessionId, frameId)

    if (!session) {
      return
    }

    while (session.pendingItems.length > 0 && session.inFlightCount < concurrency) {
      const claimSize = resolveClaimBatchSize(session.pendingItems[0], session)
      let itemCount = 1

      while (
        itemCount < claimSize &&
        itemCount < session.pendingItems.length &&
        resolveClaimBatchSize(session.pendingItems[itemCount], session) === claimSize
      ) {
        itemCount += 1
      }

      const items = session.pendingItems.splice(0, itemCount)

      if (items.length === 0) {
        break
      }

      session.inFlightCount += 1
      for (const item of items) session.activeItems.set(item.id, item)

      Promise.resolve()
        .then(() =>
          processBatch({
            tabId,
            frameId: session.frameId,
            sessionId,
            items,
            session,
          }),
        )
        .catch((error) => {
          onError(error, {
            tabId,
            frameId: session.frameId,
            sessionId,
            items,
          })
        })
        .finally(() => {
          const currentSession = get(tabId, sessionId, frameId)

          if (!currentSession) {
            return
          }

          for (const item of items) {
            currentSession.activeItems.delete(item.id)
            const latest = currentSession.latestPendingItems.get(item.id)
            currentSession.latestPendingItems.delete(item.id)
            if (latest) currentSession.pendingItems.unshift(latest)
            else currentSession.pendingIds.delete(item.id)
          }

          currentSession.inFlightCount = Math.max(0, currentSession.inFlightCount - 1)

          continueProcessing(tabId, sessionId, frameId)
        })
    }
  }

  function enqueue(tabId, sessionId, items, frameId, enqueueOptions = {}) {
    const session = get(tabId, sessionId, frameId)

    if (!session) {
      const current = get(tabId, undefined, frameId)
      return { queued: 0, sessionStatus: current ? "stale" : "missing" }
    }

    const placeAtBack = enqueueOptions?.placement === "back"
    const queuedItems = []
    const prioritizedItems = []
    const prioritizedIds = new Set()
    const pendingItemsById = new Map(session.pendingItems.map((item) => [item.id, item]))

    for (const item of items || []) {
      if (
        !item ||
        typeof item.id !== "string" ||
        (item.dedupeCompleted === true && session.translatedIds.has(item.id))
      ) {
        continue
      }

      if (session.pendingIds.has(item.id)) {
        const activeItem = session.activeItems.get(item.id)
        // Subtitle fallback owns its own prefix matching and coalescing.
        const ordinarySnapshot = item.kind !== "subtitle" && typeof item.text === "string"
        if (activeItem && ordinarySnapshot) {
          if (
            item.text === activeItem.text &&
            JSON.stringify(item.protectedFragments || []) ===
              JSON.stringify(activeItem.protectedFragments || [])
          )
            session.latestPendingItems.delete(item.id)
          else {
            session.latestPendingItems.set(item.id, item)
            session.translatedIds.delete(item.id)
          }
        }
        const pendingItem = pendingItemsById.get(item.id)
        if (pendingItem) {
          if (ordinarySnapshot) pendingItemsById.set(item.id, item)
          if (!placeAtBack && !prioritizedIds.has(item.id)) {
            prioritizedIds.add(item.id)
            prioritizedItems.push(item.id)
          }
        }
        continue
      }

      session.pendingIds.add(item.id)
      pendingItemsById.set(item.id, item)
      queuedItems.push(item)
      if (!placeAtBack) {
        prioritizedIds.add(item.id)
        prioritizedItems.push(item.id)
      }
    }

    session.pendingItems = session.pendingItems.map((item) => pendingItemsById.get(item.id))
    if (placeAtBack && queuedItems.length > 0) {
      session.pendingItems.push(...queuedItems.map((item) => pendingItemsById.get(item.id)))
    } else if (prioritizedItems.length > 0) {
      session.pendingItems = prioritizedItems
        .map((id) => pendingItemsById.get(id))
        .concat(session.pendingItems.filter((item) => !prioritizedIds.has(item.id)))
    }

    if (queuedItems.length > 0 || prioritizedItems.length > 0) {
      continueProcessing(tabId, session.sessionId, session.frameId)
    }

    return { queued: queuedItems.length, sessionStatus: "active" }
  }

  return {
    create,
    enqueue,
    get,
    getTranslatedCount,
    markTranslated,
    remove,
  }
}

export { createPageTranslationQueue, shouldKeepPageTranslationSession }
