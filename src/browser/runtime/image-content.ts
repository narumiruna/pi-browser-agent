import type { ImageContent } from "@earendil-works/pi-ai"

export const MAX_PASTED_IMAGES = 4
export const MAX_PASTED_IMAGE_BYTES = 3_000_000
const SUPPORTED_IMAGE_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"])
const MAX_RENDERED_IMAGE_BASE64_LENGTH = 7_000_000
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

export function isSupportedImageType(mimeType: string): boolean {
  return SUPPORTED_IMAGE_TYPES.has(mimeType.toLowerCase())
}

export function imageContentSource(image: ImageContent): string | undefined {
  const mimeType = image.mimeType.toLowerCase()
  if (!isSupportedImageType(mimeType)) return undefined
  if (
    image.data.length === 0 ||
    image.data.length > MAX_RENDERED_IMAGE_BASE64_LENGTH ||
    image.data.length % 4 !== 0 ||
    !BASE64_PATTERN.test(image.data)
  )
    return undefined
  return `data:${mimeType};base64,${image.data}`
}
