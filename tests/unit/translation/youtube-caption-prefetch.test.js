import assert from "node:assert/strict"
import { test } from "vitest"

import { createYoutubeCaptionPrefetch } from "../../../src/browser/translation/background/youtube-caption-prefetch.js"

function createFixture() {
  const acceptedIds = new Set()
  const enqueued = []
  const diagnostics = []
  const fetches = []
  const payload = {
    events: [
      { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "Zero" }] },
      { tStartMs: 30000, dDurationMs: 1000, segs: [{ utf8: "Thirty" }] },
      { tStartMs: 59999, dDurationMs: 1000, segs: [{ utf8: "Sixty" }] },
      { tStartMs: 60000, dDurationMs: 1000, segs: [{ utf8: "Boundary" }] },
      { tStartMs: 90000, dDurationMs: 1000, segs: [{ utf8: "Ninety" }] },
      { tStartMs: 119999, dDurationMs: 1000, segs: [{ utf8: "One twenty" }] },
      {
        tStartMs: 120000,
        dDurationMs: 1000,
        segs: [{ utf8: "Two minute boundary" }],
      },
      {
        tStartMs: 179999,
        dDurationMs: 1000,
        segs: [{ utf8: "Three minutes" }],
      },
    ],
  }
  const prefetch = createYoutubeCaptionPrefetch({
    async enqueue(context) {
      enqueued.push(context)
      const accepted = context.items.filter((item) => !acceptedIds.has(item.id))

      for (const item of accepted) {
        acceptedIds.add(item.id)
      }
      return { queued: accepted.length }
    },
    async fetch(url, init) {
      fetches.push({ init, url })
      return new Response(JSON.stringify(payload))
    },
    onDiagnostic(stage, detail) {
      diagnostics.push({ stage, detail })
    },
  })

  return { diagnostics, enqueued, fetches, prefetch }
}

test("initialization fetches JSON3 and queues the current 60-second window", async () => {
  const { diagnostics, enqueued, fetches, prefetch } = createFixture()

  assert.deepEqual(
    await prefetch.initialize({
      baseUrl: "https://www.youtube.com/api/timedtext?v=abc",
      currentTimeMs: 0,
      frameId: 0,
      sessionId: "session-1",
      tabId: 7,
    }),
    {
      attemptSource: "advertised",
      httpStatus: 200,
      available: true,
      cueCount: 8,
      queued: 3,
      sessionStatus: "active",
    },
  )
  assert.equal(new URL(fetches[0].url).searchParams.get("fmt"), "json3")
  assert.deepEqual(fetches[0].init, { credentials: "include" })
  assert.match(enqueued[0].items[0].id, /^youtube-cue-0-0$/u)
  assert.deepEqual(
    enqueued[0].items.map((item) => item.text),
    ["Zero", "Thirty", "Sixty"],
  )
  assert.equal(enqueued[0].placement, "front")
  assert.equal(enqueued[0].windowMs, 60000)
  assert.deepEqual(diagnostics.at(-2), {
    stage: "prefetch-window",
    detail: "rate=1; window=60000ms; placement=front; cues=3; queued=3",
  })
  assert.equal(diagnostics.at(-1).stage, "prefetch-ready")
})

test("playback rate expands the media window while preserving a bounded lead", async () => {
  for (const [playbackRate, expectedTexts, expectedWindowMs] of [
    [1, ["Zero", "Thirty", "Sixty"], 60000],
    [1.5, ["Zero", "Thirty", "Sixty", "Boundary"], 90000],
    [2, ["Zero", "Thirty", "Sixty", "Boundary", "Ninety", "One twenty"], 120000],
    ["fast", ["Zero", "Thirty", "Sixty"], 60000],
  ]) {
    const { enqueued, prefetch } = createFixture()

    await prefetch.initialize({
      baseUrl: "https://www.youtube.com/api/timedtext?v=rate",
      currentTimeMs: 0,
      playbackRate,
      sessionId: `session-${playbackRate}`,
      tabId: 7,
    })
    assert.deepEqual(
      enqueued[0].items.map((item) => item.text),
      expectedTexts,
    )
    assert.equal(enqueued[0].windowMs, expectedWindowMs)
  }
})

test("progress refills an overlapping window without duplicate cue IDs", async () => {
  const { enqueued, prefetch } = createFixture()

  await prefetch.initialize({
    baseUrl: "https://www.youtube.com/api/timedtext?v=abc",
    currentTimeMs: 0,
    frameId: 0,
    sessionId: "session-1",
    tabId: 7,
  })
  assert.deepEqual(
    await prefetch.update({
      currentTimeMs: 30001,
      sessionId: "session-1",
      tabId: 7,
    }),
    { available: true, queued: 2, sessionStatus: "active" },
  )
  assert.deepEqual(
    enqueued[1].items.map((item) => item.text),
    ["Thirty", "Sixty", "Boundary", "Ninety"],
  )
  assert.equal(enqueued[1].placement, "back")
  assert.deepEqual(
    await prefetch.update({
      currentTimeMs: 31000,
      sessionId: "session-1",
      tabId: 7,
    }),
    { available: true, queued: 0, sessionStatus: "active" },
  )
})

test("prefetch queues every overlapping active cue for exact DOM matching", async () => {
  const enqueued = []
  const prefetch = createYoutubeCaptionPrefetch({
    async enqueue(context) {
      enqueued.push(context)
      return { queued: context.items.length }
    },
    async fetch() {
      return new Response(
        JSON.stringify({
          events: [
            {
              tStartMs: 1000,
              dDurationMs: 5000,
              segs: [{ utf8: "First active line" }],
            },
            {
              tStartMs: 3000,
              dDurationMs: 4000,
              segs: [{ utf8: "Second active line" }],
            },
          ],
        }),
      )
    },
  })

  assert.deepEqual(
    await prefetch.initialize({
      baseUrl: "https://www.youtube.com/api/timedtext?v=overlap",
      currentTimeMs: 4000,
      sessionId: "session-overlap",
      tabId: 9,
    }),
    {
      attemptSource: "advertised",
      httpStatus: 200,
      available: true,
      cueCount: 2,
      queued: 2,
      sessionStatus: "active",
    },
  )
  assert.deepEqual(
    enqueued[0].items.map((item) => item.text),
    ["First active line", "Second active line"],
  )
})

test("seek windows return to the front of the queue", async () => {
  const { enqueued, prefetch } = createFixture()

  await prefetch.initialize({
    baseUrl: "https://www.youtube.com/api/timedtext?v=seek",
    currentTimeMs: 0,
    sessionId: "session-seek",
    tabId: 7,
  })
  await prefetch.update({
    currentTimeMs: 90000,
    reason: "seek",
    sessionId: "session-seek",
    tabId: 7,
  })

  assert.equal(enqueued[1].placement, "front")
})

test("a later refill can offer failed timed cues again", async () => {
  const enqueued = []
  const prefetch = createYoutubeCaptionPrefetch({
    async enqueue(context) {
      enqueued.push(context)
      return { queued: context.items.length }
    },
    async fetch() {
      return new Response(
        JSON.stringify({
          events: [{ tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: "Retry me" }] }],
        }),
      )
    },
  })

  await prefetch.initialize({
    baseUrl: "https://www.youtube.com/api/timedtext?v=retry",
    currentTimeMs: 0,
    sessionId: "session-retry",
    tabId: 7,
  })
  assert.deepEqual(
    await prefetch.update({
      currentTimeMs: 0,
      reason: "progress",
      sessionId: "session-retry",
      tabId: 7,
    }),
    { available: true, queued: 1, sessionStatus: "active" },
  )
  assert.equal(enqueued.length, 2)
  assert.equal(enqueued[1].items[0].id, enqueued[0].items[0].id)
})

test("unavailable or malformed timed captions preserve fallback behavior", async () => {
  const diagnostics = []
  const prefetch = createYoutubeCaptionPrefetch({
    async fetch() {
      throw new Error("timed text unavailable")
    },
    onDiagnostic(stage, detail) {
      diagnostics.push({ stage, detail })
    },
  })

  assert.deepEqual(
    await prefetch.initialize({
      baseUrl: "https://www.youtube.com/api/timedtext?v=abc",
      currentTimeMs: 0,
      sessionId: "session-1",
      tabId: 7,
    }),
    {
      attemptSource: "advertised",
      reason: "network-error",
      available: false,
      cueCount: 0,
      queued: 0,
      sessionStatus: "active",
    },
  )
  assert.equal(diagnostics.at(-1).stage, "prefetch-fallback")
  assert.deepEqual(
    await prefetch.initialize({
      baseUrl: "https://attacker.example/timedtext",
      currentTimeMs: 0,
      sessionId: "session-2",
      tabId: 7,
    }),
    {
      attemptSource: "advertised",
      reason: "untrusted-url",
      available: false,
      cueCount: 0,
      queued: 0,
      sessionStatus: "active",
    },
  )
  assert.equal(diagnostics.length, 2)
  assert.deepEqual(diagnostics.at(-1), {
    detail: "attempt=advertised; reason=untrusted-url; using visible captions",
    stage: "prefetch-fallback",
  })
  assert.doesNotMatch(JSON.stringify(diagnostics), /attacker\.example/u)
})

const privateUrl =
  "https://www.youtube.com/api/timedtext?v=private-video&pot=secret-proof&signature=secret-signature"
const privateError = new Error(`secret-exception ${privateUrl} secret-caption`)
const usableBody = JSON.stringify({
  events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "secret-caption" }] }],
})

test.each([
  { reason: "missing-url", baseUrl: "" },
  { reason: "untrusted-url", baseUrl: "https://attacker.example/secret" },
  {
    reason: "network-error",
    fetch: async () => {
      throw privateError
    },
  },
  {
    reason: "http-error",
    fetch: async () => new Response("secret-body", { status: 403 }),
    httpStatus: 403,
  },
  {
    reason: "empty-body",
    fetch: async () => new Response(""),
    httpStatus: 200,
  },
  {
    reason: "empty-body",
    fetch: async () => new Response(" \n\t"),
    httpStatus: 200,
  },
  {
    reason: "invalid-json",
    fetch: async () => new Response("secret-body invalid json"),
    httpStatus: 200,
  },
  {
    reason: "no-cues",
    fetch: async () => new Response('{"events":[]}'),
    httpStatus: 200,
  },
  {
    reason: "no-cues",
    fetch: async () => new Response('{"events":[{"segs":[{"utf8":"secret-caption"}]}]}'),
    httpStatus: 200,
  },
  {
    reason: "no-cues",
    fetch: async () => new Response('{"events":{"secret-body":true}}'),
    httpStatus: 200,
  },
  {
    reason: "network-error",
    fetch: async () => ({
      ok: true,
      status: 200,
      text: async () => {
        throw privateError
      },
    }),
    httpStatus: 200,
  },
  {
    reason: "enqueue-error",
    enqueue: async () => {
      throw privateError
    },
    httpStatus: 200,
  },
])("prefetch reports a safe $reason reason", async (options) => {
  const diagnostics = []
  let fetchCount = 0
  const prefetch = createYoutubeCaptionPrefetch({
    fetch: async (...args) => {
      fetchCount += 1
      return options.fetch ? options.fetch(...args) : new Response(usableBody)
    },
    enqueue: options.enqueue,
    onDiagnostic: (stage, detail) => diagnostics.push({ stage, detail }),
  })
  const result = await prefetch.initialize({
    attemptSource: "native-request",
    baseUrl: options.baseUrl ?? privateUrl,
    sessionId: "session-private",
    tabId: 1,
  })
  assert.deepEqual(result, {
    attemptSource: "native-request",
    available: false,
    cueCount: 0,
    queued: 0,
    sessionStatus: "active",
    reason: options.reason,
    ...(options.httpStatus === undefined ? {} : { httpStatus: options.httpStatus }),
  })
  assert.equal(fetchCount, options.baseUrl === undefined ? 1 : 0)
  assert.deepEqual(diagnostics, [
    {
      stage: "prefetch-fallback",
      detail: `attempt=native-request; reason=${options.reason}${options.httpStatus === undefined ? "" : `; status=${options.httpStatus}`}; using visible captions`,
    },
  ])
  assert.doesNotMatch(
    JSON.stringify({ result, diagnostics }),
    /secret|https:|attacker|private-video|session-private/u,
  )
  assert.equal((await prefetch.update({ tabId: 1, sessionId: "session-private" })).available, false)
})

test("untrusted attempt labels and nonnumeric status cannot enter diagnostics", async () => {
  const diagnostics = []
  const prefetch = createYoutubeCaptionPrefetch({
    fetch: async () => ({ ok: false, status: privateUrl }),
    onDiagnostic: (stage, detail) => diagnostics.push({ stage, detail }),
  })
  const result = await prefetch.initialize({
    tabId: 1,
    sessionId: "s",
    baseUrl: privateUrl,
    attemptSource: privateUrl,
  })
  assert.equal(result.attemptSource, "advertised")
  assert.equal(result.reason, "http-error")
  assert.equal(Object.hasOwn(result, "httpStatus"), false)
  assert.doesNotMatch(JSON.stringify({ result, diagnostics }), /secret|https:/u)
})

test.each(["fetch", "body", "enqueue"])(
  "cancellation during %s emits no failure or late ready event",
  async (stage) => {
    const diagnostics = []
    const controller = new AbortController()
    let release
    let entered
    const started = new Promise((resolve) => {
      entered = resolve
    })
    const pending = () => {
      entered()
      return new Promise((resolve) => {
        release = resolve
      })
    }
    const prefetch = createYoutubeCaptionPrefetch({
      fetch: async () =>
        stage === "fetch"
          ? pending()
          : {
              ok: true,
              status: 200,
              text: stage === "body" ? pending : async () => usableBody,
            },
      enqueue: stage === "enqueue" ? pending : async () => ({ queued: 1 }),
      onDiagnostic: (name, detail) => diagnostics.push({ name, detail }),
    })
    const initialization = prefetch.initialize({
      tabId: 1,
      sessionId: "s",
      baseUrl: privateUrl,
      signal: controller.signal,
    })
    await started
    controller.abort(privateError)
    prefetch.remove(1)
    const result = await initialization
    assert.equal(result.available, false)
    assert.equal(result.sessionStatus, "stale")
    release(
      stage === "fetch" ? new Response(usableBody) : stage === "body" ? usableBody : { queued: 1 },
    )
    await Promise.resolve()
    assert.deepEqual(diagnostics, [])
    assert.equal((await prefetch.update({ tabId: 1, sessionId: "s" })).sessionStatus, "missing")
  },
)
