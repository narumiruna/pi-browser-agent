import assert from "node:assert/strict"
import { test } from "vitest"
import { resolveSiteProfile } from "../../../src/browser/translation/content/extraction/site-profiles.js"
import {
  aliasClaimedSubtitleTranslation,
  applySubtitleDisplayMode,
  bindSubtitleNote,
  cacheSubtitleTranslations,
  consumeCachedSubtitleTranslations,
  findSubtitleSourceMatch,
  getMeaningfulCharacterMinimum,
  getSegmentKind,
  hasCachedSubtitleTranslation,
  isSubtitleProfile,
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
  SUBTITLE_SOURCE_TEXT_ATTR,
  shouldAllowAncestorTransforms,
  shouldKeepSessionAlive,
} from "../../../src/browser/translation/content/youtube/subtitles.js"

const youtubeProfile = resolveSiteProfile("www.youtube.com")
const defaultProfile = resolveSiteProfile("example.com")

test("prefetched subtitle translations are consumed by exact source text", () => {
  const cache = new Map()

  cacheSubtitleTranslations(cache, [
    { kind: "subtitle", sourceText: "Hello world", translation: "哈囉世界" },
    { kind: "subtitle", sourceText: "Later", translation: "稍後" },
  ])

  assert.deepEqual(
    consumeCachedSubtitleTranslations(cache, [
      { id: "visible-1", kind: "subtitle", text: "Hello world" },
      { id: "visible-2", kind: "subtitle", text: "Unknown" },
    ]),
    {
      cached: [
        {
          id: "visible-1",
          cachePath: "exact",
          kind: "subtitle",
          sourceText: "Hello world",
          translation: "哈囉世界",
        },
      ],
      missing: [{ id: "visible-2", kind: "subtitle", text: "Unknown" }],
    },
  )
  assert.equal(cache.get("Hello world").translation, "哈囉世界")
  assert.equal(cache.get("Later").translation, "稍後")
  assert.equal(hasCachedSubtitleTranslation(cache, ["Unknown", "Hello world"]), true)
  assert.equal(hasCachedSubtitleTranslation(cache, ["Unknown"]), false)
})

test("active timed cues satisfy unique progressive visible prefixes", () => {
  const cache = new Map()

  cacheSubtitleTranslations(cache, [
    {
      id: "youtube-cue-1000-0",
      cueId: "youtube-cue-1000-0",
      cueStartMs: 1000,
      durationMs: 3000,
      kind: "subtitle",
      sourceText: "Build reliable tools",
      translation: "建立可靠工具",
    },
  ])

  const matched = consumeCachedSubtitleTranslations(
    cache,
    [{ id: "visible-1", kind: "subtitle", text: "Build reliable" }],
    { currentTimeMs: 1500 },
  )

  assert.deepEqual(matched.missing, [])
  assert.deepEqual(matched.cached, [
    {
      id: "visible-1",
      cachePath: "timed-prefix",
      cueId: "youtube-cue-1000-0",
      cueStartMs: 1000,
      durationMs: 3000,
      kind: "subtitle",
      sourceText: "Build reliable",
      translation: "建立可靠工具",
    },
  ])
})

test("timed prefix results do not poison the exact subtitle cache", () => {
  const cache = new Map()

  cacheSubtitleTranslations(cache, [
    {
      id: "youtube-cue-1000-0",
      cueId: "youtube-cue-1000-0",
      cueStartMs: 1000,
      durationMs: 3000,
      kind: "subtitle",
      sourceText: "Build reliable tools",
      translation: "建立可靠工具",
    },
  ])
  const matched = consumeCachedSubtitleTranslations(
    cache,
    [{ id: "visible-1", kind: "subtitle", text: "Build reliable" }],
    { currentTimeMs: 1500 },
  )

  assert.equal(cacheSubtitleTranslations(cache, matched.cached), 0)
  assert.equal(cache.has("Build reliable"), false)
  assert.deepEqual(
    consumeCachedSubtitleTranslations(
      cache,
      [{ id: "later-cue", kind: "subtitle", text: "Build reliable" }],
      { currentTimeMs: 6000 },
    ),
    {
      cached: [],
      missing: [{ id: "later-cue", kind: "subtitle", text: "Build reliable" }],
    },
  )
})

test("timed prefix matching rejects ambiguity, reverse relations, and inactive cues", () => {
  const cache = new Map([
    [
      "first",
      {
        cueId: "first",
        cueStartMs: 1000,
        durationMs: 3000,
        kind: "subtitle",
        sourceText: "Build reliable tools",
        translation: "第一個",
      },
    ],
    [
      "second",
      {
        cueId: "second",
        cueStartMs: 1200,
        durationMs: 2800,
        kind: "subtitle",
        sourceText: "Build reliable systems",
        translation: "第二個",
      },
    ],
  ])

  cache.set("mid-word", {
    cueId: "mid-word",
    cueStartMs: 1000,
    durationMs: 3000,
    kind: "subtitle",
    sourceText: "catalog tools",
    translation: "目錄工具",
  })

  for (const [text, currentTimeMs] of [
    ["Build reliable", 1500],
    ["reliable tools", 1500],
    ["Build", 6000],
    ["cat", 1500],
  ]) {
    assert.deepEqual(
      consumeCachedSubtitleTranslations(cache, [{ id: "visible", kind: "subtitle", text }], {
        currentTimeMs,
      }),
      {
        cached: [],
        missing: [{ id: "visible", kind: "subtitle", text }],
      },
    )
  }
})

test("subtitle cache ignores empty and unrelated translation results", () => {
  const cache = new Map()

  assert.equal(
    cacheSubtitleTranslations(cache, [
      { kind: "paragraph", sourceText: "Paragraph", translation: "段落" },
      { kind: "subtitle", sourceText: "", translation: "空" },
      { kind: "subtitle", sourceText: "Caption", translation: "" },
    ]),
    0,
  )
  assert.equal(cache.size, 0)
})

test("player control state exposes stable accessible labels", () => {
  assert.deepEqual(resolvePlayerControlState("idle"), {
    pressed: "false",
    state: "idle",
    title: "Translate subtitles",
  })
  assert.deepEqual(resolvePlayerControlState("loading"), {
    pressed: "false",
    state: "loading",
    title: "Starting translation…",
  })
  assert.deepEqual(resolvePlayerControlState("active"), {
    pressed: "true",
    state: "active",
    title: "Subtitle translation is active",
  })
  assert.deepEqual(resolvePlayerControlState("error"), {
    pressed: "false",
    state: "error",
    title: "Could not start translation. Click to try again",
  })
})

test("player control surfaces runtime failures and settings recovery", () => {
  assert.deepEqual(resolvePlayerControlError({}), {
    openOptions: false,
    state: "error",
    title: "Could not start translation. Click to try again",
  })
  assert.deepEqual(
    resolvePlayerControlError({
      error: "Settings are incomplete. Configure the extension first.",
      openOptions: true,
    }),
    {
      openOptions: true,
      state: "error",
      title: "Configure translation, then click to try again",
    },
  )
  assert.deepEqual(resolvePlayerControlError({ error: "API permission was denied." }), {
    openOptions: false,
    state: "error",
    title: "API permission was denied — Click to try again",
  })
})

test("YouTube uses the compact persistent subtitle behavior", () => {
  assert.equal(isSubtitleProfile(youtubeProfile), true)
  assert.equal(getMeaningfulCharacterMinimum(youtubeProfile), 1)
  assert.equal(getSegmentKind(youtubeProfile, "paragraph"), "subtitle")
  assert.equal(shouldAllowAncestorTransforms(youtubeProfile), true)
  assert.equal(shouldKeepSessionAlive(youtubeProfile), true)
})

test("ordinary pages preserve inline note behavior", () => {
  assert.equal(isSubtitleProfile(defaultProfile), false)
  assert.equal(getMeaningfulCharacterMinimum(defaultProfile), 2)
  assert.equal(getSegmentKind(defaultProfile, "heading"), "heading")
  assert.equal(shouldAllowAncestorTransforms(defaultProfile), false)
  assert.equal(shouldKeepSessionAlive(defaultProfile), false)
})

test("changed subtitle cues drop stale identity and rendered text", () => {
  const attributes = new Map([
    ["data-ot-source-id", "ot-3"],
    ["data-ot-source-stale", "true"],
    ["data-ot-translated", "true"],
    ["data-translated", "true"],
    ["data-ot-queued", "true"],
  ])
  let noteRemoved = false
  const element = {
    removeAttribute(name) {
      attributes.delete(name)
    },
    setAttribute(name, value) {
      attributes.set(name, value)
    },
  }
  const note = {
    remove() {
      noteRemoved = true
    },
  }

  assert.equal(
    resetChangedSubtitleSource(youtubeProfile, {
      element,
      note,
      processedAttribute: "data-translated",
      queuedAttribute: "data-ot-queued",
      sourceAttribute: "data-ot-source-id",
      staleAttribute: "data-ot-source-stale",
      translatedAttribute: "data-ot-translated",
    }),
    true,
  )
  assert.equal(noteRemoved, true)
  assert.equal(attributes.has("data-ot-source-id"), false)
  assert.equal(attributes.has("data-ot-source-stale"), false)
  assert.equal(attributes.has("data-ot-translated"), false)
  assert.equal(attributes.has("data-translated"), false)
  assert.equal(attributes.get("data-ot-queued"), "false")
})

test("progressive subtitle changes keep the current translation until refresh", () => {
  const attributes = new Map([
    ["data-ot-source-id", "ot-4"],
    ["data-ot-translated", "true"],
    ["data-translated", "true"],
    ["data-ot-queued", "true"],
    ["data-ot-subtitle-replaced", "true"],
  ])
  const noteAttributes = new Map([[SUBTITLE_SOURCE_TEXT_ATTR, "Build"]])
  let noteRemoved = false
  const element = {
    getAttribute(name) {
      return attributes.get(name) || null
    },
    removeAttribute(name) {
      attributes.delete(name)
    },
    setAttribute(name, value) {
      attributes.set(name, value)
    },
  }
  const note = {
    getAttribute(name) {
      return noteAttributes.get(name) || null
    },
    remove() {
      noteRemoved = true
    },
  }

  assert.equal(
    resetChangedSubtitleSource(youtubeProfile, {
      element,
      getSourceText: () => "Build reliable tools",
      note,
      processedAttribute: "data-translated",
      queuedAttribute: "data-ot-queued",
      sourceAttribute: "data-ot-source-id",
      staleAttribute: "data-ot-source-stale",
      translatedAttribute: "data-ot-translated",
    }),
    true,
  )
  assert.equal(noteRemoved, false)
  assert.equal(attributes.get("data-ot-source-id"), "ot-4")
  assert.equal(attributes.get("data-ot-source-stale"), "true")
  assert.equal(attributes.get("data-ot-translated"), "stale")
  assert.equal(attributes.has("data-translated"), false)
  assert.equal(attributes.get("data-ot-queued"), "false")
  assert.equal(attributes.get("data-ot-subtitle-replaced"), "true")
})

test("detached subtitle sources remove notes left behind by native cue replacement", () => {
  let noteRemoved = false
  const attributes = new Map([
    ["data-ot-source-id", "ot-9"],
    ["data-ot-source-stale", "true"],
    ["data-ot-translated", "true"],
    ["data-translated", "true"],
    ["data-ot-queued", "true"],
  ])
  const source = {
    getAttribute(name) {
      return attributes.get(name) || null
    },
    removeAttribute(name) {
      attributes.delete(name)
    },
    setAttribute(name, value) {
      attributes.set(name, value)
    },
    matches(selector) {
      return selector === "[data-ot-source-id]"
    },
    querySelectorAll() {
      return []
    },
  }

  assert.equal(
    removeDetachedSubtitleSources(youtubeProfile, source, {
      findNote(candidate, id) {
        assert.equal(candidate, source)
        assert.equal(id, "ot-9")
        return {
          remove() {
            noteRemoved = true
          },
        }
      },
      processedAttribute: "data-translated",
      queuedAttribute: "data-ot-queued",
      sourceAttribute: "data-ot-source-id",
      staleAttribute: "data-ot-source-stale",
      translatedAttribute: "data-ot-translated",
    }),
    1,
  )
  assert.equal(noteRemoved, true)
  assert.equal(attributes.has("data-ot-source-id"), false)
  assert.equal(attributes.has("data-ot-source-stale"), false)
  assert.equal(attributes.has("data-ot-translated"), false)
  assert.equal(attributes.has("data-translated"), false)
  assert.equal(attributes.get("data-ot-queued"), "false")
  assert.equal(
    removeDetachedSubtitleSources(defaultProfile, source, {
      findNote() {},
      sourceAttribute: "data-ot-source-id",
    }),
    0,
  )
})

test("rendered subtitle notes move to exact replacement sources", () => {
  const oldAttributes = new Map([
    ["data-ot-source-id", "ot-7"],
    ["data-ot-translated", "true"],
    ["data-translated", "true"],
  ])
  const replacementAttributes = new Map()
  const changedAttributes = new Map()
  const noteAttributes = new Map([
    ["data-ot-subtitle-source-text", "Stable caption"],
    ["data-ot-subtitle-display-mode", "translation-only"],
  ])
  const createSource = (attributes, text) => ({
    text,
    getAttribute(name) {
      return attributes.get(name) || null
    },
    removeAttribute(name) {
      attributes.delete(name)
    },
    setAttribute(name, value) {
      attributes.set(name, value)
    },
  })
  const oldSource = createSource(oldAttributes, "Stable caption")
  const replacementSource = createSource(replacementAttributes, "Stable caption")
  const changedSource = createSource(changedAttributes, "Changed caption")
  const note = {
    getAttribute(name) {
      return noteAttributes.get(name) || null
    },
  }
  let insertedNote = null
  let rememberedText = ""

  assert.equal(
    rebindDetachedSubtitleSources(
      youtubeProfile,
      {
        matches(selector) {
          return selector === "[data-ot-source-id]"
        },
        querySelectorAll() {
          return []
        },
        ...oldSource,
      },
      [changedSource, replacementSource],
      {
        findNote(source, id) {
          assert.equal(id, "ot-7")
          assert.equal(source.text, "Stable caption")
          return note
        },
        getSourceText: (source) => source.text,
        insertNote(source, candidateNote) {
          assert.equal(source, replacementSource)
          insertedNote = candidateNote
        },
        processedAttribute: "data-translated",
        queuedAttribute: "data-ot-queued",
        rememberSourceText(_source, text) {
          rememberedText = text
        },
        sourceAttribute: "data-ot-source-id",
        staleAttribute: "data-ot-source-stale",
        translatedAttribute: "data-ot-translated",
      },
    ),
    1,
  )
  assert.equal(oldAttributes.has("data-ot-source-id"), false)
  assert.equal(replacementAttributes.get("data-ot-source-id"), "ot-7")
  assert.equal(replacementAttributes.get("data-ot-translated"), "true")
  assert.equal(replacementAttributes.get("data-translated"), "true")
  assert.equal(replacementAttributes.get("data-ot-queued"), "false")
  assert.equal(replacementAttributes.get("data-ot-subtitle-replaced"), "true")
  assert.equal(changedAttributes.size, 0)
  assert.equal(insertedNote, note)
  assert.equal(rememberedText, "Stable caption")
})

test("rendered subtitle notes survive progressive source replacement", () => {
  const oldAttributes = new Map([
    ["data-ot-source-id", "ot-8"],
    ["data-ot-translated", "true"],
    ["data-translated", "true"],
  ])
  const replacementAttributes = new Map()
  const noteAttributes = new Map([
    [SUBTITLE_SOURCE_TEXT_ATTR, "Build"],
    [SUBTITLE_DISPLAY_MODE_ATTR, "translation-only"],
  ])
  const createSource = (attributes, text) => ({
    text,
    getAttribute(name) {
      return attributes.get(name) || null
    },
    removeAttribute(name) {
      attributes.delete(name)
    },
    setAttribute(name, value) {
      attributes.set(name, value)
    },
  })
  const oldSource = createSource(oldAttributes, "Build")
  const replacementSource = createSource(replacementAttributes, "Build reliable tools")
  const note = {
    getAttribute(name) {
      return noteAttributes.get(name) || null
    },
  }
  let insertedNote = null
  let rememberedText = ""

  assert.equal(
    rebindDetachedSubtitleSources(
      youtubeProfile,
      {
        matches(selector) {
          return selector === "[data-ot-source-id]"
        },
        querySelectorAll() {
          return []
        },
        ...oldSource,
      },
      [replacementSource],
      {
        findNote: () => note,
        getSourceText: (source) => source.text,
        insertNote(_source, candidateNote) {
          insertedNote = candidateNote
        },
        processedAttribute: "data-translated",
        queuedAttribute: "data-ot-queued",
        rememberSourceText(_source, text) {
          rememberedText = text
        },
        sourceAttribute: "data-ot-source-id",
        staleAttribute: "data-ot-source-stale",
        translatedAttribute: "data-ot-translated",
      },
    ),
    1,
  )
  assert.equal(oldAttributes.has("data-ot-source-id"), false)
  assert.equal(replacementAttributes.get("data-ot-source-id"), "ot-8")
  assert.equal(replacementAttributes.get("data-ot-source-stale"), "true")
  assert.equal(replacementAttributes.get("data-ot-translated"), "stale")
  assert.equal(replacementAttributes.has("data-translated"), false)
  assert.equal(replacementAttributes.get("data-ot-queued"), "false")
  assert.equal(replacementAttributes.get("data-ot-subtitle-replaced"), "true")
  assert.equal(insertedNote, note)
  assert.equal(rememberedText, "Build reliable tools")
})

test("superseded progressive fallbacks can render provisionally", () => {
  const source = {
    text: "Build reliable tools",
    getAttribute(name) {
      return name === "data-ot-source-id" ? "ot-4" : null
    },
  }
  const translation = {
    id: "ot-4",
    kind: "subtitle",
    sourceText: "Build",
    translation: "建立",
  }

  assert.deepEqual(
    resolveProgressiveSubtitleRefresh(
      youtubeProfile,
      [source],
      translation,
      { id: "ot-4", text: "Build reliable tools" },
      (candidate) => candidate.text,
      "data-ot-source-id",
    ),
    {
      source,
      translation: { ...translation, provisional: true },
    },
  )
  assert.equal(
    resolveProgressiveSubtitleRefresh(
      youtubeProfile,
      [{ ...source, text: "Unrelated cue" }],
      translation,
      { id: "ot-4", text: "Unrelated cue" },
      (candidate) => candidate.text,
      "data-ot-source-id",
    ),
    null,
  )
  assert.equal(
    resolveProgressiveSubtitleRefresh(
      defaultProfile,
      [source],
      translation,
      { id: "ot-4", text: "Build reliable tools" },
      (candidate) => candidate.text,
      "data-ot-source-id",
    ),
    null,
  )
})

test("progressive fallback uses the live unique caption when extraction lags behind mutations", () => {
  const translation = {
    id: "ot-first",
    kind: "subtitle",
    sourceText: "Build",
    translation: "建立",
  }
  const retry = { id: "ot-pending", text: "Build reliable" }
  const source = {
    text: "Build reliable tools while captions keep growing",
    getAttribute: (name) => (name === "data-ot-source-id" ? "ot-live" : null),
  }
  const resolve = (sources, pending = retry) =>
    resolveProgressiveSubtitleRefresh(
      youtubeProfile,
      sources,
      translation,
      pending,
      (candidate) => candidate.text,
      "data-ot-source-id",
    )

  assert.deepEqual(resolve([source]), {
    source,
    translation: { ...translation, id: "ot-live", provisional: true },
  })
  // A replacement can arrive before extraction assigns an identity.
  const unclaimed = { ...source, getAttribute: () => null }
  assert.deepEqual(resolve([unclaimed]), {
    source: unclaimed,
    translation: { ...translation, id: retry.id, provisional: true },
  })
  assert.equal(resolve([source, { ...source }]), null)
  const unrelatedOwner = {
    text: "Unrelated next cue",
    getAttribute: (name) => (name === "data-ot-source-id" ? retry.id : null),
  }
  assert.equal(resolve([unclaimed, unrelatedOwner]), null)
  assert.equal(resolve([unrelatedOwner, unclaimed]), null)
  assert.equal(resolve([{ ...source, text: "Unrelated next cue" }]), null)
  assert.equal(resolve([{ ...source, text: "Builder is a different word" }]), null)
  assert.equal(resolve([source], null), null)
})

test("prefetched results adopt a matching visible fallback identity", () => {
  const source = {
    getAttribute(name) {
      return name === "data-ot-source-id" ? "ot-visible" : null
    },
  }
  const translation = {
    id: "youtube-cue-1000-0",
    kind: "subtitle",
    sourceText: "Current cue",
    translation: "目前字幕",
  }

  assert.deepEqual(
    aliasClaimedSubtitleTranslation(youtubeProfile, source, translation, "data-ot-source-id"),
    { ...translation, id: "ot-visible" },
  )
  assert.equal(translation.id, "youtube-cue-1000-0")
  assert.equal(
    aliasClaimedSubtitleTranslation(defaultProfile, source, translation, "data-ot-source-id"),
    null,
  )
})

test("timed detached results bind only to one active progressive source", () => {
  const first = { text: "Build reliable" }
  const second = { text: "Other cue" }
  const translation = {
    cueId: "youtube-cue-1000-0",
    cueStartMs: 1000,
    durationMs: 3000,
    sourceText: "Build reliable tools",
    translation: "建立可靠工具",
  }

  assert.deepEqual(
    findSubtitleSourceMatch(
      youtubeProfile,
      [first, second],
      translation,
      (source) => source.text,
      new Set(),
      { currentTimeMs: 1500 },
    ),
    { cachePath: "timed-prefix", source: first },
  )
  assert.equal(
    findSubtitleSourceMatch(
      youtubeProfile,
      [first, { text: "Build" }],
      translation,
      (source) => source.text,
      new Set(),
      { currentTimeMs: 1500 },
    ),
    null,
  )
  assert.equal(
    findSubtitleSourceMatch(
      youtubeProfile,
      [first],
      translation,
      (source) => source.text,
      new Set(),
      { currentTimeMs: 6000 },
    ),
    null,
  )
})

test("detached subtitle results rebind only to an identical visible source", () => {
  const oldSource = { text: "Old cue" }
  const matchingSource = { text: "Current cue" }
  const otherSource = { text: "Other cue" }

  assert.deepEqual(
    findSubtitleSourceMatch(
      youtubeProfile,
      [oldSource, matchingSource, otherSource],
      { sourceText: "Current cue" },
      (source) => source.text,
      new Set([oldSource]),
    ),
    { cachePath: "exact", source: matchingSource },
  )
  assert.equal(
    findSubtitleSourceMatch(
      youtubeProfile,
      [oldSource, otherSource],
      { sourceText: "Current cue" },
      (source) => source.text,
    ),
    null,
  )
  assert.equal(
    findSubtitleSourceMatch(
      defaultProfile,
      [matchingSource],
      { sourceText: "Current cue" },
      (source) => source.text,
    ),
    null,
  )
})

test("subtitle display modes change only the bound native segment", () => {
  const firstAttributes = new Map()
  const secondAttributes = new Map()
  const noteAttributes = new Map()
  const createSource = (attributes) => ({
    removeAttribute(name) {
      attributes.delete(name)
    },
    setAttribute(name, value) {
      attributes.set(name, value)
    },
  })
  const firstSource = createSource(firstAttributes)
  const secondSource = createSource(secondAttributes)
  const note = {
    setAttribute(name, value) {
      noteAttributes.set(name, value)
    },
  }

  assert.equal(
    bindSubtitleNote(youtubeProfile, note, {
      displayMode: "bilingual",
      sourceText: "  Hello   world  ",
    }),
    true,
  )
  assert.equal(noteAttributes.get(SUBTITLE_SOURCE_TEXT_ATTR), "Hello world")
  assert.equal(noteAttributes.get(SUBTITLE_DISPLAY_MODE_ATTR), "bilingual")
  assert.equal(applySubtitleDisplayMode(youtubeProfile, firstSource, "bilingual"), true)
  assert.equal(firstAttributes.has("data-ot-subtitle-replaced"), false)

  bindSubtitleNote(youtubeProfile, note, {
    displayMode: "translation-only",
    sourceText: "Hello world",
  })
  assert.equal(applySubtitleDisplayMode(youtubeProfile, firstSource, "translation-only"), true)
  assert.equal(firstAttributes.get("data-ot-subtitle-replaced"), "true")
  assert.equal(secondAttributes.has("data-ot-subtitle-replaced"), false)
  assert.equal(applySubtitleDisplayMode(defaultProfile, secondSource, "translation-only"), false)
})

test("subtitle reconciliation removes notes whose exact source changed or disappeared", () => {
  const matchingSource = {
    attributes: new Map([["data-ot-source-id", "ot-1"]]),
    text: "First cue",
    removeAttribute(name) {
      this.attributes.delete(name)
    },
    setAttribute(name, value) {
      this.attributes.set(name, value)
    },
  }
  const changedSource = {
    attributes: new Map([["data-ot-source-id", "ot-2"]]),
    text: "New second cue",
    removeAttribute(name) {
      this.attributes.delete(name)
    },
    setAttribute(name, value) {
      this.attributes.set(name, value)
    },
  }
  const sources = new Map([
    ["ot-1", matchingSource],
    ["ot-2", changedSource],
  ])
  function createNote(id, sourceText, displayMode) {
    const attributes = new Map([
      ["data-ot-note-id", id],
      [SUBTITLE_SOURCE_TEXT_ATTR, sourceText],
      [SUBTITLE_DISPLAY_MODE_ATTR, displayMode],
    ])

    return {
      attributes,
      removed: false,
      getAttribute(name) {
        return attributes.get(name) || null
      },
      remove() {
        this.removed = true
      },
    }
  }
  const matchingNote = createNote("ot-1", "First cue", "bilingual")
  const changedNote = createNote("ot-2", "Previous second cue", "translation-only")
  const progressiveSource = {
    attributes: new Map([
      ["data-ot-source-id", "ot-4"],
      ["data-ot-source-stale", "true"],
    ]),
    text: "Build reliable tools",
    getAttribute(name) {
      return this.attributes.get(name) || null
    },
    removeAttribute(name) {
      this.attributes.delete(name)
    },
    setAttribute(name, value) {
      this.attributes.set(name, value)
    },
  }
  sources.set("ot-4", progressiveSource)
  const detachedNote = createNote("ot-3", "Detached cue", "translation-only")
  const progressiveNote = createNote("ot-4", "Build", "translation-only")

  assert.equal(
    reconcileSubtitleNotes(youtubeProfile, {
      findSource: (id) => sources.get(id) || null,
      getSourceText: (source) => source.text,
      noteAttribute: "data-ot-note-id",
      notes: [matchingNote, changedNote, detachedNote, progressiveNote],
      processedAttribute: "data-translated",
      queuedAttribute: "data-ot-queued",
      sourceAttribute: "data-ot-source-id",
      staleAttribute: "data-ot-source-stale",
      translatedAttribute: "data-ot-translated",
    }),
    2,
  )
  assert.equal(matchingNote.removed, false)
  assert.equal(changedNote.removed, true)
  assert.equal(detachedNote.removed, true)
  assert.equal(progressiveNote.removed, false)
  assert.equal(progressiveSource.attributes.get("data-ot-subtitle-replaced"), "true")
  assert.equal(changedSource.attributes.has("data-ot-source-id"), false)
  assert.equal(changedSource.attributes.get("data-ot-queued"), "false")
})

test("translated subtitles can still explicitly clear native replacement state", () => {
  const attributes = new Map()
  const source = {
    removeAttribute(name) {
      attributes.delete(name)
    },
    setAttribute(name, value) {
      attributes.set(name, value)
    },
  }

  assert.equal(replaceSubtitleSource(youtubeProfile, source, true), true)
  assert.equal(attributes.get("data-ot-subtitle-replaced"), "true")
  assert.equal(replaceSubtitleSource(youtubeProfile, source, false), true)
  assert.equal(attributes.has("data-ot-subtitle-replaced"), false)
  assert.equal(replaceSubtitleSource(defaultProfile, source, true), false)
})

test("subtitle notes inherit size when the source is the caption segment", () => {
  const properties = new Map()
  const source = {
    matches(selector) {
      return selector === ".ytp-caption-segment"
    },
  }
  const note = {
    setAttribute() {},
    style: {
      setProperty(name, value) {
        properties.set(name, value)
      },
    },
  }

  assert.equal(
    prepareSubtitleNote(youtubeProfile, note, source, (element) => {
      assert.equal(element, source)
      return { fontSize: "26px" }
    }),
    true,
  )
  assert.equal(properties.get("--ot-subtitle-font-size"), "26px")
})

test("subtitle notes inherit the native caption segment size", () => {
  const properties = new Map()
  const segment = {}
  const source = {
    querySelector(selector) {
      return selector === ".ytp-caption-segment" ? segment : null
    },
  }
  const note = {
    attributes: new Map(),
    setAttribute(name, value) {
      this.attributes.set(name, value)
    },
    style: {
      setProperty(name, value) {
        properties.set(name, value)
      },
    },
  }

  assert.equal(
    prepareSubtitleNote(youtubeProfile, note, source, () => ({
      fontSize: "24px",
    })),
    true,
  )
  assert.equal(note.attributes.get("data-ot-presentation"), "subtitle")
  assert.equal(properties.get("--ot-subtitle-font-size"), "24px")
})
