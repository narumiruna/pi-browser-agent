import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import { JSDOM } from "jsdom"
import { afterEach, describe, expect, test, vi } from "vitest"
import { renderMessageContent } from "../../src/browser/sidepanel/conversation-page.js"

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
    expect(container.textContent).toBe("Inspect safely[tool call: browser_read_page]\n{}")
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
