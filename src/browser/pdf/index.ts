import "./compatibility.js"
import { BrowserConfiguration } from "../configuration.js"
import { initializeDocumentLanguage } from "../i18n/dom.js"
import { translationUiStrings } from "../i18n/translation-ui.js"
import { hasApprovedHostPermission, requestHostPermissions } from "../permissions.js"
import { record } from "../runtime/translation.js"
import { TranslationProvider } from "../translation/provider.js"
import * as Pdf from "../translation/shared/pdf.js"
import * as Settings from "../translation/shared/settings.js"
import { configureTranslationUi, ui } from "../translation/shared/ui.js"
import { initializeReaderSession, setReaderSourceUrl, stopReaderSession } from "./local-session.js"
import { decodeLaunchToken } from "./reader-utils.js"

const approve = document.querySelector<HTMLButtonElement>("#pdf-approve")
const settingsButton = document.querySelector<HTMLButtonElement>("#pdf-settings")
const error = document.querySelector<HTMLElement>("#error")
const configuration = new BrowserConfiguration(() => {})
const token =
  decodeLaunchToken(location.hash) || sessionStorage.getItem("vibePdfLaunchToken") || "local"
const key = `${Pdf.PDF_LAUNCH_PREFIX}${token}`
let settings: Awaited<ReturnType<typeof Settings.getSettings>>
let origins: string[] = []
let modelOrigins: string[] = []
let readerProvider: TranslationProvider | undefined
let sourceUrl = ""
let busy = false
let revision = 0

function showError(cause: unknown): void {
  if (error) {
    error.hidden = false
    error.textContent =
      cause instanceof Error && cause.message === "Translation access was denied"
        ? cause.message
        : ui("Could not start PDF translation")
  }
}

async function prepare(): Promise<void> {
  if (approve) approve.disabled = true
  const version = ++revision
  const nextSettings = await Settings.getSettings()
  const provider = await new TranslationProvider(configuration).scoped(nextSettings)
  const endpoints = await provider.getModelEndpointPatterns(nextSettings)
  if (version !== revision) return
  settings = nextSettings
  readerProvider = provider
  modelOrigins = endpoints
  origins = [...endpoints, ...(sourceUrl ? [sourceUrl] : [])]
  if (approve) approve.disabled = false
}

async function loadReader(): Promise<void> {
  const reader = await import("./reader.js")
  reader.onSessionStopped(() => {
    void prepare().catch(showError)
  })
  reader.onLocalDocumentReady(() => {
    sourceUrl = ""
    origins = [...modelOrigins]
    setReaderSourceUrl("")
  })
}

async function start(version: number): Promise<void> {
  if (version !== revision) throw new Error("PDF translation settings changed")
  if (!readerProvider) throw new Error("PDF translation configuration expired")
  await initializeReaderSession(settings, sourceUrl, readerProvider)
  if (version !== revision) throw new Error("PDF translation settings changed")
  const reader = await import("./reader.js")
  reader.connectPort()
  if (approve) approve.hidden = true
  if (token !== "local") {
    const stored = await chrome.storage.session.get(key)
    if (stored[key]) await chrome.storage.session.set({ [key]: { ...stored[key], started: true } })
  }
}

approve?.addEventListener("click", () => {
  if (busy || !origins.length) return
  const version = revision
  const permission = requestHostPermissions(origins)
  busy = true
  approve.disabled = true
  void permission
    .then(async (granted) => {
      if (!granted) throw new Error("Translation access was denied")
      await start(version)
    })
    .catch(showError)
    .finally(() => {
      busy = false
      approve.disabled = false
    })
})
settingsButton?.addEventListener("click", () => {
  const path = chrome.runtime.getManifest().side_panel?.default_path
  if (path) void chrome.tabs.create({ url: `${chrome.runtime.getURL(path)}?view=settings` })
})
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && Settings.STORAGE_KEY in changes) {
    stopReaderSession()
    if (approve) approve.hidden = false
    void prepare().catch(showError)
  }
})

void (async () => {
  if (!Pdf.isSafePdfId(token)) throw new Error("Invalid reader launch")
  await initializeDocumentLanguage(document)
  configureTranslationUi(translationUiStrings())
  await configuration.initialize()
  const tab = await chrome.tabs.getCurrent()
  if (token !== "local") {
    const stored = await chrome.storage.session.get(key)
    const launch = stored[key]
    if (
      !record(launch) ||
      !Number.isFinite(launch.createdAt) ||
      typeof launch.sourceUrl !== "string" ||
      Date.now() - Number(launch.createdAt) > 86400000 ||
      !tab?.id ||
      (launch.readerTabId && launch.readerTabId !== tab.id) ||
      (!launch.localOnly && !Pdf.parseHttpUrl(launch.sourceUrl))
    ) {
      throw new Error("Invalid or expired reader launch")
    }
    sourceUrl = String(launch.sourceUrl)
    await prepare().catch(showError)
    await loadReader()
    if (
      !launch.started &&
      origins.length > 0 &&
      (await Promise.all(origins.map(hasApprovedHostPermission))).every(Boolean)
    )
      await start(revision)
  } else {
    await prepare().catch(showError)
    await loadReader()
  }
})().catch(showError)
