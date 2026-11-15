import { getSourceIdentity } from "../../shared/source-identity.js"

export function createSourceAnalyzer(options = {}) {
  const {
    document,
    window,
    Node,
    activeSiteProfile: ACTIVE_SITE_PROFILE,
    sourceAttr: SOURCE_ATTR,
    rootAttr: ROOT_ATTR,
    processedAttr: PROCESSED_ATTR,
    staleAttr: STALE_ATTR,
    protectedPlaceholderRegex: PROTECTED_PLACEHOLDER_REGEX,
    mathSelector: MATH_SELECTOR,
    skipAncestorSelector: SKIP_ANCESTOR_SELECTOR,
    inlineCodeSelector: INLINE_CODE_SELECTOR,
    contentRules,
    terminalLikeSelector: TERMINAL_LIKE_SELECTOR,
    ExtractionApi,
    SubtitleApi,
    isInsideTranslation,
    getExistingNoteForSource,
    debugSkip,
    normalizeInlineWhitespace,
    normalizeSegmentText,
  } = options
  const EXPLICIT_TEXT_BLOCK_SELECTOR =
    contentRules?.selectors?.EXPLICIT_TEXT_BLOCK_SELECTOR || ":not(*)"
  const READABLE_BLOCK_SELECTOR = contentRules?.selectors?.READABLE_BLOCK_SELECTOR || ":not(*)"
  let sourceIdCounter = null
  let sourceTextSnapshots = new WeakMap()
  function shouldTranslateText(text) {
    const normalized = normalizeSegmentText(text).replace(PROTECTED_PLACEHOLDER_REGEX, " ")
    const meaningfulChars = normalized.replace(/[\s\p{P}\p{S}]/gu, "")
    const minimumLength = SubtitleApi.getMeaningfulCharacterMinimum(ACTIVE_SITE_PROFILE)

    return meaningfulChars.length >= minimumLength
  }

  function getHighestSourceIdCounter() {
    let highest = 0

    for (const element of document.querySelectorAll(`[${SOURCE_ATTR}]`)) {
      const match = /^ot-(\d+)$/.exec(element.getAttribute(SOURCE_ATTR) || "")

      if (match) {
        highest = Math.max(highest, Number(match[1]) || 0)
      }
    }

    return highest
  }

  function initializeSourceIdCounter() {
    if (sourceIdCounter !== null) {
      return
    }

    sourceIdCounter = getHighestSourceIdCounter()
  }

  function allocateSourceId() {
    initializeSourceIdCounter()
    sourceIdCounter += 1

    return `ot-${sourceIdCounter}`
  }

  function resetSourceIdCounterForTest() {
    sourceIdCounter = null
  }

  function rememberSourceText(element, text, protectedFragments) {
    if (element) {
      sourceTextSnapshots.set(
        element,
        getSourceIdentity(
          String(text || ""),
          protectedFragments ?? getSegmentContent(element).protectedFragments,
        ),
      )
    }
  }

  function hasSourceTextChanged(element) {
    if (!element) {
      return false
    }

    const previousText = sourceTextSnapshots.get(element)

    if (typeof previousText !== "string") {
      return true
    }

    const content = getSegmentContent(element)
    return getSourceIdentity(content.text, content.protectedFragments) !== previousText
  }

  function resetSourceTextSnapshotsForTest() {
    sourceTextSnapshots = new WeakMap()
  }

  function createProtectedPlaceholder(context, fragment) {
    if (!context || !fragment) {
      return ""
    }

    context.counter += 1

    const placeholder = `__OT_MATH_${context.counter}__`

    context.tokens.push({
      placeholder,
      preservePlaceholder: true,
      ...fragment,
    })

    return placeholder
  }

  function isEditableSource(element) {
    if (document.designMode?.toLowerCase() === "on") return true
    for (let current = element; current; current = current.parentElement) {
      const value = current.getAttribute?.("contenteditable")
      if (
        current.isContentEditable ||
        (value !== null &&
          value !== undefined &&
          ["", "true", "plaintext-only"].includes(value.toLowerCase()))
      )
        return true
    }
    return false
  }

  function isExcludedSource(element, context) {
    if (isEditableSource(element)) return true
    if (
      element.matches?.(
        'script, style, noscript, textarea, input, select, option, button, [role="button"]',
      )
    )
      return true
    for (let current = element; current; current = current.parentElement) {
      // Only the owned, ready note can authorize its hidden native caption.
      if (current === context.sourceRoot && context.readableCaption) continue
      if (current.hasAttribute?.("hidden") || current.getAttribute?.("aria-hidden") === "true")
        return true
      const style = window.getComputedStyle(current)
      if (
        style.display === "none" ||
        style.contentVisibility === "hidden" ||
        style.opacity === "0" ||
        (current === element && ["hidden", "collapse"].includes(style.visibility))
      )
        return true
    }
    return false
  }

  function extractMathFragment(element, context) {
    const text = normalizeSegmentText(serializeNode(element, context, true))
    if (text) return { kind: "math", text, value: text }
    for (const attributeName of ["data-tex", "data-latex", "alttext", "aria-label"]) {
      const value = normalizeSegmentText(element.getAttribute(attributeName) || "")
      if (value) return { kind: "math", text: value, value }
    }
    return null
  }

  function isVisible(element) {
    if (!element?.isConnected) {
      return false
    }

    let target = element
    if (
      SubtitleApi.isSubtitleProfile(ACTIVE_SITE_PROFILE) &&
      element.matches?.(SubtitleApi.YOUTUBE_CAPTION_SEGMENT_SELECTOR) &&
      element.getAttribute?.(SubtitleApi.SUBTITLE_REPLACED_ATTR) === "true" &&
      element.getAttribute?.(STALE_ATTR) === "true"
    ) {
      const id = element.getAttribute(SOURCE_ATTR)
      const note = id && getExistingNoteForSource?.(element, id)
      // Translation-only mode hides the native segment. Its visible note
      // remains the anchor while a progressive caption needs a refresh.
      if (note?.isConnected && note.getAttribute("data-phase") === "ready") {
        target = note
      }
    }
    const style = window.getComputedStyle(target)

    if (style.visibility === "hidden" || style.display === "none") {
      return false
    }

    const rect = target.getBoundingClientRect()

    return rect.width > 0 && rect.height > 0
  }

  function getSegmentKind(element) {
    if (SubtitleApi.isSubtitleProfile(ACTIVE_SITE_PROFILE)) {
      return SubtitleApi.getSegmentKind(ACTIVE_SITE_PROFILE, "paragraph")
    }

    if (!element) {
      return "paragraph"
    }

    const tag = element.tagName

    if (isHeadingLikeElement(element)) {
      return "heading"
    }

    if (tag === "LI") {
      return "list_item"
    }

    if (tag === "TD" || tag === "TH") {
      return "table_cell"
    }

    if (tag === "BLOCKQUOTE") {
      return "quote"
    }

    return "paragraph"
  }

  const isHeadingLikeElement = ExtractionApi.isHeadingLikeElement

  function serializeNode(node, context, plain = false) {
    if (!node) {
      return ""
    }

    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent || ""
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return ""
    }

    const element = node

    if (isExcludedSource(element, context)) return ""

    if (!plain && element.matches(MATH_SELECTOR)) {
      const mathFragment = extractMathFragment(element, context)

      return createProtectedPlaceholder(context, mathFragment)
    }

    if (
      !plain &&
      element.closest(SKIP_ANCESTOR_SELECTOR) &&
      !element.matches(INLINE_CODE_SELECTOR)
    ) {
      return ""
    }

    if (element.matches("br")) {
      return "\n"
    }

    if (
      !plain &&
      (element.matches(INLINE_CODE_SELECTOR) ||
        (element.matches("pre") && !element.matches(EXPLICIT_TEXT_BLOCK_SELECTOR)))
    ) {
      return `\`${normalizeInlineWhitespace(serializeNode(element, context, true))}\``
    }

    return Array.from(element.childNodes)
      .map((child) => serializeNode(child, context, plain))
      .join("")
  }

  function getSegmentContent(element) {
    const caption =
      SubtitleApi?.isSubtitleProfile(ACTIVE_SITE_PROFILE) &&
      element.matches?.(SubtitleApi.YOUTUBE_CAPTION_SEGMENT_SELECTOR) &&
      element.getAttribute?.(SubtitleApi.SUBTITLE_REPLACED_ATTR) === "true"
    const note = caption && getExistingNoteForSource?.(element, element.getAttribute(SOURCE_ATTR))
    const context = {
      counter: 0,
      tokens: [],
      sourceRoot: element,
      readableCaption: Boolean(
        note?.isConnected && note.getAttribute("data-phase") === "ready" && isVisible(note),
      ),
    }

    return {
      text: normalizeSegmentText(serializeNode(element, context)),
      protectedFragments: context.tokens,
    }
  }

  const hasNestedReadableBlocks = ExtractionApi.hasNestedReadableBlocks
  const isUnsupportedElement = ExtractionApi.isUnsupportedElement
  const isReadableTitleLink = ExtractionApi.isReadableTitleLink
  const isLikelyUiMetaBlock = ExtractionApi.isLikelyUiMetaBlock
  const scoreCandidateBlock = ExtractionApi.scoreCandidateBlock
  const getCandidateElements = ExtractionApi.getCandidateElements
  const hasSelectedRelative = ExtractionApi.hasSelectedRelative

  function isTranslatorOwned(element) {
    return Boolean(element?.closest?.(`[${ROOT_ATTR}]`))
  }

  function classifySegment(element, content) {
    const text = content?.text || ""
    const protectedFragments = content?.protectedFragments || []
    const isMetadata = Boolean(
      element?.matches?.("time, .meta, .metadata, .byline, .timestamp, [itemprop*='date' i]") ||
        element?.closest?.("time, .meta, .metadata, .byline, .timestamp, [itemprop*='date' i]"),
    )
    const isUI = Boolean(isLikelyUiMetaBlock(element, text))
    const containsMath = protectedFragments.some(
      (fragment) =>
        fragment?.kind === "math" || String(fragment?.placeholder || "").startsWith("__OT_MATH_"),
    )

    return {
      isUI,
      isMetadata,
      containsMath,
    }
  }

  function classifyCandidateElement(element) {
    if (!element) {
      return { ok: false, reason: "missing element" }
    }

    if (isInsideTranslation(element) || isTranslatorOwned(element)) {
      debugSkip("inside translation", element)
      return { ok: false, reason: "inside translation" }
    }

    if (
      element.getAttribute(PROCESSED_ATTR) === "true" &&
      element.getAttribute(STALE_ATTR) !== "true"
    ) {
      debugSkip("already translated", element)
      return { ok: false, reason: "already translated" }
    }

    if (isEditableSource(element)) return { ok: false, reason: "editable content" }

    if (isUnsupportedElement(element)) {
      debugSkip("unsupported element", element)
      return { ok: false, reason: "unsupported element" }
    }

    if (!isVisible(element)) {
      return { ok: false, reason: "not visible" }
    }

    if (element.closest(SKIP_ANCESTOR_SELECTOR)) {
      return { ok: false, reason: "skipped ancestor" }
    }

    if (element.closest(TERMINAL_LIKE_SELECTOR)) {
      return { ok: false, reason: "terminal-like block" }
    }

    if (!element.matches(READABLE_BLOCK_SELECTOR)) {
      return { ok: false, reason: "non-readable block" }
    }

    if (hasNestedReadableBlocks(element)) {
      debugSkip("ancestor block", element)
      return { ok: false, reason: "ancestor block" }
    }

    const content = getSegmentContent(element)
    const classification = classifySegment(element, content)

    if (!shouldTranslateText(content.text)) {
      return {
        ok: false,
        reason: "insufficient content",
        content,
        classification,
      }
    }

    if (classification.isMetadata) {
      debugSkip("metadata block", element)
      return {
        ok: false,
        reason: "metadata block",
        content,
        classification,
      }
    }

    if (classification.isUI) {
      debugSkip("ui/meta block", element)
      return {
        ok: false,
        reason: "ui/meta block",
        content,
        classification,
      }
    }

    const minimumScore = isHeadingLikeElement(element) || isReadableTitleLink(element) ? 20 : 40

    if (
      scoreCandidateBlock(element, content.text, {
        explicitTextBlockSelector: EXPLICIT_TEXT_BLOCK_SELECTOR,
      }) < minimumScore
    ) {
      debugSkip("ui/meta block", element)
      return {
        ok: false,
        reason: "ui/meta block",
        content,
        classification,
      }
    }

    return {
      ok: true,
      content,
      classification,
    }
  }

  return {
    allocateSourceId,
    classifyCandidateElement,
    classifySegment,
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
  }
}
