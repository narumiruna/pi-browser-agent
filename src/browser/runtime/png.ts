export function pngDimensions(base64: string): { height: number; width: number } | undefined {
  if (base64.length < 32) return undefined
  let header: string
  try {
    header = atob(base64.slice(0, 32))
  } catch {
    return undefined
  }
  const signature = "\x89PNG\r\n\x1a\n"
  if (header.length < 24 || header.slice(0, 8) !== signature || header.slice(12, 16) !== "IHDR")
    return undefined
  const readUint32 = (offset: number): number =>
    ((header.charCodeAt(offset) << 24) |
      (header.charCodeAt(offset + 1) << 16) |
      (header.charCodeAt(offset + 2) << 8) |
      header.charCodeAt(offset + 3)) >>>
    0
  const width = readUint32(16)
  const height = readUint32(20)
  return width > 0 && height > 0 ? { width, height } : undefined
}
