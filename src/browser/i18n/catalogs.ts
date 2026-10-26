import catalog5 from "./de.js"
import { type Catalog, english } from "./en.js"
import catalog3 from "./es.js"
import catalog4 from "./fr.js"
import catalog16 from "./hi.js"
import catalog13 from "./id.js"
import catalog8 from "./it.js"
import catalog1 from "./ja.js"
import catalog2 from "./ko.js"
import type { Locale } from "./locales.js"
import catalog9 from "./nl.js"
import catalog10 from "./pl.js"
import catalog6 from "./pt.js"
import catalog7 from "./pt-BR.js"
import catalog12 from "./ru.js"
import catalog15 from "./th.js"
import catalog11 from "./tr.js"
import catalog14 from "./vi.js"
import catalog0 from "./zh-TW.js"

export const catalogs: Record<Locale, Catalog> = {
  en: english,
  "zh-TW": catalog0,
  ja: catalog1,
  ko: catalog2,
  es: catalog3,
  fr: catalog4,
  de: catalog5,
  pt: catalog6,
  "pt-BR": catalog7,
  it: catalog8,
  nl: catalog9,
  pl: catalog10,
  tr: catalog11,
  ru: catalog12,
  id: catalog13,
  vi: catalog14,
  th: catalog15,
  hi: catalog16,
}
