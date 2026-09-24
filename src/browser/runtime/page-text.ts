import { MAX_TEXT_RESULT_BYTES, RuntimeError, TRUNCATION_SUFFIX, truncateUtf8 } from "./types.js"

export interface PageTextResult {
  text: string
  offset: number
  title: string
  url: string
}

export function boundPageTextResult(value: PageTextResult) {
  const encoder = new TextEncoder()
  // Leave room for the untrusted wrapper added to the pretty-printed JSON by the agent tool.
  const budget = MAX_TEXT_RESULT_BYTES - 256
  const fits = (result: object): boolean =>
    encoder.encode(JSON.stringify(result, null, 2)).byteLength <= budget
  // Page-controlled metadata must not prevent even a short page read.
  const metadata = { ...value }
  if (!fits({ ...metadata, text: TRUNCATION_SUFFIX, truncated: true, nextOffset: value.offset })) {
    metadata.title = truncateUtf8(value.title, 512).text
    metadata.url = truncateUtf8(value.url, 4096).text
  }
  const candidate = (length: number) => {
    let prefix = value.text.slice(0, length)
    const last = prefix.charCodeAt(prefix.length - 1)
    const next = value.text.charCodeAt(length)
    // Do not split a surrogate pair; preserve a terminal or otherwise unpaired high surrogate.
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff)
      prefix = prefix.slice(0, -1)
    const truncated = prefix.length < value.text.length
    return {
      ...metadata,
      text: truncated ? `${prefix}${TRUNCATION_SUFFIX}` : prefix,
      truncated,
      ...(truncated ? { nextOffset: value.offset + prefix.length } : {}),
    }
  }
  const full = candidate(value.text.length)
  if (fits(full)) return full
  let low = 0
  let high = value.text.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (fits(candidate(middle))) low = middle
    else high = middle - 1
  }
  const result = candidate(low)
  if (!fits(result) || (result.truncated && result.nextOffset === value.offset))
    throw new RuntimeError("INTERNAL_ERROR", "Page metadata exceeds the text result limit")
  return result
}
