import assert from "node:assert/strict"
import { test } from "vitest"

import {
  analyzePdfPage,
  annotateMarkedContentItems,
  assignReadingOrder,
  collectStructureRoles,
  findRepeatedFurniture,
  isLikelyFormula,
  removeRepeatedFurniture,
} from "../../../src/browser/pdf/extraction.js"

function item(str, x, y, options = {}) {
  return {
    fontName: options.fontName || "Body",
    hasEOL: true,
    height: options.height || 10,
    str,
    transform: [options.height || 10, 0, 0, options.height || 10, x, y],
    width: options.width || str.length * 5,
  }
}

test("PDF extraction orders complete columns and joins conservative hyphenation", () => {
  const blocks = analyzePdfPage({
    documentId: "fixture",
    pageNumber: 1,
    pageWidth: 600,
    items: [
      item("Document heading", 40, 760, { height: 18, width: 520 }),
      item("Left first line", 40, 700),
      item("computa-", 40, 680),
      item("tional methods.", 40, 660),
      item("Left final line.", 40, 640),
      item("Right first line", 330, 700),
      item("Right final line.", 330, 680),
    ],
  })
  const joined = blocks.map((block) => block.text).join(" | ")

  assert.match(joined, /^Document heading/)
  assert.ok(joined.indexOf("Left first") < joined.indexOf("Right first"))
  assert.match(joined, /computational methods\./)
  assert.equal(new Set(blocks.map((block) => block.id)).size, blocks.length)
  assert.equal(
    blocks.every((block) => block.boxes.length > 0),
    true,
  )
})

test("PDF extraction uses tagged roles and protects formula-heavy content", () => {
  const roles = collectStructureRoles({
    role: "Document",
    children: [{ role: "H2", id: "heading-1", children: [] }],
  })
  assert.equal(roles.get("heading-1"), "heading")
  assert.equal(
    annotateMarkedContentItems([
      { type: "beginMarkedContentProps", id: "heading-1" },
      item("Tagged heading", 40, 700),
      { type: "endMarkedContent" },
    ])[0].markedContentId,
    "heading-1",
  )
  const taggedBlocks = analyzePdfPage({
    documentId: "tagged",
    pageNumber: 1,
    pageWidth: 600,
    structureTree: {
      role: "Document",
      children: [{ role: "H2", id: "heading-1", children: [] }],
    },
    items: [
      { type: "beginMarkedContentProps", id: "heading-1" },
      item("Tagged heading", 40, 700),
      { type: "endMarkedContent" },
    ],
  })
  assert.equal(taggedBlocks[0].role, "heading")
  assert.equal(isLikelyFormula("x^2 + y^2 = z^2"), true)
  assert.equal(isLikelyFormula("A normal sentence with one value = 4."), false)
})

test("PDF reading order retains body lines sharing a spanning baseline", () => {
  const line = (text, x, y, width) => ({
    column: 0,
    height: 10,
    markedContentIds: new Set(),
    rotation: 0,
    text,
    x,
    x2: x + width,
    y,
  })
  const ordered = assignReadingOrder(
    [
      line("Spanning heading", 30, 700, 520),
      line("Left baseline body", 30, 700, 120),
      line("Left next body", 30, 680, 120),
      line("Right baseline body", 340, 700, 120),
      line("Right next body", 340, 680, 120),
      line("Left third body", 30, 660, 120),
      line("Right third body", 340, 660, 120),
    ],
    600,
  )
  const text = ordered.map((entry) => entry.text).join(" ")
  assert.match(text, /Left baseline body/)
  assert.match(text, /Right baseline body/)
})

test("PDF extraction preserves short compound hyphens across lines", () => {
  const blocks = analyzePdfPage({
    documentId: "hyphen",
    pageNumber: 1,
    pageWidth: 600,
    items: [item("cost-", 30, 700), item("effective method", 30, 680)],
  })
  assert.match(blocks.map((block) => block.text).join(" "), /cost- effective/)
})

test("PDF extraction orders three deterministic columns from left to right", () => {
  const blocks = analyzePdfPage({
    documentId: "columns",
    pageNumber: 1,
    pageWidth: 600,
    items: [
      item("Left one", 30, 700),
      item("Left two", 30, 680),
      item("Middle one", 220, 700),
      item("Middle two", 220, 680),
      item("Right one", 410, 700),
      item("Right two", 410, 680),
    ],
  })
  const text = blocks.map((block) => block.text).join(" ")
  assert.ok(text.indexOf("Left one") < text.indexOf("Middle one"))
  assert.ok(text.indexOf("Middle one") < text.indexOf("Right one"))
})

test("PDF repeated furniture requires repetition across pages", () => {
  const pages = Array.from({ length: 3 }, (_, index) => ({
    height: 800,
    pageNumber: index + 1,
    blocks: [
      { id: `header-${index}`, text: `Journal page ${index + 1}`, y: 760 },
      { id: `body-${index}`, text: "Repeated body sentence", y: 400 },
      { id: `footer-${index}`, text: "Project footer", y: 20 },
    ],
  }))
  const furniture = findRepeatedFurniture(pages)
  pages[0].blocks.push({
    id: "interior-footer-text",
    text: "Project footer",
    y: 400,
  })
  const filtered = removeRepeatedFurniture(pages)

  assert.equal(furniture.has("top:journal page #"), true)
  assert.equal(furniture.has("bottom:project footer"), true)
  assert.deepEqual(
    filtered.map((page) => page.blocks.map((block) => block.id)),
    [["body-0", "interior-footer-text"], ["body-1"], ["body-2"]],
  )
})
