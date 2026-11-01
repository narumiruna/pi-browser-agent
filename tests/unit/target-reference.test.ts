import type { ImageContent } from "@earendil-works/pi-ai"
import { describe, expect, test } from "vitest"
import {
  composeSubmittedContext,
  createUserContextManifest,
  retainPairIds,
  type SubmittedContext,
  serializeUserContext,
  USER_CONTEXT_HEADER,
} from "../../src/browser/runtime/target-reference.js"
import { selectedTarget } from "../support/target-context.js"

const images: ImageContent[] = [
  { type: "image", data: "YQ==", mimeType: "image/png" },
  { type: "image", data: "Yg==", mimeType: "image/png" },
]
const pair = { targetId: "image-a", referenceId: "image-b" }
const submitted = { imageIds: ["image-a", "image-b"], elementIds: [], pair }

describe("target/reference manifest", () => {
  test("maps immutable image IDs to submitted positions, not old composer positions", () => {
    const first = createUserContextManifest(submitted, images, [])
    expect(first.attachments).toEqual([
      { id: "image-a", kind: "image", imagePosition: 1 },
      { id: "image-b", kind: "image", imagePosition: 2 },
    ])
    const reversed = createUserContextManifest(
      { ...submitted, imageIds: ["image-b", "image-a"] },
      [...images].reverse(),
      [],
    )
    expect(reversed.pair).toEqual(pair)
    expect(reversed.attachments[0]).toMatchObject({ id: "image-b", imagePosition: 1 })
    expect(retainPairIds(pair, new Set(["image-b"]))).toEqual({ referenceId: "image-b" })
    expect(retainPairIds(pair, new Set(["image-a", "image-b", "new"]))).toEqual(pair)
    expect(retainPairIds(pair, new Set())).toEqual({})
  })

  test("fails closed for missing, duplicate, unknown, incomplete, and additional keys", () => {
    for (const input of [
      { ...submitted, imageIds: ["image-a"] },
      { ...submitted, imageIds: ["image-a", "image-a"] },
      { ...submitted, pair: { targetId: "image-a", referenceId: "image-a" } },
      { ...submitted, pair: { targetId: "unknown", referenceId: "image-b" } },
      { ...submitted, pair: { targetId: "image-a" } },
      { ...submitted, pair: { ...pair, instruction: "click" } },
      { ...submitted, fetch: "https://evil.test" },
      { ...submitted, imageIds: ["https://evil.test", "image-b"] },
    ])
      expect(() => createUserContextManifest(input as SubmittedContext, images, [])).toThrow()
  })

  test("keeps pin notes separate from validated untrusted page fields and requires ordinary task text only for pairs", () => {
    const pin = {
      id: "pin-uuid",
      number: 1,
      note: "Match <script> this",
      context: selectedTarget(),
    }
    const manifest = createUserContextManifest(
      { imageIds: ["image-a"], elementIds: [], pair: { targetId: pin.id, referenceId: "image-a" } },
      images.slice(0, 1),
      [],
      [pin],
    )
    expect(manifest.attachments[1]).toEqual({
      id: pin.id,
      kind: "pin",
      number: 1,
      userNote: pin.note,
      untrustedPageContext: pin.context,
    })
    expect(composeSubmittedContext("Match the style", manifest)).toContain(USER_CONTEXT_HEADER)
    expect(() => composeSubmittedContext(" ", manifest)).toThrow()
    expect(
      composeSubmittedContext(
        "",
        createUserContextManifest(
          { imageIds: ["image-a"], elementIds: [] },
          images.slice(0, 1),
          [],
        ),
      ),
    ).toContain('"imagePosition":1')
    expect(composeSubmittedContext("Plain request", { version: 1, attachments: [] })).toBe(
      "Plain request",
    )
    expect(() =>
      createUserContextManifest({ imageIds: [], elementIds: [pin.id] }, [], [pin.context], [pin]),
    ).toThrow()
  })

  test("charges one combined 16KiB UTF-8 budget including every wrapper and role", () => {
    const manifest = createUserContextManifest(submitted, images, [])
    const pin = {
      id: "pin",
      kind: "pin" as const,
      number: 1,
      userNote: "",
      untrustedPageContext: selectedTarget(),
    }
    manifest.attachments.push(pin)
    const bytes = new TextEncoder().encode(`\n\n${serializeUserContext(manifest)}`).byteLength
    pin.userNote = "a".repeat(16 * 1024 - bytes)
    expect(new TextEncoder().encode(`\n\n${serializeUserContext(manifest)}`).byteLength).toBe(
      16 * 1024,
    )
    pin.userNote += "a"
    expect(() => serializeUserContext(manifest)).toThrow(/16 KiB/)
    pin.userNote = "界".repeat(Math.floor((16 * 1024 - bytes) / 3) + 1)
    expect(() => serializeUserContext(manifest)).toThrow(/16 KiB/)
  })

  test("reuses the four-image/3 MB raster-only composer boundary", () => {
    for (const image of [
      { ...images[0], mimeType: "image/svg+xml" },
      { ...images[0], data: "not-base64" },
      { ...images[0], url: "https://evil.test" },
    ])
      expect(() =>
        createUserContextManifest(
          { imageIds: ["image"], elementIds: [] },
          [image as ImageContent],
          [],
        ),
      ).toThrow()
    expect(() =>
      createUserContextManifest(
        { imageIds: ["1", "2", "3", "4", "5"], elementIds: [] },
        Array.from({ length: 5 }, () => images[0] as ImageContent),
        [],
      ),
    ).toThrow()
    expect(() =>
      createUserContextManifest(
        { imageIds: ["image"], elementIds: [] },
        [{ type: "image", mimeType: "image/png", data: "AAAA".repeat(1_000_001) }],
        [],
      ),
    ).toThrow(/3 MB/)
  })

  test("shares the five-target bound and rejects malformed nested contexts", () => {
    const elements = Array.from({ length: 5 }, () => selectedTarget())
    const input = { imageIds: [], elementIds: elements.map((_, index) => `element-${index}`) }
    expect(createUserContextManifest(input, [], elements).attachments).toHaveLength(5)
    expect(() =>
      createUserContextManifest(input, [], elements, [
        { id: "pin", number: 1, note: "", context: selectedTarget() },
      ]),
    ).toThrow()
    expect(() =>
      createUserContextManifest(
        { imageIds: [], elementIds: ["e"] },
        [],
        [{ ...selectedTarget(), extra: "x" }],
      ),
    ).toThrow()
  })
})
