export const LOCALES = [
  { code: "en", name: "English" },
  { code: "zh-TW", name: "繁體中文" },
  { code: "ja", name: "日本語" },
  { code: "ko", name: "한국어" },
  { code: "es", name: "Español" },
  { code: "fr", name: "Français" },
  { code: "de", name: "Deutsch" },
  { code: "pt", name: "Português" },
  { code: "pt-BR", name: "Português do Brasil" },
  { code: "it", name: "Italiano" },
  { code: "nl", name: "Nederlands" },
  { code: "pl", name: "Polski" },
  { code: "tr", name: "Türkçe" },
  { code: "ru", name: "Русский" },
  { code: "id", name: "Bahasa Indonesia" },
  { code: "vi", name: "Tiếng Việt" },
  { code: "th", name: "ไทย" },
  { code: "hi", name: "हिन्दी" },
] as const

export type Locale = (typeof LOCALES)[number]["code"]
export type LanguagePreference = "auto" | Locale

export function isLocale(value: unknown): value is Locale {
  return LOCALES.some((locale) => locale.code === value)
}

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === "auto" || isLocale(value)
}

/** Read only the presentation preference from an untrusted stored settings shape. */
export function languagePreferenceFromSettings(value: unknown): LanguagePreference {
  const language =
    value && typeof value === "object" && "language" in value ? value.language : undefined
  return isLanguagePreference(language) ? language : "en"
}

export function browserLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return []
  return navigator.languages?.length ? navigator.languages : [navigator.language]
}

export function resolveLocale(
  preference: unknown,
  languages: readonly string[] = browserLanguages(),
): Locale {
  if (preference !== "auto") return isLocale(preference) ? preference : "en"
  for (const candidate of languages) {
    try {
      const locale = new Intl.Locale(candidate)
      if (locale.language === "zh") {
        if (locale.script === "Hans") continue
        if (
          locale.script === "Hant" ||
          (!locale.script && ["TW", "HK", "MO"].includes(locale.region ?? ""))
        )
          return "zh-TW"
        continue
      }
      if (locale.language === "pt") return locale.region === "BR" ? "pt-BR" : "pt"
      const exact = LOCALES.find(
        (entry) => entry.code.toLowerCase() === locale.toString().toLowerCase(),
      )
      if (exact) return exact.code
      if (isLocale(locale.language)) return locale.language
    } catch {
      // A malformed browser preference cannot prevent extension startup.
    }
  }
  return "en"
}
