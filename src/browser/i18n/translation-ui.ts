import { TRANSLATION_UI_KEYS } from "../translation/shared/ui.js"
import { catalogs } from "./catalogs.js"
import { getLocale } from "./index.js"

/** Select only fixed packaged labels; do not send complete application catalogs to a page. */
export function translationUiStrings(): Record<string, string> {
  const catalog = catalogs[getLocale()]
  return Object.fromEntries(
    TRANSLATION_UI_KEYS.map((key) => {
      const value = catalog[key]
      return [key, typeof value === "string" ? value : key]
    }),
  )
}
