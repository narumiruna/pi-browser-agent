import { readFile } from "node:fs/promises"
import { describe, expect, test } from "vitest"
import {
  parseSkill,
  SKILL_LIMITS,
  SkillError,
  skillByteLength,
} from "../../src/browser/skills/format.js"

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
    "name: review-page\ndescription: Example\n__proto__: pollution",
    "name: review-page\ndescription: Example\nconstructor: pollution",
    "name: review-page\ndescription: Example\ntoString: pollution",
    " name: review-page\ndescription: Example",
    "name:\treview-page\ndescription: Example",
    "name:review-page\ndescription: Example",
    "name: review-page\r\r\ndescription: Example",
    "name: review-page\ndescription: Example\u2028",
    "name: review-page\ndescription: Example\u2029",
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

  test("accepts synthetic OpenAI-like metadata without returning optional fields", async () => {
    const input = await fixture("synthetic-openai-like")
    const skill = parseSkill(input)
    expect(skill.name).toBe("synthetic-comment-review")
    expect(skill.description).toBe(
      "Review synthetic comments and identify the next text-only action.",
    )
    expect(skill.body).toBe(new TextDecoder().decode(input).split("\n---\n")[1])
    expect(Object.keys(skill).sort()).toEqual(["body", "description", "name", "warnings"])
    expect(skill.warnings).toHaveLength(3)
    expect(skill.warnings.join(" ")).toContain("Scripts are not executed")
  })

  test("accepts flow string metadata and folded descriptions without changing the body", async () => {
    const input = await fixture("synthetic-folded")
    const skill = parseSkill(input)
    expect(skill.description).toBe("Compare the supplied text and report unsupported claims.")
    expect(skill.body).toBe(
      new TextDecoder().decode(input).split("\n---\n").slice(1).join("\n---\n"),
    )
    const crlf = new TextDecoder().decode(input).replaceAll("\n", "\r\n")
    expect(parseSkill(crlf).description).toBe(skill.description)
    expect(parseSkill(crlf).body).toBe(skill.body.replaceAll("\n", "\r\n"))
  })

  test.each([
    "true",
    "false",
    "TRUE",
    "False",
    "null",
    "Null",
    "~",
    "0001",
    "0xFF",
    "1e4",
    ".inf",
    ".nan",
    "2026-10-27",
    "yes",
    "off",
  ])("preserves plain scalar %j as a string without implicit YAML types", (value) => {
    expect(parseSkill(source("123", value)).description).toBe(value)
    const skill = parseSkill(
      `---\nname: true\ndescription: ${value}\nlicense: ${value}\ncompatibility: ${value}\nallowed-tools: ${value}\nmetadata: {${value}: ${value}}\n---\nBody`,
    )
    expect(skill.name).toBe("true")
    expect(skill.description).toBe(value)
  })

  test.each([
    ["plain:punctuation,[brackets]", "plain:punctuation,[brackets]"],
    ["-leading", "-leading"],
    ["?leading", "?leading"],
    [":leading", ":leading"],
    ["  plain  ", "plain"],
    ["\u00a0plain\u2003", "plain"],
    ['\u00a0"quoted"\uFEFF', "quoted"],
    ["\u2003'quoted'\u00a0", "quoted"],
    ['"JSON \\/ \\u732b \\uD83D\\uDC08"', "JSON / 猫 🐈"],
    ["'literal \\path and ''quotes'''", "literal \\path and 'quotes'"],
  ])("preserves previously valid scalar form %j", (value, expected) => {
    expect(parseSkill(source("valid", value)).description).toBe(expected)
  })

  test("accepts YAML comments as review text, not field values", () => {
    const skill = parseSkill(
      "---\n# Synthetic comment\nname: valid # name comment\ndescription: Example # value comment\nlicense: 'MIT # literal'\n---\nBody",
    )
    expect(skill.description).toBe("Example")
    expect(skill.name).toBe("valid")
  })

  test.each([">", ">-", ">+"])(
    "normalizes only the final newlines of a folded description %s",
    (style) => {
      expect(
        parseSkill(source("valid", `${style}\n  Review the\n  supplied text.\n`)).description,
      ).toBe("Review the supplied text.")
      expect(
        parseSkill(source("valid", `${style}\n  ${"a".repeat(512)}`)).description,
      ).toHaveLength(512)
      expect(() => parseSkill(source("valid", `${style}\n  ${"a".repeat(513)}`))).toThrow(
        "description",
      )
    },
  )

  test.each([
    ">-\n  First paragraph.\n\n  Second paragraph.",
    ">-\n  First line.\n    Indented line.",
    ">-\n  Trailing space. ",
    ">-\n  ",
    ">-\n  Contains\u2028separator",
    ">-\n  Contains\u0085control",
    "|\n  Literal text",
    "|+\n  Literal text\n",
  ])("rejects descriptions that remain invalid after folding: %j", (description) => {
    expect(() => parseSkill(source("valid", description))).toThrow()
  })

  test.each([
    "license: [MIT]",
    "license: {name: MIT}",
    "compatibility: [browser]",
    "compatibility: {runtime: browser}",
    "allowed-tools: [Read, Write]",
    "allowed-tools: {Read: true}",
    "metadata: scalar",
    "metadata: [author, example]",
    "metadata:\n  author: {nested: value}",
    "metadata:\n  author: [example]",
    "metadata:\n  ? [complex, key]\n  : value",
    'metadata: {author: example, "author": duplicate}',
    "license: MIT\nlicense: Apache-2.0",
    "metadata: {}\nmetadata: {}",
    'metadata: {author: example, "\\u0061uthor": duplicate}',
    '"\\u006eame": duplicate',
    "metadata: {author: &author Example}",
    "metadata: {author: *author}",
    "metadata: &meta {author: Example}",
    "metadata: !!map {author: Example}",
    "metadata: !custom {author: Example}",
    "metadata: {author: !!str Example}",
    "license: !!str MIT",
    "license: !<tag:example.invalid,2026:value> MIT",
    'license: "bad\\u0000text"',
    'compatibility: "bad\\u0085text"',
    'allowed-tools: "bad\\u2028text"',
    'metadata: {"bad\\u2029key": text}',
    'metadata: {author: "bad\\u007ftext"}',
    'metadata: {author: "\\ud800"}',
    "metadata: {author: bad\u009ftext}",
    "metadata: {author: bad\u0000text}",
    "metadata: {author: bad\u2029text}",
    "unknown-field: value",
    "...\nname: second",
    "...\n--- # second document\nname: second",
    "%YAML 1.1\n--- # directive document",
    "%TAG !e! tag:example.invalid,2026:\n--- # directive document",
  ])("rejects invalid optional shapes and unsafe YAML: %j", (extra) => {
    expect(() => parseSkill(`---\nname: valid\ndescription: Example\n${extra}\n---\nBody`)).toThrow(
      SkillError,
    )
  })

  test("limits compatibility to 500 UTF-16 code units", () => {
    const input = (value: string) =>
      `---\nname: valid\ndescription: Example\ncompatibility: ${value}\n---\nBody`
    expect(parseSkill(input("a".repeat(500))).name).toBe("valid")
    expect(parseSkill(input("🐈".repeat(250))).name).toBe("valid")
    expect(() => parseSkill(input("a".repeat(501)))).toThrow(
      "Skill compatibility must be at most 500 characters",
    )
    expect(() => parseSkill(input("🐈".repeat(251)))).toThrow(
      "Skill compatibility must be at most 500 characters",
    )
  })

  test("keeps quoted syntax inert and never treats metadata as object properties", () => {
    const skill = parseSkill(
      `---\nname: valid\ndescription: Example\nmetadata:\n  __proto__: pollution\n  constructor: pollution\n  toString: pollution\n  syntax: '!tag &anchor *alias ---'\nlicense: '&anchor *alias !!str'\nallowed-tools: Bash(arbitrary:*)\n---\nBody`,
    )
    expect(Object.hasOwn(Object.prototype, "pollution")).toBe(false)
    expect(skill).toEqual(parseSkill(source("valid", "Example", "Body")))
  })

  test("bounds YAML containers before composition, including deeply nested input", () => {
    const nested = (count: number) =>
      `---\nname: valid\ndescription: Example\nmetadata: ${"[".repeat(count)}text${"]".repeat(count)}\n---\nBody`
    // The root mapping counts as the first container. Eight levels pass the
    // structural bound but still fail the optional metadata shape check.
    expect(() => parseSkill(nested(7))).toThrow("string-to-string map")
    expect(() => parseSkill(nested(8))).toThrow("8 container levels or 256 nodes")
    expect(() => parseSkill(nested(2_000))).toThrow("8 container levels or 256 nodes")
    const implicitMaps = (count: number) =>
      `---\nname: valid\ndescription: Example\nmetadata: ${"[key: ".repeat(count)}text${"]".repeat(count)}\n---\nBody`
    expect(() => parseSkill(implicitMaps(3))).toThrow("string-to-string map")
    expect(() => parseSkill(implicitMaps(4))).toThrow("8 container levels or 256 nodes")
    const blocks = Array.from({ length: 9 }, (_, i) => `${"  ".repeat(i + 1)}nested:`).join("\n")
    expect(() =>
      parseSkill(`---\nname: valid\ndescription: Example\nmetadata:\n${blocks}\n---\nBody`),
    ).toThrow("8 container levels or 256 nodes")
  })

  test("bounds YAML nodes, including map keys and implicit empty scalars", () => {
    const metadata = (count: number, last = "text") =>
      Array.from(
        { length: count },
        (_, i) => `  key-${i}: ${i === count - 1 ? last : "text"}`,
      ).join("\n")
    const input = (count: number, last?: string) =>
      `---\nname: valid\ndescription: Example\nmetadata:\n${metadata(count, last)}\n---\nBody`
    expect(parseSkill(input(124)).name).toBe("valid") // 255 nodes
    expect(() => parseSkill(input(124, "[text]"))).toThrow("string-to-string map") // 256 nodes
    expect(() => parseSkill(input(124, "[text, other]"))).toThrow("8 container levels or 256 nodes")
    expect(() => parseSkill(input(125))).toThrow("8 container levels or 256 nodes")
    expect(() => parseSkill(input(125, ""))).toThrow("8 container levels or 256 nodes")
  })

  test("uses fixed diagnostics without untrusted YAML field names or parser errors", () => {
    const secret = "synthetic-private-value"
    for (const extra of [
      `${secret}: value`,
      `license: !${secret} value`,
      `metadata: {author: "${secret}`,
    ]) {
      try {
        parseSkill(`---\nname: valid\ndescription: Example\n${extra}\n---\nBody`)
        expect.unreachable("Expected a skill error")
      } catch (error) {
        expect(error).toBeInstanceOf(SkillError)
        expect((error as Error).message).not.toContain(secret)
      }
    }
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
