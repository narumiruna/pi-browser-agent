import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { cropRegionPng, inwardRegionPixels } from "../../src/browser/region-crop.js"
import { RuntimeError } from "../../src/browser/runtime/types.js"

function png(width: number, height: number): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(24)
  data.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82])
  const view = new DataView(data.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return data
}
const source = (width = 1500, height = 1050) =>
  `data:image/png;base64,${Buffer.from(png(width, height)).toString("base64")}`
const rectangle = { x: 100.2, y: 120.4, width: 200.6, height: 160.2 }
const viewport = { width: 1000, height: 700 }
let bitmap: { width: number; height: number; close: ReturnType<typeof vi.fn> }
let canvases: Array<{ width: number; height: number }>
let draw: ReturnType<typeof vi.fn>
let encode: ReturnType<typeof vi.fn>
let decode: ReturnType<typeof vi.fn>

beforeEach(() => {
  bitmap = { width: 1500, height: 1050, close: vi.fn() }
  canvases = []
  draw = vi.fn()
  encode = vi.fn(async function (this: { width: number; height: number }) {
    return new Blob([png(this.width, this.height)], { type: "image/png" })
  })
  decode = vi.fn(async () => bitmap)
  vi.stubGlobal("createImageBitmap", decode)
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      constructor(
        public width: number,
        public height: number,
      ) {
        canvases.push(this)
      }
      getContext() {
        return { drawImage: draw }
      }
      convertToBlob = encode
    },
  )
})
afterEach(() => vi.unstubAllGlobals())
const crop = (
  input = source(),
  maxBytes = 3_000_000,
  guard: () => Promise<void> = async () => undefined,
) => cropRegionPng(input, rectangle, viewport, maxBytes, guard)

describe("worker-local inward PNG crop", () => {
  test("uses actual decoded scales independently on both axes and rounds inward", () => {
    expect(inwardRegionPixels(rectangle, viewport, bitmap)).toEqual({
      x: 151,
      y: 181,
      width: 300,
      height: 239,
    })
    expect(inwardRegionPixels(rectangle, viewport, { width: 1200, height: 1400 })).toEqual({
      x: 121,
      y: 241,
      width: 239,
      height: 320,
    })
    expect(inwardRegionPixels({ x: 0, y: 0, ...viewport }, viewport, bitmap)).toEqual({
      x: 0,
      y: 0,
      width: 1500,
      height: 1050,
    })
  })
  test("returns only a bounded crop, clears canvas, closes bitmap, and uses no fetch or object URL", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const output = await crop()
    expect(output).toEqual({
      dataUrl: source(300, 239),
      mimeType: "image/png",
      width: 300,
      height: 239,
    })
    expect(output.dataUrl).not.toBe(source())
    expect(draw).toHaveBeenCalledWith(bitmap, 151, 181, 300, 239, 0, 0, 300, 239)
    expect(bitmap.close).toHaveBeenCalledOnce()
    expect(canvases).toEqual([{ width: 1, height: 1, convertToBlob: encode }])
    expect(fetch).not.toHaveBeenCalled()
  })
  test.each([
    "data:image/jpeg;base64,AAAA",
    "data:image/png;base64,broken!",
    source(4097, 1),
    source(4096, 4096),
    "x".repeat(3_000_001),
  ])("rejects source bounds before decode", async (input) => {
    await expect(crop(input)).rejects.toThrow()
    expect(decode).not.toHaveBeenCalled()
    expect(encode).not.toHaveBeenCalled()
  })
  test("rejects header/decode mismatch and releases the decoded bitmap", async () => {
    bitmap.width--
    await expect(crop()).rejects.toThrow()
    expect(bitmap.close).toHaveBeenCalledOnce()
    expect(canvases).toEqual([])
  })
  test.each([NaN, Infinity, 0, -1, 3_000_001])(
    "rejects invalid export budget %s",
    async (maxBytes) => {
      await expect(crop(source(), maxBytes)).rejects.toThrow()
      expect(decode).not.toHaveBeenCalled()
    },
  )
  test.each([
    new Blob([], { type: "image/png" }),
    new Blob(["no"], { type: "image/jpeg" }),
    new Blob([png(2, 2)], { type: "image/png" }),
  ])("rejects invalid export without source fallback", async (blob) => {
    encode.mockResolvedValue(blob)
    await expect(crop()).rejects.toThrow()
    expect(bitmap.close).toHaveBeenCalledOnce()
    expect(canvases[0]?.width).toBe(1)
  })
  test("rejects byte overflow and encoding failure, clearing owned resources", async () => {
    await expect(crop(source(), 1)).rejects.toThrow()
    encode.mockRejectedValue(new Error("encode failed"))
    await expect(crop()).rejects.toThrow()
    expect(canvases.every((c) => c.width === 1 && c.height === 1)).toBe(true)
  })
  test.each([1, 2, 3, 4, 5])(
    "cancels at asynchronous guard %s without returning pixels",
    async (turn) => {
      let calls = 0
      const guard = async () => {
        if (++calls === turn) throw new RuntimeError("REQUEST_CANCELLED", "cancelled")
      }
      await expect(crop(source(), 3_000_000, guard)).rejects.toMatchObject({
        code: "REQUEST_CANCELLED",
      })
      if (turn > 1) expect(bitmap.close).toHaveBeenCalledOnce()
      expect(canvases.every((c) => c.width === 1 && c.height === 1)).toBe(true)
    },
  )
  test("rejects empty, out-of-bounds and oversized pixel geometry", () => {
    for (const rect of [
      { ...rectangle, x: -1 },
      { ...rectangle, width: NaN },
      { ...rectangle, x: 999 },
      { ...rectangle, width: 0 },
    ])
      expect(() => inwardRegionPixels(rect, viewport, bitmap)).toThrow()
    expect(() => inwardRegionPixels(rectangle, viewport, { width: 1, height: 1 })).toThrow()
  })
})
