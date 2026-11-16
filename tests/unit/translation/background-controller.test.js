import assert from "node:assert/strict"
import { test } from "vitest"

import { createBackgroundController } from "../../../src/browser/translation/background/controller.js"
import { createBackgroundPlatform } from "../../../src/browser/translation/background/platform.js"
import * as Messages from "../../../src/browser/translation/shared/messages.js"
import * as Settings from "../../../src/browser/translation/shared/settings.js"
import * as Api from "../../../src/browser/translation/translation/api.js"
import {
  buildProgressiveRequestChunks,
  buildProgressiveRequestConcurrency,
} from "../../../src/browser/translation/translation/progressive.js"

function createController(options = {}) {
  const chrome =
    options.chrome ||
    Object.freeze({
      runtime: {
        getManifest() {
          return { version: "0.1.3" }
        },
        id: "trusted-extension-id",
      },
    })
  const pageTranslationQueue =
    options.pageTranslationQueue ||
    Object.freeze({
      enqueue() {},
      get() {},
      getTranslatedCount() {
        return 0
      },
      markTranslated() {},
      remove() {},
    })

  return createBackgroundController({
    chrome,
    Api: options.Api || {},
    Messages,
    ProviderRuntime: options.ProviderRuntime,
    Settings: options.Settings || {},
    SiteProfiles: {},
    logger: {
      debug() {},
      error() {},
      info() {},
    },
    openPdfTranslator: options.openPdfTranslator,
    TranslationSession: {
      createPageTranslationQueue(configuration) {
        options.captureQueueConfiguration?.(configuration)
        return pageTranslationQueue
      },
    },
    platform: {
      async ensureApiPermission() {
        return true
      },
      buildDebugPayload(settings) {
        return {
          debug: { enabled: Boolean(settings?.showTranslationDebugInfo) },
        }
      },
      buildTranslationAppearancePayload(settings) {
        return {
          translationAppearance: settings?.translationAppearance,
        }
      },
      buildYoutubeSubtitlePayload(settings) {
        return {
          youtubeSubtitleDisplayMode: Settings.normalizeYoutubeSubtitleDisplayMode(
            settings?.youtubeSubtitleDisplayMode,
          ),
        }
      },
    },
  })
}

test("background controller configures page and subtitle queue claim sizes", () => {
  let queueConfiguration

  createController({
    captureQueueConfiguration(configuration) {
      queueConfiguration = configuration
    },
  })

  assert.equal(queueConfiguration.concurrency, 5)
  assert.equal(queueConfiguration.batchSize, 8)
  assert.equal(queueConfiguration.getBatchSize({ kind: "paragraph" }), 1)
  assert.equal(queueConfiguration.getBatchSize({ kind: "subtitle" }), 8)
})

test("background controller groups short subtitle batches without changing page chunks", () => {
  const subtitles = Array.from({ length: 33 }, (_, index) => ({
    id: `caption-${index}`,
    kind: "subtitle",
    text: `Short caption ${index}`,
  }))
  let requestCount = 0

  for (let index = 0; index < subtitles.length; index += 8) {
    const batch = subtitles.slice(index, index + 8)
    const plan = Api.createRecursiveChunkPlan(batch)
    const chunks = buildProgressiveRequestChunks(Api, batch, plan)

    assert.equal(chunks.length, 1)
    assert.ok(chunks[0].length <= 8)
    assert.equal(buildProgressiveRequestConcurrency(batch, chunks, 5), 1)
    requestCount += chunks.length
  }
  assert.equal(requestCount, 5)

  const pageItems = [
    { id: "paragraph-1", kind: "paragraph", text: "First" },
    { id: "paragraph-2", kind: "paragraph", text: "Second" },
  ]
  const pagePlan = Api.createRecursiveChunkPlan(pageItems)

  assert.equal(buildProgressiveRequestChunks(Api, pageItems, pagePlan), pagePlan.chunks)
  assert.equal(buildProgressiveRequestConcurrency(pageItems, pagePlan.chunks, 5), 2)
})

test("content script injection waits for the generated idle bundle to mount", async () => {
  const sentMessages = []
  const injectedScripts = []
  const delays = []
  let pingCount = 0
  const platform = createBackgroundPlatform({
    Appearance: {},
    EmbeddedFrames: {},
    Messages,
    Settings: {},
    SiteProfiles: {},
    chrome: {
      runtime: {
        getManifest() {
          return {
            content_scripts: [
              {
                js: ["content_scripts/content-0.js"],
                matches: ["https://www.youtube.com/*"],
              },
            ],
          }
        },
      },
      scripting: {
        async executeScript(details) {
          injectedScripts.push(details)
        },
      },
      tabs: {
        async sendMessage(tabId, message, options) {
          pingCount += 1
          sentMessages.push({ message, options, tabId })

          if (pingCount < 3) {
            throw new Error("Could not establish connection. Receiving end does not exist.")
          }

          return { ok: true }
        },
      },
    },
    async sleep(delay) {
      delays.push(delay)
    },
  })

  await platform.ensureContentScript(17, 3)

  assert.equal(pingCount, 3)
  assert.equal(
    sentMessages.every(({ message }) => message.type === "ping"),
    true,
  )
  assert.deepEqual(injectedScripts, [
    {
      files: ["content_scripts/content-0.js"],
      target: { frameIds: [3], tabId: 17 },
    },
  ])
  assert.deepEqual(delays, [100])
})

test("background controller rejects messages without the extension sender id", async () => {
  const controller = createController()

  assert.deepEqual(await controller.handleRuntimeMessage(Messages.getRuntimeHealth(), {}), {
    ok: false,
    error: "Untrusted message sender.",
  })
  assert.deepEqual(
    await controller.handleRuntimeMessage(Messages.getRuntimeHealth(), {
      id: "other-extension-id",
    }),
    { ok: false, error: "Untrusted message sender." },
  )
})

test("background controller accepts health checks from this extension", async () => {
  const controller = createController()

  assert.deepEqual(
    await controller.handleRuntimeMessage(Messages.getRuntimeHealth(), {
      id: "trusted-extension-id",
    }),
    { ok: true, component: "background", version: "0.1.3" },
  )
})

test("model endpoint lookup ignores unrelated prompt validation errors", async () => {
  let receivedSettings
  const controller = createController({
    ProviderRuntime: {
      async getModelEndpointPatterns(settings) {
        receivedSettings = settings
        return ["https://api.example.com/*"]
      },
    },
    Settings,
  })
  const message = Messages.getModelEndpoints({
    ...Settings.DEFAULT_SETTINGS,
    provider: Settings.CUSTOM_PROVIDER,
    model: "mock-model",
    customBaseUrl: "https://api.example.com/v1",
    userPromptTemplate: "Missing the source placeholder",
  })

  assert.deepEqual(
    await controller.handleRuntimeMessage(message, {
      id: "trusted-extension-id",
      url: "chrome-extension://trusted-extension-id/options/index.html",
    }),
    { ok: true, origins: ["https://api.example.com/*"] },
  )
  assert.equal(receivedSettings.provider, Settings.CUSTOM_PROVIDER)
  assert.equal(receivedSettings.model, "mock-model")
})

test("connection tests bypass the translation cache", async () => {
  let request
  const controller = createController({
    Api: {
      async requestTranslations(options) {
        request = options
        return [{ id: "sample", translation: "你好" }]
      },
    },
    Settings,
  })

  const response = await controller.handleRuntimeMessage(
    Messages.createMessage(Messages.MESSAGE_TYPES.TEST_CONNECTION, {
      ...Settings.DEFAULT_SETTINGS,
    }),
    {
      id: "trusted-extension-id",
      url: "chrome-extension://trusted-extension-id/options/index.html",
    },
  )

  assert.equal(request.bypassCache, true)
  assert.equal(response.ok, true)
  assert.equal(response.translation, "你好")
})

test("background controller returns an active frame session for content reinjection", async () => {
  const session = {
    sessionId: "page-session",
    settings: {
      showTranslationDebugInfo: true,
      targetLanguage: "French",
      translationAppearance: { preset: "minimal" },
      youtubeSubtitleDisplayMode: "bilingual",
    },
  }
  const requestedSessions = []
  const controller = createController({
    pageTranslationQueue: {
      enqueue() {},
      get(tabId, sessionId, frameId) {
        requestedSessions.push({ tabId, sessionId, frameId })
        return session
      },
      getTranslatedCount() {
        return 0
      },
      markTranslated() {},
      remove() {},
    },
  })

  assert.deepEqual(
    await controller.handleRuntimeMessage(Messages.getPageTranslationSession(), {
      id: "trusted-extension-id",
      tab: { id: 17 },
      frameId: 3,
    }),
    {
      ok: true,
      active: true,
      sessionId: "page-session",
      targetLanguage: "French",
      translationAppearance: session.settings.translationAppearance,
      youtubeSubtitleDisplayMode: "bilingual",
      debug: { enabled: true },
    },
  )
  assert.deepEqual(requestedSessions, [{ tabId: 17, sessionId: undefined, frameId: 3 }])
})

test("startup and render payloads carry the normalized YouTube subtitle display mode", async () => {
  const sentMessages = []
  const settings = {
    apiKey: "sk-demo",
    baseUrl: "https://example.com/v1",
    model: "demo-model",
    targetLanguage: "French",
    userPromptTemplate: "{{sourcePayload}}",
    youtubeSubtitleDisplayMode: "bilingual",
  }
  let processBatch
  const session = { sessionId: "page-session", settings }
  const chrome = {
    action: {
      setBadgeBackgroundColor: async () => {},
      setBadgeText: async () => {},
    },
    permissions: {
      contains: async () => true,
      request: async () => true,
    },
    runtime: {
      getManifest() {
        return {
          content_scripts: [{ js: ["content.js"], matches: ["*://*.youtube.com/*"] }],
          version: "0.1.3",
        }
      },
      id: "trusted-extension-id",
    },
    scripting: {
      executeScript: async () => [],
    },
    tabs: {
      async sendMessage(_tabId, message) {
        sentMessages.push(message)
        if (message.type === Messages.MESSAGE_TYPES.PING) {
          return { ok: true }
        }
        if (message.type === Messages.MESSAGE_TYPES.START_PAGE_TRANSLATION_SESSION) {
          return {
            items: [{ id: "caption-1", kind: "subtitle", text: "Hello" }],
            totalSegments: 1,
          }
        }
        return { ok: true }
      },
    },
  }
  const controllerSettings = {
    ...Settings,
    async getSettings() {
      return settings
    },
    hasCompleteSettings() {
      return true
    },
  }
  const platform = createBackgroundPlatform({
    Appearance: {
      normalizeTranslationAppearance(value) {
        return value
      },
    },
    EmbeddedFrames: {
      async discoverEmbeddedFrames() {
        return []
      },
    },
    Messages,
    Settings: controllerSettings,
    SiteProfiles: {},
    chrome,
  })
  const queue = {
    create() {
      return session
    },
    enqueue(_tabId, _sessionId, items) {
      return { queued: items.length }
    },
    get() {
      return session
    },
    getTranslatedCount() {
      return 1
    },
    markTranslated() {},
    remove() {},
  }
  const controller = createBackgroundController({
    Api: {
      consumeProgressiveTranslations(_chunkPlan, _mergeState, translations) {
        return translations
      },
      createProgressiveMergeState() {
        return {}
      },
      createRecursiveChunkPlan(items) {
        return { chunks: [items] }
      },
      getIncompleteSegmentIds() {
        return []
      },
      async requestTranslationsBatchedProgressive({ onChunkResolved }) {
        await onChunkResolved({
          translations: [
            {
              id: "caption-1",
              kind: "subtitle",
              sourceText: "Hello",
              translation: "Bonjour",
            },
          ],
        })
        return { failures: [] }
      },
    },
    Messages,
    Settings: controllerSettings,
    SiteProfiles: {},
    TranslationSession: {
      createPageTranslationQueue(configuration) {
        processBatch = configuration.processBatch
        return queue
      },
      shouldKeepPageTranslationSession() {
        return true
      },
    },
    chrome,
    logger: { debug() {}, error() {}, info() {} },
    platform,
  })

  await controller.translatePage({
    id: 17,
    url: "https://www.youtube.com/watch?v=demo",
  })
  await processBatch({
    frameId: 0,
    items: [{ id: "caption-1", kind: "subtitle", text: "Hello" }],
    sessionId: session.sessionId,
    tabId: 17,
  })

  const startupMessage = sentMessages.find(
    (message) => message.type === Messages.MESSAGE_TYPES.START_PAGE_TRANSLATION_SESSION,
  )
  const renderMessage = sentMessages.find(
    (message) => message.type === Messages.MESSAGE_TYPES.RENDER_PAGE_TRANSLATION_UPDATES,
  )
  assert.equal(startupMessage.payload.youtubeSubtitleDisplayMode, "bilingual")
  assert.equal(renderMessage.payload.youtubeSubtitleDisplayMode, "bilingual")
})

test("automation target resolution authorizes extension pages and finds exact URLs", async () => {
  const pageUrl = "https://example.com/document.pdf"
  let openedTab
  let queryCount = 0
  const chrome = {
    runtime: {
      getManifest() {
        return { version: "0.1.3" }
      },
      id: "trusted-extension-id",
    },
    tabs: {
      async query() {
        queryCount += 1
        return [{ id: 17, url: pageUrl }]
      },
    },
  }
  const controller = createController({
    chrome,
    async openPdfTranslator(tab) {
      openedTab = tab
      return { readerTabId: 27 }
    },
  })
  const message = Messages.automationOpenPdf({ pageUrl })

  assert.deepEqual(
    await controller.handleRuntimeMessage(message, {
      id: chrome.runtime.id,
      url: "https://example.com/not-extension-owned",
    }),
    {
      ok: false,
      error: "Automation commands require an extension page.",
    },
  )
  assert.equal(queryCount, 0)
  assert.deepEqual(
    await controller.handleRuntimeMessage(message, {
      id: chrome.runtime.id,
      url: `chrome-extension://${chrome.runtime.id}/fixture.html`,
    }),
    { ok: true, readerTabId: 27 },
  )
  assert.deepEqual(openedTab, { id: 17, url: pageUrl })
})

test("automation target resolution preserves missing-tab errors", async () => {
  const chrome = {
    runtime: {
      getManifest() {
        return { version: "0.1.3" }
      },
      id: "trusted-extension-id",
    },
    tabs: {
      async query() {
        return []
      },
    },
  }
  const controller = createController({ chrome })

  await assert.rejects(
    controller.handleRuntimeMessage(
      Messages.automationOpenPdf({
        pageUrl: "https://example.com/missing.pdf",
      }),
      {
        id: chrome.runtime.id,
        url: `chrome-extension://${chrome.runtime.id}/fixture.html`,
      },
    ),
    /Could not resolve the PDF automation tab\./,
  )
})

test("background controller reports no reinjection session without a sender tab", async () => {
  const controller = createController()

  assert.deepEqual(
    await controller.handleRuntimeMessage(Messages.getPageTranslationSession(), {
      id: "trusted-extension-id",
    }),
    { ok: true, active: false },
  )
})
