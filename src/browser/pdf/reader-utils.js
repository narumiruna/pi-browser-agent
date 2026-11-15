function decodeLaunchToken(hash) {
  try {
    return hash ? decodeURIComponent(String(hash).replace(/^#/u, "")) : ""
  } catch (_error) {
    return ""
  }
}

function buildPdfTranslationCopy(blocks, translations) {
  const completed = blocks.map((block) => translations.get(block.id)).filter(Boolean)
  if (completed.length === 0) {
    return ""
  }
  const translatableCount = blocks.filter((block) => !block.originalOnly).length
  const partialLabel =
    completed.length < translatableCount
      ? `[Partial translation: ${completed.length} of ${translatableCount} blocks completed]\n\n`
      : ""
  return `${partialLabel}${completed.join("\n\n")}`
}

function createBoundedPdfBatches(items, limits) {
  const maximumCharacters = Math.max(1, Number(limits?.maximumCharacters) || 1)
  const maximumItems = Math.max(1, Number(limits?.maximumItems) || 1)
  const batches = []
  let batch = []
  let characterCount = 0

  for (const item of items) {
    const itemCharacters = String(item.text || "").length
    if (itemCharacters > maximumCharacters) {
      throw new Error("A PDF translation item exceeds the batch character limit.")
    }
    if (
      batch.length > 0 &&
      (batch.length >= maximumItems || characterCount + itemCharacters > maximumCharacters)
    ) {
      batches.push(batch)
      batch = []
      characterCount = 0
    }
    batch.push(item)
    characterCount += itemCharacters
  }
  if (batch.length > 0) {
    batches.push(batch)
  }
  return batches
}

function splitPdfBlocks(blocks, maximumCharacters) {
  const limit = Math.max(1, Number(maximumCharacters) || 1)
  return blocks.flatMap((block) => {
    if (block.text.length <= limit) {
      return block
    }

    const parts = []
    let remaining = block.text
    while (remaining.length > limit) {
      let splitAt = remaining.lastIndexOf(" ", limit)
      if (splitAt < limit / 2) {
        splitAt = limit
      }
      parts.push(remaining.slice(0, splitAt).trim())
      remaining = remaining.slice(splitAt).trimStart()
    }
    if (remaining) {
      parts.push(remaining)
    }

    return parts.map((text, index) => ({
      ...block,
      id: `${block.id}:part${index + 1}`,
      text,
    }))
  })
}

function getPdfHighlightBounds(viewport, box) {
  const start = viewport.convertToViewportPoint(box.x, box.y)
  const end = viewport.convertToViewportPoint(box.x + box.width, box.y + box.height)
  return {
    left: Math.min(start[0], end[0]),
    top: Math.min(start[1], end[1]),
    width: Math.abs(end[0] - start[0]),
    height: Math.abs(end[1] - start[1]),
  }
}

function hashText(text) {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function renderSearchText(element, text, query, documentNode = document) {
  element.replaceChildren()
  if (!query) {
    element.textContent = text
    return
  }
  const lowerText = text.toLocaleLowerCase()
  const lowerQuery = query.toLocaleLowerCase()
  let offset = 0
  let index = lowerText.indexOf(lowerQuery)
  while (index >= 0) {
    element.append(documentNode.createTextNode(text.slice(offset, index)))
    const mark = documentNode.createElement("mark")
    mark.textContent = text.slice(index, index + query.length)
    element.append(mark)
    offset = index + query.length
    index = lowerText.indexOf(lowerQuery, offset)
  }
  element.append(documentNode.createTextNode(text.slice(offset)))
}

function sanitizeDocumentId(value, randomUUID = () => crypto.randomUUID()) {
  const normalized = String(value || "")
    .replace(/[^A-Za-z0-9_-]/gu, "")
    .slice(0, 32)
  return `d${normalized || randomUUID().replaceAll("-", "").slice(0, 20)}`
}

export {
  buildPdfTranslationCopy,
  createBoundedPdfBatches,
  decodeLaunchToken,
  getPdfHighlightBounds,
  hashText,
  renderSearchText,
  sanitizeDocumentId,
  splitPdfBlocks,
}
