import { waitForAbortable } from "../shared/abort.js"
import * as CacheApi from "./cache.js"
import * as ChunkPlan from "./chunk-plan.js"
import * as ProtectedFragments from "./protected-fragments.js"
import * as ResponsesApi from "./responses.js"

const DEFAULT_MAX_BATCH_CHARS = 5000
const DEFAULT_MAX_CONCURRENCY = 5
const translationCache = CacheApi.createTranslationCache()
function clearTranslationCache() {
  translationCache.clear()
}

function mergeTranslationsInItemOrder(items, translations) {
  const translationById = new Map((translations || []).map((item) => [item.id, item.translation]))

  return (items || [])
    .filter((item) => translationById.has(item.id))
    .map((item) => ({
      id: item.id,
      translation: translationById.get(item.id),
    }))
}

const maskProtectedFragments = ProtectedFragments.maskProtectedFragments
const unmaskProtectedFragments = ProtectedFragments.unmaskProtectedFragments
const chunkTranslationItems = ChunkPlan.chunkTranslationItems
const createRecursiveChunkPlan = ChunkPlan.createRecursiveChunkPlan
const splitTextRecursively = ChunkPlan.splitTextRecursively
const createProgressiveMergeState = ChunkPlan.createProgressiveMergeState
const consumeProgressiveTranslations = ChunkPlan.consumeProgressiveTranslations
const mergeRecursiveTranslations = ChunkPlan.mergeRecursiveTranslations
const getIncompleteSegmentIds = ChunkPlan.getIncompleteSegmentIds
const buildResponsesRequest = ResponsesApi.buildResponsesRequest
const buildTranslationInput = ResponsesApi.buildTranslationInput
const callResponsesApi = ResponsesApi.callResponsesApi
const estimateTokenCount = ResponsesApi.estimateTokenCount
const extractOutputText = ResponsesApi.extractOutputText
const parseTranslationResponse = ResponsesApi.parseTranslationResponse
const stripCodeFences = ResponsesApi.stripCodeFences
const validateProtectedFragments = ProtectedFragments.validateProtectedFragments
const InvalidTranslationResponseError = ResponsesApi.InvalidTranslationResponseError

async function runBoundedScheduler(options) {
  const taskCount = Math.max(0, Math.floor(Number(options.taskCount) || 0))
  const concurrency = Math.max(
    1,
    Math.floor(Number(options.concurrency) || DEFAULT_MAX_CONCURRENCY),
  )
  const shouldContinue = options.shouldContinue || (() => true)
  let nextIndex = 0

  async function worker() {
    while (nextIndex < taskCount && shouldContinue()) {
      const taskIndex = nextIndex

      nextIndex += 1
      await options.runTask(taskIndex)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, taskCount) }, () => worker()))
}

async function requestTranslations(options) {
  const signal = options.signal
  signal?.throwIfAborted()
  const settings = options.settings
  const items = options.items || []
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const completeImpl = options.completeImpl || callResponsesApi

  if (items.length === 0) {
    return []
  }

  const { cachedTranslations, missingItems } = options.bypassCache
    ? { cachedTranslations: [], missingItems: items }
    : translationCache.splitItemsByCache(settings, items)

  if (missingItems.length === 0) {
    return mergeTranslationsInItemOrder(items, cachedTranslations)
  }

  if (typeof fetchImpl !== "function") {
    throw new Error("Fetch is not available.")
  }

  const requestFetch = signal ? (url, init) => fetchImpl(url, { ...init, signal }) : fetchImpl
  const complete = () => {
    signal?.throwIfAborted()
    return waitForAbortable(completeImpl(settings, missingItems, requestFetch, { signal }), signal)
  }
  let freshTranslations

  try {
    freshTranslations = await complete()
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof InvalidTranslationResponseError) {
      freshTranslations = await complete()
    } else {
      throw error
    }
  }

  signal?.throwIfAborted()
  if (!options.bypassCache) {
    translationCache.cacheTranslations(settings, missingItems, freshTranslations)
  }

  return mergeTranslationsInItemOrder(items, cachedTranslations.concat(freshTranslations))
}

async function requestTranslationsBatched(options) {
  const signal = options.signal
  signal?.throwIfAborted()
  const settings = options.settings
  const chunks = options.chunks || []
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const results = new Array(chunks.length)

  await runBoundedScheduler({
    taskCount: chunks.length,
    concurrency: options.concurrency,
    shouldContinue: () => !signal?.aborted,
    async runTask(chunkIndex) {
      results[chunkIndex] = await requestTranslations({
        settings,
        items: chunks[chunkIndex],
        fetchImpl,
        completeImpl: options.completeImpl,
        signal,
      })
    },
  })

  signal?.throwIfAborted()
  return results.flat()
}

async function requestTranslationsBatchedProgressive(options) {
  const signal = options.signal
  signal?.throwIfAborted()
  const settings = options.settings
  const chunks = options.chunks || []
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const onChunkResolved =
    typeof options.onChunkResolved === "function" ? options.onChunkResolved : null
  const onChunkRejected =
    typeof options.onChunkRejected === "function" ? options.onChunkRejected : null
  const shouldContinue =
    typeof options.shouldContinue === "function" ? options.shouldContinue : () => true
  const successes = []
  const failures = []

  await runBoundedScheduler({
    taskCount: chunks.length,
    concurrency: options.concurrency,
    shouldContinue: () => !signal?.aborted && shouldContinue(),
    async runTask(chunkIndex) {
      const chunkItems = chunks[chunkIndex]

      try {
        const result = await requestTranslations({
          settings,
          items: chunkItems,
          fetchImpl,
          completeImpl: options.completeImpl,
          signal,
        })

        signal?.throwIfAborted()
        successes[chunkIndex] = result

        if (onChunkResolved) {
          await waitForAbortable(
            onChunkResolved({
              chunkIndex,
              chunkItems,
              translations: result,
            }),
            signal,
          )
        }
      } catch (error) {
        const failure = {
          chunkIndex,
          chunkItems,
          error,
        }

        failures.push(failure)

        if (onChunkRejected && !signal?.aborted) {
          await waitForAbortable(onChunkRejected(failure), signal)
        }
      }
    },
  })

  signal?.throwIfAborted()
  return {
    successes: successes.filter(Boolean).flat(),
    failures,
  }
}

async function completeTranslationsWithProviderRuntime(
  providerRuntime,
  settings,
  items,
  options = {},
) {
  const signal = options.signal
  signal?.throwIfAborted()
  const input = buildTranslationInput({
    systemPromptTemplate: settings.systemPromptTemplate,
    userPromptTemplate: settings.userPromptTemplate,
    items,
    targetLanguage: settings.targetLanguage,
  })
  const response = await waitForAbortable(
    providerRuntime.complete(
      settings,
      {
        systemPrompt: input[0]?.content || "",
        userPrompt: input[1]?.content || "",
      },
      { signal },
    ),
    signal,
  )
  signal?.throwIfAborted()

  try {
    const translations = parseTranslationResponse({
      output_text: response.text,
    })
    ResponsesApi.validateTranslationCoverage(items, translations)
    validateProtectedFragments(items, translations)
    return translations
  } catch (error) {
    throw new InvalidTranslationResponseError(error)
  }
}

function createTranslationApi(providerRuntime) {
  const completeImpl = (settings, items, _fetchImpl, options) =>
    completeTranslationsWithProviderRuntime(providerRuntime, settings, items, options)
  async function withModelCacheIdentity(options) {
    const signal = options.signal
    signal?.throwIfAborted()
    const modelCacheIdentity = await waitForAbortable(
      providerRuntime.getModelCacheIdentity(options.settings, { signal }),
      signal,
    )
    signal?.throwIfAborted()
    return {
      ...options,
      completeImpl,
      settings: { ...options.settings, modelCacheIdentity },
    }
  }

  return {
    buildResponsesRequest,
    buildTranslationInput,
    chunkTranslationItems,
    clearTranslationCache,
    consumeProgressiveTranslations,
    createProgressiveMergeState,
    createRecursiveChunkPlan,
    estimateTokenCount,
    extractOutputText,
    getIncompleteSegmentIds,
    maskProtectedFragments,
    mergeRecursiveTranslations,
    parseTranslationResponse,
    requestTranslations: async (options) =>
      requestTranslations(await withModelCacheIdentity(options)),
    requestTranslationsBatched: async (options) =>
      requestTranslationsBatched(await withModelCacheIdentity(options)),
    requestTranslationsBatchedProgressive: async (options) =>
      requestTranslationsBatchedProgressive(await withModelCacheIdentity(options)),
    splitTextRecursively,
    stripCodeFences,
    unmaskProtectedFragments,
    validateProtectedFragments,
  }
}

export {
  buildResponsesRequest,
  buildTranslationInput,
  chunkTranslationItems,
  clearTranslationCache,
  completeTranslationsWithProviderRuntime,
  consumeProgressiveTranslations,
  createProgressiveMergeState,
  createRecursiveChunkPlan,
  createTranslationApi,
  DEFAULT_MAX_BATCH_CHARS,
  DEFAULT_MAX_CONCURRENCY,
  estimateTokenCount,
  extractOutputText,
  getIncompleteSegmentIds,
  maskProtectedFragments,
  mergeRecursiveTranslations,
  parseTranslationResponse,
  requestTranslations,
  requestTranslationsBatched,
  requestTranslationsBatchedProgressive,
  splitTextRecursively,
  stripCodeFences,
  unmaskProtectedFragments,
  validateProtectedFragments,
}
