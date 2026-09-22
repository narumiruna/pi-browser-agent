import { describe, expect, test, vi } from "vitest"
import {
  ANNOTATION_LIMITS,
  AnnotationHistory,
  annotationCanvasSize,
  canvasPng,
  canvasPoint,
  pngDimensions,
} from "../../src/browser/sidepanel/screenshot-annotation.js"

function pngHeader(width: number, height: number): string {
  const bytes = new Uint8Array(24)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
  bytes.set([73, 72, 68, 82], 12)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return btoa(String.fromCharCode(...bytes))
}

describe("screenshot annotation", () => {
  test("parses PNG dimensions and rejects malformed headers", () => {
    expect(pngDimensions(pngHeader(1280, 720))).toEqual({ width: 1280, height: 720 })
    expect(pngDimensions(btoa("not a png header value"))).toBeUndefined()
    expect(pngDimensions("%%%%")).toBeUndefined()
    expect(pngDimensions(pngHeader(0, 720))).toBeUndefined()
  })

  test("bounds and proportionally scales the editing canvas", () => {
    expect(annotationCanvasSize(1280, 720)).toEqual({ width: 1280, height: 720 })
    const scaled = annotationCanvasSize(8000, 4000)
    expect(scaled.width / scaled.height).toBeCloseTo(2)
    expect(scaled.width).toBeLessThanOrEqual(ANNOTATION_LIMITS.maxCanvasDimension)
    expect(scaled.width * scaled.height).toBeLessThanOrEqual(ANNOTATION_LIMITS.maxCanvasPixels)
    for (const dimensions of [
      [0, 10],
      [10.5, 10],
      [ANNOTATION_LIMITS.maxSourceDimension + 1, 10],
      [10_000, 10_000],
    ]) {
      expect(() => annotationCanvasSize(dimensions[0] ?? 0, dimensions[1] ?? 0)).toThrow(
        "too large",
      )
    }
  })

  test("maps and clamps displayed pointer coordinates to source pixels", () => {
    const rectangle = { left: 10, top: 20, width: 200, height: 100 }
    expect(canvasPoint(110, 70, rectangle, 1000, 500)).toEqual({ x: 500, y: 250 })
    expect(canvasPoint(-20, 200, rectangle, 1000, 500)).toEqual({ x: 0, y: 500 })
    expect(() => canvasPoint(0, 0, { ...rectangle, width: 0 }, 10, 10)).toThrow("visible")
  })

  test("bounds vector stroke history and supports undo and clear", () => {
    const history = new AnnotationHistory()
    expect(history.start({ x: Number.NaN, y: 2 }, 8)).toBe(false)
    expect(history.start({ x: 1, y: 2 }, Number.POSITIVE_INFINITY)).toBe(false)
    expect(history.start({ x: 1, y: 2 }, 100)).toBe(true)
    expect(history.strokes[0]?.width).toBe(ANNOTATION_LIMITS.maxPenWidth)
    expect(history.append({ x: 1, y: 2 })).toBe(false)
    expect(history.append({ x: Number.NaN, y: 3 })).toBe(false)
    expect(history.append({ x: 2, y: 3 })).toBe(true)
    history.finish()
    history.undo()
    expect(history.strokes).toHaveLength(0)

    for (let index = 0; index < ANNOTATION_LIMITS.maxStrokes; index += 1) {
      expect(history.start({ x: index, y: index }, 1)).toBe(true)
      history.finish()
    }
    expect(history.start({ x: 0, y: 0 }, 1)).toBe(false)
    history.clear()
    expect(history.strokes).toHaveLength(0)
  })

  test("rejects null and oversized exports while accepting a bounded PNG", async () => {
    const toBlob = vi.fn()
    const canvas = { toBlob } as unknown as HTMLCanvasElement

    toBlob.mockImplementationOnce((callback: BlobCallback) => callback(null))
    await expect(canvasPng(canvas)).rejects.toThrow("could not export")

    toBlob.mockImplementationOnce((callback: BlobCallback) =>
      callback(
        new Blob([new Uint8Array(ANNOTATION_LIMITS.maxCanvasPixels)], { type: "image/png" }),
      ),
    )
    await expect(canvasPng(canvas)).rejects.toThrow("3 MB or less")

    toBlob.mockImplementationOnce((callback: BlobCallback) =>
      callback(new Blob([new Uint8Array([1])], { type: "image/jpeg" })),
    )
    await expect(canvasPng(canvas)).rejects.toThrow("PNG")

    const image = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })
    toBlob.mockImplementationOnce((callback: BlobCallback) => callback(image))
    await expect(canvasPng(canvas)).resolves.toBe(image)
  })
})
