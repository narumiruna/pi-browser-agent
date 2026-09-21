import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { ImageContent } from "@earendil-works/pi-ai"
import { createCopyButton } from "./copy-button.js"
import { imageContentSource } from "./images.js"
import { renderMarkdown } from "./markdown.js"

interface ContentState {
  disclosures: Map<string, HTMLDetailsElement>
  images: Map<number, HTMLImageElement>
}
function newContentState(): ContentState {
  return { disclosures: new Map(), images: new Map() }
}

function appendTextContent(container: HTMLElement, text: string): void {
  const block = document.createElement("span")
  block.className = "content-text"
  block.textContent = text
  container.append(block)
}

function appendProse(container: HTMLElement, text: string, markdown: boolean, blockKey = 0): void {
  if (!markdown) {
    appendTextContent(container, text)
    return
  }
  const block = document.createElement("div")
  block.className = "markdown"
  block.append(renderMarkdown(text))
  for (const [index, pre] of block.querySelectorAll("pre").entries()) {
    const wrapper = document.createElement("div")
    wrapper.className = "code-block"
    const copy = createCopyButton("Copy code", pre.querySelector("code")?.textContent ?? "")
    copy.dataset.focusKey = `code-${blockKey}-${index}`
    pre.replaceWith(wrapper)
    wrapper.append(copy, pre)
  }
  for (const [index, link] of block.querySelectorAll("a").entries())
    link.dataset.focusKey = `link-${blockKey}-${index}:${link.href}`
  for (const [index, table] of block.querySelectorAll("table").entries()) {
    const wrapper = document.createElement("div")
    wrapper.className = "table-scroll"
    wrapper.tabIndex = 0
    wrapper.dataset.focusKey = `table-${blockKey}-${index}`
    wrapper.setAttribute("role", "region")
    wrapper.setAttribute("aria-label", "Table")
    table.replaceWith(wrapper)
    wrapper.append(table)
  }
  container.append(block)
}

function disclosure(
  state: ContentState,
  key: string,
  title: string,
  className: string,
): HTMLDetailsElement {
  let details = state.disclosures.get(key)
  if (!details) {
    details = document.createElement("details")
    details.className = className
    const summary = document.createElement("summary")
    summary.dataset.focusKey = key
    details.append(summary, document.createElement("div"))
    state.disclosures.set(key, details)
  }
  const summary = details.firstElementChild as HTMLElement
  summary.textContent = title
  return details
}

export function renderMessageContent(
  container: HTMLElement,
  message: AgentMessage,
  renderedImages: WeakMap<ImageContent, HTMLImageElement> = new WeakMap(),
  state: ContentState = newContentState(),
): { hasImage: boolean; roleLabel: string; text: string; toolCall: boolean } {
  let hasImage = false
  let toolCall = false
  let text: string
  const answers: string[] = []
  if (
    !("content" in message) ||
    (!Array.isArray(message.content) && typeof message.content !== "string")
  ) {
    text = JSON.stringify("content" in message ? message.content : message)
    appendTextContent(container, text)
  } else if (typeof message.content === "string") {
    text = message.content
    appendProse(container, text, message.role === "assistant")
    if (message.role === "assistant") answers.push(text)
  } else {
    const textParts: string[] = []
    for (const [index, item] of message.content.entries()) {
      if (item.type === "image") {
        hasImage = true
        textParts.push(`[image: ${item.mimeType}]`)
        const source = imageContentSource(item)
        if (!source) {
          appendTextContent(container, `[image unavailable: ${item.mimeType}]`)
          continue
        }
        let image = state.images.get(index) ?? renderedImages.get(item)
        if (!image) {
          image = document.createElement("img")
          image.className = "message-image"
          image.alt = message.role === "user" ? "Pasted image" : "Image result"
          image.loading = "lazy"
          image.decoding = "async"
        }
        if (image.getAttribute("src") !== source) image.src = source
        state.images.set(index, image)
        renderedImages.set(item, image)
        container.append(image)
      } else if (item.type === "text") {
        textParts.push(item.text)
        if (item.text) appendProse(container, item.text, message.role === "assistant", index)
        if (message.role === "assistant") answers.push(item.text)
      } else if (item.type === "toolCall") {
        toolCall = message.role === "assistant"
        const value = `[tool call: ${item.name}]\n${JSON.stringify(item.arguments, null, 2)}`
        textParts.push(value)
        const details = disclosure(
          state,
          `tool-${index}`,
          `Tool call · ${item.name}`,
          "message toolCall",
        )
        const content = details.lastElementChild as HTMLElement
        content.className = "content"
        content.replaceChildren()
        appendTextContent(content, value)
        container.append(details)
      } else if (item.type === "thinking") {
        textParts.push(item.thinking)
        const details = disclosure(state, `thinking-${index}`, "Thinking", "message thinking")
        const content = details.lastElementChild as HTMLElement
        content.className = "content"
        content.replaceChildren()
        appendTextContent(content, item.thinking)
        container.append(details)
      } else {
        textParts.push("[content]")
        appendTextContent(container, "[content]")
      }
    }
    text = textParts.join("\n")
  }
  if (answers.some(Boolean)) {
    const copy = createCopyButton("Copy answer", answers.join("\n"))
    copy.dataset.focusKey = "copy-answer"
    container.append(copy)
  }
  const roleLabel = toolCall
    ? "Tool call"
    : message.role === "user"
      ? "You"
      : message.role === "assistant"
        ? "Pi"
        : message.role === "toolResult"
          ? "Tool result"
          : message.role
  return { hasImage, roleLabel, text, toolCall }
}

interface MessageView {
  node: HTMLElement
  content: HTMLElement
  state: ContentState
  signature: string
  initialized: boolean
}

/** UI-only state. No disclosure state or rendered HTML enters saved/model messages. */
export class TranscriptRenderer {
  private sessionId = ""
  private readonly views = new Map<string, MessageView>()
  private images = new WeakMap<ImageContent, HTMLImageElement>()

  constructor(private readonly transcript: HTMLElement) {}

  render(messages: AgentMessage[], sessionId: string): void {
    const changedSession = sessionId !== this.sessionId
    const nearBottom =
      this.transcript.scrollHeight - this.transcript.scrollTop - this.transcript.clientHeight < 48
    const scrollTop = this.transcript.scrollTop
    const focused = this.transcript.ownerDocument.activeElement as HTMLElement | null
    const focusedMessage = focused?.closest<HTMLElement>("[data-message-key]")?.dataset.messageKey
    const focusedKey = focused?.dataset.focusKey
    if (changedSession) {
      this.sessionId = sessionId
      this.views.clear()
      this.images = new WeakMap()
      this.transcript.replaceChildren()
    }
    const used = new Set<string>()
    const occurrences = new Map<string, number>()
    let cursor = this.transcript.firstChild
    for (const message of messages) {
      const base = `${message.role}:${"timestamp" in message ? message.timestamp : ""}:${message.role === "toolResult" ? message.toolCallId : ""}`
      const occurrence = occurrences.get(base) ?? 0
      occurrences.set(base, occurrence + 1)
      const key = `${base}:${occurrence}`
      used.add(key)
      let view = this.views.get(key)
      if (!view) {
        const node = document.createElement(message.role === "toolResult" ? "details" : "article")
        node.className = `message ${message.role}`
        node.dataset.messageKey = key
        const heading = document.createElement(message.role === "toolResult" ? "summary" : "span")
        heading.className = "role"
        heading.dataset.focusKey = "heading"
        const content = document.createElement("div")
        content.className = "content"
        node.append(heading, content)
        view = { node, content, state: newContentState(), signature: "", initialized: false }
        this.views.set(key, view)
      }
      const signature = JSON.stringify(message)
      if (view.signature !== signature) {
        view.content.replaceChildren()
        const rendered = renderMessageContent(view.content, message, this.images, view.state)
        const heading = view.node.firstElementChild as HTMLElement
        if (message.role === "toolResult") {
          heading.textContent = `Tool result · ${message.toolName}${message.isError ? " · Error" : ""}`
          if (!view.initialized)
            (view.node as HTMLDetailsElement).open = message.isError || rendered.hasImage
        } else heading.textContent = message.role === "assistant" ? "Pi" : rendered.roleLabel
        view.signature = signature
        view.initialized = true
      }
      // Leave already ordered nodes attached: unchanged controls keep focus and image state.
      if (view.node !== cursor) this.transcript.insertBefore(view.node, cursor)
      cursor = view.node.nextSibling
    }
    for (const [key, view] of this.views) {
      if (!used.has(key)) {
        view.node.remove()
        this.views.delete(key)
      }
    }
    while (cursor) {
      const next = cursor.nextSibling
      cursor.remove()
      cursor = next
    }
    if (!changedSession && focusedMessage && focusedKey) {
      const node = this.views.get(focusedMessage)?.node
      const target = Array.from(node?.querySelectorAll<HTMLElement>("[data-focus-key]") ?? []).find(
        (item) => item.dataset.focusKey === focusedKey,
      )
      if (target && document.activeElement !== target) target.focus({ preventScroll: true })
    }
    this.transcript.scrollTop =
      changedSession || nearBottom ? this.transcript.scrollHeight : scrollTop
  }
}
