import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import { JSDOM } from "jsdom"
import { afterEach, describe, expect, test, vi } from "vitest"
import {
  renderMessageContent,
  TranscriptRenderer,
} from "../../src/browser/sidepanel/message-rendering.js"

function assistantContent(content: AssistantMessage["content"]): AgentMessage {
  return {
    role: "assistant",
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.6-terra",
    timestamp: 1,
    stopReason: "toolUse",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    content,
  }
}

function installDocument(): Document {
  const document = new JSDOM("<!doctype html><body></body>").window.document
  vi.stubGlobal("document", document)
  return document
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("conversation message rendering", () => {
  test("keeps answers outside disclosures and preserves toggles, focus, and session boundaries", () => {
    const document = installDocument()
    const transcript = document.createElement("div")
    document.body.append(transcript)
    const renderer = new TranscriptRenderer(transcript)
    const message = assistantContent([
      { type: "thinking", thinking: "Private trace" },
      { type: "text", text: "# Answer" },
      { type: "toolCall", id: "call", name: "browser_read_page", arguments: {} },
    ])
    const original = JSON.stringify(message)
    renderer.render([message], "one")
    expect(transcript.querySelector("h1")?.closest("details")).toBeNull()
    const thinking = transcript.querySelector("details.thinking") as HTMLDetailsElement
    const summary = thinking.querySelector("summary") as HTMLElement
    thinking.open = true
    summary.focus()
    const updated = structuredClone(message) as ReturnType<typeof assistantContent> & {
      content: AssistantMessage["content"]
    }
    updated.content.push({ type: "text", text: "More streamed text" })
    renderer.render([updated], "one")
    expect(transcript.querySelector("details.thinking")).toBe(thinking)
    expect(thinking.open).toBe(true)
    expect(document.activeElement).toBe(summary)
    renderer.render([structuredClone(updated)], "one")
    expect(thinking.open).toBe(true)
    renderer.render([updated], "two")
    expect(transcript.querySelector("details.thinking")).not.toBe(thinking)
    expect((transcript.querySelector("details.thinking") as HTMLDetailsElement).open).toBe(false)
    expect(JSON.stringify(message)).toBe(original)
  })

  test("uses structured tool errors and preserves user-collapsed image results across updates", () => {
    const document = installDocument()
    const transcript = document.createElement("div")
    const renderer = new TranscriptRenderer(transcript)
    const result: AgentMessage = {
      role: "toolResult",
      toolCallId: "call",
      toolName: "browser_click",
      timestamp: 2,
      isError: true,
      content: [{ type: "text", text: "Declined" }],
    }
    renderer.render([result], "one")
    const details = transcript.querySelector("details") as HTMLDetailsElement
    expect(details.open).toBe(true)
    expect(details.querySelector("summary")?.textContent).toContain("Error")
    details.open = false
    renderer.render([{ ...result, content: [{ type: "text", text: "Updated error" }] }], "one")
    expect(details.open).toBe(false)
    const image: AgentMessage = {
      ...result,
      isError: false,
      toolCallId: "image",
      content: [{ type: "image", data: "cG5n", mimeType: "image/png" }],
    }
    renderer.render([image], "one")
    const imageNode = transcript.querySelector("img")
    const imageDetails = transcript.querySelector("details") as HTMLDetailsElement
    expect(imageDetails.open).toBe(true)
    imageDetails.open = false
    renderer.render(
      [
        {
          ...structuredClone(image),
          timestamp: 2,
          content: [...image.content, { type: "text", text: "caption" }],
        },
      ],
      "one",
    )
    expect(transcript.querySelector("img")).toBe(imageNode)
    expect(imageDetails.open).toBe(false)
  })

  test("keeps Copy answer focused when new code controls arrive during streaming", () => {
    const document = installDocument()
    const transcript = document.createElement("div")
    document.body.append(transcript)
    const renderer = new TranscriptRenderer(transcript)
    renderer.render([assistantContent([{ type: "text", text: "Start" }])], "one")
    transcript.querySelector<HTMLButtonElement>("button")?.focus()
    renderer.render(
      [assistantContent([{ type: "text", text: "Start\n\n```ts\nconst x = 1\n```" }])],
      "one",
    )
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Copy answer")
  })

  test("does not force readers back to the bottom on updates", () => {
    const document = installDocument()
    const transcript = document.createElement("div")
    Object.defineProperty(transcript, "scrollHeight", { value: 1000 })
    Object.defineProperty(transcript, "clientHeight", { value: 200 })
    const renderer = new TranscriptRenderer(transcript)
    renderer.render([assistantContent([{ type: "text", text: "Start" }])], "one")
    transcript.scrollTop = 100
    renderer.render([assistantContent([{ type: "text", text: "Changed" }])], "one")
    expect(transcript.scrollTop).toBe(100)
    transcript.scrollTop = 795
    renderer.render([assistantContent([{ type: "text", text: "Follow" }])], "one")
    expect(transcript.scrollTop).toBe(1000)
  })

  test("projects text, thinking, and tool calls while rendering them once", () => {
    const document = installDocument()
    const container = document.createElement("span")
    const message = assistantContent([
      { type: "text", text: "" },
      { type: "thinking", thinking: "Inspect safely" },
      { type: "toolCall", id: "call-1", name: "browser_read_page", arguments: {} },
    ])

    const rendered = renderMessageContent(container, message)

    expect(rendered).toEqual({
      hasImage: false,
      roleLabel: "Tool call",
      text: "\nInspect safely\n[tool call: browser_read_page]\n{}",
      toolCall: true,
    })
    expect(container.querySelectorAll(".content-text")).toHaveLength(2)
    expect(container.querySelectorAll("details")).toHaveLength(2)
    expect(container.querySelector("details")?.open).toBe(false)
    expect(container.textContent).toContain("Inspect safely")
    expect(container.textContent).toContain("[tool call: browser_read_page]\n{}")
  })

  test("renders supported images with stable nodes and accessibility labels", () => {
    const document = installDocument()
    const image = { type: "image" as const, data: "cG5n", mimeType: "image/png" }
    const message: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: "Inspect" }, image],
      timestamp: 1,
    }
    const renderedImages = new WeakMap()
    const firstContainer = document.createElement("span")
    const secondContainer = document.createElement("span")

    const first = renderMessageContent(firstContainer, message, renderedImages)
    const firstImage = firstContainer.querySelector("img")
    const second = renderMessageContent(secondContainer, message, renderedImages)

    expect(first).toEqual({
      hasImage: true,
      roleLabel: "You",
      text: "Inspect\n[image: image/png]",
      toolCall: false,
    })
    expect(second).toEqual(first)
    expect(firstImage).not.toBeNull()
    expect(secondContainer.querySelector("img")).toBe(firstImage)
    expect(firstImage).toMatchObject({
      alt: "Pasted image",
      className: "message-image",
      decoding: "async",
      loading: "lazy",
    })
    expect(firstImage?.getAttribute("src")).toBe("data:image/png;base64,cG5n")
  })

  test("keeps unavailable-image and error preview metadata unchanged", () => {
    const document = installDocument()
    const unavailableContainer = document.createElement("span")
    const unavailable = renderMessageContent(unavailableContainer, {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "browser_capture_visible",
      timestamp: 1,
      isError: false,
      content: [{ type: "image", data: "PHN2Zz4=", mimeType: "image/svg+xml" }],
    })
    const errorContainer = document.createElement("span")
    const error = renderMessageContent(errorContainer, {
      role: "toolResult",
      toolCallId: "call-2",
      toolName: "browser_click",
      timestamp: 2,
      isError: true,
      content: [{ type: "text", text: "Error: Browser action was declined" }],
    })

    expect(unavailable).toEqual({
      hasImage: true,
      roleLabel: "Tool result",
      text: "[image: image/svg+xml]",
      toolCall: false,
    })
    expect(unavailableContainer.textContent).toBe("[image unavailable: image/svg+xml]")
    expect(unavailableContainer.querySelector("img")).toBeNull()
    expect(error).toEqual({
      hasImage: false,
      roleLabel: "Tool result",
      text: "Error: Browser action was declined",
      toolCall: false,
    })
    expect(errorContainer.textContent).toBe("Error: Browser action was declined")
  })
})
