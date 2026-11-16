import assert from "node:assert/strict"
import { test } from "vitest"

import {
  maskProtectedFragments,
  unmaskProtectedFragments,
  validateProtectedFragments,
} from "../../../src/browser/translation/translation/protected-fragments.js"

test("protected fragment masking preserves code paths urls and tech terms", () => {
  const masked = maskProtectedFragments(
    "Run `npm test` in src/app/ and open https://example.com for GitHub API docs.",
  )

  assert.equal(masked.maskedText.includes("`npm test`"), false)
  assert.ok(masked.tokens.length >= 4)
  assert.equal(
    unmaskProtectedFragments(masked.maskedText, masked.tokens),
    "Run `npm test` in src/app/ and open https://example.com for GitHub API docs.",
  )
})

test("salary ranges and multiple prices are protected as complete fragments", () => {
  for (const [text, values] of [
    ["$50-$150/hr", ["$50-$150/hr"]],
    ["$50–$150/hr", ["$50–$150/hr"]],
    ["$50—$150/hr", ["$50—$150/hr"]],
    [
      "Pay $50-$150/hr, $200/day, and $1,000.50 per week.",
      ["$50-$150/hr", "$200/day", "$1,000.50"],
    ],
    [
      "Prices are $5, $10, and $15. Use $2x + 1$ or $2 + 3$ or $p(x)$.",
      ["$5", "$10", "$15", "$2x + 1$", "$2 + 3$", "$p(x)$"],
    ],
  ]) {
    const masked = maskProtectedFragments(text)
    assert.equal(unmaskProtectedFragments(masked.maskedText, masked.tokens), text)
    assert.deepEqual(
      masked.tokens.map(({ value }) => value),
      values,
    )
  }
})

test("whitespace-padded dollar math stays intact while prose is translated", () => {
  for (const math of ["$ x + y $", "$ x + y$", "$x + y $"]) {
    const masked = maskProtectedFragments(`Use ${math} here.`)
    assert.deepEqual(
      masked.tokens.map(({ value }) => value),
      [math],
    )
    assert.equal(masked.maskedText, "Use __OT_TOKEN_1__ here.")
    const translation = masked.maskedText.replace("Use", "使用").replace("here", "在此處")
    validateProtectedFragments(
      [
        {
          id: "math",
          text: masked.maskedText,
          protectedFragments: masked.tokens,
        },
      ],
      [{ id: "math", translation }],
    )
    assert.equal(unmaskProtectedFragments(translation, masked.tokens), `使用 ${math} 在此處.`)
  }
})

test("multiple prices and padded math leave surrounding prose translatable", () => {
  const text = "Pay $5, $10, and $15. Use $ x + y $, $ x + y$, $x + y $, and $2 + 3$ here."
  const masked = maskProtectedFragments(text)
  assert.deepEqual(
    masked.tokens.map(({ value }) => value),
    ["$5", "$10", "$15", "$ x + y $", "$ x + y$", "$x + y $", "$2 + 3$"],
  )
  const translation = masked.maskedText
    .replace("Pay", "支付")
    .replaceAll("and", "和")
    .replace("Use", "使用")
    .replace("here", "在此處")
  validateProtectedFragments(
    [
      {
        id: "mixed",
        text: masked.maskedText,
        protectedFragments: masked.tokens,
      },
    ],
    [{ id: "mixed", translation }],
  )
  assert.equal(
    unmaskProtectedFragments(translation, masked.tokens),
    "支付 $5, $10, 和 $15. 使用 $ x + y $, $ x + y$, $x + y $, 和 $2 + 3$ 在此處.",
  )
})

test("masking does not nest generated or pre-extracted placeholders", () => {
  const existing = [{ placeholder: "__OT_MATH_1__", value: "$x$", preservePlaceholder: true }]
  const text = "`$x$ and API` __OT_MATH_1__/docs src/app.js https://example.com/API"
  const masked = maskProtectedFragments(text, existing)
  assert.ok(masked.tokens.some(({ value }) => value === "`$x$ and API`"))
  assert.ok(masked.tokens.slice(1).every(({ value }) => !value.includes("__OT_")))
  assert.equal(unmaskProtectedFragments(masked.maskedText, masked.tokens), text)
  const repeated = maskProtectedFragments(masked.maskedText, masked.tokens)
  assert.deepEqual(repeated, masked)
})

test("literal placeholder examples do not collide with generated tokens", () => {
  for (const text of [
    "Use `__OT_TOKEN_1__` with API.",
    "`__OT_TOKEN_1__`",
    "`__OT_TOKEN_X__` and __OT_MATH_42__",
    "A malformed example: __OT_TOKEN_1_ with API.",
  ]) {
    const masked = maskProtectedFragments(text)
    validateProtectedFragments(
      [
        {
          id: "literal",
          text: masked.maskedText,
          protectedFragments: masked.tokens,
        },
      ],
      [{ id: "literal", translation: masked.maskedText }],
    )
    assert.equal(unmaskProtectedFragments(masked.maskedText, masked.tokens), text)
  }
})

test("inline code containing literal placeholders stays atomic while prose is translated", () => {
  for (const literal of ["__OT_MATH_42__", "__OT_TOKEN_1__", "__OT_TOKEN_X__", "__OT_TOKEN_1_"]) {
    const text = `\`${literal}\` means a placeholder; \`hello\` is code.`
    const masked = maskProtectedFragments(text)
    assert.deepEqual(
      masked.tokens.map(({ value }) => value),
      [`\`${literal}\``, "`hello`"],
    )
    assert.equal(masked.maskedText.includes("hello"), false)
    assert.ok(masked.tokens.every(({ placeholder }) => placeholder !== literal))
    assert.deepEqual(maskProtectedFragments(masked.maskedText, masked.tokens), masked)
    const translation = masked.maskedText
      .replace("means a placeholder", "表示佔位符")
      .replace("is code", "是程式碼")
    validateProtectedFragments(
      [
        {
          id: "code",
          text: masked.maskedText,
          protectedFragments: masked.tokens,
        },
      ],
      [{ id: "code", translation }],
    )
    assert.equal(
      unmaskProtectedFragments(translation, masked.tokens),
      `\`${literal}\` 表示佔位符; \`hello\` 是程式碼.`,
    )
  }
})

test("inline code does not take ownership of pre-extracted math placeholders", () => {
  const existing = [{ placeholder: "__OT_MATH_1__", value: "$x$", preservePlaceholder: true }]
  const text = "`__OT_MATH_1__` means a placeholder; `hello` is code."
  const masked = maskProtectedFragments(text, existing)
  assert.deepEqual(masked.tokens, [
    ...existing,
    { placeholder: "__OT_TOKEN_1__", value: "`hello`" },
  ])
  assert.equal(masked.maskedText, "`__OT_MATH_1__` means a placeholder; __OT_TOKEN_1__ is code.")
  assert.equal(unmaskProtectedFragments(masked.maskedText, masked.tokens), text)
  assert.deepEqual(maskProtectedFragments(masked.maskedText, masked.tokens), masked)
})

test("validation does not join text across a known placeholder", () => {
  const text = "__OT_`x`TOKEN_"
  const masked = maskProtectedFragments(text)
  assert.equal(masked.maskedText, "__OT___OT_TOKEN_1__TOKEN_")
  validateProtectedFragments(
    [
      {
        id: "boundary",
        text: masked.maskedText,
        protectedFragments: masked.tokens,
      },
    ],
    [{ id: "boundary", translation: masked.maskedText }],
  )
  assert.equal(unmaskProtectedFragments(masked.maskedText, masked.tokens), text)
})

test("restoration resolves nested tokens independent of token order", () => {
  const tokens = [
    { placeholder: "__OT_TOKEN_1__", value: "$50–$" },
    { placeholder: "__OT_TOKEN_2__", value: "__OT_TOKEN_1__150/hr" },
  ]
  for (const ordered of [tokens, [...tokens].reverse()]) {
    assert.equal(unmaskProtectedFragments("__OT_TOKEN_2__", ordered), "$50–$150/hr")
  }
})

test("restoration fails safely on unknown malformed and cyclic tokens", () => {
  for (const text of ["__OT_TOKEN_99__", "__OT_TOKEN_X__", "__OT_TOKEN_1_"]) {
    assert.throws(() => unmaskProtectedFragments(text, []), /Protected placeholder/)
  }
  assert.throws(
    () =>
      unmaskProtectedFragments("__OT_TOKEN_1__", [
        { placeholder: "__OT_TOKEN_1__", value: "__OT_TOKEN_2__" },
        { placeholder: "__OT_TOKEN_2__", value: "__OT_TOKEN_1__" },
      ]),
    /Protected placeholder/,
  )
})

test("validation rejects extra duplicated and malformed placeholders", () => {
  const items = [
    {
      id: "a",
      text: "__OT_TOKEN_1__",
      protectedFragments: [{ placeholder: "__OT_TOKEN_1__", value: "API" }],
    },
  ]
  for (const translation of [
    "__OT_TOKEN_1__ __OT_TOKEN_99__",
    "__OT_TOKEN_1__ __OT_TOKEN_1__",
    "__OT_TOKEN_1__ __OT_TOKEN_X__",
    "__OT_TOKEN_1__ __OT_MATH_99__",
    "__OT_TOKEN_1____OT_TOKEN_X__",
  ]) {
    assert.throws(
      () => validateProtectedFragments(items, [{ id: "a", translation }]),
      /Protected placeholder/,
    )
  }
  validateProtectedFragments(items, [{ id: "a", translation: "Use __OT_TOKEN_1__." }])
})

test("protected fragment validation rejects missing placeholders", () => {
  assert.throws(
    () =>
      validateProtectedFragments(
        [
          {
            id: "a",
            protectedFragments: [{ placeholder: "__OT_TOKEN_1__" }],
          },
        ],
        [{ id: "a", translation: "missing" }],
      ),
    /Protected placeholder missing/,
  )
})
