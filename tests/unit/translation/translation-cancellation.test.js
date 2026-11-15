import assert from "node:assert/strict"
import { afterEach, test } from "vitest"

import * as Api from "../../../src/browser/translation/translation/api.js"
import { translateItemsProgressively } from "../../../src/browser/translation/translation/progressive.js"
import { InvalidTranslationResponseError } from "../../../src/browser/translation/translation/responses.js"

const settings = {
  model: "cancellation-test",
  targetLanguage: "French",
  systemPromptTemplate: "Translate",
  userPromptTemplate: "{{sourcePayload}}",
}
const items = [{ id: "cue", kind: "subtitle", text: "Hello" }]
const translations = [{ id: "cue", translation: "Bonjour" }]
const response = { text: JSON.stringify({ translations }) }

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function outcomeWithin(promise) {
  let timer
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ status: "resolved", value }),
        (error) => ({ status: "rejected", error }),
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ status: "pending" }), 100)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function createRuntime(overrides = {}) {
  return {
    async getModelCacheIdentity() {
      return "cancellation-test"
    },
    async complete() {
      return response
    },
    ...overrides,
  }
}

afterEach(() => Api.clearTranslationCache())

test("progressive setup rejection propagates before chunk collection", async () => {
  const error = new Error("model setup failed")
  const api = Api.createTranslationApi(
    createRuntime({
      async getModelCacheIdentity() {
        throw error
      },
    }),
  )
  await assert.rejects(
    translateItemsProgressively({ Api: api, settings, items }),
    (value) => value === error,
  )
})

test("a signal releases progressive translation when model setup ignores abort", async () => {
  const setup = deferred()
  const controller = new AbortController()
  let completionCalls = 0
  let setupSignal
  const api = Api.createTranslationApi(
    createRuntime({
      getModelCacheIdentity(_settings, options) {
        setupSignal = options?.signal
        return setup.promise
      },
      async complete() {
        completionCalls += 1
        return response
      },
    }),
  )
  const pending = translateItemsProgressively({
    Api: api,
    settings,
    items,
    signal: controller.signal,
  })
  const reason = new DOMException("Batch deadline", "TimeoutError")
  controller.abort(reason)
  const outcome = await outcomeWithin(pending)
  setup.resolve("cancellation-test")
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(outcome.status, "rejected")
  assert.equal(outcome.error, reason)
  assert.equal(setupSignal, controller.signal)
  assert.equal(completionCalls, 0)
})

test("ignored provider abort cannot deliver late callbacks or write translation cache", async () => {
  const completion = deferred()
  const started = deferred()
  const controller = new AbortController()
  let calls = 0
  let providerSignal
  const emitted = []
  const api = Api.createTranslationApi(
    createRuntime({
      complete(_settings, _input, options) {
        calls += 1
        providerSignal = options?.signal
        started.resolve()
        return calls === 1 ? completion.promise : Promise.resolve(response)
      },
    }),
  )
  const pending = translateItemsProgressively({
    Api: api,
    settings,
    items,
    signal: controller.signal,
    onTranslations(value) {
      emitted.push(...value)
    },
  })
  await started.promise
  controller.abort()
  const outcome = await outcomeWithin(pending)
  completion.resolve(response)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(outcome.status, "rejected")
  assert.equal(outcome.error.name, "AbortError")
  assert.equal(providerSignal, controller.signal)
  assert.deepEqual(emitted, [])
  assert.deepEqual(await api.requestTranslations({ settings, items }), translations)
  assert.equal(calls, 2, "late completion must not populate the global cache")
})

test("abandoned setup and provider rejections remain observed after cancellation", async () => {
  for (const stage of ["setup", "complete"]) {
    const abandoned = deferred()
    const started = deferred()
    const controller = new AbortController()
    const api = Api.createTranslationApi(
      createRuntime({
        [stage === "setup" ? "getModelCacheIdentity" : "complete"]() {
          started.resolve()
          return abandoned.promise
        },
      }),
    )
    const pending = api.requestTranslations({
      settings,
      items,
      signal: controller.signal,
    })
    await started.promise
    controller.abort()
    const outcome = await outcomeWithin(pending)
    assert.equal(outcome.status, "rejected")
    abandoned.reject(new Error(`late ${stage} failure`))
    await new Promise((resolve) => setImmediate(resolve))
  }
})

test("aborted chunk collection does not start queued chunks or call failure callbacks", async () => {
  const started = deferred()
  const abandoned = deferred()
  const controller = new AbortController()
  let calls = 0
  let rejectedCallbacks = 0
  const pending = Api.requestTranslationsBatchedProgressive({
    settings,
    chunks: [items, [{ ...items[0], id: "next", text: "Goodbye" }]],
    concurrency: 1,
    signal: controller.signal,
    completeImpl() {
      calls += 1
      started.resolve()
      return abandoned.promise
    },
    onChunkRejected() {
      rejectedCallbacks += 1
    },
  })
  await started.promise
  controller.abort()
  const outcome = await outcomeWithin(pending)
  abandoned.resolve(translations)
  assert.equal(outcome.status, "rejected")
  assert.equal(calls, 1)
  assert.equal(rejectedCallbacks, 0)
})

test("an aborted invalid response is not retried", async () => {
  const controller = new AbortController()
  let calls = 0
  const pending = Api.requestTranslations({
    settings,
    items,
    signal: controller.signal,
    async completeImpl() {
      calls += 1
      controller.abort()
      throw new InvalidTranslationResponseError(new Error("invalid JSON"))
    },
  })
  await assert.rejects(pending, { name: "AbortError" })
  assert.equal(calls, 1)
})

test("pre-aborted requests do not start model setup or provider work", async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  const api = Api.createTranslationApi(
    createRuntime({
      async getModelCacheIdentity() {
        calls += 1
        return "test"
      },
      async complete() {
        calls += 1
        return response
      },
    }),
  )
  await assert.rejects(api.requestTranslations({ settings, items, signal: controller.signal }), {
    name: "AbortError",
  })
  assert.equal(calls, 0)
})

test("normal progressive translation accepts an optional signal", async () => {
  const controller = new AbortController()
  const api = Api.createTranslationApi(createRuntime())
  const emitted = []
  const result = await translateItemsProgressively({
    Api: api,
    settings,
    items,
    signal: controller.signal,
    onTranslations(value) {
      emitted.push(...value)
    },
  })
  assert.equal(result.failures.length, 0)
  assert.equal(emitted[0].translation, "Bonjour")
  assert.deepEqual(result.incompleteSegmentIds, [])
})

test("raw API fetch receives the optional signal through response body consumption", async () => {
  const controller = new AbortController()
  const reading = deferred()
  const started = deferred()
  let fetchSignal
  const pending = Api.requestTranslations({
    settings: { ...settings, baseUrl: "https://example.test/v1" },
    items,
    signal: controller.signal,
    async fetchImpl(_url, options) {
      fetchSignal = options.signal
      started.resolve()
      return { ok: true, text: () => reading.promise }
    },
  })
  await started.promise
  controller.abort()
  const outcome = await outcomeWithin(pending)
  reading.resolve(JSON.stringify({ output_text: response.text }))
  assert.equal(outcome.status, "rejected")
  assert.equal(fetchSignal, controller.signal)
})

test("progressive wrappers suppress callbacks even when a custom chunk collector ignores abort", async () => {
  const collector = deferred()
  const controller = new AbortController()
  let collectOptions
  const emitted = []
  const pending = translateItemsProgressively({
    Api: {
      ...Api,
      requestTranslationsBatchedProgressive(options) {
        collectOptions = options
        return collector.promise
      },
    },
    settings,
    items,
    signal: controller.signal,
    onTranslations(value) {
      emitted.push(...value)
    },
  })
  controller.abort()
  const outcome = await outcomeWithin(pending)
  await collectOptions.onChunkResolved({ translations })
  collector.resolve({ successes: translations, failures: [] })
  assert.equal(outcome.status, "rejected")
  assert.equal(collectOptions.signal, controller.signal)
  assert.deepEqual(emitted, [])
})
