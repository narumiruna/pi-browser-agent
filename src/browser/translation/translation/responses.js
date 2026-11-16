import * as ProtectedFragments from "./protected-fragments.js"

const TRANSLATION_RESPONSE_FORMAT = Object.freeze({
  type: "json_schema",
  name: "translation_result",
  schema: {
    type: "object",
    description: "Translations corresponding one-to-one with the input items.",
    properties: {
      translations: {
        type: "array",
        description: "One result per input item, in the same order.",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "The input item id copied without changes.",
            },
            translatedText: {
              type: "string",
              description: "Only the translated text for this item.",
            },
          },
          required: ["id", "translatedText"],
          additionalProperties: false,
        },
      },
    },
    required: ["translations"],
    additionalProperties: false,
  },
  strict: true,
})
const { validateProtectedFragments } = ProtectedFragments

class InvalidTranslationResponseError extends Error {
  constructor(cause) {
    super(cause?.message || String(cause), { cause })
    this.name = "InvalidTranslationResponseError"
  }
}

function renderPromptTemplate(template, variables) {
  return String(template || "").replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    if (!Object.hasOwn(variables, key)) {
      return ""
    }

    return String(variables[key])
  })
}

function estimateTokenCount(value) {
  const text = String(value || "").trim()

  if (!text) {
    return 0
  }

  return Math.max(1, Math.ceil(text.length / 4))
}

function buildTranslationInput(options) {
  const items = options.items || []
  const targetLanguage = options.targetLanguage
  const payloadItems = items.map((item) => ({
    id: item.id,
    kind: item.kind || "paragraph",
    isUI: Boolean(item.isUI),
    isMetadata: Boolean(item.isMetadata),
    containsMath: Boolean(item.containsMath),
    text: item.text,
  }))
  const userPayload =
    payloadItems.length === 1
      ? {
          targetLanguage,
          ...payloadItems[0],
        }
      : {
          targetLanguage,
          items: payloadItems,
        }
  const templateVariables = {
    targetLanguage,
    sourcePayload: JSON.stringify(userPayload),
    itemCount: String(payloadItems.length),
    itemKind: payloadItems.length === 1 ? payloadItems[0].kind || "text" : "items",
  }

  return [
    {
      role: "system",
      content: renderPromptTemplate(options.systemPromptTemplate, {
        targetLanguage,
        itemCount: String(payloadItems.length),
        itemKind:
          payloadItems.length === 1 &&
          [
            "paragraph",
            "heading",
            "list_item",
            "table_cell",
            "quote",
            "selection",
            "subtitle",
            "text",
          ].includes(payloadItems[0].kind)
            ? payloadItems[0].kind
            : "text",
      }),
    },
    {
      role: "user",
      content: renderPromptTemplate(options.userPromptTemplate, templateVariables),
    },
  ]
}

function buildResponsesRequest(settings, items) {
  return {
    model: settings.model,
    input: buildTranslationInput({
      systemPromptTemplate: settings.systemPromptTemplate,
      userPromptTemplate: settings.userPromptTemplate,
      items,
      targetLanguage: settings.targetLanguage,
    }),
    text: {
      format: TRANSLATION_RESPONSE_FORMAT,
    },
  }
}

function extractOutputText(payload) {
  if (payload && typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text
  }

  const output = Array.isArray(payload?.output) ? payload.output : []
  const textParts = []

  for (const item of output) {
    if (!item || !Array.isArray(item.content)) {
      continue
    }

    for (const contentItem of item.content) {
      if (
        contentItem &&
        contentItem.type === "output_text" &&
        typeof contentItem.text === "string"
      ) {
        textParts.push(contentItem.text)
      }
    }
  }

  return textParts.join("\n")
}

function stripCodeFences(text) {
  return String(text || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
}

function parseTranslationResponse(payload) {
  let parsed = payload?.output_parsed

  if (!parsed) {
    const fallbackText = stripCodeFences(extractOutputText(payload))

    if (!fallbackText) {
      throw new Error("Response did not include parsed output.")
    }

    parsed = JSON.parse(fallbackText)
  }

  const candidate = Array.isArray(parsed) ? parsed : (parsed?.translations ?? parsed)
  const translations = Array.isArray(candidate)
    ? candidate
    : candidate &&
        typeof candidate.id === "string" &&
        (typeof candidate.translatedText === "string" || typeof candidate.translation === "string")
      ? [candidate]
      : null

  if (!translations) {
    throw new Error("Response JSON is missing translations array.")
  }

  return translations.map((item) => {
    if (
      !item ||
      typeof item.id !== "string" ||
      (typeof item.translatedText !== "string" && typeof item.translation !== "string")
    ) {
      throw new Error("Response item is missing id or translatedText/translation.")
    }

    return {
      id: item.id,
      translation: typeof item.translatedText === "string" ? item.translatedText : item.translation,
    }
  })
}

function validateTranslationCoverage(items, translations) {
  const expectedIds = (items || []).map((item) => item?.id).filter((id) => typeof id === "string")
  const expectedIdSet = new Set(expectedIds)
  const seenIds = new Set()

  for (const translation of translations || []) {
    const id = translation?.id

    if (!expectedIdSet.has(id)) {
      throw new Error(`Translation response included unknown id: ${id}`)
    }

    if (seenIds.has(id)) {
      throw new Error(`Translation response included duplicate id: ${id}`)
    }

    seenIds.add(id)
  }

  const missingIds = expectedIds.filter((id) => !seenIds.has(id))

  if (missingIds.length > 0) {
    throw new Error(`Translation response missing id(s): ${missingIds.join(", ")}`)
  }
}

async function callResponsesApi(settings, items, fetchImpl) {
  const requestPayload = buildResponsesRequest(settings, items)
  const response = await fetchImpl(`${settings.baseUrl}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestPayload),
  })
  const rawText = typeof response.text === "function" ? await response.text() : ""
  let payload

  try {
    payload = rawText ? JSON.parse(rawText) : {}
  } catch (_error) {
    payload = { error: { message: rawText || "Invalid JSON response." } }
  }

  if (!response.ok) {
    const message =
      payload?.error && typeof payload.error.message === "string" && payload.error.message.trim()

    throw new Error(message || `Translation request failed with status ${response.status}.`)
  }

  try {
    const translations = parseTranslationResponse(payload)

    validateTranslationCoverage(items, translations)
    validateProtectedFragments(items, translations)

    return translations
  } catch (error) {
    throw new InvalidTranslationResponseError(error)
  }
}

export {
  buildResponsesRequest,
  buildTranslationInput,
  callResponsesApi,
  estimateTokenCount,
  extractOutputText,
  InvalidTranslationResponseError,
  parseTranslationResponse,
  renderPromptTemplate,
  stripCodeFences,
  TRANSLATION_RESPONSE_FORMAT,
  validateTranslationCoverage,
}
