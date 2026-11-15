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

export const TRANSLATION_CONTEXT_MENU_TITLES = {
  en: [
    "Translate this page",
    "Translate selected text",
    "Translate YouTube subtitles",
    "Translate PDF",
  ],
  de: [
    "Diese Seite übersetzen",
    "Ausgewählten Text übersetzen",
    "YouTube-Untertitel übersetzen",
    "PDF übersetzen",
  ],
  es: [
    "Traducir esta página",
    "Traducir texto seleccionado",
    "Traducir subtítulos de YouTube",
    "Traducir PDF",
  ],
  fr: [
    "Traduire cette page",
    "Traduire le texte sélectionné",
    "Traduire les sous-titres YouTube",
    "Traduire un PDF",
  ],
  hi: [
    "इस पेज का अनुवाद करें",
    "चुने गए टेक्स्ट का अनुवाद करें",
    "YouTube सबटाइटल का अनुवाद करें",
    "PDF का अनुवाद करें",
  ],
  id: [
    "Terjemahkan halaman ini",
    "Terjemahkan teks pilihan",
    "Terjemahkan subtitel YouTube",
    "Terjemahkan PDF",
  ],
  it: [
    "Traduci questa pagina",
    "Traduci il testo selezionato",
    "Traduci i sottotitoli YouTube",
    "Traduci PDF",
  ],
  ja: ["このページを翻訳", "選択したテキストを翻訳", "YouTube の字幕を翻訳", "PDF を翻訳"],
  ko: ["이 페이지 번역", "선택한 텍스트 번역", "YouTube 자막 번역", "PDF 번역"],
  nl: [
    "Deze pagina vertalen",
    "Geselecteerde tekst vertalen",
    "YouTube-ondertitels vertalen",
    "PDF vertalen",
  ],
  pl: [
    "Przetłumacz tę stronę",
    "Przetłumacz zaznaczony tekst",
    "Przetłumacz napisy YouTube",
    "Przetłumacz PDF",
  ],
  "pt-BR": [
    "Traduzir esta página",
    "Traduzir texto selecionado",
    "Traduzir legendas do YouTube",
    "Traduzir PDF",
  ],
  pt: [
    "Traduzir esta página",
    "Traduzir texto selecionado",
    "Traduzir legendas do YouTube",
    "Traduzir PDF",
  ],
  ru: [
    "Перевести эту страницу",
    "Перевести выделенный текст",
    "Перевести субтитры YouTube",
    "Перевести PDF",
  ],
  th: ["แปลหน้านี้", "แปลข้อความที่เลือก", "แปลคำบรรยาย YouTube", "แปล PDF"],
  tr: ["Bu sayfayı çevir", "Seçili metni çevir", "YouTube altyazılarını çevir", "PDF çevir"],
  vi: ["Dịch trang này", "Dịch văn bản đã chọn", "Dịch phụ đề YouTube", "Dịch PDF"],
  "zh-TW": ["翻譯此網頁", "翻譯選取文字", "翻譯 YouTube 字幕", "翻譯 PDF"],
} satisfies Record<Locale, [string, string, string, string]>
