import type { ImageContent } from "@earendil-works/pi-ai"
import { t } from "../i18n/index.js"

import {
  imageContentSource,
  isSupportedImageType,
  MAX_PASTED_IMAGE_BYTES,
  MAX_PASTED_IMAGES,
} from "../runtime/image-content.js"

export {
  imageContentSource,
  isSupportedImageType,
  MAX_PASTED_IMAGE_BYTES,
  MAX_PASTED_IMAGES,
} from "../runtime/image-content.js"

export interface ComposerImage {
  content: ImageContent
  byteLength: number
}

export type PastedImage = ComposerImage

function encodeBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

async function readComposerImage(
  image: Blob,
  remainingBytes: number,
  messages: { empty: string; tooLarge: string; unsupported: string },
): Promise<ComposerImage> {
  const mimeType = image.type.toLowerCase()
  if (!isSupportedImageType(mimeType)) throw new Error(messages.unsupported)
  if (image.size === 0) throw new Error(messages.empty)
  if (image.size > remainingBytes) throw new Error(messages.tooLarge)
  return {
    content: { type: "image", data: encodeBase64(await image.arrayBuffer()), mimeType },
    byteLength: image.size,
  }
}

export function readPastedImage(
  image: Blob,
  remainingBytes = MAX_PASTED_IMAGE_BYTES,
): Promise<ComposerImage> {
  return readComposerImage(image, remainingBytes, {
    unsupported: t("Paste a PNG, JPEG, WebP, or GIF image"),
    empty: t("The pasted image is empty"),
    tooLarge: t("Pasted images must use 3 MB or less in total"),
  })
}

export function readGeneratedImage(
  image: Blob,
  remainingBytes = MAX_PASTED_IMAGE_BYTES,
): Promise<ComposerImage> {
  return readComposerImage(image, remainingBytes, {
    unsupported: t("Attach a PNG, JPEG, WebP, or GIF image"),
    empty: t("The generated image is empty"),
    tooLarge: t("Composer images must use 3 MB or less in total"),
  })
}

export function restoreComposerImages(images: readonly ImageContent[]): ComposerImage[] {
  if (images.length > MAX_PASTED_IMAGES)
    throw new Error(t("Saved message exceeds the composer image limit"))
  let bytes = 0
  return images.map((image) => {
    if (
      typeof image.mimeType !== "string" ||
      typeof image.data !== "string" ||
      !imageContentSource(image)
    ) {
      throw new Error(t("Saved message contains an unsupported image"))
    }
    const byteLength =
      (image.data.length * 3) / 4 -
      (image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0)
    bytes += byteLength
    if (bytes > MAX_PASTED_IMAGE_BYTES)
      throw new Error(t("Saved message images exceed the 3 MB composer limit"))
    return { content: { type: "image", mimeType: image.mimeType, data: image.data }, byteLength }
  })
}
