// @vitest-environment jsdom

import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { afterEach, describe, expect, test, vi } from "vitest"
import { renderMarkdown } from "../../src/browser/sidepanel/markdown.js"
import { renderMessageContent } from "../../src/browser/sidepanel/message-rendering.js"

afterEach(() => vi.unstubAllGlobals())
function render(text: string) {
  const container = document.createElement("div")
  container.append(renderMarkdown(text))
  return container
}

describe("restricted assistant Markdown", () => {
  test("renders headings, tables, lists, emphasis, safe links and literal fenced code", () => {
    const container = render(
      "# Heading\n\n- **Strong** and *emphasis*\n\n| A | B |\n| - | - |\n| one | two |\n\n[link](https://example.test/)\n\n```html\n<script>x</script>\n```",
    )
    for (const selector of ["h1", "ul", "strong", "em", "table", "thead", "tbody", "code"])
      expect(container.querySelector(selector)).not.toBeNull()
    expect(container.querySelector("code")?.textContent).toBe("<script>x</script>")
    expect(container.querySelector("a")?.getAttribute("rel")).toBe("noopener noreferrer")
    expect(container.querySelector("a")?.getAttribute("target")).toBe("_blank")
    expect(container.querySelector("script")).toBeNull()
  })

  test.each([
    '<script>alert(1)</script><img src="https://evil.test/pixel" onerror="alert(1)">',
    '<svg><a href="javascript:alert(1)">svg</a></svg><iframe src="https://evil.test"></iframe>',
    '<form id="location"><input name="href"></form><style>body{display:none}</style>',
    "[bad](javascript:alert%281%29) [bad](jav&#x61;script:alert%281%29)",
    "[bad](data:text/html,evil) [bad](file:///etc/passwd) [bad](chrome://settings)",
    "[bad](//evil.test) [bad](/relative) [bad](https://user:password@evil.test)",
    "![remote](https://evil.test/pixel) ![data](data:image/svg+xml,evil)",
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">',
  ])("keeps malicious content inert: %s", (text) => {
    const container = render(text)
    expect(
      container.querySelector(
        "script, img, svg, math, iframe, form, input, style, [id], [name], [style], [onerror], [onclick], a",
      ),
    ).toBeNull()
  })

  test("accepts every partial prefix of a streamed fence without executable nodes", () => {
    const text =
      "# Title\n\n```html\n<img src=x onerror=alert(1)>\n```\n\n[link](https://example.test)"
    for (let i = 0; i <= text.length; i++) {
      const container = render(text.slice(0, i))
      expect(container.querySelector("img,script,[onerror]")).toBeNull()
    }
  })

  test("copies exact answer and code text only on a click and handles clipboard denial", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    const container = document.createElement("div")
    const text = '# Answer\n\n```ts\nconst x = "<tag>"\n```'
    const message = { role: "assistant", content: [{ type: "text", text }] } as AgentMessage
    renderMessageContent(container, message)
    const buttons = container.querySelectorAll("button")
    expect(writeText).not.toHaveBeenCalled()
    buttons[0]?.click()
    expect(writeText).toHaveBeenLastCalledWith('const x = "<tag>"')
    buttons[1]?.click()
    expect(writeText).toHaveBeenLastCalledWith(text)
    await Promise.resolve()
    expect(buttons[1]?.querySelector(".copy-label")?.textContent).toBe("Copied")
    writeText.mockRejectedValueOnce(new Error("Denied"))
    buttons[1]?.click()
    await Promise.resolve()
    expect(buttons[1]?.querySelector(".copy-label")?.textContent).toBe("Copy failed")
  })

  test("keeps user, tool, and thinking text plain when rendering saved messages", () => {
    for (const message of [
      { role: "user", content: "# User <script>" },
      { role: "toolResult", content: [{ type: "text", text: "# Tool <img>" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "# Thinking <svg>" }] },
    ]) {
      const container = document.createElement("div")
      renderMessageContent(container, message as AgentMessage)
      expect(container.querySelector("h1,script,img,svg")).toBeNull()
      expect(container.textContent).toContain("#")
    }
  })
})
