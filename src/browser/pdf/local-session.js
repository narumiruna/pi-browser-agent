import { browserOAuthOrigins } from "../auth/browser-oauth.js"
import { hasApprovedHostPermission } from "../permissions.js"
import * as Pdf from "../translation/shared/pdf.js"
import * as Settings from "../translation/shared/settings.js"
import { createTranslationApi } from "../translation/translation/api.js"
import { createPdfController } from "./controller.js"

let controller
let readerTab
let selectedProvider
let selectedConfiguration
let sourceOrigin = ""
let activeOrigins = []
let sessionGeneration = 0

export function setReaderSourceUrl(url) {
  sourceOrigin = url
}
const clients = new Set()
const listeners = () => {
  const callbacks = new Set()
  return {
    addListener: (callback) => callbacks.add(callback),
    removeListener: (callback) => callbacks.delete(callback),
    emit: (value) => {
      for (const callback of callbacks) callback(value)
    },
  }
}

/** The reader talks to its own controller in memory, never to worker-owned credentials. */
export async function initializeReaderSession(settings, sourceUrl, provider) {
  stopReaderSession()
  const generation = sessionGeneration
  const tab = await chrome.tabs.getCurrent()
  if (tab?.id === undefined) throw new Error("Open the PDF reader in an extension tab")
  const urls = await provider.getModelEndpointPatterns(settings)
  if (generation !== sessionGeneration) throw new Error("PDF startup was superseded")
  readerTab = tab
  selectedProvider = settings.provider
  selectedConfiguration = provider.configuration
  sourceOrigin = sourceUrl
  activeOrigins = urls
  controller = createPdfController({
    chrome,
    Pdf,
    Api: createTranslationApi(provider),
    platform: {
      async loadSettingsOrOpenOptions() {
        await provider.assertConfigured(settings)
        return settings
      },
      async ensureApiPermission() {
        const urls = await provider.getModelEndpointPatterns(settings)
        return (
          await Promise.all(
            [...urls, ...(sourceOrigin ? [sourceOrigin] : [])].map(hasApprovedHostPermission),
          )
        ).every(Boolean)
      },
      getModelCacheIdentity: () => provider.getModelCacheIdentity(settings),
      isDomainDisabled(url, current) {
        const hostname = new URL(url).hostname
        return current.disabledDomains
          .split("\n")
          .some((rule) => rule && (hostname === rule || hostname.endsWith(`.${rule}`)))
      },
    },
  })
}

export function createReaderPort() {
  if (!controller || !readerTab) throw new Error("Start PDF translation and approve access first")
  const toServer = listeners()
  const toClient = listeners()
  const closed = listeners()
  let disconnected = false
  const disconnect = () => {
    if (disconnected) return
    disconnected = true
    clients.delete(client)
    closed.emit()
  }
  const client = {
    name: Pdf.PDF_PORT_NAME,
    onMessage: toClient,
    onDisconnect: closed,
    postMessage(message) {
      if (!disconnected)
        queueMicrotask(() => {
          if (!disconnected) toServer.emit(message)
        })
    },
    disconnect,
  }
  const server = {
    name: Pdf.PDF_PORT_NAME,
    sender: {
      id: chrome.runtime.id,
      url: chrome.runtime.getURL(Pdf.PDF_READER_PATH),
      tab: readerTab,
    },
    onMessage: toServer,
    onDisconnect: closed,
    postMessage(message) {
      if (!disconnected)
        queueMicrotask(() => {
          if (!disconnected) toClient.emit(message)
        })
    },
    disconnect,
  }
  clients.add(client)
  controller.handleConnect(server)
  return client
}

export function stopReaderSession() {
  sessionGeneration += 1
  for (const client of [...clients]) client.disconnect()
}

chrome.permissions.onRemoved.addListener(() => {
  if (selectedProvider && selectedConfiguration)
    void (async () => {
      const provider = selectedProvider
      const configuration = selectedConfiguration
      const credential = await configuration.credentials.read(provider)
      if (
        credential?.type === "oauth" &&
        !(await Promise.all(browserOAuthOrigins(provider).map(hasApprovedHostPermission))).every(
          Boolean,
        )
      ) {
        stopReaderSession()
        await configuration.invalidateCredential(provider, "oauth")
      }
    })().catch(stopReaderSession)
  const generation = sessionGeneration
  void Promise.all(
    [...activeOrigins, ...(sourceOrigin ? [sourceOrigin] : [])].map(hasApprovedHostPermission),
  )
    .then((grants) => {
      if (generation === sessionGeneration && !grants.every(Boolean)) stopReaderSession()
    })
    .catch(stopReaderSession)
})
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return
  if (
    Settings.STORAGE_KEY in changes ||
    changes.piBrowserAgentAuthChangeV1?.newValue?.providerId === selectedProvider
  )
    stopReaderSession()
  const previous = changes.piBrowserAgentCredentialsV1?.oldValue?.[selectedProvider]
  const next = changes.piBrowserAgentCredentialsV1?.newValue?.[selectedProvider]
  if (
    previous &&
    (!next ||
      previous.type !== next.type ||
      (next.type === "api_key" && JSON.stringify(previous) !== JSON.stringify(next)) ||
      (next.type === "oauth" && previous.accountId !== next.accountId))
  )
    stopReaderSession()
})
window.addEventListener("pagehide", stopReaderSession)
