import { readdir, readFile } from "node:fs/promises"
import { JSDOM } from "jsdom"
import { afterEach, describe, expect, test, vi } from "vitest"
import { BROWSER_TOOL_NAMES } from "../../src/browser/agent/browser-tool-names.js"
import { BROWSER_TOOL_OPTIONS } from "../../src/browser/agent/browser-tools.js"
import { catalogs } from "../../src/browser/i18n/catalogs.js"
import { CONTEXT_MENU_TITLES } from "../../src/browser/i18n/context-menu.js"
import {
  applyDocumentLanguage,
  initializeDocumentLanguage,
  observeDocumentLanguage,
} from "../../src/browser/i18n/dom.js"
import { english, type Message, type MessageKey } from "../../src/browser/i18n/en.js"
import {
  getLocale,
  setLanguagePreference,
  t,
  translate,
  translateDiagnostic,
} from "../../src/browser/i18n/index.js"
import {
  isLanguagePreference,
  LOCALES,
  type Locale,
  resolveLocale,
} from "../../src/browser/i18n/locales.js"
import { DEFAULT_SETTINGS, getSettings, saveSettings } from "../../src/browser/storage.js"

const codes = [
  "en",
  "zh-TW",
  "ja",
  "ko",
  "es",
  "fr",
  "de",
  "pt",
  "pt-BR",
  "it",
  "nl",
  "pl",
  "tr",
  "ru",
  "id",
  "vi",
  "th",
  "hi",
]
const slots = (text: string): string[] =>
  [
    ...new Set([...text.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)].map((match) => match[1] ?? "")),
  ].sort()
const render = translate as (
  locale: Locale,
  key: MessageKey,
  parameters?: Record<string, string | number>,
) => string

afterEach(() => {
  setLanguagePreference("en")
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("interface locale resolution", () => {
  test("supports only the approved LTR locales and an opt-in browser preference", () => {
    expect(LOCALES.map((locale) => locale.code)).toEqual(codes)
    for (const value of [...codes, "auto"]) expect(isLanguagePreference(value)).toBe(true)
    for (const value of [undefined, null, {}, [], "en-US", "zh-CN", "ar", "he", "__proto__"]) {
      expect(isLanguagePreference(value)).toBe(false)
      expect(resolveLocale(value, ["ja"])).toBe("en")
    }
    expect(resolveLocale("en", ["ja"])).toBe("en")
  })

  test.each([
    [["invalid_tag", "JA-jp", "fr"], "ja"],
    [["es-MX", "ja"], "es"],
    [["pt-BR"], "pt-BR"],
    [["pt-Latn-BR"], "pt-BR"],
    [["pt-PT"], "pt"],
    [["pt-AO"], "pt"],
    [["pt"], "pt"],
    [["zh-Hant"], "zh-TW"],
    [["zh-Hant-CN"], "zh-TW"],
    [["zh-TW"], "zh-TW"],
    [["zh-HK"], "zh-TW"],
    [["zh-MO"], "zh-TW"],
    [["zh-Hans-TW", "de"], "de"],
    [["zh-CN", "zh-SG", "zh", "fr-CA"], "fr"],
    [["zh-CN"], "en"],
    [["ar", "he", "fa"], "en"],
    [[], "en"],
  ])("resolves ordered browser preferences %j to %s", (preferences, expected) => {
    expect(resolveLocale("auto", preferences)).toBe(expected)
  })

  test("uses navigator.language when the preference list is empty", () => {
    vi.stubGlobal("navigator", { languages: [], language: "ko-KR" })
    expect(resolveLocale("auto")).toBe("ko")
    vi.stubGlobal("navigator", { languages: ["fr", "ja"], language: "ko-KR" })
    expect(resolveLocale("auto")).toBe("fr")
  })
})

describe("complete bundled catalogs", () => {
  test("keeps the lightweight worker menu and stored tool names aligned with their owners", () => {
    expect([...BROWSER_TOOL_NAMES]).toEqual(BROWSER_TOOL_OPTIONS.map((tool) => tool.name))
    expect(Object.keys(CONTEXT_MENU_TITLES).sort()).toEqual([...codes].sort())
    for (const { code } of LOCALES)
      expect(CONTEXT_MENU_TITLES[code]).toBe(translate(code, "Send selection to Pi Browser Agent"))
  })

  test("ships exactly the approved native catalogs with matching metadata messages", async () => {
    const directory = (code: Locale): string => (code === "pt" ? "pt_PT" : code.replace("-", "_"))
    expect((await readdir("_locales")).sort()).toEqual(
      LOCALES.map(({ code }) => directory(code)).sort(),
    )
    const messages = {
      description: "A Chrome-native AI assistant for the page you are viewing.",
      actionTitle: "Open Pi Browser Agent",
      pickerCommand: "Open Pi Browser Agent and select a page element",
    } as const
    for (const { code } of LOCALES) {
      const native = JSON.parse(
        await readFile(`_locales/${directory(code)}/messages.json`, "utf8"),
      ) as Record<string, { message: string }>
      expect(Object.keys(native).sort()).toEqual(Object.keys(messages).sort())
      for (const [key, source] of Object.entries(messages))
        expect(native[key]?.message).toBe(translate(code, source))
    }
  })

  test.each(LOCALES)(
    "validates $code keys, named parameters, and required plural forms",
    ({ code }) => {
      const catalog = code === "en" ? english : catalogs[code]
      expect(catalog).toBeDefined()
      expect(Object.keys(catalog ?? {}).sort()).toEqual(Object.keys(english).sort())
      for (const key of Object.keys(english) as MessageKey[]) {
        const source: Message = english[key]
        const message = catalog?.[key]
        expect(message, `${code}: ${key}`).toBeDefined()
        if (typeof source !== "string") {
          expect(typeof message, `${code}: ${key}`).toBe("object")
          expect(Object.keys(message ?? {}).sort()).toEqual(
            new Intl.PluralRules(code).resolvedOptions().pluralCategories.sort(),
          )
        } else {
          expect(typeof message, `${code}: ${key}`).toBe("string")
        }
        for (const form of typeof message === "string" ? [message] : Object.values(message ?? {})) {
          expect(form.trim(), `${code}: ${key}`).not.toBe("")
          expect(slots(form), `${code}: ${key}`).toEqual(slots(key))
        }
        const parameters = Object.fromEntries(
          slots(key).map((name) => [name, name === "count" ? 2 : "value"]),
        )
        for (const count of [0, 1, 2, 5, 11, 21]) {
          if ("count" in parameters) parameters.count = count
          expect(render(code, key, parameters)).not.toMatch(/\{[a-zA-Z][a-zA-Z0-9]*\}/)
        }
      }
      if (code !== "en") expect(render(code, "Send")).not.toBe("Send")
    },
  )

  test("falls back directly to English without mixing Portuguese variants", () => {
    const catalog = catalogs["pt-BR"]
    if (!catalog) throw new Error("Missing Brazilian Portuguese catalog")
    const saved = catalog.Send
    Reflect.deleteProperty(catalog, "Send")
    try {
      expect(translate("pt-BR", "Send")).toBe("Send")
    } finally {
      catalog.Send = saved
    }
  })

  test("uses locale plural rules and does not interpret parameter text or HTML", () => {
    expect(translate("en", "Command list open. {count} commands available.", { count: 1 })).toBe(
      "Command list open. 1 command available.",
    )
    expect(translate("en", "Command list open. {count} commands available.", { count: 2 })).toBe(
      "Command list open. 2 commands available.",
    )
    const title = "<img src=x onerror=alert(1)> {count}"
    expect(translate("en", "Use the tab {title}?", { title })).toBe(`Use the tab ${title}?`)
    expect(translateDiagnostic(new Error("Bearer abcdefghijklmnop"))).toBe("Bearer [REDACTED]")
    setLanguagePreference("ja")
    expect(translateDiagnostic(new Error("Send"))).toBe("Send")
  })
})

function documentEnvironment(language: unknown = "en") {
  const dom = new JSDOM(
    '<!doctype html><html><body><button aria-label="Send">Send</button><input placeholder="Search providers" data-placeholder="Search providers"><textarea>Send</textarea><code>Send</code><section id="untrusted"></section></body></html>',
  )
  const listeners = new Set<
    (changes: Record<string, chrome.storage.StorageChange>, area: string) => void
  >()
  const settings: Record<string, unknown> = { language }
  const get = vi.fn(async () => ({ piBrowserAgentSettings: { ...settings } }))
  const set = vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(settings, items.piBrowserAgentSettings)
  })
  vi.stubGlobal("window", dom.window)
  vi.stubGlobal("document", dom.window.document)
  vi.stubGlobal("navigator", { languages: ["zh-TW"], language: "zh-TW" })
  vi.stubGlobal("chrome", {
    storage: {
      local: { get, set },
      onChanged: {
        addListener: (
          listener: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void,
        ) => listeners.add(listener),
        removeListener: (
          listener: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void,
        ) => listeners.delete(listener),
      },
    },
  })
  return {
    document: dom.window.document,
    get,
    set,
    settings,
    listeners,
    change(next: unknown, area = "local") {
      settings.language = next
      for (const listener of [...listeners])
        listener({ piBrowserAgentSettings: { newValue: { language: next } } }, area)
    },
  }
}

describe("trusted static document localization", () => {
  test("binds only packaged nodes and attributes, not subsequent model text or editable/code content", async () => {
    const environment = documentEnvironment("ja")
    await initializeDocumentLanguage(environment.document)
    const button = environment.document.querySelector("button")
    expect(button?.textContent).toBe(t("Send"))
    expect(button?.textContent).not.toBe("Send")
    expect(button?.getAttribute("aria-label")).toBe(t("Send"))
    expect(environment.document.querySelector("input")?.getAttribute("data-placeholder")).toBe(
      t("Search providers"),
    )
    expect(environment.document.querySelector("textarea")?.textContent).toBe("Send")
    expect(environment.document.querySelector("code")?.textContent).toBe("Send")
    const untrusted = environment.document.querySelector("#untrusted")
    if (untrusted) untrusted.textContent = "Send"
    setLanguagePreference("fr")
    applyDocumentLanguage(environment.document)
    expect(untrusted?.textContent).toBe("Send")
    expect(button?.textContent).toBe(t("Send"))
    expect(environment.document.documentElement.lang).toBe("fr")
    expect(environment.document.documentElement.dir).toBe("ltr")
  })

  test("defers saved changes during work, applies the latest preference, and cancels pending retries on disposal", async () => {
    vi.useFakeTimers()
    const environment = documentEnvironment()
    await initializeDocumentLanguage(environment.document)
    let busy = true
    const refresh = vi.fn()
    const watcher = observeDocumentLanguage({ isBusy: () => busy, refresh })
    environment.change("fr")
    environment.change("ja")
    await vi.advanceTimersByTimeAsync(250)
    expect(getLocale()).toBe("en")
    expect(refresh).not.toHaveBeenCalled()
    busy = false
    watcher.flush()
    expect(getLocale()).toBe("ja")
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(environment.set).not.toHaveBeenCalled()
    busy = true
    environment.change("de")
    watcher()
    busy = false
    await vi.advanceTimersByTimeAsync(250)
    expect(getLocale()).toBe("ja")
    expect(environment.listeners.size).toBe(0)
  })

  test("applies pending changes by idle polling without an explicit flush", async () => {
    vi.useFakeTimers()
    const environment = documentEnvironment()
    await initializeDocumentLanguage(environment.document)
    let busy = true
    const refresh = vi.fn()
    const watcher = observeDocumentLanguage({ isBusy: () => busy, refresh })
    environment.change("ja")
    await vi.advanceTimersByTimeAsync(150)
    expect(getLocale()).toBe("en")
    busy = false
    await vi.advanceTimersByTimeAsync(100)
    expect(getLocale()).toBe("ja")
    expect(refresh).toHaveBeenCalledOnce()
    watcher()
  })

  test("a newer storage event wins an initial read, and browser changes affect only auto", async () => {
    const environment = documentEnvironment()
    await initializeDocumentLanguage(environment.document)
    let resolveInitial:
      | ((value: { piBrowserAgentSettings: { language: string } }) => void)
      | undefined
    environment.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveInitial = resolve
        }),
    )
    const watcher = observeDocumentLanguage({ isBusy: () => false, refresh: vi.fn() })
    environment.change("ja")
    resolveInitial?.({ piBrowserAgentSettings: { language: "en" } })
    await Promise.resolve()
    expect(getLocale()).toBe("ja")
    vi.stubGlobal("navigator", { languages: ["fr"], language: "fr" })
    window.dispatchEvent(new window.Event("languagechange"))
    expect(getLocale()).toBe("ja")
    environment.change("auto")
    expect(getLocale()).toBe("fr")
    vi.stubGlobal("navigator", { languages: ["de"], language: "de" })
    window.dispatchEvent(new window.Event("languagechange"))
    expect(getLocale()).toBe("de")
    watcher()
  })

  test("ignores session notifications and resolves Follow browser without writes", async () => {
    const environment = documentEnvironment()
    await initializeDocumentLanguage(environment.document)
    const watcher = observeDocumentLanguage({ isBusy: () => false, refresh: vi.fn() })
    environment.change("ja", "session")
    expect(getLocale()).toBe("en")
    environment.change("auto")
    expect(getLocale()).toBe("zh-TW")
    expect(environment.set).not.toHaveBeenCalled()
    watcher()
  })
})

describe("language storage compatibility", () => {
  test("reads legacy/invalid preferences without rewriting and preserves all approved values", async () => {
    const environment = documentEnvironment()
    delete environment.settings.language
    await expect(getSettings()).resolves.toMatchObject({
      language: "en",
      confirmationMode: "strict",
    })
    environment.settings.language = "ar"
    await expect(getSettings()).resolves.toMatchObject({ language: "en" })
    expect(environment.set).not.toHaveBeenCalled()
    for (const language of ["auto", ...codes]) {
      if (!isLanguagePreference(language)) throw new Error("Invalid test locale")
      await saveSettings({ ...DEFAULT_SETTINGS, language })
      await expect(getSettings()).resolves.toMatchObject({ language })
    }
  })
})
