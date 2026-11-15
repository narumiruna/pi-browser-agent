import assert from "node:assert/strict"
import { test } from "vitest"

import { createTranslationCache } from "../../../src/browser/translation/translation/cache.js"

function buildSettings(overrides = {}) {
  return {
    baseUrl: "https://example.com/v1",
    model: "demo",
    systemPromptTemplate: "system",
    userPromptTemplate: "user {{sourcePayload}}",
    targetLanguage: "台灣正體中文",
    ...overrides,
  }
}

test("translation cache splits cached and missing items", () => {
  const cache = createTranslationCache()
  const settings = buildSettings()
  const items = [
    { id: "a", kind: "paragraph", text: "Alpha" },
    { id: "b", kind: "paragraph", text: "Beta" },
  ]

  cache.set(settings, items[0], "阿爾法")

  assert.deepEqual(cache.splitItemsByCache(settings, items), {
    cachedTranslations: [{ id: "a", translation: "阿爾法" }],
    missingItems: [items[1]],
  })
})

test("translation cache separates provider backend identities", () => {
  const cache = createTranslationCache()
  const item = { id: "a", kind: "paragraph", text: "Alpha" }
  const firstBackend = buildSettings({ modelCacheIdentity: "backend-one" })
  const secondBackend = buildSettings({ modelCacheIdentity: "backend-two" })

  cache.set(firstBackend, item, "阿爾法")

  assert.equal(cache.get(firstBackend, item), "阿爾法")
  assert.equal(cache.get(secondBackend, item), null)
})

test("translation cache separates normalized thinking levels", () => {
  const cache = createTranslationCache()
  const item = { id: "a", kind: "paragraph", text: "Alpha" }
  const settings = buildSettings()
  cache.set(settings, item, "Default result")
  assert.equal(cache.get(buildSettings({ thinkingLevel: "default" }), item), "Default result")
  assert.equal(cache.get(buildSettings({ thinkingLevel: "invalid" }), item), "Default result")
  for (const thinkingLevel of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    const levelSettings = buildSettings({ thinkingLevel })
    assert.equal(cache.get(levelSettings, item), null)
    cache.set(levelSettings, item, thinkingLevel)
    assert.equal(
      cache.get(buildSettings({ thinkingLevel: ` ${thinkingLevel.toUpperCase()} ` }), item),
      thinkingLevel,
    )
  }
})

test("translation cache evicts least recently used entries", () => {
  const cache = createTranslationCache({ limit: 2 })
  const settings = buildSettings()
  const alpha = { id: "a", text: "Alpha" }
  const beta = { id: "b", text: "Beta" }
  const gamma = { id: "c", text: "Gamma" }

  cache.set(settings, alpha, "A")
  cache.set(settings, beta, "B")
  assert.equal(cache.get(settings, alpha), "A")
  cache.set(settings, gamma, "C")

  assert.equal(cache.get(settings, beta), null)
  assert.equal(cache.get(settings, alpha), "A")
  assert.equal(cache.get(settings, gamma), "C")
})
