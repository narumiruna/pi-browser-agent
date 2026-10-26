import type { Locale } from "./locales.js"

// Keep worker startup independent of the full application catalogs. Unit tests enforce parity.
export const CONTEXT_MENU_TITLES = {
  en: "Send selection to Pi Browser Agent",
  "zh-TW": "將所選內容傳送至 Pi Browser Agent",
  ja: "選択範囲を Pi Browser Agent に送信",
  ko: "선택한 내용을 Pi Browser Agent로 보내기",
  es: "Enviar selección a Pi Browser Agent",
  fr: "Envoyer la sélection à Pi Browser Agent",
  de: "Auswahl an Pi Browser Agent senden",
  pt: "Enviar seleção para Pi Browser Agent",
  "pt-BR": "Enviar seleção para Pi Browser Agent",
  it: "Invia selezione a Pi Browser Agent",
  nl: "Selectie naar Pi Browser Agent verzenden",
  pl: "Wyślij zaznaczenie do Pi Browser Agent",
  tr: "Seçimi Pi Browser Agent'a gönder",
  ru: "Отправить выделение в Pi Browser Agent",
  id: "Kirim pilihan ke Pi Browser Agent",
  vi: "Gửi vùng chọn đến Pi Browser Agent",
  th: "ส่งส่วนที่เลือกไปยัง Pi Browser Agent",
  hi: "चुना हुआ अंश Pi Browser Agent को भेजें",
} satisfies Record<Locale, string>
