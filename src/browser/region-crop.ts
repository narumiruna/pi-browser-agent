import { pngDimensions } from "./runtime/png.js"
import {
  REGION_CAPTURE_LIMITS,
  type RegionRectangle,
  validRegionRectangle,
} from "./runtime/region-capture.js"
import { RuntimeError } from "./runtime/types.js"

function invalid(): never {
  throw new RuntimeError(
    "INVALID_REQUEST",
    "The region image could not be cropped within the image limits",
  )
}
function bounded(width: number, height: number): boolean {
  return (
    [width, height].every(
      (v) => Number.isSafeInteger(v) && v > 0 && v <= REGION_CAPTURE_LIMITS.maxDimension,
    ) && width * height <= REGION_CAPTURE_LIMITS.maxPixels
  )
}

/** Map decoded source pixels, not an assumed DPR. No outside pixel is added. */
export function inwardRegionPixels(
  rectangle: RegionRectangle,
  viewport: { width: number; height: number },
  source: { width: number; height: number },
): RegionRectangle {
  if (
    !bounded(viewport.width, viewport.height) ||
    !bounded(source.width, source.height) ||
    !validRegionRectangle(rectangle, viewport.width, viewport.height)
  )
    return invalid()
  const x = Math.ceil((rectangle.x * source.width) / viewport.width)
  const y = Math.ceil((rectangle.y * source.height) / viewport.height)
  const right = Math.floor(((rectangle.x + rectangle.width) * source.width) / viewport.width)
  const bottom = Math.floor(((rectangle.y + rectangle.height) * source.height) / viewport.height)
  if (right <= x || bottom <= y || x < 0 || y < 0 || right > source.width || bottom > source.height)
    return invalid()
  return { x, y, width: right - x, height: bottom - y }
}

/** Worker-local only. Never return or fall back to the source viewport PNG. */
export async function cropRegionPng(
  source: string,
  rectangle: RegionRectangle,
  viewport: { width: number; height: number },
  maxBytes: number,
  guard: () => Promise<void>,
): Promise<{ dataUrl: string; mimeType: "image/png"; width: number; height: number }> {
  let bitmap: ImageBitmap | undefined
  let canvas: OffscreenCanvas | undefined
  let sourceBlob: Blob | undefined
  try {
    await guard()
    const prefix = "data:image/png;base64,"
    if (
      source.length > REGION_CAPTURE_LIMITS.maxSourceCharacters ||
      !source.startsWith(prefix) ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > REGION_CAPTURE_LIMITS.maxBytes
    )
      return invalid()
    let base64 = source.slice(prefix.length)
    const header = pngDimensions(base64)
    if (
      !header ||
      !bounded(header.width, header.height) ||
      base64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)
    )
      return invalid()
    sourceBlob = new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], {
      type: "image/png",
    })
    source = base64 = ""
    bitmap = await createImageBitmap(sourceBlob)
    sourceBlob = undefined
    await guard()
    if (bitmap.width !== header.width || bitmap.height !== header.height) return invalid()
    const crop = inwardRegionPixels(rectangle, viewport, bitmap)
    canvas = new OffscreenCanvas(crop.width, crop.height)
    const paint = canvas.getContext("2d")
    if (!paint) return invalid()
    paint.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height)
    bitmap.close()
    bitmap = undefined
    await guard()
    const blob = await canvas.convertToBlob({ type: "image/png" })
    await guard()
    if (blob.type !== "image/png" || blob.size === 0 || blob.size > maxBytes) return invalid()
    const bytes = new Uint8Array(await blob.arrayBuffer())
    await guard()
    let binary = ""
    for (let offset = 0; offset < bytes.length; offset += 8192)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
    const data = btoa(binary)
    const output = pngDimensions(data)
    if (!output || output.width !== crop.width || output.height !== crop.height) return invalid()
    return {
      dataUrl: `${prefix}${data}`,
      mimeType: "image/png",
      width: crop.width,
      height: crop.height,
    }
  } catch (error) {
    if (error instanceof RuntimeError) throw error
    return invalid()
  } finally {
    source = ""
    sourceBlob = undefined
    bitmap?.close()
    if (canvas) canvas.width = canvas.height = 1
  }
}
