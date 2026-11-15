import assert from "node:assert/strict"
import { test, vi } from "vitest"

import {
  createPdfController,
  createSettingsFingerprint,
  sanitizeError,
} from "../../../src/browser/pdf/controller.js"
import * as Pdf from "../../../src/browser/translation/shared/pdf.js"
import * as Api from "../../../src/browser/translation/translation/api.js"

function createEvent() {
  const listeners = []
  return {
    addListener(listener) {
      listeners.push(listener)
    },
    emit(...args) {
      for (const listener of listeners) listener(...args)
    },
  }
}

function createHarness(options = {}) {
  const storage = new Map()
  const pdf = options.Pdf || Pdf
  const createdTabs = []
  const permissionRequests = []
  const chrome = {
    permissions: {
      async contains() {
        return Boolean(options.permissionAlreadyGranted)
      },
      async request(permission) {
        permissionRequests.push(permission)
        return options.permissionDenied !== true
      },
    },
    runtime: {
      getURL(path) {
        return `chrome-extension://trusted/${path}`
      },
      id: "trusted",
    },
    storage: {
      session: {
        async get(key) {
          return storage.has(key) ? { [key]: storage.get(key) } : {}
        },
        async remove(key) {
          storage.delete(key)
        },
        async set(values) {
          for (const [key, value] of Object.entries(values)) storage.set(key, value)
        },
      },
    },
    tabs: {
      async create(details) {
        createdTabs.push(details)
        return { id: 77, ...details }
      },
    },
  }
  const progressiveApi = {
    ...Api,
    async requestTranslationsBatchedProgressive(request) {
      if (options.requestTranslationsBatchedProgressive) {
        return options.requestTranslationsBatchedProgressive(request)
      }
      if (options.translationFailure) {
        throw new Error("Expected translation failure")
      }
      const successes = []
      for (const chunk of request.chunks) {
        const translations = chunk.map((item) => ({
          id: item.id,
          translation: `translated:${item.id}`,
        }))
        successes.push(...translations)
        await request.onChunkResolved({ translations })
      }
      return { failures: [], successes }
    },
  }
  const platform = {
    async ensureApiPermission() {
      return options.apiPermissionDenied !== true
    },
    async getModelCacheIdentity() {
      return options.getModelCacheIdentity
        ? options.getModelCacheIdentity()
        : options.modelCacheIdentity || "test-model-cache-identity"
    },
    isDomainDisabled() {
      return false
    },
    async loadSettingsOrOpenOptions() {
      if (options.incompleteSettings) throw new Error("Settings are incomplete.")
      return {
        provider: "openai-compatible",
        customBaseUrl: "https://api.example/v1",
        model: "model",
        systemPromptTemplate: "system",
        targetLanguage: "台灣正體中文",
        userPromptTemplate: "{{sourcePayload}}",
      }
    },
  }
  const controller = createPdfController({
    Api: progressiveApi,
    Pdf: pdf,
    chrome,
    logger: { error() {}, info() {} },
    platform,
  })
  return { chrome, controller, createdTabs, permissionRequests, storage }
}

function createPort(overrides = {}) {
  const onDisconnect = createEvent()
  const onMessage = createEvent()
  const posted = []
  return {
    disconnected: false,
    name: overrides.name || Pdf.PDF_PORT_NAME,
    onDisconnect,
    onMessage,
    posted,
    sender: {
      id: overrides.senderId || "trusted",
      tab: { id: overrides.tabId || 77 },
      url: overrides.senderUrl || `chrome-extension://trusted/${Pdf.PDF_READER_PATH}`,
    },
    disconnect() {
      this.disconnected = true
      onDisconnect.emit()
    },
    postMessage(message) {
      posted.push(message)
    },
  }
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("Condition did not settle.")
}

async function openAndStart(harness, port = createPort()) {
  const opened = await harness.controller.openPdfTranslator({
    id: 42,
    title: "Private paper",
    url: "https://papers.example/document.pdf?token=secret",
  })
  assert.equal(harness.controller.handleConnect(port), true)
  port.onMessage.emit({ type: "start", launchToken: opened.token })
  await waitFor(() => port.posted.some((message) => message.type === "session-started"))
  const started = port.posted.find((message) => message.type === "session-started")
  port.onMessage.emit({
    type: "document",
    sessionId: started.sessionId,
    documentId: "document-1",
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  return { opened, port, started }
}

test("PDF settings fingerprint separates provider and custom endpoint caches", async () => {
  const settings = {
    provider: "openai",
    customBaseUrl: "https://api.openai.com/v1",
    model: "shared-model",
    systemPromptTemplate: "system",
    targetLanguage: "台灣正體中文",
    userPromptTemplate: "{{sourcePayload}}",
  }
  const original = await createSettingsFingerprint(settings)
  const otherProvider = await createSettingsFingerprint({
    ...settings,
    provider: "anthropic",
  })
  const firstCustomEndpoint = await createSettingsFingerprint({
    ...settings,
    provider: "openai-compatible",
    customBaseUrl: "https://first.example/v1",
  })
  const secondCustomEndpoint = await createSettingsFingerprint({
    ...settings,
    provider: "openai-compatible",
    customBaseUrl: "https://second.example/v1",
  })

  const firstCredentialEndpoint = await createSettingsFingerprint(
    settings,
    "first-model-cache-identity",
  )
  const secondCredentialEndpoint = await createSettingsFingerprint(
    settings,
    "second-model-cache-identity",
  )

  assert.notEqual(original, otherProvider)
  assert.notEqual(firstCustomEndpoint, secondCustomEndpoint)
  assert.notEqual(firstCredentialEndpoint, secondCredentialEndpoint)
})

test("PDF settings fingerprints separate normalized thinking levels", async () => {
  const settings = { model: "model" }
  const defaultFingerprint = await createSettingsFingerprint(settings)
  assert.equal(
    await createSettingsFingerprint({ ...settings, thinkingLevel: "default" }),
    defaultFingerprint,
  )
  assert.equal(
    await createSettingsFingerprint({ ...settings, thinkingLevel: "invalid" }),
    defaultFingerprint,
  )
  const fingerprints = [defaultFingerprint]
  for (const thinkingLevel of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    const fingerprint = await createSettingsFingerprint({
      ...settings,
      thinkingLevel,
    })
    assert.equal(
      await createSettingsFingerprint({
        ...settings,
        thinkingLevel: ` ${thinkingLevel.toUpperCase()} `,
      }),
      fingerprint,
    )
    fingerprints.push(fingerprint)
  }
  assert.equal(new Set(fingerprints).size, fingerprints.length)
})

test("PDF controller opens a tokenized reader with exact-origin permission", async () => {
  const harness = createHarness()
  const opened = await harness.controller.openPdfTranslator({
    id: 42,
    title: "Paper",
    url: "https://papers.example/document.pdf?token=secret",
  })

  assert.deepEqual(harness.permissionRequests, [{ origins: ["https://papers.example/*"] }])
  assert.equal(harness.createdTabs.length, 1)
  assert.match(harness.createdTabs[0].url, /pages\/pdf\.html#launch-/)
  assert.doesNotMatch(harness.createdTabs[0].url, /papers|secret/)
  assert.equal(opened.readerTabId, 77)
})

test("PDF controller opens extensionless sources only through explicit validation", async () => {
  const harness = createHarness()
  await assert.rejects(
    harness.controller.openPdfTranslator({
      id: 42,
      title: "download",
      url: "https://papers.example/download?id=1",
    }),
    /cannot be opened/,
  )
  await harness.controller.openPdfTranslator(
    {
      id: 42,
      title: "download",
      url: "https://papers.example/download?id=1",
    },
    { allowUnknownType: true },
  )
  assert.deepEqual(harness.permissionRequests, [{ origins: ["https://papers.example/*"] }])
})

test("PDF controller opens local PDF tabs without requesting file host access", async () => {
  const harness = createHarness()
  await harness.controller.openPdfTranslator({
    id: 42,
    title: "local.pdf",
    url: "file:///tmp/local.pdf",
  })

  assert.deepEqual(harness.permissionRequests, [])
  assert.equal(harness.createdTabs.length, 1)
})

test("PDF controller rejects untrusted reader ports", () => {
  const harness = createHarness()
  const port = createPort({ senderUrl: "https://example.com/" })

  assert.equal(harness.controller.handleConnect(port), false)
  assert.equal(port.disconnected, true)
})

test("PDF controller reports incomplete settings and API permission denial safely", async () => {
  for (const harness of [
    createHarness({ incompleteSettings: true }),
    createHarness({ apiPermissionDenied: true }),
  ]) {
    const opened = await harness.controller.openPdfTranslator({
      id: 42,
      title: "Paper",
      url: "https://papers.example/document.pdf",
    })
    const port = createPort()
    harness.controller.handleConnect(port)
    port.onMessage.emit({ type: "start", launchToken: opened.token })
    await waitFor(() => port.posted.some((message) => message.type === "error"))
    const error = port.posted.find((message) => message.type === "error")
    assert.equal(error.sessionId, "")
    assert.equal(JSON.stringify(error).includes("apiKey"), false)
  }
})

test("PDF controller rejects stale and cross-tab launch tokens", async () => {
  const harness = createHarness()
  const opened = await harness.controller.openPdfTranslator({
    id: 42,
    title: "Paper",
    url: "https://papers.example/document.pdf",
  })
  const wrongTabPort = createPort({ tabId: 88 })
  harness.controller.handleConnect(wrongTabPort)
  wrongTabPort.onMessage.emit({ type: "start", launchToken: opened.token })
  await waitFor(() => wrongTabPort.posted.some((message) => message.type === "error"))
  assert.match(
    wrongTabPort.posted.find((message) => message.type === "error").error,
    /already in use/,
  )

  const stalePort = createPort()
  harness.controller.handleConnect(stalePort)
  stalePort.onMessage.emit({ type: "start", launchToken: "launch-missing" })
  await waitFor(() => stalePort.posted.some((message) => message.type === "error"))
  assert.match(stalePort.posted.find((message) => message.type === "error").error, /expired/)
})

test("PDF controller starts one scoped session and emits progressive results", async () => {
  const harness = createHarness()
  const { port, started } = await openAndStart(harness)
  assert.equal(started.targetLanguage, "台灣正體中文")
  assert.equal(typeof started.settingsFingerprint, "string")
  assert.equal(started.apiKey, undefined)

  port.onMessage.emit({
    type: "queue",
    sessionId: started.sessionId,
    documentId: "document-1",
    requestId: "request-1",
    items: [{ id: "doc:p1:b1", kind: "paragraph", text: "Sensitive source" }],
  })
  await waitFor(() => port.posted.some((message) => message.type === "batch-complete"))
  const update = port.posted.find((message) => message.type === "translation-update")
  assert.deepEqual(update.translations, [{ id: "doc:p1:b1", translation: "translated:doc:p1:b1" }])
  assert.equal(JSON.stringify(port.posted).includes("Sensitive source"), false)
  assert.equal(JSON.stringify(port.posted).includes("secret"), true)
  assert.equal(JSON.stringify(port.posted).includes("apiKey"), false)
})

test("PDF controller rejects batches before a document is announced", async () => {
  const harness = createHarness()
  const opened = await harness.controller.openPdfTranslator({
    id: 42,
    title: "Paper",
    url: "https://papers.example/document.pdf",
  })
  const port = createPort()
  harness.controller.handleConnect(port)
  port.onMessage.emit({ type: "start", launchToken: opened.token })
  await waitFor(() => port.posted.some((message) => message.type === "session-started"))
  const started = port.posted.find((message) => message.type === "session-started")
  port.onMessage.emit({
    type: "queue",
    sessionId: started.sessionId,
    documentId: "document-1",
    requestId: "request-1",
    items: [{ id: "block-1", text: "text" }],
  })
  await waitFor(() =>
    port.posted.some(
      (message) =>
        message.type === "error" &&
        message.requestId === "request-1" &&
        /Start the PDF document/.test(message.error),
    ),
  )
})

test("PDF controller rejects duplicate request ids and skips retries of completed blocks", async () => {
  const harness = createHarness()
  const { port, started } = await openAndStart(harness)
  const batch = {
    type: "queue",
    sessionId: started.sessionId,
    documentId: "document-1",
    requestId: "request-1",
    items: [{ id: "doc:p1:b1", text: "First" }],
  }
  port.onMessage.emit(batch)
  await waitFor(() => port.posted.some((message) => message.type === "batch-complete"))
  const updateCount = port.posted.filter((message) => message.type === "translation-update").length
  port.onMessage.emit(batch)
  await waitFor(() =>
    port.posted.some((message) => message.type === "error" && /already used/.test(message.error)),
  )
  port.onMessage.emit({
    ...batch,
    type: "retry",
    requestId: "request-2",
  })
  await waitFor(() =>
    port.posted.some(
      (message) => message.type === "batch-complete" && message.requestId === "request-2",
    ),
  )
  assert.equal(
    port.posted.filter((message) => message.type === "translation-update").length,
    updateCount,
  )
})

test("PDF controller rejects changed text under a reused block id", async () => {
  const harness = createHarness()
  const { port, started } = await openAndStart(harness)
  port.onMessage.emit({
    type: "queue",
    sessionId: started.sessionId,
    documentId: "document-1",
    requestId: "request-1",
    items: [{ id: "doc:p1:b1", text: "First" }],
  })
  await waitFor(() => port.posted.some((message) => message.type === "batch-complete"))
  port.onMessage.emit({
    type: "retry",
    sessionId: started.sessionId,
    documentId: "document-1",
    requestId: "request-2",
    items: [{ id: "doc:p1:b1", text: "Changed" }],
  })
  await waitFor(() =>
    port.posted.some((message) => message.type === "error" && /changed/.test(message.error)),
  )
})

test("PDF controller reuses a tab-bound launch after a Port disconnect", async () => {
  const harness = createHarness()
  const { opened, port, started } = await openAndStart(harness)
  port.disconnect()
  const replacement = createPort()
  assert.equal(harness.controller.handleConnect(replacement), true)
  replacement.onMessage.emit({ type: "start", launchToken: opened.token })
  await waitFor(() => replacement.posted.some((message) => message.type === "session-started"))
  const replacementStarted = replacement.posted.find(
    (message) => message.type === "session-started",
  )
  assert.notEqual(replacementStarted.sessionId, started.sessionId)
})

test("PDF controller resets document accounting when the reader changes files", async () => {
  const limitedPdf = {
    ...Pdf,
    PDF_LIMITS: {
      ...Pdf.PDF_LIMITS,
      maximumDocumentCharacters: 10,
    },
  }
  const harness = createHarness({ Pdf: limitedPdf })
  const { port, started } = await openAndStart(harness)
  port.onMessage.emit({
    type: "document",
    sessionId: started.sessionId,
    documentId: "document-1",
  })
  port.onMessage.emit({
    type: "queue",
    sessionId: started.sessionId,
    documentId: "document-1",
    requestId: "request-1",
    items: [{ id: "shared-block", text: "12345678" }],
  })
  await waitFor(() =>
    port.posted.some(
      (message) => message.type === "batch-complete" && message.requestId === "request-1",
    ),
  )

  port.onMessage.emit({
    type: "queue",
    sessionId: started.sessionId,
    documentId: "document-1",
    requestId: "request-over-limit",
    items: [{ id: "second-block", text: "1234" }],
  })
  await waitFor(() =>
    port.posted.some(
      (message) =>
        message.type === "error" &&
        message.requestId === "request-over-limit" &&
        /too much text/.test(message.error),
    ),
  )

  port.onMessage.emit({
    type: "document",
    sessionId: started.sessionId,
    documentId: "document-2",
  })
  port.onMessage.emit({
    type: "queue",
    sessionId: started.sessionId,
    documentId: "document-2",
    requestId: "request-2",
    items: [{ id: "shared-block", text: "abcdefgh" }],
  })
  await waitFor(() =>
    port.posted.some(
      (message) => message.type === "batch-complete" && message.requestId === "request-2",
    ),
  )

  assert.equal(
    port.posted.some((message) => message.type === "error" && message.requestId === "request-2"),
    false,
  )
  assert.equal(
    port.posted.some(
      (message) =>
        message.type === "translation-update" &&
        message.documentId === "document-2" &&
        message.requestId === "request-2",
    ),
    true,
  )

  port.onMessage.emit({
    type: "queue",
    sessionId: started.sessionId,
    documentId: "document-1",
    requestId: "request-stale",
    items: [{ id: "stale-block", text: "x" }],
  })
  await waitFor(() =>
    port.posted.some(
      (message) =>
        message.type === "error" &&
        message.requestId === "request-stale" &&
        /document is stale/.test(message.error),
    ),
  )
  port.onMessage.emit({
    type: "queue",
    sessionId: started.sessionId,
    documentId: "document-2",
    requestId: "request-3",
    items: [{ id: "current-block", text: "x" }],
  })
  await waitFor(() =>
    port.posted.some(
      (message) => message.type === "batch-complete" && message.requestId === "request-3",
    ),
  )
})

test("PDF controller suppresses stale work after the document changes", async () => {
  const requests = []
  let oldRequestSettled = false
  let releaseOldRequest
  const oldRequestGate = new Promise((resolve) => {
    releaseOldRequest = resolve
  })
  const harness = createHarness({
    async requestTranslationsBatchedProgressive(request) {
      requests.push(request)
      const ids = request.chunks.flat().map((item) => item.id)
      if (ids.includes("old-active")) {
        await oldRequestGate
      }
      const translations = request.chunks
        .flat()
        .map((item) => ({ id: item.id, translation: `translated:${item.id}` }))
      await request.onChunkResolved({ translations })
      if (ids.includes("old-active")) {
        oldRequestSettled = true
      }
      return { failures: [], successes: translations }
    },
  })
  const { port, started } = await openAndStart(harness)
  const queue = (documentId, requestId, id) => {
    port.onMessage.emit({
      type: "queue",
      sessionId: started.sessionId,
      documentId,
      requestId,
      items: [{ id, text: id }],
    })
  }
  queue("document-1", "request-1", "old-active")
  await waitFor(() =>
    port.posted.some(
      (message) => message.type === "batch-started" && message.requestId === "request-1",
    ),
  )
  queue("document-1", "request-2", "old-queued")
  port.onMessage.emit({
    type: "document",
    sessionId: started.sessionId,
    documentId: "document-2",
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  queue("document-2", "request-3", "new-active")
  await waitFor(() =>
    port.posted.some(
      (message) => message.type === "batch-complete" && message.requestId === "request-3",
    ),
  )

  assert.equal(
    port.posted.some(
      (message) => message.type === "translation-update" && message.documentId === "document-1",
    ),
    false,
  )
  assert.equal(
    port.posted.some(
      (message) => message.type === "batch-started" && message.requestId === "request-2",
    ),
    false,
  )
  assert.equal(
    oldRequestSettled,
    false,
    "The replacement document must not wait for stale provider work.",
  )
  assert.equal(
    port.posted.some(
      (message) =>
        message.type === "translation-update" &&
        message.documentId === "document-2" &&
        message.translations.some((item) => item.id === "new-active"),
    ),
    true,
  )
  assert.equal(requests[0].signal.aborted, true)
  assert.equal(requests[1].signal.aborted, false)
  const messageCount = port.posted.length
  releaseOldRequest()
  await waitFor(() => oldRequestSettled)
  assert.equal(port.posted.length, messageCount)
  assert.equal(requests[1].signal.aborted, false, "Old completion must not abort the replacement.")
})

test("PDF controller accepts failed retries after a Port reconnect", async () => {
  const options = { translationFailure: true }
  const harness = createHarness(options)
  const { opened, port, started } = await openAndStart(harness)
  port.onMessage.emit({
    type: "queue",
    sessionId: started.sessionId,
    documentId: "document-1",
    requestId: "request-1",
    items: [{ id: "failed-block", text: "Retry me" }],
  })
  await waitFor(() =>
    port.posted.some((message) => message.type === "error" && message.requestId === "request-1"),
  )

  port.disconnect()
  options.translationFailure = false
  const replacement = createPort()
  harness.controller.handleConnect(replacement)
  replacement.onMessage.emit({ type: "start", launchToken: opened.token })
  await waitFor(() => replacement.posted.some((message) => message.type === "session-started"))
  const replacementStarted = replacement.posted.find(
    (message) => message.type === "session-started",
  )
  replacement.onMessage.emit({
    type: "document",
    sessionId: replacementStarted.sessionId,
    documentId: "document-1",
  })
  replacement.onMessage.emit({
    type: "retry",
    sessionId: replacementStarted.sessionId,
    documentId: "document-1",
    requestId: "request-2",
    items: [{ id: "failed-block", text: "Retry me" }],
  })
  await waitFor(() =>
    replacement.posted.some(
      (message) => message.type === "batch-complete" && message.requestId === "request-2",
    ),
  )
  assert.equal(
    replacement.posted.some(
      (message) =>
        message.type === "translation-update" &&
        message.translations.some((item) => item.id === "failed-block"),
    ),
    true,
  )
})

test("PDF controller cancellation prevents later queue work", async () => {
  const harness = createHarness()
  const { port, started } = await openAndStart(harness)
  port.onMessage.emit({ type: "cancel", sessionId: started.sessionId })
  await waitFor(() => port.posted.some((message) => message.type === "cancelled"))
  port.onMessage.emit({
    type: "queue",
    sessionId: started.sessionId,
    documentId: "document-1",
    requestId: "request-1",
    items: [{ id: "doc:p1:b1", text: "Late" }],
  })
  await waitFor(() => port.posted.some((message) => message.type === "error"))
  assert.equal(
    port.posted.some((message) => message.type === "translation-update"),
    false,
  )
})

for (const teardown of ["cancel", "disconnect", "tab removal", "document replacement"]) {
  test(`PDF ${teardown} aborts active document work and ignores late callbacks`, async () => {
    let request
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const harness = createHarness({
      async requestTranslationsBatchedProgressive(value) {
        request = value
        await gate
        await value.onChunkResolved({
          translations: [{ id: "old", translation: "Late" }],
        })
        return { successes: [], failures: [] }
      },
    })
    const { port, started } = await openAndStart(harness)
    port.onMessage.emit({
      type: "queue",
      sessionId: started.sessionId,
      documentId: "document-1",
      requestId: "active",
      items: [{ id: "old", text: "Old source" }],
    })
    await waitFor(() => request)
    try {
      assert.ok(
        request.signal instanceof AbortSignal,
        "The provider must receive the document abort signal.",
      )
      if (teardown === "cancel")
        port.onMessage.emit({ type: "cancel", sessionId: started.sessionId })
      if (teardown === "disconnect") port.disconnect()
      if (teardown === "tab removal") harness.controller.removeSessionByTab(77)
      if (teardown === "document replacement")
        port.onMessage.emit({
          type: "document",
          sessionId: started.sessionId,
          documentId: "document-2",
        })
      await waitFor(() => request.signal.aborted)
      release()
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert.equal(
        port.posted.some((message) => message.type === "translation-update"),
        false,
      )
    } finally {
      release()
    }
  })
}

test("PDF batch deadline aborts a stalled provider and releases queued work", async () => {
  const requests = []
  const harness = createHarness({
    async requestTranslationsBatchedProgressive(request) {
      requests.push(request)
      if (requests.length === 1) return new Promise(() => {})
      await request.onChunkResolved({
        translations: [{ id: "next", translation: "Recovered" }],
      })
      return { successes: [], failures: [] }
    },
  })
  const { port, started } = await openAndStart(harness)
  vi.useFakeTimers()
  try {
    for (const id of ["stalled", "next"]) {
      port.onMessage.emit({
        type: "queue",
        sessionId: started.sessionId,
        documentId: "document-1",
        requestId: id,
        items: [{ id, text: id }],
      })
      await vi.advanceTimersByTimeAsync(0)
    }
    assert.ok(requests[0].signal instanceof AbortSignal)
    await vi.advanceTimersByTimeAsync(119_999)
    assert.equal(requests[0].signal.aborted, false)
    assert.equal(requests.length, 1)
    await vi.advanceTimersByTimeAsync(1)
    assert.equal(requests[0].signal.aborted, true)
    assert.equal(requests.length, 2, "The next batch must not wait for the retired promise.")
    assert.equal(requests[1].signal.aborted, false)
    assert.ok(
      port.posted.some(
        (message) => message.type === "error" && message.failedIds.includes("stalled"),
      ),
    )
    assert.ok(
      port.posted.some(
        (message) => message.type === "batch-complete" && message.requestId === "next",
      ),
    )
    const count = port.posted.length
    await requests[0].onChunkResolved({
      translations: [{ id: "stalled", translation: "Late" }],
    })
    assert.equal(port.posted.length, count)
    await vi.advanceTimersByTimeAsync(120_000)
    assert.equal(requests[1].signal.aborted, false, "A completed batch must dispose its deadline.")
  } finally {
    vi.useRealTimers()
    port.disconnect()
  }
})

test("PDF errors redact URLs and authorization material", () => {
  assert.equal(
    sanitizeError(new Error("Request https://example.com/paper?token=x Bearer abc failed")),
    "Request [redacted URL] Bearer [redacted] failed",
  )
})

test("a disconnected late PDF startup cannot cancel a replacement session", async () => {
  let release
  let calls = 0
  const delayed = new Promise((resolve) => {
    release = resolve
  })
  const harness = createHarness({
    getModelCacheIdentity: () => (++calls === 1 ? delayed : "replacement"),
  })
  const old = createPort()
  harness.controller.handleConnect(old)
  old.onMessage.emit({ type: "start", launchToken: "local" })
  await waitFor(() => calls === 1)
  old.disconnect()
  const replacement = createPort()
  harness.controller.handleConnect(replacement)
  replacement.onMessage.emit({ type: "start", launchToken: "local" })
  await waitFor(() => replacement.posted.some((message) => message.type === "session-started"))
  release("old")
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(
    old.posted.some((message) => message.type === "session-started"),
    false,
  )
  const started = replacement.posted.find((message) => message.type === "session-started")
  replacement.onMessage.emit({
    type: "document",
    sessionId: started.sessionId,
    documentId: "replacement-document",
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(
    replacement.posted.some((message) => message.type === "cancelled"),
    false,
  )
})
