const DEFAULT_PREFETCH_VIEWPORTS = 2
const DEFAULT_TOP_MARGIN = 96

function normalizeNumberOption(value, fallback) {
  const numeric = Number(value)

  return Number.isFinite(numeric) ? numeric : fallback
}

function normalizeViewportOptions(options) {
  const viewportHeight = Math.max(0, normalizeNumberOption(options?.viewportHeight, 0))
  const prefetchViewports = Math.max(
    0,
    normalizeNumberOption(options?.prefetchViewports, DEFAULT_PREFETCH_VIEWPORTS),
  )
  const topPrefetchViewports = Math.max(
    0,
    normalizeNumberOption(options?.topPrefetchViewports, prefetchViewports),
  )
  const topMargin = Math.max(0, normalizeNumberOption(options?.topMargin, DEFAULT_TOP_MARGIN))

  return {
    viewportHeight,
    prefetchViewports,
    topPrefetchViewports,
    topMargin,
  }
}

function isRectWithinTranslationWindow(rect, options) {
  if (!rect) {
    return false
  }

  const normalized = normalizeViewportOptions(options)
  const minBottom =
    -normalized.topMargin - normalized.viewportHeight * normalized.topPrefetchViewports
  const maxTop = normalized.viewportHeight * (1 + normalized.prefetchViewports)

  return Number(rect.bottom) >= minBottom && Number(rect.top) <= maxTop
}

function sortByViewportPosition(items) {
  return [...(items || [])].sort((left, right) => {
    if (left.rect.top !== right.rect.top) {
      return left.rect.top - right.rect.top
    }

    return left.rect.bottom - right.rect.bottom
  })
}

function getTranslationWindowPriority(rect, options) {
  if (!rect) {
    return Number.POSITIVE_INFINITY
  }

  const normalized = normalizeViewportOptions(options)
  const viewportHeight = normalized.viewportHeight
  const top = Number(rect.top) || 0
  const bottom = Number(rect.bottom) || 0

  if (viewportHeight <= 0) {
    return Math.max(0, top)
  }

  if (bottom < 0) {
    return viewportHeight + Math.abs(bottom)
  }

  if (top < viewportHeight) {
    return Math.max(0, top)
  }

  return viewportHeight + Math.max(0, top - viewportHeight)
}

function sortByTranslationWindowPriority(items, options) {
  return [...(items || [])].sort((left, right) => {
    const leftPriority = getTranslationWindowPriority(left.rect, options)
    const rightPriority = getTranslationWindowPriority(right.rect, options)

    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority
    }

    return sortByViewportPosition([left, right])[0] === left ? -1 : 1
  })
}

function selectWindowCandidates(items, options) {
  const filtered = (items || []).filter((item) => isRectWithinTranslationWindow(item.rect, options))

  return sortByTranslationWindowPriority(filtered, options)
}

export {
  DEFAULT_PREFETCH_VIEWPORTS,
  DEFAULT_TOP_MARGIN,
  getTranslationWindowPriority,
  isRectWithinTranslationWindow,
  normalizeViewportOptions,
  selectWindowCandidates,
  sortByTranslationWindowPriority,
  sortByViewportPosition,
}
