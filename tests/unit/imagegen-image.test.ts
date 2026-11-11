import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  decodeGeneratedImage,
  GeneratedImageError,
  MAX_GENERATED_IMAGE_BYTES,
} from "../../src/browser/imagegen/image.js"

const ERROR = "Invalid generated image"
const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64")

function pngChunk(type: string, data = Buffer.alloc(0)): Buffer {
  const chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length)
  chunk.write(type, 4, "ascii")
  chunk.set(data, 8)
  // CRC and compressed raster validity belong to the browser decoder in these mocks.
  return chunk
}

function png(width = 2, height = 3, extra: Buffer[] = [], dataLength = 1): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header.set([8, 6], 8)
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    ...extra,
    pngChunk("IDAT", Buffer.alloc(dataLength)),
    pngChunk("IEND"),
  ])
}

function jpeg(width = 2, height = 3, marker = 0xc0): Buffer {
  const frame = Buffer.from([0xff, marker, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0x11, 0])
  frame.writeUInt16BE(height, 5)
  frame.writeUInt16BE(width, 7)
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0]),
    frame,
    Buffer.from([0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 1, 0xff, 0xd9]),
  ])
}

function webpChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(8 + data.length + (data.length % 2))
  chunk.write(type, 0, "ascii")
  chunk.writeUInt32LE(data.length, 4)
  chunk.set(data, 8)
  return chunk
}

function webp(...chunks: Buffer[]): Buffer {
  const header = Buffer.from("RIFF\0\0\0\0WEBP", "ascii")
  const bytes = Buffer.concat([header, ...chunks])
  bytes.writeUInt32LE(bytes.length - 8, 4)
  return bytes
}

function vp8(width = 2, height = 3): Buffer {
  const data = Buffer.from([0, 0, 0, 0x9d, 1, 0x2a, 0, 0, 0, 0])
  data.writeUInt16LE(width, 6)
  data.writeUInt16LE(height, 8)
  return webpChunk("VP8 ", data)
}

function vp8l(width = 2, height = 3): Buffer {
  const data = Buffer.alloc(5)
  data[0] = 0x2f
  data.writeUInt32LE((width - 1) | ((height - 1) << 14), 1)
  return webpChunk("VP8L", data)
}

function vp8x(width = 2, height = 3, flags = 0): Buffer {
  const data = Buffer.alloc(10)
  data[0] = flags
  data.writeUIntLE(width - 1, 4, 3)
  data.writeUIntLE(height - 1, 7, 3)
  return webpChunk("VP8X", data)
}

let bitmap: { width: number; height: number; close: ReturnType<typeof vi.fn> }
let decode: ReturnType<typeof vi.fn>

beforeEach(() => {
  bitmap = { width: 2, height: 3, close: vi.fn() }
  decode = vi.fn(async () => bitmap)
  vi.stubGlobal("createImageBitmap", decode)
})
afterEach(() => vi.unstubAllGlobals())

describe("generated image decoding", () => {
  test.each([
    ["PNG", png(), "image/png"],
    ["JPEG", jpeg(), "image/jpeg"],
    ["progressive JPEG", jpeg(2, 3, 0xc2), "image/jpeg"],
    ["lossy WebP", webp(vp8()), "image/webp"],
    ["lossless WebP", webp(vp8l()), "image/webp"],
    ["extended WebP", webp(vp8x(), vp8()), "image/webp"],
    ["extended lossless WebP", webp(vp8x(), vp8l()), "image/webp"],
  ])("decodes %s without changing the original bytes", async (_name, bytes, mimeType) => {
    const base64 = encode(bytes as Buffer)
    await expect(decodeGeneratedImage(base64)).resolves.toEqual({
      content: { type: "image", data: base64, mimeType },
      width: 2,
      height: 3,
    })
    expect(decode).toHaveBeenCalledOnce()
    const [blob, options] = decode.mock.calls[0] ?? []
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.type).toBe(mimeType)
    expect(Buffer.from(await blob.arrayBuffer())).toEqual(bytes)
    expect(options).toEqual({ imageOrientation: "none" })
    expect(bitmap.close).toHaveBeenCalledOnce()
  })

  test.each([
    "",
    "a",
    "AAAAA",
    "YQ",
    "YQ=",
    "YQ===",
    "=YQ=",
    "YQ==\n",
    " YQ==",
    "YQ-_",
    "YQ!@",
    "YR==",
    "YWJ=",
    "data:image/png;base64,YQ==",
    "A".repeat(Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4 + 4),
  ])("rejects noncanonical, empty, or oversized base64 (case %#)", async (input) => {
    await expect(decodeGeneratedImage(input)).rejects.toThrow(ERROR)
    expect(decode).not.toHaveBeenCalled()
  })

  test("checks actual decoded byte bounds independently of base64 length", async () => {
    for (const binary of ["", "x".repeat(MAX_GENERATED_IMAGE_BYTES + 1)]) {
      vi.stubGlobal(
        "atob",
        vi.fn(() => binary),
      )
      await expect(decodeGeneratedImage("AAAA")).rejects.toThrow(ERROR)
    }
    expect(decode).not.toHaveBeenCalled()
  })

  test("accepts the exact byte limit and rejects the next byte before raster decoding", async () => {
    const overhead = png(2, 3, [], 0).length
    const bytes = png(2, 3, [], MAX_GENERATED_IMAGE_BYTES - overhead)
    expect(bytes.length).toBe(MAX_GENERATED_IMAGE_BYTES)
    await expect(decodeGeneratedImage(encode(bytes))).resolves.toMatchObject({ width: 2 })
    decode.mockClear()
    await expect(
      decodeGeneratedImage(encode(Buffer.concat([bytes, Buffer.alloc(1)]))),
    ).rejects.toThrow(ERROR)
    expect(decode).not.toHaveBeenCalled()
  })

  test.each([
    [0, 3],
    [2, 0],
    [4097, 1],
    [1, 4097],
    [4096, 4096],
    [4001, 4000],
    [0xffffffff, 1],
  ])("rejects PNG header dimensions %s × %s before decoding", async (width, height) => {
    await expect(decodeGeneratedImage(encode(png(width, height)))).rejects.toThrow(ERROR)
    expect(decode).not.toHaveBeenCalled()
  })

  test.each([
    [4096, 1],
    [1, 4096],
    [4000, 4000],
  ])("accepts dimension boundaries %s × %s", async (width, height) => {
    bitmap.width = width
    bitmap.height = height
    await expect(decodeGeneratedImage(encode(png(width, height)))).resolves.toMatchObject({
      width,
      height,
    })
    expect(bitmap.close).toHaveBeenCalledOnce()
  })

  test.each([
    jpeg(0, 1),
    jpeg(4097, 1),
    jpeg(4096, 4096),
    webp(vp8(0, 1)),
    webp(vp8(4097, 1)),
    webp(vp8l(4097, 1)),
    webp(vp8x(4097, 1), vp8()),
    webp(vp8x(4096, 4096), vp8()),
    webp(vp8x(1, 1), vp8()),
  ])("checks JPEG and WebP dimensions before decoding (case %#)", async (bytes) => {
    await expect(decodeGeneratedImage(encode(bytes))).rejects.toThrow(ERROR)
    expect(decode).not.toHaveBeenCalled()
  })

  test.each([
    Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' width='2' height='3'/>"),
    Buffer.from("GIF89a\x02\0\x03\0"),
    Buffer.from("not an image"),
    png().subarray(0, 24),
    png().subarray(0, -1),
    Buffer.concat([png(), Buffer.from([0])]),
    png(2, 3, [pngChunk("IHDR")]),
    png(2, 3, [pngChunk("acTL", Buffer.alloc(8))]),
    png(2, 3, [pngChunk("fcTL", Buffer.alloc(26))]),
    png(2, 3, [pngChunk("fdAT", Buffer.alloc(4))]),
    jpeg().subarray(0, -2),
    Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0xff, 0xff]),
    Buffer.from([0xff, 0xd8, 0xff, 0xd0]),
    webp(vp8x(2, 3, 0x02), vp8()),
    webp(webpChunk("ANIM", Buffer.alloc(6)), vp8()),
    webp(vp8(), webpChunk("ANMF", Buffer.alloc(16))),
    webp(vp8(), vp8()),
    webp(vp8l(), vp8x()),
    webp(vp8()).subarray(0, -1),
    webp(webpChunk("VP8 ", Buffer.alloc(10))),
    webp(webpChunk("VP8L", Buffer.alloc(5))),
    webp(webpChunk("JUNK", Buffer.from("VP8 "))),
  ])("rejects unsupported, animated, or malformed containers (case %#)", async (bytes) => {
    await expect(decodeGeneratedImage(encode(bytes))).rejects.toThrow(ERROR)
    expect(decode).not.toHaveBeenCalled()
  })

  test("does not mistake animation marker text in metadata for an animation chunk", async () => {
    await expect(
      decodeGeneratedImage(encode(png(2, 3, [pngChunk("tEXt", Buffer.from("key\0acTL"))]))),
    ).resolves.toMatchObject({ width: 2, height: 3 })
    await expect(
      decodeGeneratedImage(encode(webp(vp8x(), webpChunk("EXIF", Buffer.from("ANIM")), vp8()))),
    ).resolves.toMatchObject({ width: 2, height: 3 })
  })

  test.each([
    { width: 3, height: 2 },
    { width: 2, height: 4 },
    { width: 0, height: 3 },
    { width: 4097, height: 3 },
  ])("rejects decoded dimension mismatch and closes the bitmap (%j)", async (dimensions) => {
    Object.assign(bitmap, dimensions)
    await expect(decodeGeneratedImage(encode(png()))).rejects.toThrow(ERROR)
    expect(bitmap.close).toHaveBeenCalledOnce()
  })

  test("closes the bitmap if reading its dimensions fails", async () => {
    Object.defineProperty(bitmap, "width", {
      get() {
        throw new Error("provider secret")
      },
    })
    await expect(decodeGeneratedImage(encode(png()))).rejects.toThrow(new GeneratedImageError())
    expect(bitmap.close).toHaveBeenCalledOnce()
  })

  test("returns fixed errors without raw input, decoder diagnostics, or causes", async () => {
    for (const fail of [
      () => {
        throw new Error("provider secret")
      },
      () => Promise.reject("provider secret"),
    ]) {
      decode.mockImplementation(fail)
      try {
        await decodeGeneratedImage(encode(png()))
        expect.unreachable("Expected decode failure")
      } catch (error) {
        expect(error).toBeInstanceOf(GeneratedImageError)
        expect((error as Error).message).toBe(ERROR)
        expect((error as Error).cause).toBeUndefined()
      }
    }
    expect(bitmap.close).not.toHaveBeenCalled()
    vi.stubGlobal("atob", () => {
      throw new Error("provider secret")
    })
    await expect(decodeGeneratedImage(encode(png()))).rejects.toThrow(new GeneratedImageError())
  })

  test("returns a fixed error even when bitmap cleanup fails", async () => {
    bitmap.close.mockImplementation(() => {
      throw new Error("provider secret")
    })
    await expect(decodeGeneratedImage(encode(png()))).rejects.toThrow(new GeneratedImageError())
    expect(bitmap.close).toHaveBeenCalledOnce()
  })
})
