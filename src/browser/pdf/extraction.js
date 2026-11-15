const ROLE_MAP = Object.freeze({
  Caption: "caption",
  H: "heading",
  H1: "heading",
  H2: "heading",
  H3: "heading",
  H4: "heading",
  H5: "heading",
  H6: "heading",
  L: "list-item",
  LI: "list-item",
  P: "paragraph",
  TD: "table-cell",
  TH: "table-cell",
})

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/gu, " ")
    .trim()
}

function normalizeTextItem(item, index) {
  if (!item || typeof item.str !== "string" || !Array.isArray(item.transform)) {
    return null
  }
  const text = normalizeText(item.str)
  if (!text) {
    return null
  }
  const transform = item.transform
  const height = Math.max(
    1,
    Math.abs(Number(item.height) || 0),
    Math.hypot(Number(transform[2]) || 0, Number(transform[3]) || 0),
  )
  const width = Math.max(0, Math.abs(Number(item.width) || 0))
  const x = Number(transform[4]) || 0
  const y = Number(transform[5]) || 0
  const rotation = Math.atan2(Number(transform[1]) || 0, Number(transform[0]) || 1)

  return {
    fontName: String(item.fontName || ""),
    hasEOL: Boolean(item.hasEOL),
    height,
    index,
    markedContentId: String(item.markedContentId || ""),
    rotation,
    text,
    width,
    x,
    y,
  }
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (sorted.length === 0) {
    return 0
  }
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function createLine(item) {
  return {
    column: 0,
    height: item.height,
    items: [item],
    markedContentIds: new Set(item.markedContentId ? [item.markedContentId] : []),
    rotation: item.rotation,
    text: item.text,
    x: item.x,
    x2: item.x + item.width,
    y: item.y,
  }
}

function finalizeLine(line) {
  line.items.sort((a, b) => a.x - b.x || a.index - b.index)
  let text = ""
  let previous = null
  for (const item of line.items) {
    if (previous) {
      const gap = item.x - (previous.x + previous.width)
      if (gap > Math.max(1.5, line.height * 0.18)) {
        text += " "
      }
    }
    text += item.text
    previous = item
  }
  line.text = normalizeText(text)
  line.x = Math.min(...line.items.map((item) => item.x))
  line.x2 = Math.max(...line.items.map((item) => item.x + item.width))
  line.y = line.items.reduce((sum, item) => sum + item.y, 0) / line.items.length
  line.height = median(line.items.map((item) => item.height)) || line.height
  return line
}

function splitWideLine(line) {
  line.items.sort((a, b) => a.x - b.x || a.index - b.index)
  const groups = []
  let current = []
  let previous = null
  for (const item of line.items) {
    const gap = previous ? item.x - (previous.x + previous.width) : 0
    if (current.length > 0 && gap > Math.max(40, line.height * 4)) {
      groups.push(current)
      current = []
    }
    current.push(item)
    previous = item
  }
  if (current.length > 0) {
    groups.push(current)
  }
  return groups.map((group) => {
    const split = createLine(group[0])
    split.items = group
    split.markedContentIds = new Set(group.map((item) => item.markedContentId).filter(Boolean))
    return finalizeLine(split)
  })
}

function annotateMarkedContentItems(items) {
  const stack = []
  const annotated = []
  for (const item of items || []) {
    if (item?.type === "beginMarkedContentProps") {
      stack.push(String(item.id || ""))
      continue
    }
    if (item?.type === "beginMarkedContent") {
      stack.push("")
      continue
    }
    if (item?.type === "endMarkedContent") {
      stack.pop()
      continue
    }
    annotated.push({
      ...item,
      markedContentId: item?.markedContentId || stack.at(-1) || "",
    })
  }
  return annotated
}

function groupItemsIntoLines(items) {
  const normalized = annotateMarkedContentItems(items)
    .map(normalizeTextItem)
    .filter(Boolean)
    .sort((a, b) => b.y - a.y || a.x - b.x || a.index - b.index)
  const lines = []

  for (const item of normalized) {
    const tolerance = Math.max(1.5, item.height * 0.45)
    const line = lines.find(
      (candidate) =>
        Math.abs(candidate.y - item.y) <= tolerance &&
        Math.abs(candidate.rotation - item.rotation) < 0.08,
    )
    if (!line) {
      lines.push(createLine(item))
      continue
    }
    line.items.push(item)
    if (item.markedContentId) {
      line.markedContentIds.add(item.markedContentId)
    }
  }

  return lines.flatMap(splitWideLine).filter((line) => line.text)
}

function detectColumnStarts(lines, pageWidth) {
  const starts = lines
    .filter((line) => Math.abs(line.rotation) < 0.08 && line.x2 - line.x < pageWidth * 0.72)
    .map((line) => line.x)
    .sort((a, b) => a - b)
  if (starts.length < 6) {
    return [0]
  }

  const gaps = []
  for (let index = 1; index < starts.length; index += 1) {
    gaps.push({ gap: starts[index] - starts[index - 1], index })
  }
  const boundaries = gaps
    .filter((entry) => entry.gap >= pageWidth * 0.14)
    .sort((a, b) => b.gap - a.gap)
    .slice(0, 2)
    .sort((a, b) => a.index - b.index)
  if (boundaries.length === 0) {
    return [median(starts)]
  }

  const clusters = []
  let startIndex = 0
  for (const boundary of boundaries) {
    clusters.push(starts.slice(startIndex, boundary.index))
    startIndex = boundary.index
  }
  clusters.push(starts.slice(startIndex))
  const strongClusters = clusters.filter((cluster) => cluster.length >= 2)
  return strongClusters.length > 1
    ? strongClusters.map((cluster) => median(cluster))
    : [median(starts)]
}

function assignReadingOrder(lines, pageWidth) {
  const columnStarts = detectColumnStarts(lines, pageWidth)
  if (columnStarts.length === 1) {
    return lines.sort((a, b) => b.y - a.y || a.x - b.x)
  }

  const spanning = []
  const body = []
  for (const line of lines) {
    if (line.x2 - line.x >= pageWidth * 0.62) {
      spanning.push(line)
      continue
    }
    let bestColumn = 0
    let bestDistance = Number.POSITIVE_INFINITY
    for (let index = 0; index < columnStarts.length; index += 1) {
      const distance = Math.abs(line.x - columnStarts[index])
      if (distance < bestDistance) {
        bestColumn = index
        bestDistance = distance
      }
    }
    line.column = bestColumn
    body.push(line)
  }

  const ordered = []
  const sortedSpanning = spanning.sort((a, b) => b.y - a.y || a.x - b.x)
  let upperY = Number.POSITIVE_INFINITY
  for (const separator of [...sortedSpanning, { y: Number.NEGATIVE_INFINITY }]) {
    const section = body.filter((line) => line.y <= upperY && line.y > separator.y)
    for (let column = 0; column < columnStarts.length; column += 1) {
      ordered.push(
        ...section.filter((line) => line.column === column).sort((a, b) => b.y - a.y || a.x - b.x),
      )
    }
    if (separator.y !== Number.NEGATIVE_INFINITY) {
      ordered.push(separator)
    }
    upperY = separator.y
  }
  return ordered
}

function joinLineText(previous, next) {
  if (/\p{L}{6,}-$/u.test(previous) && /^\p{Ll}{2,}/u.test(next)) {
    return `${previous.slice(0, -1)}${next}`
  }
  return `${previous} ${next}`
}

function inferRole(lines, bodyFontSize, taggedRoles) {
  for (const line of lines) {
    for (const id of line.markedContentIds) {
      if (taggedRoles?.has(id)) {
        return taggedRoles.get(id)
      }
    }
  }
  const text = lines.map((line) => line.text).join(" ")
  const fontSize = median(lines.map((line) => line.height))
  if (
    (fontSize >= bodyFontSize * 1.2 && text.length <= 180) ||
    (text.length <= 100 && /^\p{Lu}[\p{Lu}\p{N}\p{P}\p{Zs}]+$/u.test(text))
  ) {
    return "heading"
  }
  if (/^(?:[•●▪◦]|[-–—]|\d+[.)])\s/u.test(text)) {
    return "list-item"
  }
  return "paragraph"
}

function isLikelyFormula(text) {
  const compact = text.replace(/\s+/gu, "")
  if (compact.length < 3) {
    return false
  }
  const letters = (compact.match(/\p{L}/gu) || []).length
  const math = (compact.match(/[=+−×÷∑∫√∞≈≠≤≥<>^_|{}[\]\\]/gu) || []).length
  return (
    math >= 2 &&
    (/\b(?:equation|formula)\b/iu.test(text) ||
      (math / compact.length > 0.18 && letters / compact.length < 0.65))
  )
}

function mergeBoxes(lines) {
  return lines.map((line) => ({
    height: line.height,
    width: Math.max(0, line.x2 - line.x),
    x: line.x,
    y: line.y - line.height,
  }))
}

function groupLinesIntoBlocks(lines, options = {}) {
  const bodyFontSize = median(lines.map((line) => line.height)) || 12
  const blocks = []
  let current = null

  for (const line of lines) {
    const taggedRole = inferRole([line], bodyFontSize, options.taggedRoles)
    const formulaLine = isLikelyFormula(line.text)
    const previousLine = current?.lines.at(-1)
    const verticalGap = previousLine
      ? Math.max(0, previousLine.y - line.y - previousLine.height)
      : Number.POSITIVE_INFINITY
    const startsNew =
      !current ||
      line.column !== previousLine.column ||
      formulaLine ||
      Boolean(current && isLikelyFormula(current.text)) ||
      Math.abs(line.rotation) >= 0.08 ||
      verticalGap > Math.max(bodyFontSize * 0.85, previousLine.height) ||
      taggedRole === "heading" ||
      current.role === "heading" ||
      (previousLine &&
        Math.abs(line.x - previousLine.x) > bodyFontSize * 2.2 &&
        /[.!?:;]$/u.test(previousLine.text))

    if (startsNew) {
      current = {
        column: line.column,
        lines: [line],
        role: taggedRole,
        text: line.text,
      }
      blocks.push(current)
    } else {
      current.lines.push(line)
      current.text = joinLineText(current.text, line.text)
      current.role = inferRole(current.lines, bodyFontSize, options.taggedRoles)
    }
  }

  return blocks.map((block) => ({
    boxes: mergeBoxes(block.lines),
    column: block.column,
    fontSize: median(block.lines.map((line) => line.height)),
    originalOnly: isLikelyFormula(block.text),
    role: block.role,
    text: normalizeText(block.text),
    x: Math.min(...block.lines.map((line) => line.x)),
    y: Math.max(...block.lines.map((line) => line.y)),
  }))
}

function collectStructureRoles(node, roles = new Map(), inheritedRole = "paragraph") {
  if (!node || typeof node !== "object") {
    return roles
  }
  const role = ROLE_MAP[node.role] || inheritedRole
  if (node.id) {
    roles.set(String(node.id), role)
  }
  for (const child of Array.isArray(node.children) ? node.children : []) {
    if (typeof child === "object") {
      collectStructureRoles(child, roles, role)
    }
  }
  return roles
}

function analyzePdfPage(options) {
  const lines = groupItemsIntoLines(options.items || [])
  const orderedLines = assignReadingOrder(lines, Number(options.pageWidth) || 1)
  const taggedRoles = collectStructureRoles(options.structureTree)
  return groupLinesIntoBlocks(orderedLines, { taggedRoles }).map((block, index) => ({
    ...block,
    id: `${options.documentId}:p${options.pageNumber}:b${index + 1}`,
    pageNumber: options.pageNumber,
  }))
}

function normalizeFurnitureText(text) {
  return normalizeText(text).toLowerCase().replace(/\d+/gu, "#")
}

function findRepeatedFurniture(pages) {
  const counts = new Map()
  for (const page of pages) {
    const height = Number(page.height) || 1
    const seen = new Set()
    for (const block of page.blocks || []) {
      const nearEdge = block.y >= height * 0.88 || block.y <= height * 0.12
      const normalized = normalizeFurnitureText(block.text)
      if (!nearEdge || normalized.length < 2 || normalized.length > 160) {
        continue
      }
      const key = `${block.y >= height * 0.88 ? "top" : "bottom"}:${normalized}`
      if (!seen.has(key)) {
        counts.set(key, (counts.get(key) || 0) + 1)
        seen.add(key)
      }
    }
  }
  const threshold = Math.max(2, Math.ceil(pages.length * 0.5))
  return new Set(
    Array.from(counts)
      .filter(([, count]) => count >= threshold)
      .map(([key]) => key),
  )
}

function removeRepeatedFurniture(pages) {
  const repeated = findRepeatedFurniture(pages)
  return pages.map((page) => ({
    ...page,
    blocks: (page.blocks || []).filter((block) => {
      const height = Number(page.height) || 1
      const nearTop = block.y >= height * 0.88
      const nearBottom = block.y <= height * 0.12
      if (!nearTop && !nearBottom) {
        return true
      }
      const edge = nearTop ? "top" : "bottom"
      return !repeated.has(`${edge}:${normalizeFurnitureText(block.text)}`)
    }),
  }))
}

export {
  analyzePdfPage,
  annotateMarkedContentItems,
  assignReadingOrder,
  collectStructureRoles,
  findRepeatedFurniture,
  groupItemsIntoLines,
  groupLinesIntoBlocks,
  isLikelyFormula,
  normalizeTextItem,
  removeRepeatedFurniture,
}
