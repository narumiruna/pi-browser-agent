const DEFAULT_SLOT_LIMIT = 16
const DEFAULT_SUPERSEDED_LIMIT = 64

function normalizeLimit(value) {
  const number = Math.floor(Number(value))

  return Number.isFinite(number) && number > 0 ? number : DEFAULT_SUPERSEDED_LIMIT
}

function createCaptionFallbackStore(options = {}) {
  const slotLimit = normalizeLimit(options.slotLimit || DEFAULT_SLOT_LIMIT)
  const supersededLimit = normalizeLimit(options.supersededLimit)
  const slots = new Map()
  const slotByActiveId = new Map()
  const supersededIds = new Map()
  const failures = new Map()
  let coalescedFallbackCount = 0
  let supersededResultCount = 0

  function rememberSupersededId(id, invalidated) {
    if (!id) {
      return
    }

    supersededIds.delete(id)
    supersededIds.set(id, Boolean(invalidated))
    while (supersededIds.size > supersededLimit) {
      supersededIds.delete(supersededIds.keys().next().value)
    }
  }

  function supersedeSlot(slotId, invalidated = false) {
    const state = slots.get(slotId)

    if (!state) {
      return false
    }

    slots.delete(slotId)
    slotByActiveId.delete(state.activeId)
    rememberSupersededId(state.activeId, invalidated)
    return true
  }

  function offer(slotId, item) {
    if (!slotId || !item || typeof item.id !== "string") {
      return { accepted: false, coalesced: false }
    }

    const current = slots.get(slotId)
    const failed = failures.get(slotId)
    if (failed?.text !== String(item.text || "")) failures.delete(slotId)
    if (failed?.text === String(item.text || "") && failed.count >= 2) {
      return { accepted: false, coalesced: false }
    }

    if (!current) {
      if (slotByActiveId.has(item.id) || slots.size >= slotLimit) {
        return { accepted: false, coalesced: false }
      }

      slots.set(slotId, {
        activeId: item.id,
        activeText: String(item.text || ""),
        latest: null,
      })
      slotByActiveId.set(item.id, slotId)
      return { accepted: true, coalesced: false }
    }

    const itemText = String(item.text || "")

    if (
      (current.activeId === item.id && current.activeText === itemText) ||
      (current.latest?.id === item.id && current.latest?.text === itemText)
    ) {
      return { accepted: false, coalesced: false }
    }

    coalescedFallbackCount += 1
    current.latest = { id: item.id, text: itemText }
    return { accepted: false, coalesced: true }
  }

  function retain(activeSlotIds) {
    const active = activeSlotIds instanceof Set ? activeSlotIds : new Set()

    for (const slotId of slots.keys()) {
      if (!active.has(slotId)) {
        supersedeSlot(slotId)
      }
    }
    for (const slotId of failures.keys()) {
      if (!active.has(slotId)) failures.delete(slotId)
    }
  }

  function invalidate() {
    for (const id of supersededIds.keys()) supersededIds.set(id, true)
    for (const slotId of slots.keys()) supersedeSlot(slotId, true)
    failures.clear()
  }

  function fail(id, options = {}) {
    const slotId = slotByActiveId.get(id)
    const state = slots.get(slotId)
    if (!state) return { tracked: false, shouldRetry: false }
    const previous = failures.get(slotId)
    const count = previous?.text === state.activeText ? previous.count + 1 : 1
    failures.set(slotId, {
      text: state.activeText,
      count: options.retryable ? count : 2,
    })
    const latestChanged = state.latest && state.latest.text !== state.activeText
    settle(id)
    return {
      tracked: true,
      shouldRetry: Boolean(options.retryable && (latestChanged || count < 2)),
      retryExhausted: !options.retryable || (!latestChanged && count >= 2),
    }
  }

  function getLatest(id) {
    const slotId = slotByActiveId.get(id)
    const latest = slotId ? slots.get(slotId)?.latest : null

    return latest ? { ...latest } : null
  }

  function settle(id) {
    const invalidated = supersededIds.get(id)
    if (supersededIds.delete(id)) {
      supersededResultCount += 1
      return {
        shouldRetry: false,
        superseded: true,
        tracked: true,
        ...(invalidated ? { invalidated: true } : {}),
      }
    }

    const slotId = slotByActiveId.get(id)
    const state = slotId ? slots.get(slotId) : null

    if (!state || state.activeId !== id) {
      return { shouldRetry: false, superseded: false, tracked: false }
    }

    slots.delete(slotId)
    slotByActiveId.delete(id)
    const shouldRetry = Boolean(state.latest)

    if (shouldRetry) {
      supersededResultCount += 1
    }

    return {
      shouldRetry,
      superseded: shouldRetry,
      tracked: true,
    }
  }

  function clear() {
    slots.clear()
    slotByActiveId.clear()
    supersededIds.clear()
    failures.clear()
    coalescedFallbackCount = 0
    supersededResultCount = 0
  }

  function getSummary() {
    let latestPendingCount = 0

    for (const state of slots.values()) {
      if (state.latest) {
        latestPendingCount += 1
      }
    }

    return {
      activeSlotCount: slots.size,
      coalescedFallbackCount,
      latestPendingCount,
      supersededResultCount,
    }
  }

  return {
    clear,
    fail,
    getLatest,
    getSummary,
    invalidate,
    offer,
    retain,
    settle,
  }
}

export { createCaptionFallbackStore }
