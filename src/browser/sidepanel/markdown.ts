import createDOMPurify, { type DOMPurify } from "dompurify"
import { Marked } from "marked"

function escapeText(text: string): string {
  return text.replace(/[&<>"']/g, (character) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character] ?? ""
  })
}

const parser = new Marked({
  async: false,
  gfm: true,
  renderer: {
    html: ({ text }) => escapeText(text),
    image: ({ text }) => escapeText(text),
    code: ({ text }) => `<pre><code>${escapeText(text)}</code></pre>`,
  },
})

const purifiers = new WeakMap<Document, DOMPurify>()

/** The only HTML parsing boundary for untrusted assistant prose. */
export function renderMarkdown(text: string): DocumentFragment {
  let purifier = purifiers.get(document)
  if (!purifier) {
    if (!document.defaultView) throw new Error("Markdown requires a browser document")
    purifier = createDOMPurify(document.defaultView)
    purifiers.set(document, purifier)
  }
  const fragment = purifier.sanitize(parser.parse(text, { async: false }), {
    ALLOWED_TAGS: [
      "p",
      "br",
      "hr",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "ul",
      "ol",
      "li",
      "strong",
      "em",
      "del",
      "blockquote",
      "pre",
      "code",
      "a",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
    ],
    ALLOWED_ATTR: ["href", "title", "start"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  })
  for (const link of fragment.querySelectorAll("a")) {
    const href = link.getAttribute("href") ?? ""
    let safe = false
    try {
      const url = new URL(href)
      safe = /^https?:$/.test(url.protocol) && !url.username && !url.password
    } catch {
      // Relative URLs have no meaningful base in an extension conversation.
    }
    if (!safe) {
      link.replaceWith(...link.childNodes)
      continue
    }
    link.setAttribute("target", "_blank")
    link.setAttribute("rel", "noopener noreferrer")
  }
  return fragment
}
