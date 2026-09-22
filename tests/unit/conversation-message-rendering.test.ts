import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import { JSDOM } from "jsdom"
import { afterEach, describe, expect, test, vi } from "vitest"
import {
  conversationLanguage,
  conversationText,
} from "../../src/browser/sidepanel/conversation-copy.js"
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
    expect(details.querySelector("summary")?.textContent).toBe("Could not select the page control")
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

  test("hides internal tool names and result payloads outside developer builds", () => {
    const document = installDocument()
    const transcript = document.createElement("div")
    const renderer = new TranscriptRenderer(transcript)
    const toolCall = assistantContent([
      { type: "toolCall", id: "call", name: "browser_read_page", arguments: {} },
    ])
    const result: AgentMessage = {
      role: "toolResult",
      toolCallId: "call",
      toolName: "browser_read_page",
      timestamp: 2,
      isError: false,
      content: [{ type: "text", text: "Private page payload" }],
    }

    renderer.render([toolCall, result], "one")

    expect(transcript.querySelector(".assistant-turn")?.getAttribute("aria-label")).toBe(
      "Pi · Browser assistant",
    )
    expect(transcript.textContent).toContain("Reading the page")
    expect(transcript.textContent).toContain("Read the page")
    expect(transcript.textContent).not.toContain("browser_read_page")
    expect(transcript.textContent).not.toContain("Private page payload")
    expect(transcript.querySelector(".toolResult")?.localName).toBe("article")

    const developerTranscript = document.createElement("div")
    new TranscriptRenderer(developerTranscript, true).render([toolCall, result], "one")
    expect(developerTranscript.textContent).toContain("browser_read_page")
    expect(developerTranscript.textContent).toContain("Private page payload")
    expect(developerTranscript.querySelector(".toolResult")?.localName).toBe("details")
  })

  test("renders icon-only copy controls with action names, tooltips, and a live status", () => {
    const document = installDocument()
    const transcript = document.createElement("div")
    const renderer = new TranscriptRenderer(transcript)
    renderer.render(
      [assistantContent([{ type: "text", text: "Answer\n\n```ts\nconst x = 1\n```" }])],
      "one",
    )
    const buttons = transcript.querySelectorAll<HTMLButtonElement>("button.copy-button")
    expect(buttons).toHaveLength(2)
    for (const [index, label] of ["Copy code", "Copy answer"].entries()) {
      const button = buttons[index] as HTMLButtonElement
      expect(button.classList.contains("icon-button")).toBe(true)
      expect(button.getAttribute("aria-label")).toBe(label)
      expect(button.title).toBe(label)
      expect(button.textContent).toBe("")
      expect(button.querySelectorAll("svg[aria-hidden='true'] path")).toHaveLength(1)
      const status = button.querySelector("[role='status']")
      expect(status?.className).toBe("visually-hidden")
      expect(status?.getAttribute("aria-atomic")).toBe("true")
    }
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

  test.each([
    ["Copy answer", "Copied"],
    ["Copy answer", "Copy failed"],
    ["Copy code", "Copied"],
    ["Copy code", "Copy failed"],
  ])("preserves %s icons and feedback through streaming: %s", async (label, feedback) => {
    const document = installDocument()
    const transcript = document.createElement("div")
    document.body.append(transcript)
    const renderer = new TranscriptRenderer(transcript)
    let settle = () => {}
    const pending = new Promise<void>((resolve, reject) => {
      settle = feedback === "Copied" ? resolve : () => reject(new Error("Denied"))
    })
    const writeText = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(undefined)
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    const first = "# First\n\n```ts\nconst first = 1"
    const latest = `${first}\nconst second = 2\n\`\`\``
    const button = () =>
      transcript.querySelector<HTMLButtonElement>(
        `button[aria-label="${label}"]`,
      ) as HTMLButtonElement
    renderer.render([assistantContent([{ type: "text", text: first }])], "one")
    const clicked = button()
    const path = clicked.querySelector("path") as SVGPathElement
    const initialIcon = path.getAttribute("d")
    clicked.click()
    const pendingIcon = path.getAttribute("d")
    expect(pendingIcon).not.toBe(initialIcon)
    expect(writeText).toHaveBeenCalledExactlyOnceWith(
      label === "Copy answer" ? first : "const first = 1",
    )
    renderer.render([assistantContent([{ type: "text", text: latest }])], "one")
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(button().querySelector("[role='status']")?.textContent).toBe("Copying…")
    expect(button().title).toBe(`${label}: Copying…`)
    expect(button().querySelector("path")).toBe(path)
    settle()
    await Promise.resolve()
    expect(button().querySelector("[role='status']")?.textContent).toBe(feedback)
    expect(button().title).toBe(`${label}: ${feedback}`)
    const resultIcon = path.getAttribute("d")
    expect(resultIcon).not.toBe(initialIcon)
    expect(resultIcon).not.toBe(pendingIcon)
    expect(button()).toBe(clicked)
    renderer.render([assistantContent([{ type: "text", text: `${latest}\n\nDone.` }])], "one")
    expect(button().textContent).toBe(feedback)
    expect(path.getAttribute("d")).toBe(resultIcon)
    expect(button().getAttribute("aria-label")).toBe(label)
    button().click()
    expect(path.getAttribute("d")).toBe(pendingIcon)
    expect(writeText).toHaveBeenLastCalledWith(
      label === "Copy answer" ? `${latest}\n\nDone.` : "const first = 1\nconst second = 2",
    )
    await Promise.resolve()
    expect(button().textContent).toBe("Copied")
  })

  test("ignores older clipboard completions and isolates pending feedback across sessions", async () => {
    const document = installDocument()
    const transcript = document.createElement("div")
    document.body.append(transcript)
    const renderer = new TranscriptRenderer(transcript)
    let finishFirst = () => {}
    let failSecond = () => {}
    const first = new Promise<void>((resolve) => {
      finishFirst = resolve
    })
    const second = new Promise<void>((_resolve, reject) => {
      failSecond = () => reject(new Error("Denied"))
    })
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi
          .fn()
          .mockReturnValueOnce(first)
          .mockReturnValueOnce(second)
          .mockReturnValueOnce(first),
      },
    })
    const message = assistantContent([{ type: "text", text: "Answer" }])
    renderer.render([message], "one")
    const button = transcript.querySelector("button") as HTMLButtonElement
    button.click()
    button.click()
    failSecond()
    await Promise.resolve()
    expect(button.textContent).toBe("Copy failed")
    finishFirst()
    await Promise.resolve()
    expect(button.textContent).toBe("Copy failed")

    button.click()
    renderer.render([message], "two")
    const newButton = transcript.querySelector("button") as HTMLButtonElement
    expect(newButton).not.toBe(button)
    await Promise.resolve()
    expect(button.textContent).toBe("Copied")
    expect(newButton.textContent).toBe("")
    expect(newButton.title).toBe("Copy answer")
  })

  test.each([
    undefined,
    {
      writeText: () => {
        throw new Error("Denied")
      },
    },
  ])("keeps synchronous clipboard failure feedback after streaming updates", (clipboard) => {
    const document = installDocument()
    const transcript = document.createElement("div")
    const renderer = new TranscriptRenderer(transcript)
    vi.stubGlobal("navigator", { clipboard })
    renderer.render([assistantContent([{ type: "text", text: "Start" }])], "one")
    const button = transcript.querySelector("button") as HTMLButtonElement
    button.click()
    renderer.render([assistantContent([{ type: "text", text: "Start and finish" }])], "one")
    expect(transcript.querySelector("button")?.textContent).toBe("Copy failed")
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

    const rendered = renderMessageContent(container, message, undefined, undefined, {
      developerDetails: true,
    })

    expect(rendered).toEqual({
      hasImage: false,
      roleLabel: "Activity",
      text: "\nInspect safely\n[tool call: browser_read_page]\n{}",
      toolCall: true,
    })
    expect(container.querySelectorAll(".content-text")).toHaveLength(2)
    expect(container.querySelectorAll("details")).toHaveLength(2)
    expect(container.querySelector("details")?.open).toBe(false)
    expect(container.textContent).toContain("Inspect safely")
    expect(container.textContent).toContain("[tool call: browser_read_page]\n{}")
  })

  test("uses Traditional Chinese labels for a Traditional Chinese browser locale", () => {
    const document = installDocument()
    vi.stubGlobal("navigator", { language: "zh-TW", languages: ["zh-TW"] })
    const transcript = document.createElement("div")
    const renderer = new TranscriptRenderer(transcript)
    renderer.render(
      [
        { role: "user", content: "你好", timestamp: 1 },
        assistantContent([
          { type: "thinking", thinking: "檢查內容" },
          { type: "toolCall", id: "call", name: "browser_read_page", arguments: {} },
        ]),
      ],
      "one",
    )

    expect(transcript.querySelector(".message.user .role")?.textContent).toBe("你")
    expect(transcript.querySelector("details.thinking summary")?.textContent).toBe("思考中")
    expect(transcript.textContent).toContain("正在讀取頁面")
    expect(transcript.querySelector(".assistant-turn")?.getAttribute("aria-label")).toBe(
      "Pi · 瀏覽器助理",
    )
  })

  test.each([
    { languages: ["en-US", "zh-TW"], fallback: "en-US", language: "en", user: "You" },
    {
      languages: ["fr-FR", "zh-Hant-HK", "en-US"],
      fallback: "fr-FR",
      language: "zh-TW",
      user: "你",
    },
    { languages: ["fr-FR", "en-GB", "zh-TW"], fallback: "fr-FR", language: "en", user: "You" },
    { languages: [], fallback: "zh-HK", language: "zh-TW", user: "你" },
  ])(
    "uses the first supported preferred locale from $languages",
    ({ languages, fallback, language, user }) => {
      vi.stubGlobal("navigator", { language: fallback, languages })

      expect(conversationLanguage()).toBe(language)
      expect(conversationText("user")).toBe(user)
    },
  )

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
      roleLabel: "Activity",
      text: "[image: image/svg+xml]",
      toolCall: false,
    })
    expect(unavailableContainer.textContent).toBe("[image unavailable: image/svg+xml]")
    expect(unavailableContainer.querySelector("img")).toBeNull()
    expect(error).toEqual({
      hasImage: false,
      roleLabel: "Activity",
      text: "Error: Browser action was declined",
      toolCall: false,
    })
    expect(errorContainer.textContent).toBe("Error: Browser action was declined")
  })
})
