import assert from "node:assert/strict"
import { test } from "vitest"

import {
  createPageObserver,
  isSubtitleRelatedMutation,
} from "../../../src/browser/translation/content/page/observer.js"

function createElement(options = {}) {
  return {
    nodeType: 1,
    matches(selector) {
      return options.matches === selector
    },
    closest(selector) {
      return options.closest === selector ? {} : null
    },
    querySelector(selector) {
      return options.descendant === selector ? {} : null
    },
  }
}

const Node = { ELEMENT_NODE: 1 }
const selector = ".ytp-caption-segment"

test("subtitle observer accepts only mutations involving caption segments", () => {
  assert.equal(
    isSubtitleRelatedMutation(
      {
        target: createElement(),
        addedNodes: [createElement({ matches: selector })],
        removedNodes: [],
      },
      { Node, selector },
    ),
    true,
  )
  assert.equal(
    isSubtitleRelatedMutation(
      {
        target: {
          nodeType: 3,
          parentElement: createElement({ closest: selector }),
        },
        addedNodes: [],
        removedNodes: [],
      },
      { Node, selector },
    ),
    true,
  )
  assert.equal(
    isSubtitleRelatedMutation(
      {
        target: createElement({ descendant: selector }),
        addedNodes: [createElement()],
        removedNodes: [],
      },
      { Node, selector },
    ),
    false,
  )
})

test("subtitle replacements rebind exact notes before cleanup and scheduling", () => {
  const events = []
  const timers = []
  let handleMutations
  const body = {}
  const detachedNote = {
    getAttribute(name) {
      if (name === "data-ot-note-id") return "ot-detached"
      if (name === "data-ot-role") return "note"
      return null
    },
  }
  const removedSource = {
    ...createElement({ matches: selector }),
    querySelectorAll(value) {
      return value === '[data-ot-role="note"][data-ot-note-id]' ? [detachedNote] : []
    },
  }
  const secondRemovedSource = createElement({ matches: selector })
  const addedSource = createElement({ matches: selector })
  const secondAddedSource = createElement({ matches: selector })
  const observer = createPageObserver({
    // biome-ignore lint/correctness/noComponentHookFactories: This is a DOM constructor stub, not a React component.
    MutationObserver: function MutationObserver(callback) {
      handleMutations = callback
      return {
        disconnect() {},
        observe() {},
      }
    },
    Node,
    SubtitleApi: {
      YOUTUBE_CAPTION_SEGMENT_SELECTOR: selector,
      isSubtitleProfile() {
        return true
      },
      rebindDetachedSubtitleSources(_profile, source, replacements, options) {
        assert.ok(source === removedSource || source === secondRemovedSource)
        assert.deepEqual(replacements, [addedSource, secondAddedSource])
        assert.equal(
          options.findNote(source, source === removedSource ? "ot-detached" : "ot-other"),
          source === removedSource ? detachedNote : null,
        )
        events.push("rebind")
        return 1
      },
      reconcileSubtitleNotes() {
        events.push("reconcile")
      },
      removeDetachedSubtitleSources(_profile, source) {
        assert.ok(source === removedSource || source === secondRemovedSource)
        events.push("remove")
      },
      resetChangedSubtitleSource() {
        return false
      },
    },
    activeSiteProfile: {},
    contentLifecycle: {
      cleanup() {},
      start() {},
    },
    document: {
      body,
      querySelectorAll() {
        return []
      },
    },
    getExistingNoteForSource() {
      return null
    },
    getSourceText() {
      return ""
    },
    hasSourceTextChanged() {
      return false
    },
    insertSubtitleNote() {},
    isInsideTranslation() {
      return false
    },
    noteAttr: "data-ot-note-id",
    onScheduleVisibleTranslation() {
      events.push("schedule")
    },
    observerDebounceMs: 0,
    processedAttr: "data-translated",
    queuedAttr: "data-ot-queued",
    rememberSourceText() {},
    rootAttr: "data-ot-role",
    setSourceQueued() {},
    sourceAttr: "data-ot-source-id",
    staleAttr: "data-ot-source-stale",
    translatedAttr: "data-ot-translated",
    window: {
      clearTimeout() {},
      setTimeout(callback) {
        timers.push(callback)
        return timers.length
      },
    },
  })

  observer.ensureObserver()
  handleMutations([
    {
      addedNodes: [addedSource],
      removedNodes: [removedSource],
      target: createElement(),
      type: "childList",
    },
    {
      addedNodes: [secondAddedSource],
      removedNodes: [secondRemovedSource],
      target: createElement(),
      type: "childList",
    },
  ])

  assert.deepEqual(events, ["rebind", "remove", "rebind", "remove", "reconcile", "schedule"])
  assert.equal(timers.length, 0)
})

test.each([0, 200])(
  "seek discards detached pre-seek records before observer flush (delay=%s)",
  (observerDebounceMs) => {
    let callback
    let takeCount = 0
    let rebound = 0
    let scheduled = 0
    const records = []
    const timers = new Map()
    const observer = createPageObserver({
      // biome-ignore lint/correctness/noComponentHookFactories: DOM constructor fixture.
      MutationObserver: function MutationObserver(handle) {
        callback = handle
        return {
          disconnect() {},
          observe() {},
          takeRecords() {
            takeCount++
            return records.splice(0)
          },
        }
      },
      Node,
      SubtitleApi: {
        YOUTUBE_CAPTION_SEGMENT_SELECTOR: selector,
        isSubtitleProfile: () => true,
        rebindDetachedSubtitleSources() {
          rebound++
        },
        removeDetachedSubtitleSources() {},
        reconcileSubtitleNotes() {},
      },
      activeSiteProfile: {},
      contentLifecycle: { start() {}, cleanup() {} },
      document: { body: {}, querySelectorAll: () => [] },
      isInsideTranslation: () => false,
      onScheduleVisibleTranslation() {
        scheduled++
      },
      rootAttr: "data-ot-role",
      sourceAttr: "data-ot-source-id",
      observerDebounceMs,
      window: {
        setTimeout(fn) {
          timers.set(1, fn)
          return 1
        },
        clearTimeout(id) {
          timers.delete(id)
        },
      },
    })
    observer.ensureObserver()
    records.push({
      type: "childList",
      target: createElement(),
      addedNodes: [],
      removedNodes: [{ ...createElement({ matches: selector }), querySelectorAll: () => [] }],
    })
    if (observerDebounceMs) callback(records.splice(0))
    observer.resetPendingMutations()
    assert.equal(takeCount, 1)
    assert.equal(records.length, 0)
    assert.equal(timers.size, 0)
    callback([
      {
        type: "childList",
        target: createElement(),
        addedNodes: [createElement({ matches: selector })],
        removedNodes: [],
      },
    ])
    for (const flush of [...timers.values()]) flush()
    assert.equal(rebound, 0, "Pre-seek notes must not bind to a post-seek replacement.")
    assert.equal(scheduled, 1)
    observer.cleanup()
  },
)

test.each([true, false])(
  "text changes reset the source before scheduling (subtitle=%s)",
  (subtitle) => {
    const events = []
    const timers = []
    let handleMutations
    const body = {}
    const source = {
      nodeType: Node.ELEMENT_NODE,
      closest(value) {
        return value === selector || value === "[data-ot-source-id]" ? source : null
      },
      getAttribute(name) {
        return name === "data-ot-source-id" ? "ot-1" : null
      },
      matches(value) {
        return value === selector
      },
      setAttribute() {},
      removeAttribute() {},
    }
    const observer = createPageObserver({
      // biome-ignore lint/correctness/noComponentHookFactories: This is a DOM constructor stub, not a React component.
      MutationObserver: function MutationObserver(callback) {
        handleMutations = callback
        return {
          disconnect() {},
          observe() {},
        }
      },
      Node,
      SubtitleApi: {
        YOUTUBE_CAPTION_SEGMENT_SELECTOR: selector,
        isSubtitleProfile() {
          return subtitle
        },
        removeDetachedSubtitleSources() {},
        resetChangedSubtitleSource(_profile, options) {
          assert.equal(options.getSourceText(source), "Build reliable tools")
          if (subtitle) events.push("reset")
          return subtitle
        },
      },
      activeSiteProfile: {},
      contentLifecycle: {
        cleanup() {},
        start() {},
      },
      document: { body },
      getExistingNoteForSource() {
        return null
      },
      getSourceText() {
        return "Build reliable tools"
      },
      hasSourceTextChanged() {
        return true
      },
      isInsideTranslation() {
        return false
      },
      onScheduleVisibleTranslation() {
        events.push("schedule")
      },
      observerDebounceMs: 0,
      processedAttr: "data-translated",
      queuedAttr: "data-ot-queued",
      rootAttr: "data-ot-role",
      setSourceQueued() {
        events.push("reset")
      },
      sourceAttr: "data-ot-source-id",
      staleAttr: "data-ot-source-stale",
      translatedAttr: "data-ot-translated",
      window: {
        clearTimeout() {},
        setTimeout(callback) {
          timers.push(callback)
          return timers.length
        },
      },
    })

    observer.ensureObserver()
    handleMutations([
      {
        addedNodes: [],
        removedNodes: [],
        target: { nodeType: 3, parentElement: source },
        type: "characterData",
      },
    ])

    assert.deepEqual(events, ["reset", "schedule"])
    assert.equal(timers.length, 0)
  },
)
