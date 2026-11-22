import { getSourceIdentity } from "../../shared/source-identity.js"
import { ui } from "../../shared/ui.js"

export function createContentRenderer(options = {}) {
  const {
    document,
    window,
    chrome,
    pageState,
    activeSiteProfile: ACTIVE_SITE_PROFILE,
    siteProfileId: SITE_PROFILE_ID,
    allowAncestorTransforms: ALLOW_ANCESTOR_TRANSFORMS,
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
  } = options
  function isLayoutItem(element) {
    const parent = element?.parentElement

    if (!parent) {
      return false
    }

    const parentDisplay = window.getComputedStyle(parent).display

    return ["grid", "inline-grid", "flex", "inline-flex"].includes(parentDisplay)
  }

  function getNoteElementTagName(sourceElement, insertionTarget = sourceElement) {
    if (isLayoutItem(insertionTarget) && shouldAppendNoteInsideTarget(insertionTarget)) {
      return "span"
    }

    if (isHeadingLikeElement(sourceElement) || isReadableTitleLink(sourceElement)) {
      return "p"
    }

    const tagName = sourceElement?.tagName ? sourceElement.tagName.toLowerCase() : "p"

    if (tagName === "td" || tagName === "th") {
      return "div"
    }

    return tagName === "a" || tagName === "span" ? "p" : tagName
  }

  function canAppendNoteInsideTarget(element) {
    const style = window.getComputedStyle(element)
    // Typed OM keeps auto distinct from the pixel height returned by CSSOM.
    const height = element.computedStyleMap?.().get("height") ?? style.height
    const parentStyle = element.parentElement && window.getComputedStyle(element.parentElement)
    const column = ["column", "column-reverse"].includes(parentStyle?.flexDirection)
    const verticalWriting = /^(vertical|sideways)-/.test(parentStyle?.writingMode || "")
    const fixedFlexHeight =
      ["flex", "inline-flex"].includes(parentStyle?.display) &&
      column !== verticalWriting &&
      !["auto", "content"].includes(style.flexBasis || "auto")
    return (
      (!height || String(height) === "auto") &&
      !fixedFlexHeight &&
      !["flex", "inline-flex", "grid", "inline-grid"].includes(style.display) &&
      [style.overflowX, style.overflowY].every((overflow) => !overflow || overflow === "visible") &&
      (!style.maxHeight || style.maxHeight === "none") &&
      !/(?:paint|size|strict|content)/.test(style.contain || "")
    )
  }

  function shouldAppendNoteInsideTarget(element) {
    const tagName = element?.tagName ? element.tagName.toLowerCase() : ""
    return (
      (tagName === "td" || tagName === "th" || isLayoutItem(element)) &&
      canAppendNoteInsideTarget(element)
    )
  }

  function canInsertSiblingNote(element) {
    if (["TD", "TH"].includes(element?.tagName?.toUpperCase())) return false
    const parent = element?.parentElement
    if (!parent) return true
    const style = window.getComputedStyle(parent)
    if (style.display === "grid" || style.display === "inline-grid") return false
    return (
      !["flex", "inline-flex"].includes(style.display) ||
      (["column", "column-reverse"].includes(style.flexDirection) &&
        (!style.flexWrap || style.flexWrap === "nowrap"))
    )
  }

  function normalizeNoteElement(sourceElement, insertionTarget, note) {
    const tagName = SubtitleApi.isSubtitleProfile(ACTIVE_SITE_PROFILE)
      ? "div"
      : getNoteElementTagName(sourceElement, insertionTarget)
    if (!note.tagName || note.tagName.toLowerCase() === tagName) return note
    const replacement = document.createElement(tagName)
    for (const attribute of note.attributes) {
      replacement.setAttribute(attribute.name, attribute.value)
    }
    replacement.append(...note.childNodes)
    note.replaceWith(replacement)
    return replacement
  }

  function measureNoteColumn(note, target) {
    const siblingParent = target.parentElement
    if (!siblingParent || note.parentElement !== siblingParent) return null
    const style = window.getComputedStyle(target)
    let parent = siblingParent
    let parentStyle = window.getComputedStyle(parent)
    const direction = parentStyle.direction
    // A display: contents wrapper is in the DOM but has no box to measure.
    while (parentStyle.display === "contents" && parent.parentElement) {
      parent = parent.parentElement
      parentStyle = window.getComputedStyle(parent)
    }
    if (
      parent !== siblingParent &&
      (!["block", "flow-root", "list-item", "table-cell"].includes(parentStyle.display) ||
        parentStyle.direction !== direction ||
        note.currentCSSZoom !== parent.currentCSSZoom)
    )
      return null
    if (
      style.writingMode !== "horizontal-tb" ||
      parentStyle.writingMode !== "horizontal-tb" ||
      style.display.startsWith("inline") ||
      style.float !== "none" ||
      ["absolute", "fixed", "sticky"].includes(style.position) ||
      parentStyle.columnCount !== "auto" ||
      parentStyle.columnWidth !== "auto" ||
      !parent.offsetWidth
    )
      return null

    const parentBox = parent.getBoundingClientRect()
    const targetBox = target.getBoundingClientRect()
    const scale = parentBox.width / parent.offsetWidth
    if (!scale || !targetBox.width) return null
    const leftPadding = Number.parseFloat(parentStyle.paddingLeft)
    const rightPadding = Number.parseFloat(parentStyle.paddingRight)
    const available = parent.clientWidth - leftPadding - rightPadding
    const parentLeft = parent.clientLeft + leftPadding - parent.scrollLeft
    const targetScale = (target.currentCSSZoom ?? 1) / (parent.currentCSSZoom ?? 1)
    const leftInset =
      Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.borderLeftWidth)
    const rightInset =
      Number.parseFloat(style.paddingRight) + Number.parseFloat(style.borderRightWidth)
    const left = (targetBox.left - parentBox.left) / scale - parentLeft + leftInset * targetScale
    const right = (targetBox.right - parentBox.left) / scale - parentLeft - rightInset * targetScale
    const rtl = parentStyle.direction === "rtl"
    const start = Math.max(0, rtl ? available - right : left)
    const size = Math.min(available, rtl ? available - left : right) - start
    return size > 0 ? { start, size } : null
  }

  const columnUpdates = new Map()

  function scheduleNoteColumn(note, target) {
    if (!window.requestAnimationFrame || SubtitleApi.isSubtitleProfile(ACTIVE_SITE_PROFILE)) return
    const alreadyScheduled = columnUpdates.size > 0
    columnUpdates.set(note, target)
    if (alreadyScheduled) return
    window.requestAnimationFrame(() => {
      // Read all source boxes before changing any note styles.
      const columns = Array.from(columnUpdates, ([note, target]) => [
        note,
        target && note.isConnected ? measureNoteColumn(note, target) : null,
      ])
      columnUpdates.clear()
      for (const [note, column] of columns) {
        note.toggleAttribute("data-ot-note-aligned", Boolean(column))
        if (column) {
          note.style.setProperty("--ot-note-inline-start", `${column.start}px`)
          note.style.setProperty("--ot-note-inline-size", `${column.size}px`)
        } else {
          note.style.removeProperty("--ot-note-inline-start")
          note.style.removeProperty("--ot-note-inline-size")
        }
      }
    })
  }

  function insertNoteForTarget(insertionTarget, note, sourceElement = insertionTarget) {
    const appendInside = shouldAppendNoteInsideTarget(insertionTarget)
    if (!appendInside && !canInsertSiblingNote(insertionTarget)) {
      note.style?.setProperty("display", "none", "important")
      return note
    }
    note = normalizeNoteElement(sourceElement, insertionTarget, note)
    if (appendInside) {
      note.style?.removeProperty("display")
      note.style?.removeProperty("order")
      if (note.parentElement !== insertionTarget || insertionTarget.lastChild !== note) {
        insertionTarget.appendChild(note)
      }
      if (note.hasAttribute?.("data-ot-note-aligned") || columnUpdates.has(note))
        scheduleNoteColumn(note, null)
      return note
    }
    note.style?.removeProperty("display")
    const parentStyle =
      insertionTarget.parentElement && window.getComputedStyle(insertionTarget.parentElement)
    const isFlexParent = ["flex", "inline-flex"].includes(parentStyle?.display)
    if (isFlexParent) {
      note.style?.setProperty("order", window.getComputedStyle(insertionTarget).order || "0")
    } else {
      note.style?.removeProperty("order")
    }
    const reversed = isFlexParent && parentStyle.flexDirection === "column-reverse"
    const adjacent = reversed
      ? insertionTarget.previousElementSibling
      : insertionTarget.nextElementSibling
    if (adjacent !== note) {
      insertionTarget.insertAdjacentElement(reversed ? "beforebegin" : "afterend", note)
    }
    scheduleNoteColumn(note, insertionTarget)
    return note
  }

  function reconcileNotePlacements() {
    withObserverPaused(() => {
      const notes = new Map(
        Array.from(document.querySelectorAll(`[${ROOT_ATTR}="note"]`), (note) => [
          note.getAttribute(NOTE_ATTR),
          note,
        ]),
      )
      for (const source of document.querySelectorAll(`[${SOURCE_ATTR}]`)) {
        const note = notes.get(source.getAttribute(SOURCE_ATTR))
        if (!note) continue
        const target = getNoteInsertionTarget(source)
        if (target) insertNoteForTarget(target, note, source)
        else note.style.setProperty("display", "none", "important")
      }
    })
  }
  window.addEventListener?.("resize", reconcileNotePlacements)

  function buildNote(sourceElement, id, insertionTarget = sourceElement) {
    const tagName = SubtitleApi.isSubtitleProfile(ACTIVE_SITE_PROFILE)
      ? "div"
      : getNoteElementTagName(sourceElement, insertionTarget)
    const note = document.createElement(tagName)
    const label = document.createElement("span")
    const body = document.createElement("span")

    note.classList.add("translation")
    note.setAttribute(ROOT_ATTR, "note")
    note.setAttribute(NOTE_ATTR, id)
    label.setAttribute(ROOT_ATTR, "note-label")
    body.setAttribute(ROOT_ATTR, "note-body")
    body.setAttribute("data-state", "ready")
    note.appendChild(label)
    note.appendChild(body)
    SubtitleApi.prepareSubtitleNote(ACTIVE_SITE_PROFILE, note, sourceElement, (element) =>
      window.getComputedStyle(element),
    )

    return note
  }

  function getDebugPanel() {
    let panel = document.querySelector(`[${ROOT_ATTR}="debug-panel"]`)

    if (panel) {
      return panel
    }

    panel = document.createElement("aside")
    panel.classList.add("translation")
    panel.setAttribute(ROOT_ATTR, "debug-panel")
    panel.setAttribute("aria-live", "polite")
    panel.setAttribute("aria-label", ui("Translation debug info"))

    withObserverPaused(() => {
      if (document.body) {
        document.body.appendChild(panel)
      }
    })

    return panel
  }

  function clearDebugPanel() {
    const panel = document.querySelector(`[${ROOT_ATTR}="debug-panel"]`)

    if (!panel) {
      return
    }

    withObserverPaused(() => {
      panel.remove()
    })
  }

  function getDebugProfileLabel(debugInfo) {
    const profileId = debugInfo?.profileId || SITE_PROFILE_ID || "default"

    return `Profile: ${profileId}`
  }

  function renderExtractionDebugPanel(debugInfo) {
    if (!isDebugInfoEnabled() || !debugInfo) {
      clearDebugPanel()
      return
    }

    const panel = getDebugPanel()
    const title = document.createElement("strong")
    const profileLabel = document.createElement("span")
    const selectedTitle = document.createElement("span")
    const selectedList = document.createElement("ul")
    const skippedTitle = document.createElement("span")
    const skippedList = document.createElement("ul")
    const sampleTitle = document.createElement("span")
    const sampleList = document.createElement("ul")

    title.setAttribute(ROOT_ATTR, "debug-title")
    title.textContent = ui("Translation debug info")
    profileLabel.setAttribute(ROOT_ATTR, "debug-profile")
    profileLabel.textContent = getDebugProfileLabel(debugInfo)
    selectedTitle.setAttribute(ROOT_ATTR, "debug-section-title")
    selectedTitle.textContent = ui("Queued items ({count})", {
      count: debugInfo.selectedItems.length,
    })
    selectedList.setAttribute(ROOT_ATTR, "debug-list")

    for (const item of debugInfo.selectedItems) {
      const entry = document.createElement("li")

      entry.textContent = `${item.id} · ${item.kind} · ~${item.tokenCount} tokens${item.containsMath ? " · math" : ""}`
      selectedList.appendChild(entry)
    }

    skippedTitle.setAttribute(ROOT_ATTR, "debug-section-title")
    skippedTitle.textContent = ui("Skipped reasons")
    skippedList.setAttribute(ROOT_ATTR, "debug-list")

    for (const item of debugInfo.skippedByReason || []) {
      const entry = document.createElement("li")

      entry.textContent = `${item.reason}: ${item.count}`
      skippedList.appendChild(entry)
    }

    sampleTitle.setAttribute(ROOT_ATTR, "debug-section-title")
    sampleTitle.textContent = ui("Skipped node samples")
    sampleList.setAttribute(ROOT_ATTR, "debug-list")

    for (const item of debugInfo.skippedSamples || []) {
      const entry = document.createElement("li")

      entry.textContent = `${item.reason} · ${item.node}`
      sampleList.appendChild(entry)
    }

    withObserverPaused(() => {
      panel.replaceChildren()
      panel.appendChild(title)
      panel.appendChild(profileLabel)

      if (selectedList.childNodes.length > 0) {
        panel.appendChild(selectedTitle)
        panel.appendChild(selectedList)
      }

      if (skippedList.childNodes.length > 0) {
        panel.appendChild(skippedTitle)
        panel.appendChild(skippedList)
      }

      if (sampleList.childNodes.length > 0) {
        panel.appendChild(sampleTitle)
        panel.appendChild(sampleList)
      }
    })
  }

  function getNoteInsertionTarget(element, selectors = {}) {
    const readableBlockSelector = selectors.READABLE_BLOCK_SELECTOR || READABLE_BLOCK_SELECTOR
    const directNoteTargetSelector =
      selectors.DIRECT_NOTE_TARGET_SELECTOR || DIRECT_NOTE_TARGET_SELECTOR
    const allowAncestorTransforms =
      typeof selectors.allowAncestorTransforms === "boolean"
        ? selectors.allowAncestorTransforms
        : ALLOW_ANCESTOR_TRANSFORMS
    let current = element

    while (current && current !== document.body) {
      const isDirectNoteTarget = current.matches?.(directNoteTargetSelector)

      if (
        current.matches?.(readableBlockSelector) &&
        (!current.matches("article, main, section, div, body") || isDirectNoteTarget) &&
        !hasUnsafeLayoutContext(current, {
          allowAncestorTransforms:
            isDirectNoteTarget &&
            (allowAncestorTransforms ||
              SubtitleApi.shouldAllowAncestorTransforms(ACTIVE_SITE_PROFILE)),
        })
      ) {
        return shouldAppendNoteInsideTarget(current) || canInsertSiblingNote(current)
          ? current
          : null
      }

      current = current.parentElement
    }

    return null
  }

  function _isSafeNoteInsertionTarget(element, selectors) {
    return Boolean(getNoteInsertionTarget(element, selectors))
  }

  function startPageTranslationSession(payload) {
    ensureStyles(payload?.translationAppearance)
    ensureObserver()
    const sameSession =
      payload.sessionId &&
      payload.sessionId === pageState.pageTranslation.sessionId &&
      payload.targetLanguage === pageState.pageTranslation.targetLanguage
    clearPendingTranslations()
    if (!sameSession)
      withObserverPaused(() => {
        for (const note of document.querySelectorAll(`[${ROOT_ATTR}="note"]`)) note.remove()
        for (const source of document.querySelectorAll(`[${SOURCE_ATTR}]`)) {
          setSourceTranslated(source, false)
          setSourceQueued(source, false)
          source.removeAttribute(PROCESSED_ATTR)
          source.removeAttribute(STALE_ATTR)
          if (SubtitleApi.SUBTITLE_REPLACED_ATTR)
            source.removeAttribute(SubtitleApi.SUBTITLE_REPLACED_ATTR)
        }
      })
    pageState.debug.enabled = Boolean(payload?.debug?.enabled)
    if (!pageState.debug.enabled) {
      clearDebugPanel()
    }
    activatePageTranslationSession(payload.sessionId)
    pageState.pageTranslation.targetLanguage = payload.targetLanguage || ""
    pageState.pageTranslation.youtubeSubtitleDisplayMode =
      payload.youtubeSubtitleDisplayMode || "translation-only"
    pageState.youtubeSubtitleTranslations?.clear?.()
    if (pageState.youtubeControl.button) {
      applyYoutubeControlState(pageState.youtubeControl.button, "active")
    }

    const extraction = collectPageItems({ windowed: true })

    renderExtractionDebugPanel(extraction.debug)
    if (SubtitleApi.isSubtitleProfile(ACTIVE_SITE_PROFILE)) {
      if (matchYoutubeCaptionItems) {
        extraction.items = matchYoutubeCaptionItems(extraction.items || []).missing
        extraction.pendingSegments = extraction.items.length
      }
      recordYoutubeDiagnostic(
        "initial-extraction",
        `Found ${extraction.totalSegments} caption source(s); ${extraction.items?.length || 0} pending item(s)`,
      )
    }

    return extraction
  }

  function setNoteLabel(label, targetLanguage) {
    const language = String(targetLanguage || "").trim()

    label.textContent = ui("Translation")
    if (language) {
      label.setAttribute("title", language)
    } else {
      label.removeAttribute("title")
    }
  }

  function setNotePending(note, targetLanguage) {
    const label = note.querySelector(`[${ROOT_ATTR}="note-label"]`)
    const body = note.querySelector(`[${ROOT_ATTR}="note-body"]`)

    note.setAttribute("data-phase", "pending")
    note.setAttribute("data-lang", targetLanguage)
    setNoteLabel(label, targetLanguage)
    body.setAttribute("data-state", "pending")
    body.replaceChildren(document.createTextNode(" "))
  }

  function appendProtectedFragment(container, fragment) {
    if (!fragment) {
      return
    }

    // Protected page fragments are data, not executable HTML. The original
    // equation remains visible; its duplicate is rendered as plain text.

    container.appendChild(document.createTextNode(fragment.text || fragment.value || ""))
  }

  function appendFormattedText(container, text, protectedFragments) {
    const fragmentByPlaceholder = new Map(
      (protectedFragments || []).map((fragment) => [fragment.placeholder, fragment]),
    )
    const lines = String(text || "").split("\n")

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex]
      const parts = line.split(/(__OT_(?:TOKEN|MATH)_\d+__|`[^`\n]+`)/g).filter(Boolean)

      for (const part of parts) {
        const protectedFragment = fragmentByPlaceholder.get(part)

        if (protectedFragment) {
          appendProtectedFragment(container, protectedFragment)
        } else if (/^`[^`\n]+`$/.test(part)) {
          const code = document.createElement("code")

          code.textContent = part.slice(1, -1)
          container.appendChild(code)
        } else {
          container.appendChild(document.createTextNode(part))
        }
      }

      if (lineIndex < lines.length - 1) {
        container.appendChild(document.createElement("br"))
      }
    }
  }

  function upsertNoteForSource(
    element,
    id,
    translation,
    targetLanguage,
    protectedFragments,
    sourceText,
    youtubeSubtitleDisplayMode,
  ) {
    const insertionTarget = getNoteInsertionTarget(element)

    if (!insertionTarget) {
      return null
    }

    const existingNote = getExistingNoteForSource(element, id)
    let note = existingNote || buildNote(element, id, insertionTarget)
    const label = note.querySelector(`[${ROOT_ATTR}="note-label"]`)
    const body = note.querySelector(`[${ROOT_ATTR}="note-body"]`)

    withObserverPaused(() => {
      note.setAttribute("data-phase", "ready")
      note.setAttribute("data-lang", targetLanguage)
      setNoteLabel(label, targetLanguage)
      body.setAttribute("data-state", "ready")
      body.replaceChildren()
      appendFormattedText(body, translation, protectedFragments)
      note.removeAttribute("data-stale")
      SubtitleApi.bindSubtitleNote(ACTIVE_SITE_PROFILE, note, {
        displayMode: youtubeSubtitleDisplayMode,
        sourceText,
      })

      note = insertNoteForTarget(insertionTarget, note, element)

      SubtitleApi.applySubtitleDisplayMode(ACTIVE_SITE_PROFILE, element, youtubeSubtitleDisplayMode)
    })

    element.removeAttribute(STALE_ATTR)
    setSourceTranslated(element, true)
    setSourceQueued(element, false)

    return note
  }

  function renderPagePlaceholders(payload) {
    ensureStyles(payload?.translationAppearance)
    ensureObserver()

    const ids = new Set(payload.ids || [])
    let rendered = 0

    for (const element of document.querySelectorAll(`[${SOURCE_ATTR}]`)) {
      const id = element.getAttribute(SOURCE_ATTR)
      const insertionTarget = getNoteInsertionTarget(element)

      if (!ids.has(id) || !insertionTarget) {
        continue
      }

      let note = getExistingNoteForSource(element, id) || buildNote(element, id, insertionTarget)

      withObserverPaused(() => {
        setNotePending(note, payload.targetLanguage)

        note = insertNoteForTarget(insertionTarget, note, element)
      })
      setSourceQueued(element, true)
      rendered += 1
    }

    return { rendered }
  }

  function isIdentityTransform(transform) {
    const normalized = String(transform || "").replace(/\s+/g, "")

    return (
      !normalized ||
      normalized === "none" ||
      normalized === "matrix(1,0,0,1,0,0)" ||
      normalized === "matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)"
    )
  }

  function hasUnsafeLayoutContext(element, options = {}) {
    let current = element

    while (current && current !== document.body) {
      if (current.matches?.(TERMINAL_LIKE_SELECTOR)) {
        return true
      }

      const style = window.getComputedStyle(current)
      const unsafeTransform =
        !isIdentityTransform(style.transform) &&
        !(options.allowAncestorTransforms && current !== element)

      if (
        unsafeTransform ||
        style.filter !== "none" ||
        style.backdropFilter !== "none" ||
        style.mixBlendMode !== "normal"
      ) {
        return true
      }

      current = current.parentElement
    }

    return false
  }

  function renderPageTranslationUpdates(payload) {
    ensureStyles(payload?.translationAppearance)
    ensureObserver()
    const youtubeSubtitleDisplayMode =
      payload.youtubeSubtitleDisplayMode ||
      pageState.pageTranslation.youtubeSubtitleDisplayMode ||
      "translation-only"
    pageState.pageTranslation.youtubeSubtitleDisplayMode = youtubeSubtitleDisplayMode
    const cachedSubtitleCount = SubtitleApi.cacheSubtitleTranslations(
      pageState.youtubeSubtitleTranslations,
      payload.translations,
    )

    const translationMap = new Map((payload.translations || []).map((item) => [item.id, item]))
    const receivedCount = translationMap.size
    const renderedIds = []
    const subtitleProfile = SubtitleApi.isSubtitleProfile(ACTIVE_SITE_PROFILE)
    const fallbackSettlements = SubtitleApi.isSubtitleProfile(ACTIVE_SITE_PROFILE)
      ? settleYoutubeCaptionFallbacks?.(payload.translations) || {
          settledIds: new Set(),
          supersededIds: new Set(),
          supersededItems: new Map(),
        }
      : {
          settledIds: new Set(),
          supersededIds: new Set(),
          supersededItems: new Map(),
        }
    const fallbackTargetIds = new Set(
      [...fallbackSettlements.settledIds].filter(
        (id) => !fallbackSettlements.invalidatedIds?.has(id),
      ),
    )
    const reboundSources = new Set()
    let rendered = 0
    let rebound = 0
    let provisional = 0
    let stale = 0
    let cached = 0
    let superseded = 0
    let fallbackDiscarded = 0
    let timedPrefix = 0
    let missingTarget = 0

    if (SubtitleApi.isSubtitleProfile(ACTIVE_SITE_PROFILE)) {
      const captionRoot = document.querySelector(SITE_ROOT_SELECTOR)
      const captionSources = Array.from(
        captionRoot?.querySelectorAll(DIRECT_NOTE_TARGET_SELECTOR) || [],
      )

      const video = document.querySelector("#movie_player video")
      const currentTimeMs = Math.max(0, Number(video?.currentTime) || 0) * 1000

      for (const translationItem of payload.translations || []) {
        const boundSource = document.querySelector(`[${SOURCE_ATTR}="${translationItem.id}"]`)
        const isSuperseded = fallbackSettlements.supersededIds.has(translationItem.id)
        const isFallback = fallbackSettlements.settledIds.has(translationItem.id)
        if (
          isSuperseded ||
          (isFallback &&
            (!boundSource || getSegmentContent(boundSource).text !== translationItem.sourceText))
        ) {
          const refresh = SubtitleApi.resolveProgressiveSubtitleRefresh?.(
            ACTIVE_SITE_PROFILE,
            captionSources,
            translationItem,
            isSuperseded
              ? fallbackSettlements.supersededItems.get(translationItem.id)
              : { id: translationItem.id, text: translationItem.sourceText },
            (source) => getSegmentContent(source).text,
            SOURCE_ATTR,
          )

          if (
            refresh &&
            !reboundSources.has(refresh.source) &&
            refresh.source.getAttribute(TRANSLATED_ATTR) !== "true"
          ) {
            translationMap.delete(translationItem.id)
            refresh.source.setAttribute(SOURCE_ATTR, refresh.translation.id)
            rememberSourceText(refresh.source, getSegmentContent(refresh.source).text)
            translationMap.set(refresh.translation.id, refresh.translation)
            if (fallbackTargetIds.has(translationItem.id))
              fallbackTargetIds.add(refresh.translation.id)
            reboundSources.add(refresh.source)
            provisional += 1
            continue
          }
          if (isSuperseded || refresh) {
            translationMap.delete(translationItem.id)
            superseded += 1
            if (fallbackTargetIds.has(translationItem.id)) fallbackDiscarded += 1
            continue
          }
        }
        if (boundSource) {
          continue
        }

        const match = SubtitleApi.findSubtitleSourceMatch(
          ACTIVE_SITE_PROFILE,
          captionSources,
          translationItem,
          (source) => getSegmentContent(source).text,
          reboundSources,
          { currentTimeMs },
        )

        if (!match) {
          translationMap.delete(translationItem.id)
          if (fallbackSettlements.settledIds.has(translationItem.id)) {
            superseded += 1
            if (fallbackTargetIds.has(translationItem.id)) fallbackDiscarded += 1
          } else if (Number.isFinite(Number(translationItem.cueStartMs))) {
            cached += 1
          } else {
            missingTarget += 1
          }
          continue
        }

        const matchingSource = match.source
        const visibleSourceText = getSegmentContent(matchingSource).text

        if (match.cachePath === "timed-prefix") {
          timedPrefix += 1
        }
        const reboundTranslation =
          match.cachePath === "timed-prefix"
            ? {
                ...translationItem,
                cachePath: match.cachePath,
                sourceText: visibleSourceText,
              }
            : translationItem
        const claimedTranslation = SubtitleApi.aliasClaimedSubtitleTranslation(
          ACTIVE_SITE_PROFILE,
          matchingSource,
          reboundTranslation,
          SOURCE_ATTR,
        )

        if (claimedTranslation) {
          translationMap.delete(translationItem.id)
          translationMap.set(claimedTranslation.id, claimedTranslation)
          if (fallbackTargetIds.has(translationItem.id))
            fallbackTargetIds.add(claimedTranslation.id)
          reboundSources.add(matchingSource)
          continue
        }

        translationMap.set(translationItem.id, reboundTranslation)
        matchingSource.setAttribute(SOURCE_ATTR, translationItem.id)
        matchingSource.setAttribute(QUEUED_ATTR, "true")
        rememberSourceText(matchingSource, reboundTranslation.sourceText)
        reboundSources.add(matchingSource)
        rebound += 1
      }
    }

    for (const element of document.querySelectorAll(`[${SOURCE_ATTR}]`)) {
      const id = element.getAttribute(SOURCE_ATTR)
      const translationItem = translationMap.get(id)
      const translation = translationItem?.translation

      if (!translation) {
        continue
      }

      const content = getSegmentContent(element)
      if (
        !(subtitleProfile && translationItem.provisional) &&
        getSourceIdentity(translationItem.sourceText, translationItem.protectedFragments) !==
          getSourceIdentity(content.text, content.protectedFragments)
      ) {
        stale += 1
        if (fallbackTargetIds.has(translationItem.id)) fallbackDiscarded += 1
        continue
      }

      const note = upsertNoteForSource(
        element,
        id,
        translation,
        payload.targetLanguage,
        translationItem.protectedFragments,
        translationItem.sourceText || content.text,
        youtubeSubtitleDisplayMode,
      )

      if (note) {
        rendered += 1
        renderedIds.push(id)
        if (subtitleProfile && translationItem.provisional) {
          SubtitleApi.resetChangedSubtitleSource(ACTIVE_SITE_PROFILE, {
            element,
            getSourceText: (source) => getSegmentContent(source).text,
            note,
            processedAttribute: PROCESSED_ATTR,
            queuedAttribute: QUEUED_ATTR,
            sourceAttribute: SOURCE_ATTR,
            staleAttribute: STALE_ATTR,
            translatedAttribute: TRANSLATED_ATTR,
          })
        }
      } else {
        missingTarget += 1
        if (fallbackTargetIds.has(translationItem.id)) fallbackDiscarded += 1
      }
    }

    if (SubtitleApi.isSubtitleProfile(ACTIVE_SITE_PROFILE)) {
      recordYoutubeDiagnostic(
        "render",
        `Received ${receivedCount} translation(s); rendered ${rendered}; rebound ${rebound}; provisional ${provisional}; cached ${cached}; superseded ${superseded}; timed-prefix=${timedPrefix}; stale ${stale}; missing target ${missingTarget}`,
        {
          outcomes: {
            delivered: payload.sessionId ? receivedCount : 0,
            fallbackDiscarded,
            cached,
            provisional,
            rendered,
            superseded,
            timedPrefix,
          },
          show: stale > 0 || (missingTarget > 0 && cachedSubtitleCount === 0),
        },
      )
    }

    return { rendered, renderedIds }
  }

  function clearPagePlaceholders(payload) {
    const ids = new Set(payload.ids || [])
    const snapshots = new Map(
      (payload.items || []).map((item) => [
        item.id,
        getSourceIdentity(item.text, item.protectedFragments),
      ]),
    )

    if (SubtitleApi.isSubtitleProfile(ACTIVE_SITE_PROFILE)) {
      if (payload.reason) failYoutubeCaptionFallbacks?.(payload)
      else settleYoutubeCaptionFallbacks?.([...ids])
    }
    let cleared = 0

    for (const note of document.querySelectorAll(`[${ROOT_ATTR}="note"][data-phase="pending"]`)) {
      const id = note.getAttribute(NOTE_ATTR)

      if (!ids.has(id)) {
        continue
      }

      const source = document.querySelector(`[${SOURCE_ATTR}="${id}"]`)
      if (source && !SubtitleApi.isSubtitleProfile(ACTIVE_SITE_PROFILE)) {
        if (snapshots.has(id)) {
          const content = getSegmentContent(source)
          if (snapshots.get(id) !== getSourceIdentity(content.text, content.protectedFragments))
            continue
        } else if (source.getAttribute(STALE_ATTR) === "true") continue
      }

      withObserverPaused(() => {
        note.remove()
      })
      cleared += 1

      if (source) {
        setSourceTranslated(source, false)
        source.removeAttribute(STALE_ATTR)
        setSourceQueued(source, false)
      }
    }

    return { cleared }
  }

  const selectionPanelRenderer = SelectionPanelApi
    ? SelectionPanelApi.createSelectionPanelRenderer({
        document,
        window,
        rootAttr: ROOT_ATTR,
        appendFormattedText,
        ensureObserver,
        ensureStyles,
        onClose(requestId) {
          chrome.runtime
            .sendMessage(Messages.createMessage("dismiss-selection-translation", { requestId }))
            .catch(() => {})
        },
        onRetry(payload) {
          chrome.runtime.sendMessage(Messages.retrySelectionTranslation(payload)).catch(() => {})
        },
        withObserverPaused,
      })
    : null

  function renderSelectionError(payload) {
    if (!selectionPanelRenderer) {
      return { rendered: "unavailable" }
    }

    return selectionPanelRenderer.renderError(payload)
  }

  function renderSelectionTranslation(payload) {
    if (!selectionPanelRenderer) {
      return { rendered: "unavailable" }
    }

    return selectionPanelRenderer.renderTranslation(payload)
  }

  function renderSelectionPlaceholder(payload) {
    if (!selectionPanelRenderer) {
      return { rendered: "unavailable" }
    }

    return selectionPanelRenderer.renderPlaceholder(payload)
  }

  function clearPendingTranslations() {
    const notes = Array.from(
      document.querySelectorAll(`[${ROOT_ATTR}="note"][data-phase="pending"]`),
    )

    pageState.pageTranslation.active = false
    pageState.pageTranslation.sessionId = ""
    if (SubtitleApi.isSubtitleProfile(ACTIVE_SITE_PROFILE)) {
      resetYoutubeCaptionFallbacks?.()
    }
    if (pageState.youtubeControl.button) {
      applyYoutubeControlState(pageState.youtubeControl.button, "idle")
    }

    for (const note of notes) {
      withObserverPaused(() => {
        note.remove()
      })
    }

    for (const source of document.querySelectorAll(`[${SOURCE_ATTR}]`)) {
      if (source.getAttribute(TRANSLATED_ATTR) !== "true") {
        source.removeAttribute(PROCESSED_ATTR)
        setSourceQueued(source, false)
      }
    }

    return { cleared: notes.length }
  }

  function getToastLayer() {
    ensureStyles()
    let layer = document.querySelector(`[${ROOT_ATTR}="toast-layer"]`)

    if (!layer) {
      layer = document.createElement("div")
      layer.setAttribute(ROOT_ATTR, "toast-layer")
      if (document.body) {
        document.body.insertAdjacentElement("afterbegin", layer)
      } else {
        document.documentElement.appendChild(layer)
      }
    }

    return layer
  }

  function showToast(message, level, timeout) {
    const toast = document.createElement("div")
    const layer = withObserverPaused(() => {
      const layer = getToastLayer()
      toast.setAttribute(ROOT_ATTR, "toast")
      toast.setAttribute("data-level", level || "info")
      toast.textContent = message
      layer.appendChild(toast)
      return layer
    })

    window.setTimeout(
      () =>
        withObserverPaused(() => {
          toast.remove()
          if (layer.childElementCount === 0) layer.remove()
        }),
      timeout || 3200,
    )
  }

  function cleanupRendering() {
    window.removeEventListener?.("resize", reconcileNotePlacements)
    selectionPanelRenderer?.cleanup()
    for (const element of document.querySelectorAll(
      `[${ROOT_ATTR}="toast-layer"], [${ROOT_ATTR}="debug-panel"]`,
    )) {
      element.remove()
    }
  }
  return {
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
  }
}
