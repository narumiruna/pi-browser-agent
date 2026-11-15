import { hasApprovedHostPermission } from "../permissions.js"
import {
  getPdfTitleFromUrl,
  hasPdfSignature,
  PDF_LIMITS,
  parseHttpUrl,
  sanitizePdfTitle,
} from "../translation/shared/pdf.js"

async function readResponseBytes(response, maximumBytes = PDF_LIMITS.maximumSourceBytes) {
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length > maximumBytes) {
      throw new Error("This PDF is larger than the supported size limit.")
    }
    return bytes
  }
  const reader = response.body.getReader()
  const chunks = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      length += value.length
      if (length > maximumBytes) {
        throw new Error("This PDF is larger than the supported size limit.")
      }
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

async function inspectRemotePdf(sourceUrl, options = {}) {
  const parsed = parseHttpUrl(sourceUrl)
  if (!parsed) {
    throw new Error("PDF sources must use HTTP or HTTPS.")
  }
  if (!options.fetchImpl && !(await hasApprovedHostPermission(parsed)))
    throw new Error("PDF source-origin approval is required.")
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const response = await fetchImpl(parsed.toString(), {
    credentials: "omit",
    redirect: "error",
    signal: options.signal,
  })
  if (!response.ok && response.status !== 206) {
    await response.body?.cancel().catch(() => {})
    throw new Error(`The PDF server returned status ${response.status}.`)
  }
  const finalUrl = parseHttpUrl(response.url || parsed.toString())
  if (!finalUrl || finalUrl.origin !== parsed.origin) {
    await response.body?.cancel().catch(() => {})
    throw new Error(
      "The PDF redirected to another origin. Download it and choose the local file instead.",
    )
  }
  const contentType = (response.headers.get("content-type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase()
  if (
    contentType &&
    !contentType.includes("pdf") &&
    contentType !== "application/octet-stream" &&
    contentType !== "binary/octet-stream"
  ) {
    await response.body?.cancel().catch(() => {})
    throw new Error("The selected URL returned a non-PDF content type.")
  }
  const contentLength = Number(response.headers.get("content-length"))
  const contentRange = response.headers.get("content-range") || ""
  const rangeTotalMatch = contentRange.match(/\/(\d+)$/u)
  const rangeTotal = rangeTotalMatch ? Number(rangeTotalMatch[1]) : 0
  if (
    (Number.isFinite(contentLength) && contentLength > PDF_LIMITS.maximumSourceBytes) ||
    (Number.isFinite(rangeTotal) && rangeTotal > PDF_LIMITS.maximumSourceBytes)
  ) {
    await response.body?.cancel().catch(() => {})
    throw new Error("This PDF is larger than the supported size limit.")
  }
  const data = await readResponseBytes(response)
  if (!hasPdfSignature(data)) {
    throw new Error("The selected URL did not return a valid PDF document.")
  }
  return {
    contentType,
    data,
    title: getPdfTitleFromUrl(finalUrl),
    url: finalUrl.toString(),
  }
}

async function readLocalPdf(file) {
  if (!file || typeof file.arrayBuffer !== "function") {
    throw new Error("Choose a PDF file to continue.")
  }
  if (file.size > PDF_LIMITS.maximumSourceBytes) {
    throw new Error("This PDF is larger than the supported size limit.")
  }
  const data = new Uint8Array(await file.arrayBuffer())
  if (!hasPdfSignature(data)) {
    throw new Error("The selected file is not a valid PDF document.")
  }
  return {
    data,
    title: sanitizePdfTitle(file.name?.replace(/\.pdf$/iu, "")),
  }
}

export { inspectRemotePdf, readLocalPdf, readResponseBytes }
