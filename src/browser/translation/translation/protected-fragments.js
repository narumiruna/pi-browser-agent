const TECH_TERM_REGEX =
  /\b(?:API|LLM|OpenAI|GitHub|Telegram|Markdown|README|Chrome|Yahoo Finance|JSON|HTML|CSS|JavaScript|TypeScript|Node\.js)\b/g
const FILE_PATH_REGEX =
  /\b(?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w./-]*[\w.-]\b|\b[\w.-]+\.(?:md|txt|json|ya?ml|toml|js|jsx|ts|tsx|css|html|py|sh|rb|go|rs|java|kt|swift)\b/g
const URL_REGEX = /\bhttps?:\/\/[^\s<>"']+/g
const INLINE_CODE_REGEX = /`[^`\n]+`/g
const DISPLAY_LATEX_REGEX = /\$\$[\s\S]+?\$\$/g
// Allow padded math, but keep numeric price openings from absorbing prose.
// A closing dollar before a price digit belongs to the next price instead.
const INLINE_DOLLAR_MATH_REGEX = /(?<!\\)\$(?:(?!\d)[^$\n]+|(?!\s)[^$\n]*[^\s$\n])\$(?!\d)/g
const CURRENCY_REGEX =
  /(?<![\\\w])\$\d+(?:,\d{3})*(?:\.\d+)?(?:\s*[-–—]\s*\$?\d+(?:,\d{3})*(?:\.\d+)?)?(?:\s*\/\s*(?:hr|hour|day|week|mo|month|yr|year)s?)?(?![\w$])/g
// Prefer complete math expressions over a numeric price prefix, e.g. $2 + 3$.
const DOLLAR_FRAGMENT_REGEX = new RegExp(
  `${INLINE_DOLLAR_MATH_REGEX.source}|${CURRENCY_REGEX.source}`,
  "g",
)
const PLACEHOLDER_REGEX = /__OT_(?:TOKEN|MATH)_\d+__/g
const PLACEHOLDER_PREFIX_REGEX = /__OT_(?:TOKEN|MATH)_/i
const INLINE_PAREN_MATH_REGEX = /\\\([\s\S]+?\\\)/g
const BLOCK_BRACKET_MATH_REGEX = /\\\[[\s\S]+?\\\]/g

function maskProtectedFragments(text, existingTokens) {
  const tokens = [...(existingTokens || [])]
  let maskedText = String(text || "")
  let counter = tokens.reduce((max, token) => {
    const match = /^__OT_TOKEN_(\d+)__$/.exec(String(token?.placeholder))

    return match ? Math.max(max, Number(match[1]) || 0) : max
  }, 0)
  // Reserve source IDs so literal examples cannot collide with generated tokens.
  const reservedPlaceholders = new Set(maskedText.match(/__OT_TOKEN_\d+__/g))
  function allocatePlaceholder() {
    let placeholder
    do {
      placeholder = `__OT_TOKEN_${++counter}__`
    } while (reservedPlaceholders.has(placeholder))
    return placeholder
  }
  const existingPlaceholders = new Set(tokens.map((token) => token.placeholder))
  // Protect complete code spans before masking literal placeholder examples.
  maskedText = maskedText.replace(INLINE_CODE_REGEX, (value) => {
    if (
      (value.match(PLACEHOLDER_REGEX) || []).some((placeholder) =>
        existingPlaceholders.has(placeholder),
      )
    ) {
      // Keep pre-extracted placeholders visible to validation and DOM restoration.
      return value
    }
    const placeholder = allocatePlaceholder()
    const token = { placeholder, value }
    if (PLACEHOLDER_PREFIX_REGEX.test(value)) {
      token.literal = true
    }
    tokens.push(token)
    existingPlaceholders.add(placeholder)
    return placeholder
  })
  maskedText = maskedText.replace(
    /__OT_(?:TOKEN|MATH)_\d+__|__OT_(?:TOKEN|MATH)_\w*/gi,
    (value) => {
      if (existingPlaceholders.has(value)) {
        return value
      }
      const placeholder = allocatePlaceholder()
      tokens.push({ placeholder, value, literal: true })
      return placeholder
    },
  )

  function replaceWithToken(regex) {
    // Treat existing placeholders as boundaries, not as code or path text.
    maskedText = maskedText
      .split(/(__OT_(?:TOKEN|MATH)_\d+__)/g)
      .map((part, index) =>
        index % 2
          ? part
          : part.replace(regex, (match) => {
              const placeholder = allocatePlaceholder()

              tokens.push({ placeholder, value: match })
              return placeholder
            }),
      )
      .join("")
  }

  replaceWithToken(DISPLAY_LATEX_REGEX)
  replaceWithToken(BLOCK_BRACKET_MATH_REGEX)
  replaceWithToken(INLINE_PAREN_MATH_REGEX)
  replaceWithToken(DOLLAR_FRAGMENT_REGEX)
  replaceWithToken(URL_REGEX)
  replaceWithToken(FILE_PATH_REGEX)
  replaceWithToken(TECH_TERM_REGEX)

  return {
    maskedText,
    tokens,
  }
}

function shouldPreservePlaceholder(token) {
  return Boolean(token?.preservePlaceholder)
}

function assertKnownPlaceholders(text, tokens) {
  let remainder = String(text || "")

  for (const token of tokens || []) {
    remainder = remainder.split(token.placeholder).join(" ")
  }

  if (PLACEHOLDER_PREFIX_REGEX.test(remainder)) {
    throw new Error("Protected placeholder is unknown or malformed.")
  }
}

function unmaskProtectedFragments(text, tokens) {
  const tokenByPlaceholder = new Map((tokens || []).map((token) => [token.placeholder, token]))
  const resolving = new Set()
  const resolved = new Map()

  function restore(value) {
    assertKnownPlaceholders(value, tokens)
    return String(value || "").replace(PLACEHOLDER_REGEX, (placeholder) => {
      const token = tokenByPlaceholder.get(placeholder)

      if (shouldPreservePlaceholder(token)) {
        return placeholder
      }
      if (token.literal) {
        return token.value
      }
      if (resolving.has(placeholder)) {
        throw new Error("Protected placeholder contains a cycle.")
      }
      if (!resolved.has(placeholder)) {
        resolving.add(placeholder)
        resolved.set(placeholder, restore(token.value))
        resolving.delete(placeholder)
      }
      return resolved.get(placeholder)
    })
  }

  return restore(text)
}

function collectPreservedFragments(tokens) {
  return (tokens || []).filter((token) => shouldPreservePlaceholder(token))
}

function extractTokensForText(text, tokens) {
  return (tokens || []).filter((token) => String(text || "").includes(token.placeholder))
}

function validateProtectedFragments(items, translations) {
  const itemById = new Map((items || []).map((item) => [item.id, item]))

  for (const translation of translations || []) {
    const sourceItem = itemById.get(translation.id)

    if (!sourceItem) {
      throw new Error(`Unknown translation item id: ${translation.id}`)
    }

    for (const fragment of sourceItem.protectedFragments || []) {
      const count = translation.translation.split(fragment.placeholder).length - 1
      const expected = Math.max(
        1,
        String(sourceItem.text || "").split(fragment.placeholder).length - 1,
      )
      if (!count) {
        throw new Error(`Protected placeholder missing from translation for ${translation.id}`)
      }
      if (count !== expected) {
        throw new Error(`Protected placeholder count changed for ${translation.id}`)
      }
    }
    assertKnownPlaceholders(translation.translation, sourceItem.protectedFragments)
  }
}

export {
  collectPreservedFragments,
  extractTokensForText,
  maskProtectedFragments,
  unmaskProtectedFragments,
  validateProtectedFragments,
}
