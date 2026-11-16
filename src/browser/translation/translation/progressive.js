import { waitForAbortable } from "../shared/abort.js"

const DEFAULT_MAXIMUM_CONCURRENCY = 5

function buildProgressiveRequestChunks(Api, items, chunkPlan) {
  const canGroupSubtitles =
    items.length > 0 &&
    items.every((item) => item.kind === "subtitle") &&
    chunkPlan.expandedItems?.every((item) => item.partCount === 1)

  return canGroupSubtitles ? Api.chunkTranslationItems(chunkPlan.expandedItems) : chunkPlan.chunks
}

function buildProgressiveRequestConcurrency(items, requestChunks, maximum) {
  return items.length > 0 && items.every((item) => item.kind === "subtitle")
    ? 1
    : Math.min(
        Math.max(1, Number(maximum) || DEFAULT_MAXIMUM_CONCURRENCY),
        requestChunks.length || 1,
      )
}

async function translateItemsProgressively(options) {
  const {
    Api,
    settings,
    items = [],
    maximumConcurrency = DEFAULT_MAXIMUM_CONCURRENCY,
    isCurrent = () => true,
    onTranslations = async () => {},
    signal,
  } = options || {}

  signal?.throwIfAborted()
  if (!Api || !settings || items.length === 0) {
    return {
      successes: [],
      failures: [],
      incompleteSegmentIds: [],
      stale: !isCurrent(),
    }
  }

  const chunkPlan = Api.createRecursiveChunkPlan(items)
  const requestChunks = buildProgressiveRequestChunks(Api, items, chunkPlan)
  const mergeState = Api.createProgressiveMergeState(chunkPlan)
  let callbackError = null
  const result = await waitForAbortable(
    Api.requestTranslationsBatchedProgressive({
      settings,
      signal,
      chunks: requestChunks,
      shouldContinue: () => !signal?.aborted && isCurrent(),
      concurrency: buildProgressiveRequestConcurrency(items, requestChunks, maximumConcurrency),
      onChunkResolved: async ({ translations }) => {
        if (callbackError || signal?.aborted || !isCurrent()) {
          return
        }

        const completedTranslations = Api.consumeProgressiveTranslations(
          chunkPlan,
          mergeState,
          translations,
        )

        if (completedTranslations.length > 0 && !signal?.aborted && isCurrent()) {
          try {
            await onTranslations(completedTranslations)
          } catch (error) {
            callbackError ||= error
          }
        }
      },
    }),
    signal,
  )
  signal?.throwIfAborted()

  if (callbackError) {
    throw callbackError
  }

  return {
    ...result,
    incompleteSegmentIds: Api.getIncompleteSegmentIds(chunkPlan, mergeState),
    stale: !isCurrent(),
  }
}

export {
  buildProgressiveRequestChunks,
  buildProgressiveRequestConcurrency,
  translateItemsProgressively,
}
