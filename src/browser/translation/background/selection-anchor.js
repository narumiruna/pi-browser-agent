export async function getSelectionAnchor(options = {}) {
  const { chrome, frameId, isTabMessageDisconnectError, selectionText, tabId } = options
  if (chrome.translation) return chrome.translation.anchor({ tabId, frameId, text: selectionText })
  try {
    const target = { tabId }

    if (Number.isInteger(frameId) && frameId >= 0) {
      target.frameIds = [frameId]
    }

    const [result] = await chrome.scripting.executeScript({
      target,
      args: [selectionText],
      func: (selectedText) => {
        const SEARCH_SNIPPET_MAX_LENGTH = 120
        const SEARCH_SNIPPET_MIN_LENGTH = 12
        const SEARCH_ELEMENT_SELECTOR = [
          "p",
          "li",
          "blockquote",
          "figcaption",
          "td",
          "th",
          "h1",
          "h2",
          "h3",
          "h4",
          "h5",
          "h6",
          "div",
          "span",
        ].join(", ")
        const SKIP_SELECTOR = [
          "script",
          "style",
          "noscript",
          "textarea",
          "input",
          "select",
          "option",
          "svg",
          "canvas",
        ].join(", ")

        const selection = typeof window.getSelection === "function" ? window.getSelection() : null

        const toRect = (rect) => {
          if (!rect) {
            return null
          }

          return {
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            left: rect.left,
            width: rect.width,
            height: rect.height,
          }
        }

        const getRangeRect = (range) => {
          if (!range) {
            return null
          }

          const rangeRect = toRect(range.getBoundingClientRect())

          if (rangeRect && (rangeRect.width > 0 || rangeRect.height > 0)) {
            return rangeRect
          }

          const clientRects = Array.from(range.getClientRects())
            .map((rect) => toRect(rect))
            .filter((rect) => rect && (rect.width > 0 || rect.height > 0))

          if (clientRects.length === 0) {
            return null
          }

          const top = Math.min(...clientRects.map((rect) => rect.top))
          const right = Math.max(...clientRects.map((rect) => rect.right))
          const bottom = Math.max(...clientRects.map((rect) => rect.bottom))
          const left = Math.min(...clientRects.map((rect) => rect.left))

          return {
            top,
            right,
            bottom,
            left,
            width: Math.max(0, right - left),
            height: Math.max(0, bottom - top),
          }
        }

        const normalizeWithMap = (text) => {
          const raw = String(text || "")
          let normalized = ""
          const indexMap = []
          let previousWasWhitespace = false

          for (let index = 0; index < raw.length; index += 1) {
            const character = raw[index]
            const isWhitespace = /\s/.test(character)

            if (isWhitespace) {
              if (previousWasWhitespace) {
                continue
              }

              normalized += " "
              indexMap.push(index)
              previousWasWhitespace = true
              continue
            }

            normalized += character
            indexMap.push(index)
            previousWasWhitespace = false
          }

          return {
            normalized: normalized.trim(),
            indexMap,
            raw,
          }
        }

        const buildSearchSnippets = (text) => {
          const normalized = String(text || "")
            .replace(/\s+/g, " ")
            .trim()

          if (!normalized) {
            return []
          }

          return [
            normalized.slice(0, SEARCH_SNIPPET_MAX_LENGTH),
            normalized.slice(0, 80),
            normalized.slice(0, 48),
            normalized.slice(0, 24),
          ].filter(
            (snippet, index, array) =>
              snippet.length >= SEARCH_SNIPPET_MIN_LENGTH && array.indexOf(snippet) === index,
          )
        }

        const isVisibleElement = (element) => {
          if (!(element instanceof Element)) {
            return false
          }

          if (element.closest(SKIP_SELECTOR)) {
            return false
          }

          const style = window.getComputedStyle(element)

          return style.display !== "none" && style.visibility !== "hidden"
        }

        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
          const snippets = buildSearchSnippets(selectedText)

          if (snippets.length === 0 || !document.body) {
            return null
          }

          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
              if (!(node instanceof Text)) {
                return NodeFilter.FILTER_REJECT
              }

              const parent = node.parentElement

              if (!parent || !isVisibleElement(parent)) {
                return NodeFilter.FILTER_REJECT
              }

              return String(node.textContent || "").trim()
                ? NodeFilter.FILTER_ACCEPT
                : NodeFilter.FILTER_REJECT
            },
          })
          let currentNode = walker.nextNode()

          while (currentNode) {
            const normalizedNode = normalizeWithMap(currentNode.textContent)

            for (const snippet of snippets) {
              const normalizedIndex = normalizedNode.normalized.indexOf(snippet)

              if (normalizedIndex < 0) {
                continue
              }

              const rawStart = normalizedNode.indexMap[normalizedIndex]
              const rawEndIndex = Math.min(
                normalizedIndex + snippet.length - 1,
                normalizedNode.indexMap.length - 1,
              )
              const rawEnd = normalizedNode.indexMap[rawEndIndex] + 1

              if (!Number.isInteger(rawStart) || !Number.isInteger(rawEnd)) {
                continue
              }

              const range = document.createRange()
              range.setStart(currentNode, rawStart)
              range.setEnd(currentNode, rawEnd)
              const fallbackRect = getRangeRect(range)

              if (fallbackRect) {
                return fallbackRect
              }
            }

            currentNode = walker.nextNode()
          }

          for (const element of document.querySelectorAll(SEARCH_ELEMENT_SELECTOR)) {
            if (!isVisibleElement(element)) {
              continue
            }

            const normalizedText = String(element.textContent || "")
              .replace(/\s+/g, " ")
              .trim()

            if (!normalizedText) {
              continue
            }

            for (const snippet of snippets) {
              if (!normalizedText.includes(snippet)) {
                continue
              }

              const fallbackRect = toRect(element.getBoundingClientRect())

              if (fallbackRect && (fallbackRect.width > 0 || fallbackRect.height > 0)) {
                return fallbackRect
              }
            }
          }

          return null
        }

        return getRangeRect(selection.getRangeAt(0).cloneRange())
      },
    })

    return result?.result || null
  } catch (error) {
    if (isTabMessageDisconnectError(error)) {
      return null
    }

    throw error
  }
}
