import type { ImageContent } from "@earendil-works/pi-ai"

export const MAX_PASTED_IMAGES = 4
export const MAX_PASTED_IMAGE_BYTES = 3_000_000

const SUPPORTED_IMAGE_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"])
const MAX_RENDERED_IMAGE_BASE64_LENGTH = 7_000_000
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

export interface PastedImage {
  content: ImageContent
  byteLength: number
}

export function isSupportedImageType(mimeType: string): boolean {
  return SUPPORTED_IMAGE_TYPES.has(mimeType.toLowerCase())
}

function encodeBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

export async function readPastedImage(
  image: Blob,
  remainingBytes = MAX_PASTED_IMAGE_BYTES,
): Promise<PastedImage> {
  const mimeType = image.type.toLowerCase()
  if (!isSupportedImageType(mimeType)) {
    throw new Error("Paste a PNG, JPEG, WebP, or GIF image")
  }
  if (image.size === 0) throw new Error("The pasted image is empty")
  if (image.size > remainingBytes) {
    throw new Error("Pasted images must use 3 MB or less in total")
  }
  return {
    content: { type: "image", data: encodeBase64(await image.arrayBuffer()), mimeType },
    byteLength: image.size,
  }
}

export function imageContentSource(image: ImageContent): string | undefined {
  const mimeType = image.mimeType.toLowerCase()
  if (!isSupportedImageType(mimeType)) return undefined
  if (
    image.data.length === 0 ||
    image.data.length > MAX_RENDERED_IMAGE_BASE64_LENGTH ||
    image.data.length % 4 !== 0 ||
    !BASE64_PATTERN.test(image.data)
  ) {
    return undefined
  }
  return `data:${mimeType};base64,${image.data}`
}
