import { english, type MessageKey } from "./en.js"
import { getLocale, setLanguagePreference, t } from "./index.js"
import {
  type LanguagePreference,
  languagePreferenceFromSettings as preference,
  resolveLocale,
} from "./locales.js"

const SETTINGS_KEY = "piBrowserAgentSettings"
type Binding = () => void
const bindings = new WeakMap<Document, Binding[]>()

type StaticMessageKey = Exclude<MessageKey, `${string}{${string}`>

function messageKey(value: string): value is StaticMessageKey {
  return !value.includes("{") && Object.hasOwn(english, value)
}

/** Capture only the trusted packaged document, before a controller inserts untrusted content. */
function captureDocument(document: Document): void {
  if (bindings.has(document)) return
  const entries: Binding[] = []
  const walker = document.createTreeWalker(document.documentElement, 4)
  let node = walker.nextNode()
  while (node) {
    const target = node
    const original = target.textContent ?? ""
    const key = original.replace(/\s+/g, " ").trim()
    if (messageKey(key) && !target.parentElement?.closest("script, style, textarea, code, pre")) {
      const leading = original.match(/^\s*/)?.[0] ?? ""
      const trailing = original.match(/\s*$/)?.[0] ?? ""
      entries.push(() => {
        if (target.isConnected)
          target.textContent = getLocale() === "en" ? original : `${leading}${t(key)}${trailing}`
      })
    }
    node = walker.nextNode()
  }
  for (const element of document.querySelectorAll("*")) {
    for (const attribute of ["aria-label", "title", "placeholder", "data-placeholder", "alt"]) {
      const key = element.getAttribute(attribute)
      if (key && messageKey(key))
        entries.push(() => {
          if (element.isConnected) element.setAttribute(attribute, t(key))
        })
    }
  }
  bindings.set(document, entries)
}

export function applyDocumentLanguage(document: Document): void {
  document.documentElement.lang = getLocale()
  document.documentElement.dir = "ltr"
  for (const apply of bindings.get(document) ?? []) apply()
}

export async function initializeDocumentLanguage(document: Document): Promise<void> {
  captureDocument(document)
  const stored = await chrome.storage.local
    .get(SETTINGS_KEY)
    .catch(() => ({}) as Record<string, unknown>)
  setLanguagePreference(preference(stored[SETTINGS_KEY]))
  applyDocumentLanguage(document)
}

export type DocumentLanguageObserver = (() => void) & { flush: () => void }

/** Saved settings relabel idle views only. No reload, permission, session, or model operation. */
export function observeDocumentLanguage(options: {
  isBusy: () => boolean
  refresh: () => void
}): DocumentLanguageObserver {
  let disposed = false
  let pending: LanguagePreference | undefined
  let saved: LanguagePreference = "en"
  let retry: ReturnType<typeof setTimeout> | undefined
  const flush = (): void => {
    if (disposed || pending === undefined) return
    if (resolveLocale(pending) === getLocale()) {
      pending = undefined
      clearTimeout(retry)
      retry = undefined
      return
    }
    if (options.isBusy()) {
      retry ??= setTimeout(() => {
        retry = undefined
        flush()
      }, 100)
      return
    }
    clearTimeout(retry)
    retry = undefined
    const next = pending
    pending = undefined
    if (!setLanguagePreference(next)) return
    applyDocumentLanguage(document)
    options.refresh()
  }
  const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area !== "local" || !Object.hasOwn(changes, SETTINGS_KEY)) return
    saved = preference(changes[SETTINGS_KEY]?.newValue)
    pending = saved
    flush()
  }
  const languageChanged = (): void => {
    if (saved !== "auto") return
    pending = saved
    flush()
  }
  chrome.storage.onChanged.addListener(changed)
  window.addEventListener("languagechange", languageChanged)
  // The initial read can race a storage notification. Never replace a newer saved preference.
  let notified = false
  const markNotified = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ): void => {
    if (area === "local" && Object.hasOwn(changes, SETTINGS_KEY)) notified = true
  }
  chrome.storage.onChanged.addListener(markNotified)
  void chrome.storage.local
    .get(SETTINGS_KEY)
    .then((stored) => {
      if (!disposed && !notified) {
        saved = preference(stored[SETTINGS_KEY])
        pending = saved
        flush()
      }
    })
    .catch(() => undefined)
    .finally(() => {
      chrome.storage.onChanged.removeListener(markNotified)
    })
  const dispose = (): void => {
    disposed = true
    clearTimeout(retry)
    retry = undefined
    pending = undefined
    chrome.storage.onChanged.removeListener(changed)
    chrome.storage.onChanged.removeListener(markNotified)
    window.removeEventListener("languagechange", languageChanged)
  }
  return Object.assign(dispose, { flush })
}
