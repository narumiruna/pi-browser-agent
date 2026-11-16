import assert from "node:assert/strict"
import { test } from "vitest"

import {
  chunkTranslationItems,
  consumeProgressiveTranslations,
  createProgressiveMergeState,
  createRecursiveChunkPlan,
  DEFAULT_MAX_BATCH_CHARS,
  getIncompleteSegmentIds,
  mergeRecursiveTranslations,
  splitTextRecursively,
} from "../../../src/browser/translation/translation/chunk-plan.js"

import { validateProtectedFragments } from "../../../src/browser/translation/translation/protected-fragments.js"

test("chunk plan packs 1001 distinct words into two bounded requests", () => {
  const words = Array.from({ length: 1001 }, (_, index) => `word${index}`)
  const text = words.join(" ")
  assert.equal(text.length, 7898)
  assert.equal(new Set(words).size, 1001)

  const items = [{ id: "long", kind: "paragraph", text }]
  const plan = createRecursiveChunkPlan(items)
  assert.equal(plan.chunks.length, 2)
  assert.deepEqual(createRecursiveChunkPlan(items), plan)
  assert.deepEqual(
    plan.chunks.map((chunk) => chunk.map(({ id }) => id)),
    [["long__part_1"], ["long__part_2"]],
  )
  assert.ok(
    plan.chunks.every(
      (chunk) =>
        chunk.reduce((length, item) => length + item.text.length, 0) <= DEFAULT_MAX_BATCH_CHARS,
    ),
  )
  assert.deepEqual(
    plan.expandedItems.map(({ partIndex, partCount }) => [partIndex, partCount]),
    [
      [0, 2],
      [1, 2],
    ],
  )
  assert.equal(plan.expandedItems.map(({ text, joiner }) => text + joiner).join(""), text)

  const translations = plan.expandedItems.map((item) => ({
    id: item.id,
    translation: item.text,
  }))
  const merged = mergeRecursiveTranslations(plan, translations)
  assert.equal(merged[0].translation, text)
  const state = createProgressiveMergeState(plan)
  assert.deepEqual(consumeProgressiveTranslations(plan, state, [translations[1]]), [])
  assert.deepEqual(getIncompleteSegmentIds(plan, state), ["long"])
  assert.deepEqual(consumeProgressiveTranslations(plan, state, [translations[0]]), merged)
  assert.deepEqual(getIncompleteSegmentIds(plan, state), [])
  assert.deepEqual(consumeProgressiveTranslations(plan, state, translations), [])
})

test("recursive packing counts boundary joiners and preserves their order", () => {
  for (const [text, limit, expected] of [
    [
      "alpha\n\nbeta\n\ngamma",
      11,
      [
        { text: "alpha\n\nbeta", joiner: "\n\n" },
        { text: "gamma", joiner: "" },
      ],
    ],
    [
      "alpha\nbeta\ngamma",
      10,
      [
        { text: "alpha\nbeta", joiner: "\n" },
        { text: "gamma", joiner: "" },
      ],
    ],
    [
      "One. Two. Three.",
      10,
      [
        { text: "One. Two.", joiner: " " },
        { text: "Three.", joiner: "" },
      ],
    ],
    [
      "one, two; three: four",
      10,
      [
        { text: "one, two;", joiner: " " },
        { text: "three:", joiner: " " },
        { text: "four", joiner: "" },
      ],
    ],
    [
      "alpha beta gamma",
      10,
      [
        { text: "alpha beta", joiner: " " },
        { text: "gamma", joiner: "" },
      ],
    ],
    [
      "aa\n\nbbbbbb ccc dd\n\nee",
      10,
      [
        { text: "aa", joiner: "\n\n" },
        { text: "bbbbbb ccc", joiner: " " },
        { text: "dd\n\nee", joiner: "" },
      ],
    ],
  ]) {
    const parts = splitTextRecursively(text, limit)
    assert.deepEqual(parts, expected)
    assert.ok(parts.every((part) => part.text.length <= limit))
    assert.equal(parts.map(({ text, joiner }) => text + joiner).join(""), text)
  }
})

test("chunk plan keeps short sources separate and unchanged", () => {
  for (const kind of ["paragraph", "subtitle"]) {
    const items = [
      { id: "one", kind, text: "One" },
      { id: "two", kind, text: "Two" },
    ]
    const plan = createRecursiveChunkPlan(items)
    assert.deepEqual(
      plan.chunks.map((chunk) => chunk.map(({ id }) => id)),
      [["one"], ["two"]],
    )
    assert.deepEqual(
      plan.expandedItems.map(({ text, partCount }) => [text, partCount]),
      [
        ["One", 1],
        ["Two", 1],
      ],
    )
  }
})

test("hard splitting keeps currency and DOM math placeholders atomic", () => {
  for (const suffix of ["$50", "$50–$150/hr", "__OT_MATH_1__"]) {
    const text = "漢".repeat(4990) + suffix
    const plan = createRecursiveChunkPlan([
      {
        id: "long",
        text,
        protectedFragments: suffix.startsWith("__OT_")
          ? [{ placeholder: suffix, value: "$x$", preservePlaceholder: true }]
          : [],
      },
    ])
    const translations = plan.expandedItems.map((item) => ({
      id: item.id,
      translation: item.text,
    }))
    validateProtectedFragments(plan.expandedItems, translations)
    const merged = mergeRecursiveTranslations(plan, translations)
    assert.equal(merged[0].translation, text)
    assert.doesNotMatch(merged[0].translation, /__OT_TOKEN/)
    assert.equal(plan.expandedItems.length, 2)
  }
})

test("hard splitting makes progress when a placeholder exceeds the limit", () => {
  assert.deepEqual(splitTextRecursively("__OT_TOKEN_123__tail", 5), [
    { text: "__OT_TOKEN_123__", joiner: "" },
    { text: "tail", joiner: "" },
  ])
})

test("chunk plan preserves empty inputs and one empty request per blank item", () => {
  for (const items of [undefined, []]) {
    assert.deepEqual(createRecursiveChunkPlan(items), {
      chunks: [],
      expandedItems: [],
      items: [],
      mergePlan: new Map(),
    })
  }
  for (const text of [undefined, "", " \n\t "]) {
    const plan = createRecursiveChunkPlan([{ id: "blank", text }])
    const expected = {
      id: "blank",
      kind: "paragraph",
      text: "",
      sourceId: "blank",
      partIndex: 0,
      partCount: 1,
      joiner: "",
      protectedFragments: [],
      isUI: false,
      isMetadata: false,
      containsMath: false,
    }
    assert.deepEqual(plan.expandedItems, [expected])
    assert.deepEqual(plan.chunks, [[expected]])
    assert.deepEqual(
      [...plan.mergePlan],
      [
        [
          "blank",
          {
            originalId: "blank",
            partIds: ["blank"],
            protectedFragments: [],
          },
        ],
      ],
    )
  }
})

test("single and split parts retain IDs, timing, directives, joiners and token membership", () => {
  const item = {
    id: "cue",
    kind: "subtitle",
    cueId: "timed-1",
    cueStartMs: "1200",
    durationMs: 3400,
    text: "Run `npm test`. Then open https://example.com/docs for details.",
    isUI: true,
    isMetadata: false,
    containsMath: true,
  }
  const tokens = [
    { placeholder: "__OT_TOKEN_1__", value: "`npm test`" },
    { placeholder: "__OT_TOKEN_2__", value: "https://example.com/docs" },
  ]
  for (const [limit, texts] of [
    [5000, ["Run __OT_TOKEN_1__. Then open __OT_TOKEN_2__ for details."]],
    [24, ["Run __OT_TOKEN_1__.", "Then open __OT_TOKEN_2__", "for details."]],
  ]) {
    const plan = createRecursiveChunkPlan([item], limit)
    const expected = texts.map((text, index) => ({
      id: texts.length === 1 ? "cue" : `cue__part_${index + 1}`,
      cueId: "timed-1",
      cueStartMs: 1200,
      durationMs: 3400,
      isUI: true,
      isMetadata: false,
      containsMath: true,
      kind: "subtitle",
      text,
      sourceId: "cue",
      partIndex: index,
      partCount: texts.length,
      joiner: index < texts.length - 1 ? " " : "",
      protectedFragments: tokens.filter(({ placeholder }) => text.includes(placeholder)),
    }))
    assert.deepEqual(plan.expandedItems, expected)
    assert.deepEqual(
      plan.chunks,
      expected.map((part) => [part]),
    )
    assert.deepEqual(plan.items, [
      {
        ...item,
        maskedText: "Run __OT_TOKEN_1__. Then open __OT_TOKEN_2__ for details.",
        protectedFragments: tokens,
      },
    ])
    assert.deepEqual(
      [...plan.mergePlan],
      [
        [
          "cue",
          {
            originalId: "cue",
            partIds: expected.map(({ id }) => id),
            protectedFragments: tokens,
          },
        ],
      ],
    )
  }
})

test("chunk plan chunks items by character limit", () => {
  const chunks = chunkTranslationItems(
    [
      { id: "a", text: "1234" },
      { id: "b", text: "1234" },
      { id: "c", text: "1234" },
    ],
    8,
  )

  assert.deepEqual(
    chunks.map((chunk) => chunk.map((item) => item.id)),
    [["a", "b"], ["c"]],
  )
})

test("chunk plan splits oversized text and merges translations", () => {
  const parts = splitTextRecursively("alpha beta gamma delta epsilon zeta eta theta", 12)

  assert.ok(parts.length > 1)
  assert.ok(parts.every((part) => part.text.length <= 12))

  const plan = createRecursiveChunkPlan(
    [
      {
        id: "long",
        kind: "paragraph",
        text: "First sentence. Second sentence. Third sentence.",
      },
    ],
    20,
  )
  const merged = mergeRecursiveTranslations(
    plan,
    plan.expandedItems.map((item) => ({
      id: item.id,
      translation: `[${item.text}]`,
    })),
  )

  assert.equal(merged.length, 1)
  assert.equal(merged[0].id, "long")
  assert.equal(merged[0].sourceText, "First sentence. Second sentence. Third sentence.")
  assert.match(merged[0].translation, /^\[First sentence\./)
  assert.match(merged[0].translation, /Third sentence\.\]$/)
})

test("one-shot and progressive recursive merges assemble identical segments", () => {
  const plan = createRecursiveChunkPlan(
    [
      {
        id: "cue",
        cueId: "cue-1",
        cueStartMs: 1200,
        durationMs: 3400,
        kind: "subtitle",
        text: "Run `npm test`. Then open https://example.com/docs for details.",
      },
    ],
    24,
  )
  const translations = plan.expandedItems.map((item) => ({
    id: item.id,
    translation: item.text,
  }))
  const state = createProgressiveMergeState(plan)
  const progressive = []

  for (const translation of [...translations].reverse()) {
    progressive.push(...consumeProgressiveTranslations(plan, state, [translation]))
  }

  assert.deepEqual(progressive, mergeRecursiveTranslations(plan, translations))
})

test("chunk plan preserves translation directives on every split part", () => {
  const plan = createRecursiveChunkPlan(
    [
      {
        id: "metadata",
        kind: "paragraph",
        text: "First sentence. Second sentence. Third sentence.",
        isUI: true,
        isMetadata: true,
        containsMath: true,
      },
    ],
    20,
  )

  assert.ok(plan.expandedItems.length > 1)
  assert.ok(plan.expandedItems.every((item) => item.isUI && item.isMetadata && item.containsMath))
})

test("chunk plan progressive merge waits until all parts are available", () => {
  const plan = createRecursiveChunkPlan(
    [
      {
        id: "long",
        kind: "paragraph",
        text: "First sentence. Second sentence. Third sentence.",
      },
    ],
    20,
  )
  const state = createProgressiveMergeState(plan)
  const [firstPart, ...remainingParts] = plan.expandedItems

  assert.deepEqual(
    consumeProgressiveTranslations(plan, state, [
      { id: firstPart.id, translation: firstPart.text },
    ]),
    [],
  )

  const completed = consumeProgressiveTranslations(
    plan,
    state,
    remainingParts.map((item) => ({ id: item.id, translation: item.text })),
  )

  assert.equal(completed.length, 1)
  assert.equal(completed[0].id, "long")
  assert.equal(completed[0].sourceText, "First sentence. Second sentence. Third sentence.")
})
