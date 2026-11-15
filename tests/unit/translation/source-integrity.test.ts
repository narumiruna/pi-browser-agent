import { expect, test } from "vitest"
import { analyzePdfPage } from "../../../src/browser/pdf/extraction.js"
import { createPageTranslationQueue } from "../../../src/browser/translation/shared/translation-session.js"
import {
  createRecursiveChunkPlan,
  mergeRecursiveTranslations,
  splitTextRecursively,
} from "../../../src/browser/translation/translation/chunk-plan.js"
import {
  maskProtectedFragments,
  unmaskProtectedFragments,
  validateProtectedFragments,
} from "../../../src/browser/translation/translation/protected-fragments.js"

const pdfItem = (str: string, x: number, y = 700, width = str.length * 5) => ({
  str,
  fontName: "Body",
  transform: [10, 0, 0, 10, x, y],
  width,
  height: 10,
})
test.each([
  ["Hello ", "world."],
  ["Hello", " world."],
  ["Hello ", " world."],
  ["Hello\t", "world."],
])("PDF run boundary preserves %j and %j", (first, second) => {
  const blocks = analyzePdfPage({
    documentId: "owned",
    pageNumber: 1,
    pageWidth: 600,
    items: [pdfItem(first, 40, 700, 40), pdfItem(second, 80)],
  })
  expect(blocks.map((block) => block.text).join(" ")).toBe("Hello world.")
})
test("PDF whitespace-only runs keep separators but split words stay joined", () => {
  const extract = (items: ReturnType<typeof pdfItem>[]) =>
    analyzePdfPage({ documentId: "owned", pageNumber: 1, pageWidth: 600, items })
      .map((block) => block.text)
      .join(" ")
  expect(
    extract([pdfItem("Hello", 40, 700, 30), pdfItem(" ", 70, 700, 4), pdfItem("world.", 74)]),
  ).toBe("Hello world.")
  expect(extract([pdfItem("Hel", 40, 700, 15), pdfItem("lo", 55)])).toBe("Hello")
})
test("a repeated 20-point column gutter reads down columns, not across rows", () => {
  const items = [700, 680, 660].flatMap((y, index) => [
    pdfItem(`Left paragraph row ${index + 1}.`, 40, y, 240),
    pdfItem(`Right paragraph row ${index + 1}.`, 300, y, 240),
  ])
  const text = analyzePdfPage({ documentId: "columns", pageNumber: 1, pageWidth: 600, items })
    .map((block) => block.text)
    .join(" ")
  expect(text.indexOf("Left paragraph row 3")).toBeLessThan(text.indexOf("Right paragraph row 1"))
})
test("ordinary single-row word gaps do not become a column", () => {
  const blocks = analyzePdfPage({
    documentId: "single",
    pageNumber: 1,
    pageWidth: 600,
    items: [pdfItem("A normal phrase", 40, 700, 120), pdfItem("continues here.", 180, 700, 130)],
  })
  expect(blocks).toHaveLength(1)
  expect(blocks[0]?.text).toBe("A normal phrase continues here.")
})
test.each(["漢".repeat(5001), `${"漢".repeat(4999)}𠀀${"漢".repeat(3)}`])(
  "hard chunks preserve source code points and add no spaces",
  (text) => {
    const chunks = splitTextRecursively(text, 5000) as Array<{ text: string; joiner: string }>
    expect(chunks.map((chunk) => chunk.text + chunk.joiner).join("")).toBe(text)
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(5000)
      expect(chunk.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u)
    }
    const plan = createRecursiveChunkPlan([{ id: "owned", kind: "paragraph", text }], 5000)
    expect(
      mergeRecursiveTranslations(
        plan,
        plan.expandedItems.map((item) => ({ id: item.id, translation: item.text })),
      )[0]?.translation,
    ).toBe(text)
  },
)
test.each(["https://example.com/?price=$50&sort=ascending", "$2 + 3 $"])(
  "complete protected span stays unchanged while prose changes: %s",
  (protectedText) => {
    const masked = maskProtectedFragments(`Use ${protectedText} here.`)
    expect(masked.tokens.some((token) => token.value === protectedText)).toBe(true)
    const translation = masked.maskedText.replace("Use", "Read").replace("here", "there")
    validateProtectedFragments(
      [{ id: "owned", text: masked.maskedText, protectedFragments: masked.tokens }],
      [{ id: "owned", translation }],
    )
    expect(unmaskProtectedFragments(translation, masked.tokens)).toBe(
      `Read ${protectedText} there.`,
    )
  },
)
test("pending revision compares protected math, not only masked text", async () => {
  let finish = () => {}
  const batches: Array<
    Array<{ id: string; text: string; protectedFragments: Array<{ value: string }> }>
  > = []
  const queue = createPageTranslationQueue({
    concurrency: 1,
    batchSize: 1,
    processBatch: async ({ items }: { items: (typeof batches)[number] }) => {
      batches.push(items)
      if (batches.length === 1)
        await new Promise<void>((resolve) => {
          finish = resolve
        })
    },
  })
  const session = queue.create(7, {})
  const item = (text: string, value: string) => ({
    id: "same",
    kind: "paragraph",
    text,
    protectedFragments: [
      { placeholder: "__OT_MATH_1__", value, text: value, kind: "math", preservePlaceholder: true },
    ],
  })
  queue.enqueue(7, session.sessionId, [item("Source __OT_MATH_1__", "x")])
  await expect.poll(() => batches.length).toBe(1)
  queue.enqueue(7, session.sessionId, [item("Other __OT_MATH_1__", "b")])
  queue.enqueue(7, session.sessionId, [item("Source __OT_MATH_1__", "y")])
  finish()
  await expect.poll(() => batches.length).toBe(2)
  expect(batches[1]?.[0]?.protectedFragments[0]?.value).toBe("y")
  queue.remove(7)
})
