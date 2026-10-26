import { safeErrorMessage } from "../auth/redaction.js"
import { catalogs } from "./catalogs.js"
import { english, type Message, type MessageKey } from "./en.js"
import { type LanguagePreference, type Locale, resolveLocale } from "./locales.js"

export type { Catalog, MessageKey } from "./en.js"
export { type LanguagePreference, LOCALES, type Locale } from "./locales.js"

type Placeholders<S extends string> = S extends `${string}{${infer Name}}${infer Rest}`
  ? Name | Placeholders<Rest>
  : never
type Arguments<K extends string> = [Placeholders<K>] extends [never]
  ? [parameters?: never]
  : [parameters: Record<Placeholders<K>, string | number>]

let currentLocale: Locale = "en"

export function getLocale(): Locale {
  return currentLocale
}

export function setLanguagePreference(
  preference: LanguagePreference | unknown,
  languages?: readonly string[],
): boolean {
  const next = resolveLocale(preference, languages)
  const changed = next !== currentLocale
  currentLocale = next
  return changed
}

export function formatNumber(value: number, locale = currentLocale): string {
  return new Intl.NumberFormat(locale).format(value)
}

function renderMessage(
  locale: Locale,
  key: MessageKey,
  parameters?: Record<string, string | number>,
): string {
  const message: Message = catalogs[locale]?.[key] || english[key]
  const template =
    typeof message === "string"
      ? message
      : (message[new Intl.PluralRules(locale).select(Number(parameters?.count ?? 0))] ??
        message.other)
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (placeholder, name: string) => {
    const value = parameters?.[name]
    return value === undefined
      ? placeholder
      : typeof value === "number"
        ? formatNumber(value, locale)
        : value
  })
}

export function translate<K extends MessageKey>(
  locale: Locale,
  key: K,
  ...[parameters]: Arguments<K>
): string {
  return renderMessage(locale, key, parameters)
}

export function t<K extends MessageKey>(key: K, ...args: Arguments<K>): string {
  return translate(currentLocale, key, ...args)
}

/** Call only after classifying an extension-owned fixed message, never on remote content. */
export function translateKnownMessage(message: string): string {
  return Object.hasOwn(english, message)
    ? renderMessage(currentLocale, message as MessageKey)
    : message
}

/** Unknown browser/provider diagnostics stay redacted and are not treated as catalog keys. */
export function translateDiagnostic(error: unknown): string {
  return safeErrorMessage(error)
}
