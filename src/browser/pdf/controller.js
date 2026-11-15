import {
  createRequestAbortScope,
  TRANSLATION_BATCH_DEADLINE_MS,
} from "../translation/shared/abort.js"
import { normalizeThinkingLevel } from "../translation/shared/settings.js"
import { translateItemsProgressively } from "../translation/translation/progressive.js"

const LAUNCH_TTL_MS = 24 * 60 * 60 * 1000
const SESSION_ERROR_MAX_LENGTH = 300

function createRandomId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`
}

async function createSettingsFingerprint(settings, modelCacheIdentity = "") {
  const source = JSON.stringify({
    provider: settings.provider,
    model: settings.model,
    thinkingLevel: normalizeThinkingLevel(settings.thinkingLevel),
    customBaseUrl: settings.customBaseUrl,
    modelCacheIdentity,
    systemPromptTemplate: settings.systemPromptTemplate,
    targetLanguage: settings.targetLanguage,
    userPromptTemplate: settings.userPromptTemplate,
  })
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source))
  return Array.from(new Uint8Array(bytes).subarray(0, 12), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("")
}

function sanitizeError(error) {
  const message = String(error?.message || error || "PDF translation failed.")
    .replace(/https?:\/\/\S+/giu, "[redacted URL]")
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .trim()
    .slice(0, SESSION_ERROR_MAX_LENGTH)

  return message || "PDF translation failed."
}

function createPdfController(options = {}) {
  const { chrome, Api, Pdf, logger, platform } = options
  const launchTokensByTab = new Map()
  const sessionsByPort = new Map()
  const sessionsByTab = new Map()
  const ports = new WeakMap()
  const latestStarts = new Map()
  let startupSequence = 0
  const readerUrl = chrome.runtime.getURL(Pdf.PDF_READER_PATH)

  async function saveLaunch(record) {
    await chrome.storage.session.set({
      [`${Pdf.PDF_LAUNCH_PREFIX}${record.token}`]: record,
    })
  }

  async function getLaunch(token) {
    const key = `${Pdf.PDF_LAUNCH_PREFIX}${token}`
    const stored = await chrome.storage.session.get(key)
    const launch = stored[key]

    if (
      !launch ||
      Date.now() - Number(launch.createdAt || 0) > LAUNCH_TTL_MS ||
      (!launch.localOnly && !Pdf.parseHttpUrl(launch.sourceUrl))
    ) {
      await chrome.storage.session.remove(key)
      throw new Error("This PDF launch has expired. Open it again from the toolbar.")
    }

    return launch
  }

  async function bindLaunchToReader(token, readerTabId) {
    if (token === "local") {
      return {
        createdAt: Date.now(),
        localOnly: true,
        readerTabId,
        sourceUrl: "",
        title: "Local PDF document",
        token,
      }
    }
    const launch = await getLaunch(token)

    if (launch.readerTabId && launch.readerTabId !== readerTabId) {
      throw new Error("This PDF launch token is already in use.")
    }

    if (!launch.readerTabId) {
      launch.readerTabId = readerTabId
      await saveLaunch(launch)
    }
    launchTokensByTab.set(readerTabId, token)

    return launch
  }

  async function openPdfTranslator(tab, openOptions = {}) {
    let parsedUrl
    try {
      parsedUrl = new URL(String(tab?.url || ""))
    } catch (_error) {
      throw new Error("This PDF source cannot be opened.")
    }
    const localOnly = parsedUrl.protocol === "file:"
    if (
      !tab?.id ||
      (!localOnly && !Pdf.parseHttpUrl(parsedUrl)) ||
      (!openOptions.allowUnknownType && !Pdf.isPdfCandidateUrl(parsedUrl))
    ) {
      throw new Error("This PDF source cannot be opened.")
    }

    if (!localOnly) {
      const permission = {
        origins: [Pdf.getPdfSourcePermissionPattern(parsedUrl)],
      }
      const hasPermission =
        (await chrome.permissions.contains(permission)) ||
        (await chrome.permissions.request(permission))

      if (!hasPermission) {
        throw new Error("Permission to read this PDF origin was denied.")
      }
    }

    const token = createRandomId("launch")
    await saveLaunch({
      createdAt: Date.now(),
      localOnly,
      sourceTabId: tab.id,
      sourceUrl: localOnly ? "" : parsedUrl.toString(),
      title: Pdf.sanitizePdfTitle(
        tab.title,
        localOnly ? "Local PDF document" : Pdf.getPdfTitleFromUrl(parsedUrl),
      ),
      token,
    })
    const url = `${readerUrl}#${encodeURIComponent(token)}`
    const createdTab = await chrome.tabs.create({
      active: openOptions.active !== false,
      url,
    })

    if (createdTab?.id) {
      const launch = await getLaunch(token)
      launch.readerTabId = createdTab.id
      await saveLaunch(launch)
      launchTokensByTab.set(createdTab.id, token)
    }

    logger?.info("pdf-reader-opened", {
      sourceTabId: tab.id,
      readerTabId: createdTab?.id,
    })
    return { readerTabId: createdTab?.id, token }
  }

  function isCurrentSession(session) {
    return (
      !session.cancelled &&
      sessionsByPort.get(session.port) === session &&
      sessionsByTab.get(session.readerTabId) === session
    )
  }

  function post(session, message) {
    if (!isCurrentSession(session)) {
      return false
    }

    try {
      session.port.postMessage(message)
      return true
    } catch (_error) {
      cancelSession(session, false)
      return false
    }
  }

  function cancelSession(session, notify = true) {
    if (!session || session.cancelled) {
      return
    }

    if (notify) {
      post(session, Pdf.pdfSessionCancelled({ sessionId: session.sessionId }))
    }
    session.cancelled = true
    session.documentController?.abort()
    session.pendingBatches.length = 0
    session.sourceById.clear()
    session.pendingIds.clear()
    sessionsByPort.delete(session.port)
    if (sessionsByTab.get(session.readerTabId) === session) {
      sessionsByTab.delete(session.readerTabId)
    }
  }

  function startDocument(session, documentId) {
    if (session.documentId === documentId) {
      return
    }

    session.documentController?.abort()
    session.documentController = new AbortController()
    session.documentId = documentId
    session.documentSequence += 1
    session.characterCount = 0
    session.pendingBatches.length = 0
    session.completedIds.clear()
    session.failedIds.clear()
    session.pendingIds.clear()
    session.sourceById.clear()
  }

  function isCurrentBatch(session, batch) {
    return isCurrentSession(session) && session.documentSequence === batch.documentSequence
  }

  async function processBatch(session, batch) {
    if (!isCurrentBatch(session, batch)) {
      return
    }

    post(
      session,
      Pdf.pdfBatchStarted({
        sessionId: session.sessionId,
        documentId: batch.documentId,
        requestId: batch.requestId,
        itemCount: batch.items.length,
      }),
    )

    const abortScope = createRequestAbortScope(
      session.documentController.signal,
      TRANSLATION_BATCH_DEADLINE_MS,
    )
    const completedIds = []
    const batchIds = new Set(batch.items.map((item) => item.id))
    try {
      const result = await translateItemsProgressively({
        Api,
        settings: session.settings,
        items: batch.items,
        maximumConcurrency: 5,
        signal: abortScope.signal,
        isCurrent: () => isCurrentBatch(session, batch),
        onTranslations: async (translations) => {
          if (!isCurrentBatch(session, batch)) {
            return
          }

          const safeTranslations = translations
            .filter((translation) => batchIds.has(translation.id))
            .map((translation) => ({
              id: translation.id,
              translation: String(translation.translation || ""),
            }))
          if (
            post(
              session,
              Pdf.pdfTranslationUpdate({
                sessionId: session.sessionId,
                documentId: batch.documentId,
                requestId: batch.requestId,
                translations: safeTranslations,
              }),
            )
          ) {
            for (const translation of safeTranslations) {
              completedIds.push(translation.id)
              session.completedIds.add(translation.id)
              session.failedIds.delete(translation.id)
            }
          }
        },
      })

      if (!isCurrentBatch(session, batch) || result.stale) {
        return
      }

      const failedIds = result.incompleteSegmentIds.filter((id) => !session.completedIds.has(id))
      for (const id of failedIds) {
        session.failedIds.add(id)
      }
      post(
        session,
        Pdf.pdfBatchComplete({
          sessionId: session.sessionId,
          documentId: batch.documentId,
          requestId: batch.requestId,
          completedIds,
          failedIds,
        }),
      )
    } catch (_error) {
      if (isCurrentBatch(session, batch)) {
        for (const item of batch.items) {
          if (!session.completedIds.has(item.id)) {
            session.failedIds.add(item.id)
          }
        }
        post(
          session,
          Pdf.pdfSessionError({
            sessionId: session.sessionId,
            documentId: batch.documentId,
            requestId: batch.requestId,
            recoverable: true,
            failedIds: batch.items
              .filter((item) => !session.completedIds.has(item.id))
              .map((item) => item.id),
            error: "PDF translation failed. Retry the affected blocks.",
          }),
        )
      }
    } finally {
      abortScope.dispose()
      if (session.documentSequence === batch.documentSequence) {
        for (const item of batch.items) {
          session.pendingIds.delete(item.id)
        }
      }
    }
  }

  async function drain(session, documentSequence) {
    if (session.processingDocuments.has(documentSequence) || !isCurrentSession(session)) {
      return
    }
    session.processingDocuments.add(documentSequence)

    try {
      while (
        session.pendingBatches.length > 0 &&
        isCurrentSession(session) &&
        session.documentSequence === documentSequence
      ) {
        const batch = session.pendingBatches.shift()
        await processBatch(session, batch)
      }
    } finally {
      session.processingDocuments.delete(documentSequence)
    }
  }

  function queueBatch(session, message) {
    if (message.sessionId !== session.sessionId) {
      throw new Error("The PDF translation session is stale.")
    }
    if (session.requestIds.has(message.requestId)) {
      throw new Error("This PDF batch request id was already used.")
    }
    if (!session.documentId) {
      throw new Error("Start the PDF document before queuing translations.")
    }
    if (session.documentId !== message.documentId) {
      throw new Error("The PDF document is stale.")
    }

    const acceptedItems = []
    let addedCharacters = 0
    for (const item of message.items) {
      const previousText = session.sourceById.get(item.id)
      if (previousText && previousText !== item.text) {
        throw new Error("A PDF block changed without a new id.")
      }
      if (
        session.pendingIds.has(item.id) ||
        (message.type === Pdf.CLIENT_MESSAGE_TYPES.RETRY &&
          previousText !== undefined &&
          !session.failedIds.has(item.id)) ||
        (message.type !== Pdf.CLIENT_MESSAGE_TYPES.RETRY && session.completedIds.has(item.id))
      ) {
        continue
      }
      if (!previousText) {
        addedCharacters += item.text.length
      }
      acceptedItems.push(item)
    }
    if (session.characterCount + addedCharacters > Pdf.PDF_LIMITS.maximumDocumentCharacters) {
      throw new Error("This PDF contains too much text to translate safely.")
    }
    for (const item of acceptedItems) {
      if (!session.sourceById.has(item.id)) {
        session.sourceById.set(item.id, item.text)
        session.characterCount += item.text.length
      }
      session.pendingIds.add(item.id)
    }

    session.requestIds.add(message.requestId)
    if (acceptedItems.length === 0) {
      post(
        session,
        Pdf.pdfBatchComplete({
          sessionId: session.sessionId,
          documentId: message.documentId,
          requestId: message.requestId,
          completedIds: [],
          failedIds: [],
        }),
      )
      return
    }

    const batch = {
      documentId: message.documentId,
      documentSequence: session.documentSequence,
      items: acceptedItems,
      requestId: message.requestId,
    }
    if (message.placement === "back") {
      session.pendingBatches.push(batch)
    } else {
      session.pendingBatches.unshift(batch)
    }
    drain(session, session.documentSequence).catch((error) => {
      logger?.error("pdf-session-drain-failed", {
        error: sanitizeError(error),
        readerTabId: session.readerTabId,
      })
    })
  }

  async function startSession(port, launchToken) {
    const state = ports.get(port)
    const sequence = ++startupSequence
    const readerTabId = port.sender?.tab?.id
    latestStarts.set(readerTabId, sequence)
    const existing = sessionsByPort.get(port)
    if (existing) {
      throw new Error("This PDF reader already has an active session.")
    }

    const launch = await bindLaunchToReader(launchToken, readerTabId)
    const settings = await platform.loadSettingsOrOpenOptions()
    if (launch.sourceUrl && platform.isDomainDisabled(launch.sourceUrl, settings)) {
      throw new Error("Translation is disabled for this PDF domain.")
    }
    if (!(await platform.ensureApiPermission(settings))) {
      throw new Error("Permission to access the configured API origin was denied.")
    }

    const modelCacheIdentity = await platform.getModelCacheIdentity(settings)
    const settingsFingerprint = await createSettingsFingerprint(settings, modelCacheIdentity)
    if (!state || state.closed || latestStarts.get(readerTabId) !== sequence)
      throw new Error("PDF startup was superseded.")
    const previousSession = sessionsByTab.get(readerTabId)
    if (previousSession) cancelSession(previousSession, false)
    const session = {
      cancelled: false,
      characterCount: 0,
      completedIds: new Set(),
      documentController: null,
      documentId: "",
      documentSequence: 0,
      failedIds: new Set(),
      launchToken,
      pendingBatches: [],
      pendingIds: new Set(),
      port,
      processingDocuments: new Set(),
      readerTabId,
      requestIds: new Set(),
      sessionId: createRandomId("pdf"),
      settings,
      sourceById: new Map(),
    }
    sessionsByPort.set(port, session)
    sessionsByTab.set(readerTabId, session)
    post(
      session,
      Pdf.pdfSessionStarted({
        sessionId: session.sessionId,
        settingsFingerprint,
        targetLanguage: settings.targetLanguage,
        source: {
          title: launch.title,
          url: launch.sourceUrl,
        },
      }),
    )
  }

  function handleConnect(port) {
    if (port?.name !== Pdf.PDF_PORT_NAME) {
      return false
    }
    const senderUrl = String(port.sender?.url || "")
    if (
      port.sender?.id !== chrome.runtime.id ||
      !Number.isInteger(port.sender?.tab?.id) ||
      (senderUrl !== readerUrl && !senderUrl.startsWith(`${readerUrl}#`))
    ) {
      port.disconnect()
      return false
    }

    const state = { closed: false, starting: false }
    ports.set(port, state)
    port.onMessage.addListener((rawMessage) => {
      let validatedMessage = null
      Promise.resolve()
        .then(() => Pdf.validatePdfClientMessage(rawMessage))
        .then(async (message) => {
          validatedMessage = message
          if (state.closed) return
          if (message.type === Pdf.CLIENT_MESSAGE_TYPES.START) {
            if (state.starting) throw new Error("PDF startup is already in progress.")
            state.starting = true
            try {
              await startSession(port, message.launchToken)
            } finally {
              state.starting = false
            }
            return
          }

          const session = sessionsByPort.get(port)
          if (!session) {
            throw new Error("Start the PDF translation session first.")
          }
          if (message.sessionId !== session.sessionId) {
            throw new Error("The PDF translation session is stale.")
          }
          if (message.type === Pdf.CLIENT_MESSAGE_TYPES.DOCUMENT) {
            startDocument(session, message.documentId)
            return
          }
          if (message.type === Pdf.CLIENT_MESSAGE_TYPES.CANCEL) {
            cancelSession(session)
            return
          }
          queueBatch(session, message)
        })
        .catch((error) => {
          const session = sessionsByPort.get(port)
          const batchMessage =
            validatedMessage?.type === Pdf.CLIENT_MESSAGE_TYPES.QUEUE ||
            validatedMessage?.type === Pdf.CLIENT_MESSAGE_TYPES.RETRY
              ? validatedMessage
              : null
          const message = Pdf.pdfSessionError({
            sessionId: session?.sessionId || "",
            documentId: batchMessage?.documentId || validatedMessage?.documentId,
            requestId: batchMessage?.requestId,
            failedIds: batchMessage?.items.map((item) => item.id) || [],
            recoverable: Boolean(session),
            error: sanitizeError(error),
          })
          try {
            port.postMessage(message)
          } catch (_error) {
            if (session) {
              cancelSession(session, false)
            }
          }
        })
    })
    port.onDisconnect.addListener(() => {
      state.closed = true
      cancelSession(sessionsByPort.get(port), false)
    })
    return true
  }

  function removeSessionByTab(tabId) {
    cancelSession(sessionsByTab.get(tabId), false)
    const launchToken = launchTokensByTab.get(tabId)
    launchTokensByTab.delete(tabId)
    if (launchToken && launchToken !== "local") {
      chrome.storage.session.remove(`${Pdf.PDF_LAUNCH_PREFIX}${launchToken}`).catch(() => {})
    }
  }

  return {
    handleConnect,
    openPdfTranslator,
    removeSessionByTab,
  }
}

export { createPdfController, createSettingsFingerprint, sanitizeError }
