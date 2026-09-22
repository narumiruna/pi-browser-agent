import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { ImageContent } from "@earendil-works/pi-ai"
import { activityText, conversationText } from "./conversation-copy.js"
import { CopyButton, type CopyButtonKind } from "./copy-button.js"
import { imageContentSource } from "./images.js"
import { renderMarkdown } from "./markdown.js"

interface MessageRenderOptions {
  developerDetails?: boolean
  onAnnotateScreenshot?: (image: ImageContent) => void
}

interface ContentState {
  disclosures: Map<string, HTMLDetailsElement>
  images: Map<number, HTMLImageElement>
  copyButtons: Map<string, CopyButton>
  annotationButtons: Map<number, HTMLButtonElement>
}
function newContentState(): ContentState {
  return {
    disclosures: new Map(),
    images: new Map(),
    copyButtons: new Map(),
    annotationButtons: new Map(),
  }
}

function developerDetailsEnabled(): boolean {
  return (
    typeof __PI_BROWSER_AGENT_DEVELOPER_MODE__ !== "undefined" &&
    __PI_BROWSER_AGENT_DEVELOPER_MODE__
  )
}

function copyButton(
  state: ContentState,
  key: string,
  label: string,
  text: string,
  kind: CopyButtonKind,
): HTMLButtonElement {
  let control = state.copyButtons.get(key)
  if (!control) {
    control = new CopyButton(label, text, kind)
    control.element.dataset.focusKey = key
    state.copyButtons.set(key, control)
  }
  control.updateText(text)
  return control.element
}

function annotationButton(
  state: ContentState,
  index: number,
  image: ImageContent,
  onAnnotate: (image: ImageContent) => void,
): HTMLButtonElement {
  let button = state.annotationButtons.get(index)
  if (!button) {
    button = document.createElement("button")
    button.type = "button"
    button.className = "icon-button annotate-screenshot-button"
    button.ariaLabel = "Annotate screenshot"
    button.title = button.ariaLabel
    button.dataset.focusKey = `annotate-screenshot-${index}`
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    icon.setAttribute("class", "radix-icon")
    icon.setAttribute("viewBox", "0 0 15 15")
    icon.setAttribute("aria-hidden", "true")
    for (const data of ["m2 13 2.6-.6 7.7-7.7a1.4 1.4 0 0 0-2-2L2.6 10.4 2 13Z", "m8.9 4.1 2 2"]) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
      path.setAttribute("d", data)
      icon.append(path)
    }
    button.append(icon)
    state.annotationButtons.set(index, button)
  }
  button.onclick = () => onAnnotate(image)
  return button
}

function appendTextContent(container: HTMLElement, text: string): void {
  const block = document.createElement("span")
  block.className = "content-text"
  block.textContent = text
  container.append(block)
}

function appendProse(
  container: HTMLElement,
  text: string,
  markdown: boolean,
  state: ContentState,
  blockKey = 0,
): void {
  if (!markdown) {
    appendTextContent(container, text)
    return
  }
  const block = document.createElement("div")
  block.className = "markdown"
  block.append(renderMarkdown(text))
  for (const [index, pre] of block.querySelectorAll("pre").entries()) {
    const wrapper = document.createElement("div")
    const codeText = pre.querySelector("code")?.textContent ?? ""
    const visualExample = /[\u2500-\u257f]/u.test(codeText)
    wrapper.className = visualExample ? "code-block visual-example" : "code-block"
    pre.replaceWith(wrapper)
    wrapper.append(pre)
    if (!visualExample && codeText) {
      wrapper.append(
        copyButton(
          state,
          `code-${blockKey}-${index}`,
          conversationText("copyCode"),
          codeText,
          "code",
        ),
      )
    }
  }
  for (const [index, link] of block.querySelectorAll("a").entries())
    link.dataset.focusKey = `link-${blockKey}-${index}:${link.href}`
  for (const [index, table] of block.querySelectorAll("table").entries()) {
    const wrapper = document.createElement("div")
    wrapper.className = "table-scroll"
    wrapper.tabIndex = 0
    wrapper.dataset.focusKey = `table-${blockKey}-${index}`
    wrapper.setAttribute("role", "region")
    wrapper.setAttribute("aria-label", conversationText("table"))
    table.replaceWith(wrapper)
    wrapper.append(table)
  }
  container.append(block)
}

function activityItem(title: string, className: string): HTMLElement {
  const item = document.createElement("div")
  item.className = `${className} activity-only`
  const marker = document.createElement("span")
  marker.className = "activity-marker"
  marker.setAttribute("aria-hidden", "true")
  const label = document.createElement("span")
  label.className = "activity-title"
  label.textContent = title
  item.append(marker, label)
  return item
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
  options: MessageRenderOptions = {
    developerDetails: developerDetailsEnabled(),
  },
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
    appendProse(container, text, message.role === "assistant", state)
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
          image.alt =
            message.role === "user"
              ? conversationText("pastedImage")
              : conversationText("imageResult")
          image.loading = "lazy"
          image.decoding = "async"
        }
        if (image.getAttribute("src") !== source) image.src = source
        state.images.set(index, image)
        renderedImages.set(item, image)
        container.append(image)
        if (
          message.role === "toolResult" &&
          !message.isError &&
          message.toolName === "browser_capture_visible" &&
          options.onAnnotateScreenshot
        ) {
          container.append(annotationButton(state, index, item, options.onAnnotateScreenshot))
        }
      } else if (item.type === "text") {
        textParts.push(item.text)
        if (item.text) appendProse(container, item.text, message.role === "assistant", state, index)
        if (message.role === "assistant") answers.push(item.text)
      } else if (item.type === "toolCall") {
        toolCall = message.role === "assistant"
        const value = `[tool call: ${item.name}]\n${JSON.stringify(item.arguments, null, 2)}`
        textParts.push(value)
        if (options.developerDetails) {
          const details = disclosure(
            state,
            `tool-${index}`,
            activityText(item.name, "active"),
            "message toolCall",
          )
          const content = details.lastElementChild as HTMLElement
          content.className = "content"
          content.replaceChildren()
          appendTextContent(content, value)
          container.append(details)
        } else {
          container.append(activityItem(activityText(item.name, "active"), "message toolCall"))
        }
      } else if (item.type === "thinking") {
        textParts.push(item.thinking)
        const details = disclosure(
          state,
          `thinking-${index}`,
          conversationText("thinking"),
          "message thinking",
        )
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
    const actions = document.createElement("footer")
    actions.className = "message-actions"
    actions.append(
      copyButton(state, "copy-answer", conversationText("copyAll"), answers.join("\n"), "answer"),
    )
    container.append(actions)
  }
  const roleLabel = toolCall
    ? conversationText("activity")
    : message.role === "user"
      ? conversationText("user")
      : message.role === "assistant"
        ? "Pi"
        : message.role === "toolResult"
          ? conversationText("activity")
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

function toolResultHasImage(message: AgentMessage): boolean {
  return (
    message.role === "toolResult" &&
    Array.isArray(message.content) &&
    message.content.some((item) => item.type === "image")
  )
}

/** UI-only state. No disclosure state or rendered HTML enters saved/model messages. */
export class TranscriptRenderer {
  private sessionId = ""
  private readonly views = new Map<string, MessageView>()
  private readonly turns = new Map<string, HTMLElement>()
  private images = new WeakMap<ImageContent, HTMLImageElement>()
  private readonly developerDetails: boolean
  private readonly options: MessageRenderOptions

  constructor(
    private readonly transcript: HTMLElement,
    options: MessageRenderOptions | boolean = {},
  ) {
    this.options = typeof options === "boolean" ? {} : options
    this.developerDetails =
      typeof options === "boolean"
        ? options
        : (options.developerDetails ?? developerDetailsEnabled())
  }

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
      this.turns.clear()
      this.images = new WeakMap()
      this.transcript.replaceChildren()
    }
    const used = new Set<string>()
    const occurrences = new Map<string, number>()
    const ordered: Array<{ key: string; message: AgentMessage; view: MessageView }> = []
    for (const message of messages) {
      const base = `${message.role}:${"timestamp" in message ? message.timestamp : ""}:${message.role === "toolResult" ? message.toolCallId : ""}`
      const occurrence = occurrences.get(base) ?? 0
      occurrences.set(base, occurrence + 1)
      const key = `${base}:${occurrence}`
      used.add(key)
      const expandableToolResult =
        message.role === "toolResult" &&
        (this.developerDetails || message.isError || toolResultHasImage(message))
      const tagName = message.role === "toolResult" && expandableToolResult ? "details" : "article"
      let view = this.views.get(key)
      if (view && view.node.localName !== tagName) {
        view.node.remove()
        this.views.delete(key)
        view = undefined
      }
      if (!view) {
        const node = document.createElement(tagName)
        node.className = `message ${message.role}${
          message.role === "toolResult" && !expandableToolResult ? " activity-only" : ""
        }`
        node.dataset.messageKey = key
        const heading = document.createElement(tagName === "details" ? "summary" : "span")
        heading.className = message.role === "toolResult" ? "role activity-title" : "role"
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
        const renderTarget =
          message.role === "toolResult" && !expandableToolResult
            ? document.createElement("div")
            : view.content
        const rendered = renderMessageContent(renderTarget, message, this.images, view.state, {
          ...this.options,
          developerDetails: this.developerDetails,
        })
        const heading = view.node.firstElementChild as HTMLElement
        if (message.role === "toolResult") {
          heading.textContent = activityText(message.toolName, "complete", message.isError)
          if (!view.initialized && expandableToolResult) {
            const details = view.node as HTMLDetailsElement
            details.open = message.isError || rendered.hasImage
          }
        } else {
          heading.textContent = message.role === "assistant" ? "Pi" : rendered.roleLabel
        }
        view.signature = signature
        view.initialized = true
      }
      ordered.push({ key, message, view })
    }
    for (const [key, view] of this.views) {
      if (!used.has(key)) {
        view.node.remove()
        this.views.delete(key)
      }
    }

    const usedTurns = new Set<string>()
    const topLevelNodes: HTMLElement[] = []
    const groupedViews = new Map<HTMLElement, MessageView[]>()
    let boundaryKey = "start"
    let assistantTurn: HTMLElement | undefined
    for (const { key, message, view } of ordered) {
      if (message.role === "user") {
        boundaryKey = key
        assistantTurn = undefined
        topLevelNodes.push(view.node)
        continue
      }
      if (!assistantTurn) {
        const turnKey = `turn:${boundaryKey}`
        usedTurns.add(turnKey)
        assistantTurn = this.turns.get(turnKey)
        if (!assistantTurn) {
          assistantTurn = document.createElement("section")
          assistantTurn.className = "assistant-turn"
          assistantTurn.setAttribute("aria-label", `Pi · ${conversationText("assistantIdentity")}`)
          const heading = document.createElement("div")
          heading.className = "assistant-turn-heading"
          const name = document.createElement("strong")
          name.textContent = "Pi"
          const identity = document.createElement("span")
          identity.textContent = conversationText("assistantIdentity")
          heading.append(name, identity)
          assistantTurn.append(heading)
          this.turns.set(turnKey, assistantTurn)
        }
        topLevelNodes.push(assistantTurn)
        groupedViews.set(assistantTurn, [])
      }
      groupedViews.get(assistantTurn)?.push(view)
    }
    for (const [turnKey, turn] of this.turns) {
      if (!usedTurns.has(turnKey)) {
        turn.remove()
        this.turns.delete(turnKey)
      }
    }
    for (const [turn, turnViews] of groupedViews) {
      let cursor = turn.firstElementChild?.nextSibling ?? null
      for (const view of turnViews) {
        if (view.node !== cursor) turn.insertBefore(view.node, cursor)
        cursor = view.node.nextSibling
      }
      while (cursor) {
        const next = cursor.nextSibling
        cursor.remove()
        cursor = next
      }
    }
    let cursor = this.transcript.firstChild
    for (const node of topLevelNodes) {
      if (node !== cursor) this.transcript.insertBefore(node, cursor)
      cursor = node.nextSibling
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
