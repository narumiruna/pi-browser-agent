import { describe, expect, test } from "vitest"
import {
  imageContentSource,
  MAX_PASTED_IMAGE_BYTES,
  readGeneratedImage,
  readPastedImage,
} from "../../src/browser/sidepanel/images.js"

describe("Side Panel images", () => {
  test("converts a supported pasted image to model content", async () => {
    const image = await readPastedImage(
      new Blob([new Uint8Array([137, 80, 78, 71])], {
        type: "image/png",
      }),
    )

    expect(image).toEqual({
      content: { type: "image", data: "iVBORw==", mimeType: "image/png" },
      byteLength: 4,
    })
    expect(imageContentSource(image.content)).toBe("data:image/png;base64,iVBORw==")
  })

  test("rejects unsupported, empty, and oversized pasted images", async () => {
    await expect(readPastedImage(new Blob(["svg"], { type: "image/svg+xml" }))).rejects.toThrow(
      "PNG, JPEG, WebP, or GIF",
    )
    await expect(readPastedImage(new Blob([], { type: "image/png" }))).rejects.toThrow("empty")
    await expect(
      readPastedImage(
        new Blob([new Uint8Array(MAX_PASTED_IMAGE_BYTES + 1)], {
          type: "image/png",
        }),
      ),
    ).rejects.toThrow("3 MB or less")
  })

  test("applies the same bounds to generated composer images", async () => {
    await expect(
      readGeneratedImage(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), 2),
    ).rejects.toThrow("3 MB or less")
    await expect(
      readGeneratedImage(new Blob([new Uint8Array([1])], { type: "image/svg+xml" })),
    ).rejects.toThrow("PNG, JPEG, WebP, or GIF")
    await expect(readGeneratedImage(new Blob([], { type: "image/png" }))).rejects.toThrow("empty")
  })

  test("does not construct data URLs for invalid stored image content", () => {
    expect(
      imageContentSource({ type: "image", data: "PHN2Zz4=", mimeType: "image/svg+xml" }),
    ).toBeUndefined()
    expect(
      imageContentSource({ type: "image", data: "not base64", mimeType: "image/png" }),
    ).toBeUndefined()
  })
})
