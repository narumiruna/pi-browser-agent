import * as Settings from "../../shared/settings.js"
import { ui } from "../../shared/ui.js"

const SUBTITLE_PRESENTATION = "subtitle"
const SUBTITLE_PRESENTATION_ATTR = "data-ot-presentation"
const SUBTITLE_DISPLAY_MODE_ATTR = "data-ot-subtitle-display-mode"
const SUBTITLE_FONT_SIZE_PROPERTY = "--ot-subtitle-font-size"
const SUBTITLE_REPLACED_ATTR = "data-ot-subtitle-replaced"
const SUBTITLE_SOURCE_TEXT_ATTR = "data-ot-subtitle-source-text"
const YOUTUBE_CAPTION_SEGMENT_SELECTOR = ".ytp-caption-segment"
const TIMED_CAPTION_TOLERANCE_MS = 500

const PLAYER_CONTROL_STATES = Object.freeze({
  active: Object.freeze({
    pressed: "true",
    state: "active",
    title: "Subtitle translation is active",
  }),
  error: Object.freeze({
    pressed: "false",
    state: "error",
    title: "Could not start translation. Click to try again",
  }),
  idle: Object.freeze({
    pressed: "false",
    state: "idle",
    title: "Translate subtitles",
  }),
  loading: Object.freeze({
    pressed: "false",
    state: "loading",
    title: "Starting translation…",
  }),
})

function resolvePlayerControlState(state) {
  return {
    ...(PLAYER_CONTROL_STATES[state] || PLAYER_CONTROL_STATES.idle),
    title: ui((PLAYER_CONTROL_STATES[state] || PLAYER_CONTROL_STATES.idle).title),
  }
}

function resolvePlayerControlError(response) {
  const rawError = String(response?.error || "").trim()
  const openOptions = Boolean(response?.openOptions)
  let title = ui("Could not start translation. Click to try again")

  if (openOptions) {
    title = ui("Configure translation, then click to try again")
  } else if (rawError) {
    title = `${rawError.replace(/\s*Click to try again\.?$/iu, "").replace(/[.!?]+$/u, "")} — ${ui("Click to try again")}`
  }

  return {
    openOptions,
    state: "error",
    title,
  }
}

function isSubtitleProfile(profile) {
  return profile?.presentation === SUBTITLE_PRESENTATION
}

function cacheSubtitleTranslations(cache, translations) {
  if (!cache?.set) {
    return 0
  }

  let cached = 0

  for (const item of translations || []) {
    if (
      item?.kind !== "subtitle" ||
      item.cachePath === "timed-prefix" ||
      !String(item.sourceText || "").trim() ||
      !String(item.translation || "").trim()
    ) {
      continue
    }

    cache.set(item.sourceText, item)
    cached += 1
  }

  return cached
}

function getTimedCaptionMetadata(item) {
  const cueId = String(item?.cueId || item?.id || "")
  const cueStartMs = Number(item?.cueStartMs)
  const durationMs = Number(item?.durationMs)

  if (
    !cueId ||
    !Number.isFinite(cueStartMs) ||
    cueStartMs < 0 ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0
  ) {
    return null
  }

  return {
    cueId,
    cueStartMs,
    durationMs,
  }
}

function isProgressiveCaptionPrefix(fullText, visibleText) {
  if (!fullText.startsWith(visibleText) || fullText === visibleText) {
    return false
  }

  const lastVisible = visibleText.at(-1) || ""
  const nextFull = fullText.slice(visibleText.length, visibleText.length + 1)

  return !(/[A-Za-z0-9]/u.test(lastVisible) && /[A-Za-z0-9]/u.test(nextFull))
}

function findUniqueTimedCaptionTranslation(translations, visibleText, currentTimeMs, options = {}) {
  const normalizedVisible = normalizeSubtitleSourceText(visibleText)
  const currentTime = Number(currentTimeMs)
  const toleranceMs = Math.max(
    0,
    Number.isFinite(Number(options.toleranceMs))
      ? Number(options.toleranceMs)
      : TIMED_CAPTION_TOLERANCE_MS,
  )

  if (!normalizedVisible || !Number.isFinite(currentTime) || currentTime < 0) {
    return null
  }

  const candidates = []

  for (const item of translations || []) {
    const metadata = getTimedCaptionMetadata(item)
    const sourceText = normalizeSubtitleSourceText(item?.sourceText)

    if (
      !metadata ||
      !String(item?.translation || "").trim() ||
      !isProgressiveCaptionPrefix(sourceText, normalizedVisible) ||
      currentTime < metadata.cueStartMs - toleranceMs ||
      currentTime > metadata.cueStartMs + metadata.durationMs + toleranceMs
    ) {
      continue
    }

    candidates.push({ item, metadata })
  }

  return candidates.length === 1 ? candidates[0] : null
}

function buildCachedSubtitle(item, cachedItem, cachePath, metadata) {
  return {
    id: item.id,
    cachePath,
    ...(metadata || {}),
    kind: "subtitle",
    sourceText: item.text,
    translation: cachedItem.translation,
  }
}

function findCachedSubtitleTranslation(cache, item, options = {}) {
  const exact = item?.text ? cache?.get?.(item.text) : null

  if (exact?.translation) {
    return buildCachedSubtitle(item, exact, "exact", getTimedCaptionMetadata(exact))
  }

  const timed = findUniqueTimedCaptionTranslation(
    cache?.values?.() || [],
    item?.text,
    options.currentTimeMs,
    options,
  )

  return timed ? buildCachedSubtitle(item, timed.item, "timed-prefix", timed.metadata) : null
}

function consumeCachedSubtitleTranslations(cache, items, options = {}) {
  const cached = []
  const missing = []

  for (const item of items || []) {
    const cachedItem = findCachedSubtitleTranslation(cache, item, options)

    if (cachedItem) {
      cached.push(cachedItem)
    } else {
      missing.push(item)
    }
  }

  return { cached, missing }
}

function hasCachedSubtitleTranslation(cache, sourceTexts, options = {}) {
  return (sourceTexts || []).some((sourceText, index) =>
    Boolean(
      findCachedSubtitleTranslation(cache, { id: `visible-${index}`, text: sourceText }, options),
    ),
  )
}

function findSubtitleSourceMatch(
  profile,
  sources,
  translation,
  getSourceText,
  excludedSources = new Set(),
  options = {},
) {
  if (!isSubtitleProfile(profile) || !translation?.sourceText) {
    return null
  }

  const availableSources = (sources || []).filter(
    (source) => source && !excludedSources.has(source),
  )
  const exact = availableSources.find(
    (source) => getSourceText?.(source) === translation.sourceText,
  )

  if (exact) {
    return { cachePath: "exact", source: exact }
  }

  const timedMatches = availableSources.filter((source) =>
    Boolean(
      findUniqueTimedCaptionTranslation(
        [translation],
        getSourceText?.(source),
        options.currentTimeMs,
        options,
      ),
    ),
  )

  return timedMatches.length === 1 ? { cachePath: "timed-prefix", source: timedMatches[0] } : null
}

function resolveProgressiveSubtitleRefresh(
  profile,
  sources,
  translation,
  retryItem,
  getSourceText,
  sourceAttribute,
) {
  if (
    !isSubtitleProfile(profile) ||
    !translation?.sourceText ||
    !String(translation?.translation || "").trim() ||
    !retryItem?.id ||
    !retryItem?.text ||
    !sourceAttribute
  ) {
    return null
  }

  const retryText = normalizeSubtitleSourceText(retryItem.text)
  const translatedText = normalizeSubtitleSourceText(translation.sourceText)
  if (retryText !== translatedText && !isProgressiveSubtitleChange(translatedText, retryText)) {
    return null
  }
  // Extraction is debounced, but YouTube can replace the node or extend its
  // text again before the active response arrives. Match the live, unique
  // continuation rather than requiring the last extracted identity/snapshot.
  const matches = (sources || []).filter((source) => {
    const currentSourceText = normalizeSubtitleSourceText(getSourceText?.(source))

    return (
      (currentSourceText === retryText ||
        isProgressiveSubtitleChange(retryText, currentSourceText)) &&
      isProgressiveSubtitleChange(translatedText, currentSourceText)
    )
  })

  if (matches.length !== 1) return null
  const source = matches[0]
  const id = source.getAttribute?.(sourceAttribute) || retryItem.id
  // Slot indices can shift while a request is pending. Never give an
  // unclaimed replacement an identity still owned by another live segment.
  if (
    (sources || []).some(
      (candidate) => candidate !== source && candidate?.getAttribute?.(sourceAttribute) === id,
    )
  )
    return null
  return {
    source,
    translation: { ...translation, id, provisional: true },
  }
}

function aliasClaimedSubtitleTranslation(profile, source, translation, sourceAttribute) {
  if (!isSubtitleProfile(profile) || !source || !translation || !sourceAttribute) {
    return null
  }

  const sourceId = source.getAttribute?.(sourceAttribute)

  return sourceId ? { ...translation, id: sourceId } : null
}

function getMeaningfulCharacterMinimum(profile) {
  return isSubtitleProfile(profile) ? 1 : 2
}

function getSegmentKind(profile, fallback) {
  return isSubtitleProfile(profile) ? "subtitle" : fallback
}

function shouldAllowAncestorTransforms(profile) {
  return isSubtitleProfile(profile)
}

function shouldKeepSessionAlive(profile) {
  return Boolean(profile?.dynamic)
}

function normalizeSubtitleSourceText(value) {
  return String(value || "")
    .replace(/\s+/gu, " ")
    .trim()
}

function isProgressiveSubtitleChange(previousText, currentText) {
  const previous = normalizeSubtitleSourceText(previousText)
  const current = normalizeSubtitleSourceText(currentText)

  return Boolean(previous && isProgressiveCaptionPrefix(current, previous))
}

function markProgressiveSubtitleSource(element, options = {}) {
  element.setAttribute?.(options.staleAttribute, "true")
  element.setAttribute?.(options.translatedAttribute, "stale")
  element.removeAttribute?.(options.processedAttribute)
  element.setAttribute?.(options.queuedAttribute, "false")
}

function bindSubtitleNote(profile, note, options = {}) {
  if (!isSubtitleProfile(profile) || !note) {
    return false
  }

  note.setAttribute(SUBTITLE_SOURCE_TEXT_ATTR, normalizeSubtitleSourceText(options.sourceText))
  note.setAttribute(
    SUBTITLE_DISPLAY_MODE_ATTR,
    Settings.normalizeYoutubeSubtitleDisplayMode(options.displayMode),
  )

  return true
}

function replaceSubtitleSource(profile, source, replaced) {
  if (!isSubtitleProfile(profile) || !source) {
    return false
  }

  if (replaced) {
    source.setAttribute?.(SUBTITLE_REPLACED_ATTR, "true")
  } else {
    source.removeAttribute?.(SUBTITLE_REPLACED_ATTR)
  }

  return true
}

function applySubtitleDisplayMode(profile, source, displayMode) {
  if (!isSubtitleProfile(profile) || !source) {
    return false
  }

  return replaceSubtitleSource(
    profile,
    source,
    Settings.normalizeYoutubeSubtitleDisplayMode(displayMode) === "translation-only",
  )
}

function clearSubtitleSourceState(profile, element, options = {}) {
  replaceSubtitleSource(profile, element, false)

  for (const attribute of [
    options.sourceAttribute,
    options.staleAttribute,
    options.translatedAttribute,
    options.processedAttribute,
  ]) {
    if (attribute) {
      element.removeAttribute?.(attribute)
    }
  }

  if (options.queuedAttribute) {
    element.setAttribute?.(options.queuedAttribute, "false")
  }
}

function resetChangedSubtitleSource(profile, options = {}) {
  if (!isSubtitleProfile(profile) || !options.element) {
    return false
  }

  const sourceSnapshot = normalizeSubtitleSourceText(
    options.note?.getAttribute?.(SUBTITLE_SOURCE_TEXT_ATTR),
  )
  const currentSourceText = normalizeSubtitleSourceText(options.getSourceText?.(options.element))

  if (
    options.element.getAttribute?.(options.sourceAttribute) &&
    isProgressiveSubtitleChange(sourceSnapshot, currentSourceText)
  ) {
    markProgressiveSubtitleSource(options.element, options)
    return true
  }

  options.note?.remove?.()
  clearSubtitleSourceState(profile, options.element, options)

  return true
}

function getSubtitleSources(node, sourceAttribute) {
  if (!node || !sourceAttribute) {
    return []
  }

  const selector = `[${sourceAttribute}]`
  const sources = []

  if (node.matches?.(selector)) {
    sources.push(node)
  }

  for (const source of node.querySelectorAll?.(selector) || []) {
    sources.push(source)
  }

  return sources
}

function rebindDetachedSubtitleSources(profile, node, replacementSources, options = {}) {
  if (!isSubtitleProfile(profile)) {
    return 0
  }

  const usedSources = new Set()
  let rebound = 0

  for (const source of getSubtitleSources(node, options.sourceAttribute)) {
    const id = source.getAttribute?.(options.sourceAttribute)
    const note = id ? options.findNote?.(source, id) : null
    const sourceSnapshot = normalizeSubtitleSourceText(
      note?.getAttribute?.(SUBTITLE_SOURCE_TEXT_ATTR),
    )
    const availableReplacements = (replacementSources || []).filter(
      (candidate) =>
        candidate &&
        !usedSources.has(candidate) &&
        !candidate.getAttribute?.(options.sourceAttribute),
    )
    let replacement = availableReplacements.find(
      (candidate) =>
        sourceSnapshot &&
        normalizeSubtitleSourceText(options.getSourceText?.(candidate)) === sourceSnapshot,
    )
    let progressive = false

    if (!replacement && sourceSnapshot) {
      const progressiveReplacements = availableReplacements.filter((candidate) =>
        isProgressiveSubtitleChange(sourceSnapshot, options.getSourceText?.(candidate)),
      )

      if (progressiveReplacements.length === 1) {
        replacement = progressiveReplacements[0]
        progressive = true
      }
    }

    if (!note || !replacement) {
      continue
    }

    clearSubtitleSourceState(profile, source, options)
    replacement.setAttribute?.(options.sourceAttribute, id)
    if (progressive) {
      markProgressiveSubtitleSource(replacement, options)
    } else {
      replacement.removeAttribute?.(options.staleAttribute)
      replacement.setAttribute?.(options.translatedAttribute, "true")
      replacement.setAttribute?.(options.processedAttribute, "true")
      replacement.setAttribute?.(options.queuedAttribute, "false")
    }
    const replacementSourceText = normalizeSubtitleSourceText(options.getSourceText?.(replacement))
    options.rememberSourceText?.(replacement, progressive ? replacementSourceText : sourceSnapshot)
    applySubtitleDisplayMode(profile, replacement, note.getAttribute?.(SUBTITLE_DISPLAY_MODE_ATTR))
    options.insertNote?.(replacement, note)
    usedSources.add(replacement)
    rebound += 1
  }

  return rebound
}

function removeDetachedSubtitleSources(profile, node, options = {}) {
  if (!isSubtitleProfile(profile)) {
    return 0
  }

  let removed = 0

  for (const source of getSubtitleSources(node, options.sourceAttribute)) {
    const id = source.getAttribute?.(options.sourceAttribute)
    const note = id ? options.findNote?.(source, id) : null

    clearSubtitleSourceState(profile, source, options)

    if (!note) {
      continue
    }

    note.remove?.()
    removed += 1
  }

  return removed
}

function reconcileSubtitleNotes(profile, options = {}) {
  if (!isSubtitleProfile(profile)) {
    return 0
  }

  let removed = 0

  for (const note of options.notes || []) {
    const id = note.getAttribute?.(options.noteAttribute)
    const source = id ? options.findSource?.(id) : null
    const sourceSnapshot = normalizeSubtitleSourceText(
      note.getAttribute?.(SUBTITLE_SOURCE_TEXT_ATTR),
    )
    const currentSourceText = normalizeSubtitleSourceText(
      source ? options.getSourceText?.(source) : "",
    )

    const progressiveRefresh = Boolean(
      source?.getAttribute?.(options.staleAttribute) === "true" &&
        isProgressiveSubtitleChange(sourceSnapshot, currentSourceText),
    )

    if (source && sourceSnapshot && (sourceSnapshot === currentSourceText || progressiveRefresh)) {
      applySubtitleDisplayMode(profile, source, note.getAttribute?.(SUBTITLE_DISPLAY_MODE_ATTR))
      continue
    }

    if (source) {
      clearSubtitleSourceState(profile, source, options)
    }
    note.remove?.()
    removed += 1
  }

  return removed
}

function normalizeCaptionFontSize(value) {
  const match = /^(\d+(?:\.\d+)?)px$/u.exec(String(value || "").trim())

  if (!match) {
    return ""
  }

  const size = Number(match[1])

  return size >= 8 && size <= 96 ? `${size}px` : ""
}

function prepareSubtitleNote(profile, note, source, getComputedStyle) {
  if (!isSubtitleProfile(profile) || !note) {
    return false
  }

  note.setAttribute(SUBTITLE_PRESENTATION_ATTR, SUBTITLE_PRESENTATION)

  const captionSegment = source?.matches?.(YOUTUBE_CAPTION_SEGMENT_SELECTOR)
    ? source
    : source?.querySelector?.(YOUTUBE_CAPTION_SEGMENT_SELECTOR) || source
  const fontSize = normalizeCaptionFontSize(getComputedStyle?.(captionSegment)?.fontSize)

  if (fontSize) {
    note.style?.setProperty?.(SUBTITLE_FONT_SIZE_PROPERTY, fontSize)
  }

  return true
}

export {
  aliasClaimedSubtitleTranslation,
  applySubtitleDisplayMode,
  bindSubtitleNote,
  cacheSubtitleTranslations,
  consumeCachedSubtitleTranslations,
  findCachedSubtitleTranslation,
  findSubtitleSourceMatch,
  findUniqueTimedCaptionTranslation,
  getMeaningfulCharacterMinimum,
  getSegmentKind,
  hasCachedSubtitleTranslation,
  isSubtitleProfile,
  normalizeCaptionFontSize,
  prepareSubtitleNote,
  rebindDetachedSubtitleSources,
  reconcileSubtitleNotes,
  removeDetachedSubtitleSources,
  replaceSubtitleSource,
  resetChangedSubtitleSource,
  resolvePlayerControlError,
  resolvePlayerControlState,
  resolveProgressiveSubtitleRefresh,
  SUBTITLE_DISPLAY_MODE_ATTR,
  SUBTITLE_FONT_SIZE_PROPERTY,
  SUBTITLE_PRESENTATION,
  SUBTITLE_PRESENTATION_ATTR,
  SUBTITLE_REPLACED_ATTR,
  SUBTITLE_SOURCE_TEXT_ATTR,
  shouldAllowAncestorTransforms,
  shouldKeepSessionAlive,
  YOUTUBE_CAPTION_SEGMENT_SELECTOR,
}
