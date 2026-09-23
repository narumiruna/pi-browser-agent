export type PageKind = "none" | "web" | "restricted" | "file" | "pdf"

export interface PageCapability {
  kind: PageKind
  title: string
}

/** Classification is conservative; a web URL still needs permission and may reject injection. */
export function classifyPage(url?: string, title = ""): PageCapability {
  const safeTitle = title.slice(0, 160)
  if (!url) return { kind: "none", title: "" }
  try {
    const parsed = new URL(url)
    if (parsed.protocol === "file:") {
      return { kind: /\.pdf$/i.test(parsed.pathname) ? "pdf" : "file", title: "" }
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { kind: "restricted", title: safeTitle }
    }
    if (/\.pdf$/i.test(parsed.pathname)) return { kind: "pdf", title: "" }
    if (
      parsed.hostname === "chromewebstore.google.com" ||
      (parsed.hostname === "chrome.google.com" && parsed.pathname.startsWith("/webstore"))
    ) {
      return { kind: "restricted", title: safeTitle }
    }
    return { kind: "web", title: safeTitle }
  } catch {
    return { kind: "restricted", title: safeTitle }
  }
}
