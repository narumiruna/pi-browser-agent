import type { ImageContent } from "@earendil-works/pi-ai"

export const MAX_GENERATED_IMAGE_BYTES = 3_000_000

const MAX_BASE64_LENGTH = Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4
const INVALID_IMAGE = "Invalid generated image"

export class GeneratedImageError extends Error {
  constructor() {
    super(INVALID_IMAGE)
    this.name = "GeneratedImageError"
  }
}

type Dimensions = { width: number; height: number }
type ImageHeader = Dimensions & { mimeType: string }

function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new GeneratedImageError()
}

function checkDimensions(dimensions: Dimensions): void {
  const { width, height } = dimensions
  requireValid(
    Number.isSafeInteger(width) &&
      Number.isSafeInteger(height) &&
      width > 0 &&
      height > 0 &&
      width <= 4096 &&
      height <= 4096 &&
      width * height <= 16_000_000,
  )
}

function tag(bytes: Uint8Array, offset: number, value: string): boolean {
  return [...value].every((character, index) => bytes[offset + index] === character.charCodeAt(0))
}

function pngHeader(bytes: Uint8Array, view: DataView): ImageHeader {
  requireValid(bytes.length >= 33 && view.getUint32(8) === 13 && tag(bytes, 12, "IHDR"))
  const dimensions = { width: view.getUint32(16), height: view.getUint32(20) }
  checkDimensions(dimensions)
  let hasData = false
  for (let offset = 8; offset < bytes.length; ) {
    requireValid(offset + 12 <= bytes.length)
    const length = view.getUint32(offset)
    const end = offset + 12 + length
    requireValid(end <= bytes.length)
    requireValid(
      !tag(bytes, offset + 4, "acTL") &&
        !tag(bytes, offset + 4, "fcTL") &&
        !tag(bytes, offset + 4, "fdAT"),
    )
    if (offset !== 8) requireValid(!tag(bytes, offset + 4, "IHDR"))
    if (tag(bytes, offset + 4, "IDAT")) hasData = true
    if (tag(bytes, offset + 4, "IEND")) {
      requireValid(length === 0 && end === bytes.length && hasData)
      return { ...dimensions, mimeType: "image/png" }
    }
    offset = end
  }
  throw new GeneratedImageError()
}

function jpegHeader(bytes: Uint8Array, view: DataView): ImageHeader {
  let dimensions: Dimensions | undefined
  let offset = 2
  while (offset < bytes.length) {
    requireValid(bytes[offset++] === 0xff)
    while (bytes[offset] === 0xff) offset += 1
    const marker = bytes[offset++]
    requireValid(marker !== undefined && marker !== 0 && marker !== 0xd8 && marker !== 0xd9)
    // TEM is the only standalone marker allowed before the scan.
    if (marker === 0x01) continue
    requireValid(marker < 0xd0 || marker > 0xd7)
    requireValid(offset + 2 <= bytes.length)
    const length = view.getUint16(offset)
    requireValid(length >= 2 && offset + length <= bytes.length)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      requireValid(!dimensions && length >= 8)
      dimensions = { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) }
      checkDimensions(dimensions)
    }
    if (marker === 0xda) {
      requireValid(
        dimensions &&
          length >= 6 &&
          bytes[bytes.length - 2] === 0xff &&
          bytes[bytes.length - 1] === 0xd9,
      )
      return { ...dimensions, mimeType: "image/jpeg" }
    }
    offset += length
  }
  throw new GeneratedImageError()
}

function webpFrame(bytes: Uint8Array, view: DataView, offset: number, length: number): Dimensions {
  const data = offset + 8
  if (tag(bytes, offset, "VP8 ")) {
    requireValid(
      length >= 10 && (view.getUint8(data) & 1) === 0 && tag(bytes, data + 3, "\x9d\x01\x2a"),
    )
    return {
      width: view.getUint16(data + 6, true) & 0x3fff,
      height: view.getUint16(data + 8, true) & 0x3fff,
    }
  }
  requireValid(length >= 5 && bytes[data] === 0x2f)
  const bits = view.getUint32(data + 1, true)
  requireValid(bits >>> 29 === 0)
  return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
}

function webpHeader(bytes: Uint8Array, view: DataView): ImageHeader {
  requireValid(bytes.length >= 20 && view.getUint32(4, true) + 8 === bytes.length)
  let canvas: Dimensions | undefined
  let frame: Dimensions | undefined
  for (let offset = 12; offset < bytes.length; ) {
    requireValid(offset + 8 <= bytes.length)
    const length = view.getUint32(offset + 4, true)
    const end = offset + 8 + length + (length % 2)
    requireValid(end <= bytes.length)
    requireValid(!tag(bytes, offset, "ANIM") && !tag(bytes, offset, "ANMF"))
    if (tag(bytes, offset, "VP8X")) {
      requireValid(offset === 12 && length === 10 && (view.getUint8(offset + 8) & 0x02) === 0)
      canvas = {
        width: (view.getUint32(offset + 12, true) & 0xffffff) + 1,
        height: (view.getUint32(offset + 14, true) >>> 8) + 1,
      }
      checkDimensions(canvas)
    } else if (tag(bytes, offset, "VP8 ") || tag(bytes, offset, "VP8L")) {
      requireValid(!frame)
      frame = webpFrame(bytes, view, offset, length)
      checkDimensions(frame)
    }
    offset = end
  }
  requireValid(frame)
  if (canvas) requireValid(canvas.width === frame.width && canvas.height === frame.height)
  return { ...frame, mimeType: "image/webp" }
}

function imageHeader(bytes: Uint8Array): ImageHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (tag(bytes, 0, "\x89PNG\r\n\x1a\n")) return pngHeader(bytes, view)
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegHeader(bytes, view)
  if (tag(bytes, 0, "RIFF") && tag(bytes, 8, "WEBP")) return webpHeader(bytes, view)
  throw new GeneratedImageError()
}

export async function decodeGeneratedImage(
  base64: string,
): Promise<{ content: ImageContent; width: number; height: number }> {
  try {
    requireValid(
      typeof base64 === "string" &&
        base64.length > 0 &&
        base64.length <= MAX_BASE64_LENGTH &&
        base64.length % 4 === 0 &&
        /^[A-Za-z0-9+/]*={0,2}$/.test(base64),
    )
    const binary = atob(base64)
    requireValid(
      binary.length > 0 && binary.length <= MAX_GENERATED_IMAGE_BYTES && btoa(binary) === base64,
    )
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    const { width, height, mimeType } = imageHeader(bytes)
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType }), {
      imageOrientation: "none",
    })
    try {
      requireValid(bitmap.width === width && bitmap.height === height)
      return { content: { type: "image", data: base64, mimeType }, width, height }
    } finally {
      bitmap.close()
    }
  } catch {
    // Provider input and browser decoder diagnostics must not reach tool errors.
    throw new GeneratedImageError()
  }
}
