import { normalizeThinkingLevel } from "../shared/settings.js"

const DEFAULT_TRANSLATION_CACHE_LIMIT = 500
const TRANSLATION_SCHEMA_VERSION = 1

function buildTranslationCacheKey(settings, item) {
  return JSON.stringify({
    schemaVersion: TRANSLATION_SCHEMA_VERSION,
    provider: String(settings?.provider || "").trim(),
    model: String(settings?.model || "").trim(),
    thinkingLevel: normalizeThinkingLevel(settings?.thinkingLevel),
    customBaseUrl: String(settings?.customBaseUrl || "").trim(),
    modelCacheIdentity: String(settings?.modelCacheIdentity || "").trim(),
    systemPromptTemplate: String(settings?.systemPromptTemplate || "").trim(),
    userPromptTemplate: String(settings?.userPromptTemplate || "").trim(),
    targetLanguage: String(settings?.targetLanguage || "").trim(),
    kind: String(item?.kind || "paragraph"),
    isUI: Boolean(item?.isUI),
    isMetadata: Boolean(item?.isMetadata),
    containsMath: Boolean(item?.containsMath),
    text: String(item?.text || ""),
  })
}

function createTranslationCache(options = {}) {
  const limit = Math.max(1, Math.floor(options.limit || DEFAULT_TRANSLATION_CACHE_LIMIT))
  const cache = new Map()

  function get(settings, item) {
    const cacheKey = buildTranslationCacheKey(settings, item)

    if (!cache.has(cacheKey)) {
      return null
    }

    const cachedTranslation = cache.get(cacheKey)

    cache.delete(cacheKey)
    cache.set(cacheKey, cachedTranslation)

    return cachedTranslation
  }

  function set(settings, item, translation) {
    const cacheKey = buildTranslationCacheKey(settings, item)

    cache.delete(cacheKey)
    cache.set(cacheKey, String(translation || ""))

    while (cache.size > limit) {
      const oldestKey = cache.keys().next().value

      if (!oldestKey) {
        break
      }

      cache.delete(oldestKey)
    }
  }

  function clear() {
    cache.clear()
  }

  function splitItemsByCache(settings, items) {
    const cachedTranslations = []
    const missingItems = []

    for (const item of items || []) {
      const cachedTranslation = get(settings, item)

      if (typeof cachedTranslation === "string") {
        cachedTranslations.push({
          id: item.id,
          translation: cachedTranslation,
        })
      } else {
        missingItems.push(item)
      }
    }

    return {
      cachedTranslations,
      missingItems,
    }
  }

  function cacheTranslations(settings, items, translations) {
    const itemsById = new Map((items || []).map((item) => [item.id, item]))

    for (const translation of translations || []) {
      const item = itemsById.get(translation.id)

      if (!item) {
        continue
      }

      set(settings, item, translation.translation)
    }
  }

  return {
    cacheTranslations,
    clear,
    get,
    set,
    splitItemsByCache,
  }
}

export { buildTranslationCacheKey, createTranslationCache, DEFAULT_TRANSLATION_CACHE_LIMIT }
