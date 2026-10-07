import { readFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"
import { build } from "esbuild"

// Use real layout and scrolling: jsdom cannot reproduce smooth-scroll races.
test("follows streamed messages immediately without moving readers of older messages", async ({
  page,
}) => {
  const bundle = await build({
    entryPoints: ["src/browser/sidepanel/message-rendering.ts"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "transcriptRendering",
    define: { __PI_BROWSER_AGENT_DEVELOPER_MODE__: "false" },
  })
  const script = bundle.outputFiles[0]
  if (!script) throw new Error("Missing transcript renderer bundle")
  await page.setContent('<div id="transcript" style="width: 360px; height: 200px"></div>')
  await page.addStyleTag({ content: await readFile("src/browser/sidepanel/styles.css", "utf8") })
  await page.addScriptTag({ content: script.text })

  const positions = await page.evaluate(() => {
    const transcript = document.getElementById("transcript") as HTMLElement
    const { TranscriptRenderer } = (
      window as typeof window & {
        transcriptRendering: typeof import("../../src/browser/sidepanel/message-rendering.js")
      }
    ).transcriptRendering
    const renderer = new TranscriptRenderer(transcript)
    const distances: number[] = []
    const distance = () => transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight
    let text = ""
    for (let index = 0; index < 5; index++) {
      text += "Streaming paragraph.\n\n".repeat(20)
      renderer.render([{ role: "user", content: text, timestamp: 1 }], "session")
      // Measure before any animation frame: the next chunk may arrive immediately.
      distances.push(distance())
    }
    transcript.scrollTop = 100
    renderer.render([{ role: "user", content: `${text}\nMore text`, timestamp: 1 }], "session")
    const readerPosition = transcript.scrollTop
    renderer.render([{ role: "user", content: text, timestamp: 1 }], "another-session")
    return { distances, readerPosition, sessionDistance: distance() }
  })

  for (const distance of positions.distances) expect(distance).toBeLessThanOrEqual(1)
  expect(positions.readerPosition).toBe(100)
  expect(positions.sessionDistance).toBeLessThanOrEqual(1)
})
