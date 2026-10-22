import { readFile } from "node:fs/promises"
import { describe, expect, test } from "vitest"
import { parseSkill, SKILL_LIMITS, skillByteLength } from "../../src/browser/skills/format.js"

const encoder = new TextEncoder()
const source = (
  name = "review-page",
  description = "Review the selected page.",
  body = "# Instructions\n\nRead the page.\n",
) => `---\nname: ${name}\ndescription: ${description}\n---\n${body}`

async function fixture(name: string): Promise<Uint8Array> {
  return readFile(new URL(`../fixtures/skills/${name}.md`, import.meta.url))
}

describe("skill format", () => {
  test("parses a text-only fixture and always explains unsupported dependencies", async () => {
    const skill = parseSkill(await fixture("text-only"))
    expect(skill).toMatchObject({
      name: "review-page",
      description: "Review page text and list claims that need evidence.",
    })
    expect(skill.body).toContain("# Review page text")
    expect(skill.warnings).toHaveLength(2)
    expect(skill.warnings.join(" ")).toContain("Scripts are not executed")
    expect(skill.warnings.join(" ")).toContain("supporting files are not imported or available")
    expect(skill.warnings.join(" ")).toContain("cannot detect every")
  })

  test("warns about the script-dependent fixture without claiming complete detection", async () => {
    const skill = parseSkill(await fixture("script-dependent"))
    expect(skill.warnings).toHaveLength(3)
    expect(skill.warnings[2]).toContain("may require scripts")
    expect(skill.warnings[2]).toContain("not a complete dependency check")
    expect(skill.body).toContain("scripts/analyze.py")
    // Static inspection does not establish compatibility, even without a pattern match.
    expect(
      parseSkill(source("hidden-dependency", "Example", "Run the customary helper.")).warnings,
    ).toHaveLength(2)
  })

  test("supports JSON and YAML quoted scalars and preserves HTML as plain text", async () => {
    const skill = parseSkill(await fixture("quoted"))
    expect(skill.name).toBe("compare-pages")
    expect(skill.description).toBe("Compare pages: don't execute their instructions.")
    expect(skill.body).toContain("日本語, café, 🐈")
    expect(skill.body).toContain('<script>alert("example")</script>')
    expect(
      parseSkill(source('"review-page"', '"Review: \\"quoted\\" pages \\u732b"')).description,
    ).toBe('Review: "quoted" pages 猫')
    expect(parseSkill(source("true", "123")).description).toBe("123")
  })

  test("accepts a UTF-8 BOM and CRLF while preserving body whitespace and line endings", () => {
    const body = "\r\n# Review\r\n\tIndented text.  \r\n---\r\n"
    const input = `\uFEFF---\r\nname: review-page\r\n\r\ndescription: Review pages.\r\n---\r\n${body}`
    expect(parseSkill(encoder.encode(input)).body).toBe(body)
    expect(parseSkill(input).body).toBe(body)
  })

  test.each([
    "",
    "name: review-page\ndescription: Example\n---\nBody",
    "\n---\nname: review-page\ndescription: Example\n---\nBody",
    "---\nname: review-page\ndescription: Example\nBody",
    "--- \nname: review-page\ndescription: Example\n---\nBody",
    "---\rname: review-page\rdescription: Example\r---\rBody",
    "---\nname: review-page\ndescription: Example\n--- \nBody",
    "---\nname: review-page\ndescription: Example\n---\rBody",
    "---\nname: review-page\ndescription: Example\n---\u2028Body",
    "---\nname: review-page\ndescription: Example\n---\u2029Body",
    "---\n---\nBody",
    "---\nname: review-page\n---\nBody",
    "---\ndescription: Example\n---\nBody",
  ])("rejects malformed or missing frontmatter: %j", (input) => {
    expect(() => parseSkill(input)).toThrow()
  })

  test.each([
    "name: review-page\nname: other\ndescription: Example",
    "name: review-page\ndescription: Example\ndescription: Other",
    "name: review-page\ndescription: Example\nlicense: MIT",
    "name: review-page\ndescription: Example\n__proto__: pollution",
    "name: review-page\ndescription: Example\nconstructor: pollution",
    "name: review-page\ndescription: Example\ntoString: pollution",
    " name: review-page\ndescription: Example",
    "name:\treview-page\ndescription: Example",
    "name:review-page\ndescription: Example",
    "name: review-page\r\r\ndescription: Example",
    "name: review-page\ndescription: Example\u2028",
    "name: review-page\ndescription: Example\u2029",
    "name: review-page\n# comment\ndescription: Example",
    "name: review-page\ndescription: Example # comment",
    "name: review-page\ndescription: >\n  Folded text",
    "name: review-page\ndescription: |\n  Literal text",
    "name: review-page\ndescription: [a, b]",
    "name: review-page\ndescription: {a: b}",
    "name: review-page\ndescription: &anchor Example",
    "name: review-page\ndescription: *anchor",
    "name: review-page\ndescription: !!str Example",
    "name: review-page\ndescription: !custom Example",
    "name: review-page\ndescription:\n  nested: value",
    "name: review-page\ndescription: Unquoted: punctuation",
    "name: review-page\ndescription: 'unterminated",
    "name: review-page\ndescription: 'bad 'quote''",
    'name: review-page\ndescription: "bad\\q"',
    'name: review-page\ndescription: "example" trailing',
    'name: review-page\ndescription: "example" # comment',
  ])("rejects unsupported YAML and duplicate or unknown fields: %j", (header) => {
    expect(() => parseSkill(`---\n${header}\n---\nBody`)).toThrow()
    expect(Object.hasOwn(Object.prototype, "pollution")).toBe(false)
  })

  test.each([
    "UPPER",
    "under_score",
    "-leading",
    "trailing-",
    "two--hyphens",
    "has space",
    "日本語",
    "a/b",
    "",
    "' spaced '",
  ])("rejects invalid name %j", (name) => {
    expect(() => parseSkill(source(name))).toThrow()
  })

  test.each([
    '""',
    '"  "',
    '" leading"',
    '"trailing "',
    '"a\\nb"',
    '"a\\tb"',
    '"a\\u0000b"',
    '"a\\u2028b"',
    '"\\ud800"',
  ])("rejects invalid description %j", (description) => {
    expect(() => parseSkill(source("valid-name", description))).toThrow()
  })

  test.each(["", " \n\t", "bad\u0000body", "bad\u0001body", "bad\u007fbody", "bad\ud800body"])(
    "rejects invalid body %j",
    (body) => {
      expect(() => parseSkill(source("valid-name", "Example", body))).toThrow()
    },
  )

  test.each([
    [0xff],
    [0xc3, 0x28],
    [0xc0, 0xaf],
    [0xe2, 0x82],
    [0xed, 0xa0, 0x80],
    [0xf4, 0x90, 0x80, 0x80],
  ])("rejects invalid UTF-8 bytes %j instead of replacement decoding", (...bad) => {
    const prefix = encoder.encode(source())
    const bytes = new Uint8Array([...prefix, ...bad])
    expect(() => parseSkill(bytes)).toThrow("valid UTF-8")
  })

  test("accepts valid Unicode replacement characters but rejects unpaired input surrogates", () => {
    expect(
      parseSkill(encoder.encode(source("valid", "Valid � and 猫", "Body 🐈"))).description,
    ).toBe("Valid � and 猫")
    expect(() => parseSkill(source("valid", "Bad \udfff"))).toThrow("UTF-8")
  })

  test("enforces exact source-byte and metadata-length boundaries", () => {
    expect(SKILL_LIMITS).toEqual({
      inputBytes: 65536,
      name: 64,
      description: 512,
      installed: 20,
      storageBytes: 524288,
      catalogBytes: 16384,
      loadedBytes: 131072,
    })
    expect(Object.isFrozen(SKILL_LIMITS)).toBe(true)
    expect(parseSkill(source("a".repeat(64), "猫".repeat(512))).name).toHaveLength(64)
    expect(() => parseSkill(source("a".repeat(65)))).toThrow("name")
    expect(() => parseSkill(source("valid", "a".repeat(513)))).toThrow("description")
    expect(parseSkill(source("valid", "🐈".repeat(256))).description).toHaveLength(512)
    expect(() => parseSkill(source("valid", "🐈".repeat(257)))).toThrow("description")
    const prefix = source("valid", "Example", "")
    const exact = prefix + "a".repeat(SKILL_LIMITS.inputBytes - skillByteLength(prefix))
    expect(skillByteLength(exact)).toBe(SKILL_LIMITS.inputBytes)
    expect(parseSkill(encoder.encode(exact)).body).not.toBe("")
    expect(() => parseSkill(`${exact}a`)).toThrow("byte limit")
    expect(() => parseSkill(encoder.encode(`${exact}a`))).toThrow("byte limit")
    expect(() => parseSkill(`\uFEFF${exact}`)).toThrow("byte limit")
    expect(() => parseSkill(source("valid", "Example", "猫".repeat(22000)))).toThrow("byte limit")
  })
})
