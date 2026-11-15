import assert from "node:assert/strict"
import { test } from "vitest"

import {
  buildResponsesRequest,
  buildTranslationInput,
  extractOutputText,
  parseTranslationResponse,
} from "../../../src/browser/translation/translation/responses.js"

function buildSettings(overrides = {}) {
  return {
    apiKey: "x",
    baseUrl: "https://example.com/v1",
    model: "demo",
    systemPromptTemplate: "System template for {{targetLanguage}}.",
    userPromptTemplate: "User template. {{sourcePayload}}",
    targetLanguage: "台灣正體中文",
    ...overrides,
  }
}

test("responses adapter builds prompt input from templates", () => {
  const input = buildTranslationInput({
    ...buildSettings(),
    items: [{ id: "a", kind: "paragraph", text: "Hello" }],
  })

  assert.equal(input[0].role, "system")
  assert.match(input[0].content, /台灣正體中文/)
  assert.equal(input[1].role, "user")
  assert.match(input[1].content, /"id":"a"/)
})

test("responses adapter builds Responses API request shape", () => {
  const request = buildResponsesRequest(buildSettings(), [
    { id: "a", kind: "paragraph", text: "Hello" },
  ])

  assert.equal(request.model, "demo")
  assert.equal(request.text.format.type, "json_schema")
  assert.equal(request.input.length, 2)
})

test("responses adapter extracts and parses output text", () => {
  const payload = {
    output: [
      {
        content: [
          { type: "output_text", text: '{"translations":' },
          {
            type: "output_text",
            text: '[{"id":"a","translatedText":"你好"}]}',
          },
        ],
      },
    ],
  }

  assert.match(extractOutputText(payload), /translations/)
  assert.deepEqual(parseTranslationResponse(payload), [{ id: "a", translation: "你好" }])
})

test("responses adapter accepts a single unwrapped translation item", () => {
  assert.deepEqual(
    parseTranslationResponse({
      output_text: '{"id":"a","translatedText":"你好"}',
    }),
    [{ id: "a", translation: "你好" }],
  )
})
